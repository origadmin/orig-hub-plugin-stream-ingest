'use strict'
/**
 * stream-ingest —— 通用网页 HLS 流入库插件的 service 进程。
 *
 * 只绑回环（hub daemon 代理契约 BUG-855）。所有站点地址/鉴权来自运行期用户输入，
 * 本文件与整个插件包内不含任何具体站点域名或品牌（M3）。
 *
 * 端点（经 daemon 代理 /api/plugin/stream-ingest/*）：
 *   GET  /config        —— 当前配置（扁平键，供 form）
 *   POST /config        —— 保存用户手动输入
 *   GET  /health        —— { available, configured, reason }
 *   GET  /list?page=    —— 浏览列表
 *   GET  /detail?id=    —— 剧集详情
 *   GET  /tasks         —— provides:["tasks"] 聚合
 *   POST /prepare       —— {id,ep} 单集洗流 → 可播 item
 *   POST /ingest        —— {id,fromEp,toEp} 入库 → ohc
 */
const http = require('node:http')
const cfgLib = require('./lib/config')
const site = require('./lib/site')
const ingest = require('./lib/ingest')
const { mask } = require('./lib/hls')

const PORT = Number(process.env.STREAM_INGEST_PORT || 19814)
const HOST = '127.0.0.1'

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function errMsg(e) {
  // 抹掉 query（鉴权常在 query 里），避免把签名 URL 回显到 UI/日志。
  return String(e && e.message ? e.message : e).replace(/https?:\/\/\S+/g, (u) => mask(u))
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = url.pathname.replace(/^\/api\/plugin\/stream-ingest\/?/, '/').replace(/^\/+/, '/') || '/'
  const method = req.method || 'GET'
  const cfg = cfgLib.load()

  try {
    if (p === '/config' && method === 'GET') {
      return send(res, 200, { ok: true, ...cfgLib.flatten(cfg) })
    }
    if (p === '/config' && method === 'POST') {
      const flat = await readBody(req)
      const next = cfgLib.fromFlat(flat)
      cfgLib.save(next)
      return send(res, 200, { ok: true, ...cfgLib.flatten(next) })
    }
    if (p === '/health' && method === 'GET') {
      const configured = cfgLib.isConfigured(cfg)
      return send(res, 200, {
        available: true,
        configured,
        reason: configured ? '' : 'baseUrl not set; user must input site home address',
      })
    }
    if (p === '/list' && method === 'GET') {
      if (!cfgLib.isConfigured(cfg)) return send(res, 422, { error: 'baseUrl not configured' })
      const page = Number(url.searchParams.get('page') || 1)
      return send(res, 200, await site.list(cfg, page))
    }
    if (p === '/detail' && method === 'GET') {
      if (!cfgLib.isConfigured(cfg)) return send(res, 422, { error: 'baseUrl not configured' })
      const id = url.searchParams.get('id') || ''
      return send(res, 200, await site.detail(cfg, id))
    }
    if (p === '/tasks' && method === 'GET') {
      return send(res, 200, { rows: ingest.taskRows() })
    }
    if (p === '/prepare' && method === 'POST') {
      if (!cfgLib.isConfigured(cfg)) return send(res, 422, { error: 'baseUrl not configured' })
      const body = await readBody(req)
      if (!body.id) return send(res, 422, { error: 'id required' })
      return send(res, 200, await ingest.prepare(cfg, body.id, body.ep || 1))
    }
    if (p === '/ingest' && method === 'POST') {
      if (!cfgLib.isConfigured(cfg)) return send(res, 422, { error: 'baseUrl not configured' })
      const body = await readBody(req)
      if (!body.id) return send(res, 422, { error: 'id required' })
      return send(res, 200, await ingest.ingest(cfg, body.id, body.fromEp, body.toEp))
    }
    if (p === '/' && method === 'GET') {
      return send(res, 200, { ok: true, service: 'stream-ingest', endpoints: ['config', 'health', 'list', 'detail', 'tasks', 'prepare', 'ingest'] })
    }
    return send(res, 404, { error: `no route ${method} ${p}` })
  } catch (e) {
    return send(res, 500, { error: errMsg(e) })
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => send(res, 500, { error: errMsg(e) }))
})

server.listen(PORT, HOST, () => {
  // 日志只打本地端口，不打任何站点地址。
  process.stdout.write(`[stream-ingest] listening on http://${HOST}:${PORT}\n`)
})
