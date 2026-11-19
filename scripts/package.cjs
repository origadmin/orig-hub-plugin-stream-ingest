'use strict'
/**
 * 把插件目录打成 `stream-ingest.ohplug`（zip）。
 * 零 npm 依赖：Unix 用系统 zip，Windows 用 PowerShell Compress-Archive。
 * 打包条目：plugin.toml + capabilities/ + ui/ + server.js + lib/ + README.md。
 * 注意：绝不打包 `.stream-ingest-data/`（运行期用户输入，含 baseUrl，属 M3 脱敏边界）。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'stream-ingest.ohplug')
const entries = ['plugin.toml', 'capabilities', 'ui', 'server.js', 'lib', 'README.md']

function zipUnix() {
  execFileSync('zip', ['-r', '-q', OUT, ...entries], { cwd: ROOT, stdio: 'inherit' })
}
function zipWindows() {
  const TMP = path.join(ROOT, 'stream-ingest.zip')
  for (const f of [TMP, OUT]) if (fs.existsSync(f)) fs.rmSync(f, { force: true })
  const quote = (p) => `'${p.replace(/'/g, "''")}'`
  const src = entries.map((e) => quote(path.join(ROOT, e))).join(',')
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Force -LiteralPath ${src} -DestinationPath ${quote(TMP)}`], { stdio: 'inherit' })
  fs.renameSync(TMP, OUT)
}

try {
  if (process.platform === 'win32') zipWindows()
  else zipUnix()
  console.log('packaged ->', OUT)
} catch (e) {
  console.error('package failed:', e.message)
  process.exit(1)
}
