// 交付一致性门禁：jar 里的前端 == web/dist == 运行实例在发的前端。
//
// 来历：2026-10-26 那次"重启了但界面还是旧的"。跑着的 `legado-0.8.6-all.jar` 是 01:25 的，
// `web/dist` 是 08:40 的，两者都叫 0.8.6，`/healthz` 也报 0.8.6 —— 从版本号上**完全看不出**
// 部署漂移，只有把包里的 `static/index.html` 解出来比对 bundle 文件名才看得出来。
// 这条门禁就是把那次手工解包对比固化下来：不一致就红，并直接给出修复命令。
//
// 只读，不写任何文件。跑法：node tools/verify/bundled-ui-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT } from './env.mjs'
// 与 start.mjs / make-cds.mjs 共用同一份"该跑哪个包、构建指纹是什么"的判断：
// 三处各写一遍的话，门禁绿而实际跑的是另一个包。
import { bundleAssetName, newestFatJar } from '../../scripts/runtime.mjs'

const DIST_INDEX = path.join(ROOT, 'web/dist/index.html')
const RESOURCES_INDEX = path.join(ROOT, 'app/build/resources/main/static/index.html')
const LIBS = path.join(ROOT, 'app/build/libs')
const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')

const results = []
const record = (name, state, detail = '') => results.push({ name, state, detail })

/** Vite 给主 bundle 起的名字就是内容哈希，取它当指纹。 */
const fingerprint = bundleAssetName

/**
 * 读出 jar 里的 `static/index.html`。
 *
 * 不引第三方 zip 库：Windows 走自带的 .NET，类 Unix 走 `unzip`，两条都不在就跳过这一格
 * （跳过会打印出来，不会假装通过）。
 */
function indexFromJar(jarPath) {
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${jarPath.replace(/'/g, "''")}');` +
      `$e=$z.Entries | Where-Object { $_.FullName -replace '\\\\','/' -eq 'static/index.html' };` +
      `$s=New-Object System.IO.StreamReader($e.Open());$s.ReadToEnd();$s.Close();$z.Dispose()`
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 24 })
  }
  try {
    return execFileSync('unzip', ['-p', jarPath, 'static/index.html'], { encoding: 'utf8', maxBuffer: 1 << 24 })
  } catch {
    return null
  }
}

if (!fs.existsSync(DIST_INDEX)) {
  console.log('bundled-ui-check: 前置不满足 —— 没有 web/dist/index.html（先跑 npm --prefix web run build），跳过断言')
  process.exit(0)
}

const dist = fingerprint(fs.readFileSync(DIST_INDEX, 'utf8'))
record('web/dist 里有主 bundle', !!dist, dist || 'index.html 里找不到 assets/index-*.js')

if (fs.existsSync(RESOURCES_INDEX)) {
  const built = fingerprint(fs.readFileSync(RESOURCES_INDEX, 'utf8'))
  record('processResources 产物与 dist 一致', built === dist, `dist=${dist} resources=${built || '(读不到)'}`)
} else {
  record('processResources 产物', 'skip', '还没跑过 :app:processResources')
}

const jar = newestFatJar(LIBS)
if (!jar) {
  record('fatJar', 'skip', 'app/build/libs 里没有 *-all.jar（还没打过分发包）')
} else {
  let inside = null
  try {
    inside = fingerprint(indexFromJar(path.join(LIBS, jar)) || '')
  } catch (error) {
    record('fatJar 内前端', 'skip', `读不出包内 static/index.html：${error instanceof Error ? error.message.split('\n')[0] : error}`)
    inside = ''
  }
  if (inside !== null && inside !== '') record(`fatJar（${jar}）内前端与 dist 一致`, inside === dist, `dist=${dist} jar=${inside}`)
  else if (inside === '') record('fatJar 内前端', 'skip', '包里没有 static/index.html 或工具不可用')
}

try {
  const html = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.text())
  const live = fingerprint(html)
  if (live) record('运行中的实例与 dist 一致', live === dist, `dist=${dist} 运行中=${live}`)
} catch {
  record('运行中的实例', 'skip', `${BASE} 没在跑（这条只在校验已部署实例时才看）`)
}

let failed = 0
for (const r of results) {
  const mark = r.state === true ? 'PASS' : r.state === 'skip' ? 'SKIP' : 'FAIL'
  if (mark === 'FAIL') failed++
  console.log(`${mark}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
if (failed) {
  console.log(`\n${failed} 项不一致 —— 界面跑的不是当前源码。修复（顺序不能反）：`)
  console.log('  node stop.mjs && npm run build && node start.mjs')
}
console.log(`\n${results.length - failed} 项通过 / ${failed} 项失败`)
process.exit(failed ? 1 : 0)
