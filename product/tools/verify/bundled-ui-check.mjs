// 交付一致性门禁：jar 里的前端 == web/dist == 运行实例在发的前端。
//
// 来历：2026-10-26 那次"重启了但界面还是旧的"。跑着的 `legado-0.8.6-all.jar` 是 01:25 的，
// `web/dist` 是 08:40 的，两者都叫 0.8.6，`/healthz` 也报 0.8.6 —— 从版本号上**完全看不出**
// 部署漂移，只有把包里的 `static/index.html` 解出来比对 bundle 文件名才看得出来。
// 这条门禁就是把那次手工解包对比固化下来：dist、resources、jar、运行实例的全部 static
// 文件逐个比 SHA-256，不一致就红，并直接给出修复命令。
//
// 只读，不写任何文件。跑法：node tools/verify/bundled-ui-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ROOT } from './env.mjs'
// 与 start.mjs / make-cds.mjs 共用同一份"该跑哪个包、构建指纹是什么、怎么读包内条目"的判断：
// 各写一遍的话，门禁绿而实际跑的是另一个包。
import {
  bundleAssetName,
  declaredVersion,
  hashStaticDirectory,
  newestFatJar,
  readJarStaticHashes,
  staticHashDifferences,
} from '../../scripts/runtime.mjs'

const DIST_INDEX = path.join(ROOT, 'web/dist/index.html')
const RESOURCES_INDEX = path.join(ROOT, 'app/build/resources/main/static/index.html')
const LIBS = path.join(ROOT, 'app/build/libs')
const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')

const results = []
const record = (name, state, detail = '') => results.push({ name, state, detail })

/** Vite 给主 bundle 起的名字就是内容哈希，取它当指纹。 */
const fingerprint = bundleAssetName

if (!fs.existsSync(DIST_INDEX)) {
  // 缺 index.html 说明"根本没有前端可比"，不是"这条门禁不适用"。原来这里退出码 0，
  // 结果一份构建到一半的 dist（只剩 sw.js / 图标）也能让整条链全绿 —— 见 dist-check.mjs 的来历。
  console.log('FAIL  web/dist/index.html   [没有前端产物：先跑 npm --prefix web run build]')
  console.log('\n1 项失败 —— 没有可比对的界面产物。')
  process.exit(1)
}

const dist = fingerprint(fs.readFileSync(DIST_INDEX, 'utf8'))
const distHashes = hashStaticDirectory(path.dirname(DIST_INDEX))
record('web/dist 里有主 bundle', !!dist, dist || 'index.html 里找不到 assets/index-*.js')

const resourcesDirectory = path.join(ROOT, 'app/build/resources/main/static')
if (fs.existsSync(RESOURCES_INDEX)) {
  const differences = staticHashDifferences(distHashes, hashStaticDirectory(resourcesDirectory))
  const count = differences.missing.length + differences.changed.length + differences.extra.length
  record('processResources 全部静态文件与 dist 一致', count === 0,
    count ? `缺失=${differences.missing.join(',')} 变化=${differences.changed.join(',')} 多余=${differences.extra.join(',')}` : `${Object.keys(distHashes).length} 个文件`)
} else {
  record('processResources 产物', 'skip', '还没跑过 :app:processResources')
}

const jar = newestFatJar(LIBS)
if (!jar) {
  // "没有可运行包"不是"这条门禁不适用"：dist 都已经在了，却没有 *-all.jar，
  // 说明交付链断了（fatJar 没执行 / 版本改过没重打）。原来的 skip 会让这种断链保持绿灯。
  const want = declaredVersion()
  const have = fs.existsSync(LIBS) ? fs.readdirSync(LIBS).filter((n) => n.endsWith('-all.jar')).join(', ') : '(目录不存在)'
  record('fatJar', false, want
    ? `没有 legado-${want}-all.jar；libs 里现有：${have || '（空）'} —— 重跑 npm run build`
    : 'app/build/libs 里没有 *-all.jar —— fatJar 没产出可运行包')
} else {
  const jarHashes = readJarStaticHashes(path.join(LIBS, jar))
  const differences = staticHashDifferences(distHashes, jarHashes)
  const count = differences.missing.length + differences.changed.length + differences.extra.length
  record(`fatJar（${jar}）全部静态文件与 dist 一致`, count === 0,
    jarHashes
      ? count
        ? `缺失=${differences.missing.join(',')} 变化=${differences.changed.join(',')} 多余=${differences.extra.join(',')}`
        : `${Object.keys(distHashes).length} 个文件`
      : '读不到包内 static/，按失败处理')
}

/**
 * 带超时地取一次 URL，并且**一定**把定时器收掉。
 *
 * 不能用 `AbortSignal.timeout()`：它留下的定时器会在 `process.exit()` 时撞上 libuv 的
 * handle 收尾，Windows 上直接
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:94`
 * —— 五项判据全 PASS 也会因此判红（本轮实测踩到）。所以自己建 controller，finally 里清定时器。
 */
async function timed(url, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

if (process.env.LEGADO_SKIP_LIVE_UI_CHECK === '1') {
  record('运行中的实例', 'skip', '自动构建期间跳过 live 检查，避免旧实例阻止重建')
} else {
  try {
    const html = await timed(`${BASE}/`, 3000).then((r) => r.text())
    const live = fingerprint(html)
    record('运行中的实例 HTML 有主 bundle', !!live, live || 'index.html 里找不到 assets/index-*.js')
    if (live) record('运行中的实例与 dist 一致', live === dist, `dist=${dist} 运行中=${live}`)

    // 名字对上了仍可能 404 或内容损坏，所以逐个取 dist 里的文件并比对哈希。
    if (live) {
      const mismatches = []
      for (const file of Object.keys(distHashes).sort()) {
        try {
          const response = await timed(`${BASE}/${file}`, 5000)
          if (response.status !== 200) {
            mismatches.push(`${file}:http=${response.status}`)
            continue
          }
          const hash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')
          if (hash !== distHashes[file]) mismatches.push(`${file}:hash`)
        } catch {
          mismatches.push(`${file}:unreachable`)
        }
      }
      record('运行中的实例全部静态文件与 dist 一致', mismatches.length === 0,
        mismatches.length ? mismatches.join(', ') : `${Object.keys(distHashes).length} 个文件`)
    }
  } catch {
    record('运行中的实例', 'skip', `${BASE} 没在跑（这条只在校验已部署实例时才看）`)
  }
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
// 不要用 `process.exit()`：socket 还没收干净就硬退，Windows 上 libuv 会
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:94`，
// 于是"5 项全通过"变成一次崩溃 —— 判据红得没道理。设 exitCode，让事件循环自己排空。
process.exitCode = failed ? 1 : 0
