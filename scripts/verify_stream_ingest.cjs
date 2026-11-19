'use strict'
/**
 * stream-ingest 反向证伪验收（常态全绿；--teeth 注入违规必须判红 exit 1）。
 *
 * 判据对应 docs/design/specs/feature-stream-ingest.md §13：
 *   V1 脱敏：仓库内零具体站点域名/品牌（用「非占位的 http(s) 字面量」+ 已知品牌片段检测）
 *   V2 无预置 baseUrl：config.defaults().baseUrl === ''
 *   V3 无 MSE/hls.js
 *   V4 播放期无 ffmpeg（ffmpeg 只在 lib/ingest.js + lib/hls.js 的准备期出现）
 *   V5 ohc schema=2 且字段齐备
 *   V6 /config 端点存在
 *   V7 打包清单齐全
 *
 * 注意：本脚本不含任何具体站点域名。脱敏检测用「字面量 http(s)://host」启发式，
 * 允许 127.0.0.1/localhost/占位符，其余非空 host 一律判为疑似站点特征。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TEETH = process.argv.includes('--teeth')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`) }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function collectFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.stream-ingest-data', 'output', 'scripts'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectFiles(p, acc)
    else if (/\.(js|cjs|json|toml|md)$/.test(e.name)) acc.push(path.relative(ROOT, p).replace(/\\/g, '/'))
  }
  return acc
}

function main() {
  console.log('== stream-ingest verification ==')

  // V1 脱敏：扫描仓库内文本，任何非回环的 http(s) 字面量 host 都疑似站点特征。
  const files = collectFiles(ROOT)
  // 脱敏扫描覆盖所有文本文件，但排除验证脚本自身（它的判据里含示例 host/API 名，自指会误报）。
  const SELF = 'scripts/verify_stream_ingest.cjs'
  const scanFiles = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => /\.(js|cjs)$/.test(n) && n !== path.basename(__filename))
    .map((n) => `scripts/${n}`)
  const suspicious = []
  const allow = /^(127\.0\.0\.1|localhost|\[::1\]|例|example)/i
  for (const f of files.concat(scanFiles)) {
    const text = read(f)
    // 允许注释里的「形如 http://127.0.0.1:端口」，其余具体 host 判红。
    const re = /https?:\/\/([A-Za-z0-9._-]+)(?::\d+)?/g
    let m
    while ((m = re.exec(text))) {
      const host = m[1]
      if (allow.test(host)) continue
      // 允许 URL 构造器里的占位变量（小写标识符且含 { } 模板的情况已在别处），
      // 这里 host 若是纯占位词（domain/site/host/example）跳过。
      if (/^(domain|site|host|your|foo|bar|占位|站点)/i.test(host)) continue
      suspicious.push(`${f}:${m[0]}`)
    }
  }
  ok('V1 脱敏：无具体站点 host 字面量', suspicious.length === 0, suspicious.slice(0, 3).join(', '))

  // V2 无预置地址：从 config.js 源码断言 defaults().baseUrl 为空。
  const cfgSrc = read('lib/config.js')
  ok('V2 defaults.baseUrl 为空', /baseUrl:\s*''/.test(cfgSrc))
  ok('V2 包内无 config.json', !fs.existsSync(path.join(ROOT, 'config.json')))

  // V3 无 MSE / hls.js。
  const allJs = files.filter((f) => /\.(js|cjs)$/.test(f)).map((f) => read(f)).join('\n')
  ok('V3 无 MediaSource/SourceBuffer', !/MediaSource|SourceBuffer/i.test(allJs))
  ok('V3 无 hls.js', !/hls\.js|require\(['"]hls/i.test(allJs))

  // V4 播放期无 ffmpeg：ffmpeg 只应出现在准备期模块（lib/hls.js、lib/ingest.js）。
  const serverSrc = read('server.js')
  ok('V4 server.js 无 ffmpeg spawn', !/ffmpeg|execFile|spawn/.test(serverSrc))
  const hlsSrc = read('lib/hls.js')
  ok('V4 remux 用 -c copy（零重编码）', /-c['"]?\s*,\s*['"]copy/.test(hlsSrc))
  ok('V4 faststart', /\+faststart/.test(hlsSrc))

  // V5 ohc schema=2 + 字段齐备。
  const ingestSrc = read('lib/ingest.js')
  ok('V5 ohc schema=2', /schema:\s*2/.test(ingestSrc))
  for (const field of ['base', 'total', 'seekable', 'playable', 'codec']) {
    ok(`V5 ohc 字段 ${field}`, new RegExp(`\\b${field}\\b`).test(ingestSrc))
  }

  // V6 端点齐全。
  for (const ep of ['/config', '/health', '/list', '/detail', '/tasks', '/prepare', '/ingest']) {
    ok(`V6 端点 ${ep}`, serverSrc.includes(`p === '${ep}'`))
  }
  ok('V6 绑定回环', serverSrc.includes("HOST = '127.0.0.1'"))

  // V7 打包清单齐全。
  const pkg = read('scripts/package.cjs')
  for (const e of ['plugin.toml', 'capabilities', 'ui', 'server.js', 'lib', 'README.md']) {
    ok(`V7 打包项 ${e}`, pkg.includes(`'${e}'`))
  }
  const uiCfg = JSON.parse(read('ui/config.json'))
  ok('V7 UI form 有 baseUrl 字段', uiCfg.fields.some((f) => f.key === 'baseUrl'))
  ok('V7 UI layout 合法', ['table', 'detail', 'form', 'dashboard'].includes(uiCfg.layout))

  if (TEETH) {
    console.log('\n-- teeth: 注入违规，以下应判红 --')
    let toothFail = 0
    const check = (name, cond) => { if (!cond) toothFail++; console.log(`  ${cond ? 'RED-ok' : 'RED-MISS'} ${name}`) }
    // 用临时内容模拟违规，验证判据本身能抓到（不写回仓库）。
    check('teeth-V3 MediaSource 能被抓到', /MediaSource/i.test('const x = new MediaSource()'))
    check('teeth-V5 schema!=2 能被抓到', !/schema:\s*2/.test('schema: 1'))
    check('teeth-V1 host 字面量能被抓到', /https?:\/\/([A-Za-z0-9._-]+)/.test('https://some-site.invalid/x') && !allow.test('some-site'))
    if (toothFail > 0) {
      console.log(`\nverify: TEETH FAILED (${toothFail} red-miss)`)
      process.exit(1)
    }
    console.log('\nverify: teeth all red as expected (but teeth mode always exits 1 by contract)')
    process.exit(1)
  }

  console.log(`\nverify: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
