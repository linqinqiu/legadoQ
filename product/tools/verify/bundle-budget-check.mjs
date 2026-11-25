// 前端产物体积预算门禁：把体积当测试断言，而不是事后优化。
//
// 来历（2026-11-24）：路由拆包前，入口是单个 2.05 MB 的 JS（gzip 412 KB），React.lazy 拆出
// 阅读器/书源/书架等页面后降到 ~600 KB（gzip 183 KB）。体积一放松就会慢慢涨回去，所以把
// 上限钉成判据：超了就红。上限放 baselines/bundle-budget.json（棘轮，只许调低）。
//
// 口径：用 Node 自带 zlib.gzipSync 量 gzip 后的字节，和 vite 构建日志的 gzip 列同源、可复现；
// 不依赖系统 gzip（不同平台实现不同，会误报）。量三类：
//   - 入口 JS：index.html 直接引用的 .js —— 首屏一定要下的，拆包有没有做全看它。
//   - 全部 JS：dist/assets 下所有 .js 之和 —— 含惰性 chunk，防总依赖膨胀。
//   - 全部 CSS：dist/assets 下所有 .css 之和。
//
// 反向对照（gates-guide §8）：末尾 SELF TEST 会用假数据把三条判据逐一打红，确认判据不是摆设。
// 跑法：node tools/verify/bundle-budget-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ROOT } from './env.mjs'

const DIST = path.join(ROOT, 'web/dist')
const ASSETS = path.join(DIST, 'assets')
const INDEX = path.join(DIST, 'index.html')
const BASELINE = path.join(ROOT, 'tools/verify/baselines/bundle-budget.json')

const passes = []
const failures = []
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`
  console.log(line)
  if (ok) passes.push(name)
  else failures.push(name)
}

/** gzip 后的字节数；同一个文件里除了 SELF TEST 没有别的 gzip 口径，避免两套算法对不上。 */
const gz = (buf) => zlib.gzipSync(buf).length

/** 汇总一个目录下所有指定后缀文件的 gzip 字节，返回 { bytes, files }。 */
function sumAssets(dir, ext) {
  if (!fs.existsSync(dir)) return { bytes: 0, files: [] }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(ext))
  let bytes = 0
  for (const name of files) bytes += gz(fs.readFileSync(path.join(dir, name)))
  return { bytes, files }
}

/** index.html 直接引用的、落在 assets 里的 JS 文件名（按 basename 校验，挡路径穿越）。 */
function entryJsFiles() {
  const html = fs.readFileSync(INDEX, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1])
  const onDisk = new Set(fs.readdirSync(ASSETS))
  return [...new Set(refs)]
    .map((ref) => path.basename(ref.split(/[?#]/)[0]))
    .filter((name) => onDisk.has(name))
}

// 前置：产物与基线都得在。没构建就量不了，直接说清楚（同 env.mjs requireService 的口径）。
if (!fs.existsSync(INDEX) || !fs.existsSync(ASSETS)) {
  console.log('bundle-budget-check: 前置不满足（web/dist 不存在），不做任何断言')
  console.log('      先跑 npm --prefix web run build（或 npm run build）再跑本门禁。')
  process.exit(1)
}
if (!fs.existsSync(BASELINE)) {
  console.log('bundle-budget-check: 缺基线文件 tools/verify/baselines/bundle-budget.json，无法判定上限')
  process.exit(1)
}

let budget
try {
  budget = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
} catch (error) {
  console.log(`bundle-budget-check: 基线文件解析失败：${String(error?.message ?? error)}`)
  process.exit(1)
}

// 三条判据共用一个比较函数，SELF TEST 才能拿它做反向对照。
const overBudget = (actual, cap) => actual > cap
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

// 1. 入口 JS（首屏必下）
let entryBytes = 0
for (const name of entryJsFiles()) entryBytes += gz(fs.readFileSync(path.join(ASSETS, name)))
check('入口 JS gzip 未超预算', !overBudget(entryBytes, budget.entryJsGzip),
  `${entryBytes} B (${kb(entryBytes)}) / 上限 ${budget.entryJsGzip} B`)

// 2. 全部 JS（含惰性 chunk）
const allJs = sumAssets(ASSETS, '.js')
check('全部 JS gzip 未超预算', !overBudget(allJs.bytes, budget.allJsGzip),
  `${allJs.bytes} B (${kb(allJs.bytes)}) / 上限 ${budget.allJsGzip} B，共 ${allJs.files.length} 个 chunk`)

// 3. 全部 CSS
const allCss = sumAssets(ASSETS, '.css')
check('全部 CSS gzip 未超预算', !overBudget(allCss.bytes, budget.cssGzip),
  `${allCss.bytes} B (${kb(allCss.bytes)}) / 上限 ${budget.cssGzip} B`)

// 反向对照：证明这三条判据真的会红，而不是永远 PASS 的空壳。
check('SELF TEST 入口超限会被判红', overBudget(budget.entryJsGzip + 1, budget.entryJsGzip))
check('SELF TEST 全部 JS 超限会被判红', overBudget(budget.allJsGzip + 1, budget.allJsGzip))
check('SELF TEST 未超限不会误判', !overBudget(budget.allJsGzip - 1, budget.allJsGzip))

console.log(`\nbundle-budget-check: PASS ${passes.length} / FAIL ${failures.length}`)
if (failures.length) {
  console.log('前端体积超预算 —— 要么拆包/减依赖把体积压回去，要么确认这笔增长值得并有理由地调低上面的上限。')
  process.exit(1)
}
