'use strict'
/**
 * 入库编排 —— 把「一集 HLS」洗成 seekable MP4，并把多集组织成 ohc schema=2 manifest。
 *
 * ohc 字段真源：docs/standards/ohc-format.md §2（本模块不复制字节表，只按字段产出）。
 * 一集一文件（BUG-720/1051）；base=0、total=文件大小；seekable/playable 来自实测。
 *
 * 产物落到 outputDir（默认插件数据目录/output）：
 *   <out>/<id>/ep-<ep>.mp4          —— 单集媒体字节
 *   <out>/<id>/collection.ohc       —— schema=2 虚拟索引（file 为相对 out 的路径）
 */
const fs = require('node:fs')
const path = require('node:path')
const cfgLib = require('./config')
const site = require('./site')
const hls = require('./hls')

/** 任务进度（供 provides:["tasks"] 的 GET /tasks 聚合）。 */
const tasks = new Map()
function newTask(kind, id) {
  const task = { id: `${kind}-${id}-${Date.now()}`, kind, refId: String(id), status: 'running', progress: 0, note: '', createdAt: Date.now() }
  tasks.set(task.id, task)
  return task
}
function taskRows() {
  return Array.from(tasks.values()).map((t) => ({ id: t.id, kind: t.kind, title: `${t.kind}:${t.refId}`, status: t.status, progress: t.progress, note: t.note }))
}

function outRoot(cfg) {
  return cfg.outputDir || path.join(cfgLib.dataDir(), 'output')
}

function seriesDir(cfg, id) {
  return path.join(outRoot(cfg), String(id))
}

/** 准备单集：playback → m3u8 → 解密下载 → remux → probe → 写 MP4。 */
async function prepareEpisode(cfg, id, ep, task) {
  const meta = await site.playback(cfg, id, ep)
  const m3u8Buf = await hls.fetchBuffer(meta.m3u8, { headers: meta.headers, proxyUrl: cfgLib.proxy() })
  const m3u8Text = m3u8Buf.toString('utf8')

  const dir = seriesDir(cfg, id)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-ep-${ep}`)
  const mp4 = path.join(dir, `ep-${ep}.mp4`)

  const { tsFiles, durationMs } = await hls.downloadAndDecrypt(m3u8Text, meta.m3u8, tmp, {
    headers: meta.headers,
    proxyUrl: cfgLib.proxy(),
    onProgress: (done, total) => {
      if (task) task.progress = Math.round((done / total) * 70)
    },
  })
  await hls.remuxToMp4(tsFiles, mp4)
  if (task) task.progress = 85

  const codec = await hls.probeMp4(mp4)
  const size = fs.statSync(mp4).size
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }

  return {
    file: path.relative(outRoot(cfg), mp4).replace(/\\/g, '/'),
    base: 0,
    total: size,
    codec: codec || { video: 'unknown', audio: 'unknown', width: 0, height: 0, duration_ms: durationMs },
    seekable: true,
    playable: !!codec && codec.width > 0,
    note: codec ? '' : 'ffprobe failed; marked unplayable',
  }
}

/** 生成 ohc schema=2 manifest（字段严格按 ohc-format.md §2）。 */
function writeOhc(cfg, id, title, eps) {
  const dir = seriesDir(cfg, id)
  const manifest = {
    schema: 2,
    title: title || String(id),
    created_at: new Date().toISOString(),
    source: 'plugin:stream-ingest',
    items: eps.map((e, i) => ({
      id: `ep-${i + 1}`,
      title: `第${e.ep}集`,
      season: 1,
      episode: e.ep,
      file: e.file,
      base: e.base,
      total: e.total,
      codec: e.codec,
      seekable: !!e.seekable,
      segments: [],
      playable: !!e.playable,
      note: e.note || '',
    })),
  }
  const file = path.join(dir, 'collection.ohc')
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8')
  return { ohcId: `${id}`, ohcPath: file, items: manifest.items }
}

/** 入库：fromEp..toEp（缺省 1..max）逐集准备 → 生成 ohc。 */
async function ingest(cfg, id, fromEp, toEp) {
  const task = newTask('ingest', id)
  try {
    const d = await site.detail(cfg, id)
    const all = d.episodes.length ? d.episodes : [{ ep: 1, title: '第1集', duration: 0 }]
    const lo = Number(fromEp) > 0 ? Number(fromEp) : Math.min(...all.map((e) => e.ep))
    const hi = Number(toEp) > 0 ? Number(toEp) : Math.max(...all.map((e) => e.ep))
    const chosen = all.filter((e) => e.ep >= lo && e.ep <= hi)
    const results = []
    for (const e of chosen) {
      task.note = `ep ${e.ep}`
      const r = await prepareEpisode(cfg, id, e.ep, null)
      results.push({ ...r, ep: e.ep })
      task.progress = Math.round((results.length / chosen.length) * 100)
    }
    const ohc = writeOhc(cfg, id, d.title, results)
    task.status = 'done'
    task.progress = 100
    task.note = `${results.filter((x) => x.playable).length}/${results.length} playable`
    return ohc
  } catch (e) {
    task.status = 'error'
    task.note = e.message
    throw e
  }
}

/** 在线准备：单集 MP4 + item 描述（hub 播放器用原生 src/Range 消费）。 */
async function prepare(cfg, id, ep) {
  const task = newTask('prepare', `${id}:${ep}`)
  try {
    const r = await prepareEpisode(cfg, id, Number(ep) || 1, task)
    task.status = 'done'
    task.progress = 100
    return { itemId: `${id}-ep${ep}`, file: r.file, ...r }
  } catch (e) {
    task.status = 'error'
    task.note = e.message
    throw e
  }
}

module.exports = { tasks, taskRows, outRoot, seriesDir, prepareEpisode, writeOhc, ingest, prepare }
