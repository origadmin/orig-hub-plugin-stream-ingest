'use strict'
/**
 * 配置层 —— 主页地址（baseUrl）只从「用户数据目录」读取，包内不含任何默认站点地址。
 *
 * 硬约束（M1 / M3 / M6）：
 *  - 包内 `defaults` 的 baseUrl 恒为空字符串；任何非空都视为违规。
 *  - 用户手动输入的值只写到 ORIG_PLUGIN_DATA_DIR（进程外、不进版本库）。
 *  - 路径模板是通用 REST 形状 + 占位符 {id}/{ep}，不含具体站点专有路径。
 *  - **代理不属于插件私有配置**：代理值由 hub 统一持有，daemon 在 spawn 时
 *    注入 ORIG_PLUGIN_PROXY / ORIG_PLUGIN_PROXY_SOURCE；这里只读注入值。
 *    插件内不得再有 proxyUrl 字段或表单，否则就是「注册支持」的反面。
 */
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PATHS = Object.freeze({
  list: '/api/home/latest',
  detail: '/api/videos/{id}',
  playback: '/api/videos/{id}/episodes/{ep}/playback',
})

function dataDir() {
  return process.env.ORIG_PLUGIN_DATA_DIR || path.join(__dirname, '..', '.stream-ingest-data')
}

function configPath() {
  return path.join(dataDir(), 'config.json')
}

/**
 * daemon 注入的出网代理（M6）：空 = 直连。
 * 这是插件获取代理地址的**唯一入口**；不读 config.json、不猜默认端口。
 */
function proxy() {
  return (process.env.ORIG_PLUGIN_PROXY || '').trim()
}

/** daemon 注入的代理来源标签（仅用于日志/自检，不参与取值）。 */
function proxySource() {
  return (process.env.ORIG_PLUGIN_PROXY_SOURCE || '').trim() || null
}

/** 包内默认值：baseUrl 必须为空（脱敏断言用）；不含 proxyUrl（M6）。 */
function defaults() {
  return { baseUrl: '', paths: { ...DEFAULT_PATHS }, headers: {}, outputDir: '' }
}

/** 扁平键（UI form 用点号 key）→ 嵌套 config。 */
function flatten(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    'paths.list': cfg.paths.list,
    'paths.detail': cfg.paths.detail,
    'paths.playback': cfg.paths.playback,
  }
}

/** 接收 form 提交（扁平点号键）→ 规范化嵌套 config。 */
function fromFlat(flat) {
  const prev = load()
  const get = (k, fallback) => (flat[k] === undefined || flat[k] === null || flat[k] === '' ? fallback : String(flat[k]))
  return {
    baseUrl: get('baseUrl', prev.baseUrl).trim().replace(/\/+$/, ''),
    paths: {
      list: get('paths.list', prev.paths.list),
      detail: get('paths.detail', prev.paths.detail),
      playback: get('paths.playback', prev.paths.playback),
    },
    headers: prev.headers || {},
    outputDir: prev.outputDir || '',
  }
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      paths: { ...DEFAULT_PATHS, ...(parsed.paths || {}) },
      headers: parsed.headers && typeof parsed.headers === 'object' ? parsed.headers : {},
      outputDir: typeof parsed.outputDir === 'string' ? parsed.outputDir : '',
    }
  } catch {
    return defaults()
  }
}

function save(cfg) {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

/** 主页地址是否已由用户配置。 */
function isConfigured(cfg = load()) {
  return /^https?:\/\//i.test(cfg.baseUrl)
}

/** 拼占位符路径：tpl.replace('{id}', id).replace('{ep}', ep)；安全编码参数。 */
function renderPath(tpl, { id, ep } = {}) {
  let out = String(tpl || '')
  if (id !== undefined) out = out.replace(/\{id\}/g, encodeURIComponent(String(id)))
  if (ep !== undefined) out = out.replace(/\{ep\}/g, encodeURIComponent(String(ep)))
  return out
}

module.exports = {
  DEFAULT_PATHS, dataDir, configPath, proxy, proxySource,
  defaults, flatten, fromFlat, load, save, isConfigured, renderPath,
}
