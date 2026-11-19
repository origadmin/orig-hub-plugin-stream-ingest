'use strict'
/**
 * 站点适配层 —— 只按「用户配置的 baseUrl + 路径模板」请求，响应字段做容错归一化。
 *
 * 脱敏（M1/M3）：
 *  - 不认识任何具体站点；字段名用「多候选」容错匹配，不写死某站专有结构。
 *  - 鉴权头名/值来自 playback 响应（如响应给出 cdn.authKey/authValue），不内置常量。
 */
const { fetchBuffer, mask } = require('./hls')
const cfgLib = require('./config')

/** 从对象里取第一个存在的键（多候选字段名容错）。 */
function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return fallback
}

/** 解包 hub 风格响应 {data,status,msg} 或直接对象。 */
function unwrap(json) {
  if (json && typeof json === 'object' && 'data' in json) return json.data
  return json
}

function requestJson(cfg, tpl, params, extraHeaders = {}) {
  const rel = cfgLib.renderPath(tpl, params)
  const url = rel.startsWith('http') ? rel : `${cfg.baseUrl}${rel.startsWith('/') ? '' : '/'}${rel}`
  return fetchBuffer(url, { headers: { accept: 'application/json', ...cfg.headers, ...extraHeaders }, proxyUrl: cfg.proxyUrl })
    .then((buf) => JSON.parse(buf.toString('utf8')))
    .then(unwrap)
}

/** 列表归一化 → {items:[{id,title,score,episodeCount,playAt,desc,cover}]} */
async function list(cfg, page = 1) {
  const tpl = cfg.paths.list.includes('{page}') ? cfg.paths.list.replace('{page}', encodeURIComponent(String(page))) : cfg.paths.list
  const data = await requestJson(cfg, tpl, {})
  const arr = Array.isArray(data) ? data : pick(data, ['items', 'list', 'videos', 'posts', 'rows'], [])
  const items = (Array.isArray(arr) ? arr : []).map((x) => ({
    id: String(pick(x, ['id', 'videoId', 'vid', 'post_id'], '')),
    title: String(pick(x, ['title', 'name'], '')),
    score: Number(pick(x, ['score', 'rating'], 0)),
    episodeCount: Number(pick(x, ['episode_count', 'episodeCount', 'total', 'episodes'], 0)),
    playAt: String(pick(x, ['play_at', 'playAt', 'updated_at', 'created_at'], '')),
    desc: String(pick(x, ['desc', 'description', 'synopsis'], '')).slice(0, 200),
    cover: String(pick(x, ['cover', 'poster', 'thumb', 'image'], '')),
  })).filter((x) => x.id)
  return { items }
}

/** 详情归一化 → {id,title,desc,cover,episodes:[{ep,title,duration}]} */
async function detail(cfg, id) {
  const data = await requestJson(cfg, cfg.paths.detail, { id })
  const eps = pick(data, ['episodes', 'eps', 'items', 'list'], [])
  const episodes = (Array.isArray(eps) ? eps : []).map((e, i) => ({
    ep: Number(pick(e, ['ep_num', 'ep', 'episode', 'index'], i + 1)),
    title: String(pick(e, ['title', 'name', 'synopsis'], `第${i + 1}集`)).slice(0, 200),
    duration: Number(pick(e, ['duration', 'durationMs'], 0)),
  }))
  return {
    id: String(pick(data, ['id', 'videoId', 'vid'], id)),
    title: String(pick(data, ['title', 'name'], '')),
    desc: String(pick(data, ['description', 'desc', 'synopsis'], '')).slice(0, 1000),
    cover: String(pick(data, ['cover', 'poster', 'image'], '')),
    episodes,
  }
}

/**
 * 播放元数据：POST playback 路径模板 → 解析出 m3u8 URL + 鉴权头。
 * 鉴权头名/值由响应给出（候选字段名容错），不写死。
 */
async function playback(cfg, id, ep) {
  const rel = cfgLib.renderPath(cfg.paths.playback, { id, ep })
  const url = rel.startsWith('http') ? rel : `${cfg.baseUrl}${rel.startsWith('/') ? '' : '/'}${rel}`
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    ...cfg.headers,
  }
  let data
  try {
    const buf = await fetchBuffer(url, { headers, proxyUrl: cfg.proxyUrl })
    data = unwrap(JSON.parse(buf.toString('utf8')))
  } catch (e) {
    // 部分站点要求 GET；失败后按同路径 GET 再试一次。
    const { fetchBuffer: fb } = require('./hls')
    const buf = await fb(url, { headers: { ...headers, 'content-type': undefined }, proxyUrl: cfg.proxyUrl })
    data = unwrap(JSON.parse(buf.toString('utf8')))
  }

  // 流地址候选：streams.main / streams.hls / video_url / url / playUrl ...
  const streams = data && (data.streams || data.playback || data)
  const m3u8 = pick(streams, ['main', 'hls', 'm3u8', 'video_url', 'videoUrl', 'url', 'playUrl', 'src'], '')
  if (!m3u8 || !/\.m3u8(\?|$)/i.test(String(m3u8))) {
    throw new Error(`no m3u8 stream in playback response (${mask(url)})`)
  }

  // CDN 鉴权头候选：cdn.authKey/authValue、headers 对象、或 auth 字段。
  const cdn = data && (data.cdn || {})
  const authKey = pick(cdn, ['authKey', 'header', 'key'], pick(data, ['authKey'], ''))
  const authValue = pick(cdn, ['authValue', 'headerValue', 'value'], pick(data, ['authValue'], ''))
  const extra = {}
  if (authKey && authValue) extra[String(authKey)] = String(authValue)
  if (data && data.headers && typeof data.headers === 'object') Object.assign(extra, data.headers)

  return { m3u8: String(m3u8), headers: { ...cfg.headers, ...extra }, proxyUrl: cfg.proxyUrl }
}

module.exports = { pick, unwrap, list, detail, playback }
