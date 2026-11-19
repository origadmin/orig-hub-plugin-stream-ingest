'use strict'
/**
 * HLS 流处理内核 —— m3u8 解析 + AES-128-CBC 解密 + TS 分片下载 + ffmpeg remux。
 *
 * 「切片转视频」链路（M2 / M4）：
 *   m3u8 → EXT-X-KEY(key/iv) + 分片 URL → 并发有界下载 → AES 解密 →
 *   落 TS → ffmpeg -f concat -c copy -movflags +faststart → seekable MP4。
 *
 * 脱敏（M3）：本模块只处理「运行期传入的 URL」，不含任何站点地址或鉴权头名常量。
 * CDN 鉴权头名/值一律来自 playback 响应，由调用方透传，不写死。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const MAX_CONCURRENCY = 4
const MAX_RETRY = 2
const FETCH_TIMEOUT_MS = 30000

/** 通用 HTTP(S) GET，返回 Buffer。支持可选的 URL 形式代理（运行期用户提供）。 */
function fetchBuffer(url, { headers = {}, proxyUrl = '', timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (e) {
      return reject(new Error(`invalid url: ${e.message}`))
    }
    const transport = target.protocol === 'https:' ? https : http
    let req
    if (proxyUrl) {
      // 简单 HTTP 代理：请求行用绝对 URL（HTTP 代理的 standard forwarding）。
      // 仅支持 http 代理 + http/https 目标；https-over-http 隧道需 CONNECT，见下。
      const p = new URL(proxyUrl)
      const isTunnel = target.protocol === 'https:'
      if (isTunnel) {
        req = http.request({
          host: p.hostname,
          port: p.port || 80,
          method: 'CONNECT',
          path: `${target.hostname}:${target.port || 443}`,
          headers: { host: `${target.hostname}:${target.port || 443}` },
          timeout: timeoutMs,
        })
        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy()
            return reject(new Error(`proxy CONNECT failed: ${res.statusCode}`))
          }
          const tls = require('node:tls')
          const secure = tls.connect({ socket, servername: target.hostname }, () => {
            const rh = { ...headers, host: target.host }
            const r = transport.request(
              target.pathname + target.search,
              { headers: rh, method: 'GET' },
              (resp) => collect(resp, resolve, reject),
            )
            r.on('error', reject)
            r.end()
          })
          secure.on('error', reject)
        })
        req.on('error', reject)
        req.end()
        return
      }
      const proxyTransport = p.protocol === 'https:' ? https : http
      req = proxyTransport.request({
        host: p.hostname,
        port: p.port || 80,
        method: 'GET',
        path: url,
        headers: { ...headers, host: target.host },
        timeout: timeoutMs,
      })
    } else {
      req = transport.request(target, { method: 'GET', headers, timeout: timeoutMs })
    }
    req.on('timeout', () => req.destroy(new Error('fetch timeout')))
    req.on('error', reject)
    req.end()
    function collect(resp, ok, bad) {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume()
        return bad(new Error(`HTTP ${resp.statusCode} for ${mask(url)}`))
      }
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => ok(Buffer.concat(chunks)))
      resp.on('error', bad)
    }
    if (!proxyUrl || target.protocol !== 'https:') {
      req.on('response', (resp) => collect(resp, resolve, reject))
    }
  })
}

/** 日志脱敏：只保留 origin 与路径前缀，去掉 query（鉴权参数常在此）。 */
function mask(url) {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname.slice(0, 24)}…`
  } catch {
    return '<url>'
  }
}

/** 解析 m3u8 文本 → { key: {method,uri,iv}, segments:[{url,duration,seq}], targetDuration }。 */
function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/)
  const result = { key: null, segments: [], targetDuration: 0 }
  let seq = 0
  let currentDuration = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = parseInt(line.split(':')[1], 10) || 0
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = parseFloat(line.split(':')[1]) || 0
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1))
      result.key = {
        method: attrs.METHOD || '',
        uri: attrs.URI ? absolute(attrs.URI, baseUrl) : '',
        iv: attrs.IV || '',
      }
    } else if (line.startsWith('#EXTINF:')) {
      currentDuration = parseFloat(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0
    } else if (line && !line.startsWith('#')) {
      result.segments.push({ url: absolute(line, baseUrl), duration: currentDuration, seq: seq++ })
      currentDuration = 0
    }
  }
  return result
}

function parseAttrs(s) {
  const out = {}
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g
  let m
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[4]
  return out
}

function absolute(ref, base) {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

/** IV：m3u8 提供则用之；否则用媒体序号 big-endian 16 字节。 */
function ivFor(key, seq) {
  if (key.iv && /^0x/i.test(key.iv)) {
    const hex = key.iv.slice(2).padStart(32, '0')
    return Buffer.from(hex, 'hex')
  }
  const b = Buffer.alloc(16)
  b.writeUInt32BE(seq >>> 0, 12)
  return b
}

/** 有界并发 map。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/** 带重试的下载。 */
async function fetchWithRetry(url, opts) {
  let last
  for (let i = 0; i <= MAX_RETRY; i++) {
    try {
      return await fetchBuffer(url, opts)
    } catch (e) {
      last = e
    }
  }
  throw last
}

/**
 * 下载并解密一集的所有分片 → 目录 outDir，返回 { tsFiles, durationMs }。
 * opts: { headers, proxyUrl, onProgress }
 */
async function downloadAndDecrypt(m3u8Text, m3u8Url, outDir, opts = {}) {
  const parsed = parseM3u8(m3u8Text, m3u8Url)
  if (parsed.segments.length === 0) throw new Error('m3u8 has no segments')
  fs.mkdirSync(outDir, { recursive: true })

  let keyBuf = null
  if (parsed.key && parsed.key.method.toUpperCase() === 'AES-128' && parsed.key.uri) {
    keyBuf = await fetchWithRetry(parsed.key.uri, { headers: opts.headers, proxyUrl: opts.proxyUrl })
    if (keyBuf.length !== 16) throw new Error('AES key must be 16 bytes')
  }

  let done = 0
  const tsFiles = await mapLimit(parsed.segments, MAX_CONCURRENCY, async (seg, i) => {
    let chunk = await fetchWithRetry(seg.url, { headers: opts.headers, proxyUrl: opts.proxyUrl })
    if (keyBuf) {
      const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivFor(parsed.key, seg.seq))
      chunk = Buffer.concat([decipher.update(chunk), decipher.final()])
    }
    const file = path.join(outDir, `seg-${String(i).padStart(6, '0')}.ts`)
    fs.writeFileSync(file, chunk)
    done++
    if (opts.onProgress) opts.onProgress(done, parsed.segments.length)
    return file
  })

  const durationMs = Math.round(parsed.segments.reduce((s, x) => s + x.duration, 0) * 1000)
  return { tsFiles, durationMs }
}

/** ffmpeg concat demuxer 合并成 seekable/faststart MP4（零重编码）。 */
function remuxToMp4(tsFiles, outFile) {
  return new Promise((resolve, reject) => {
    const listFile = outFile + '.concat.txt'
    const lines = tsFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
    fs.writeFileSync(listFile, lines, 'utf8')
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile]
    execFile('ffmpeg', args, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(listFile) } catch { /* ignore */ }
      if (err) return reject(new Error(`ffmpeg remux failed: ${(stderr || err.message).slice(-500)}`))
      resolve(outFile)
    })
  })
}

/** ffprobe 探测 codec/duration；失败返回 null（该集标 unplayable）。 */
function probeMp4(file) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', file]
    execFile('ffprobe', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const j = JSON.parse(stdout)
        const v = (j.streams || []).find((s) => s.codec_type === 'video')
        const a = (j.streams || []).find((s) => s.codec_type === 'audio')
        resolve({
          video: v ? v.codec_name : 'unknown',
          audio: a ? a.codec_name : 'none',
          width: v ? v.width : 0,
          height: v ? v.height : 0,
          duration_ms: j.format && j.format.duration ? Math.round(parseFloat(j.format.duration) * 1000) : 0,
        })
      } catch {
        resolve(null)
      }
    })
  })
}

module.exports = { fetchBuffer, mask, parseM3u8, parseAttrs, absolute, ivFor, mapLimit, fetchWithRetry, downloadAndDecrypt, remuxToMp4, probeMp4 }
