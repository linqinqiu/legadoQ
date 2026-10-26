import fs from 'node:fs'
import path from 'node:path'

/**
 * `/next` 挂载门禁 —— 新骨架前端由 1234 这台服务同端口提供，不开第二个端口。
 *
 * 为什么必须同端口：这台服务不设身份，写操作唯一的门是"Origin 的主机+端口 == Host"
 * （`Guard.kt`）。前端换端口就得放宽闸门或加代理，两条都比多一个静态目录贵。
 *
 * 这条门禁全程不打浏览器：它验的是**服务端返回的字节**与**已构建的 SW**。
 * 之所以要专门盯 SW —— 旧界面注册了 `navigateFallback: '/index.html'` 的服务端推送缓存，
 * 放行名单里若没有 `/next`，装了旧 SW 的浏览器会把对 `/next/` 的导航用**旧界面**回答，
 * 看起来就是"挂载没生效"，而服务端 curl 一切正常（AGENTS §5 里那条 SW 陷阱的同一形状）。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')
const SW = path.join(ROOT, 'web/dist/sw.js')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const bundleOf = html => (html.match(/assets\/[\w.-]+\.js/g) ?? []).join(',')

const head = await fetch(`${BASE}/next/`).catch(error => {
  // 服务没起来时要给一句人话，而不是把 fetch 的堆栈甩出来（AGENTS §3：红的是探针还是产品，得一眼分得清）
  console.log(`FAIL  服务没在 ${BASE} 上应答：${error.message}\n     先起服务再跑这条门禁（LEGADO_BASE_URL 可指到别的端口）`)
  process.exit(1)
})
const nextHtml = await head.text()
check('/next/ 返回 200 与 HTML', head.status === 200 && head.headers.get('content-type')?.includes('text/html'),
  `${head.status} ${head.headers.get('content-type')}`)
check('/next/ 的资源地址带 /next/ 前缀（构建时 base 没写错）',
  /"\/next\/assets\//.test(nextHtml) || /src="\/next\/assets\//.test(nextHtml), bundleOf(nextHtml))
check('/next/ 的 index 是 no-cache（不带哈希，缓存住就拿不到新 bundle）',
  /no-store/.test(head.headers.get('cache-control') ?? ''), head.headers.get('cache-control') ?? '(无)')

const asset = nextHtml.match(/\/next\/assets\/[\w.-]+\.js/)?.[0]
if (!asset) throw new Error('/next/ 的 HTML 里找不到入口 bundle，后面的判据都是空判')
const assetHead = await fetch(BASE + asset)
check('/next 的入口 bundle 能取到', assetHead.status === 200 && (await assetHead.text()).length > 1000,
  `${asset} → ${assetHead.status}`)

const redirect = await fetch(`${BASE}/next`, { redirect: 'manual' })
check('/next（无斜杠）跳到 /next/', [301, 302, 307, 308].includes(redirect.status) &&
  (redirect.headers.get('location') ?? '').endsWith('/next/'), `${redirect.status} → ${redirect.headers.get('location')}`)
check('/next 下不存在的东西就是 404（不摆假页面）', (await fetch(`${BASE}/next/__no_such__.js`)).status === 404)

const oldHtml = await (await fetch(`${BASE}/`)).text()
const oldBundle = bundleOf(oldHtml)
const nextBundle = bundleOf(nextHtml)
check('/next 与旧界面是两份不同的产物（不是同一张 shell 换个地址）',
  nextBundle.length > 0 && oldBundle.length > 0 && !nextBundle.split(',').some(name => oldBundle.includes(name)),
  `旧 ${oldBundle} · 新 ${nextBundle}`)
check('旧界面照旧在 /（书库那页不许被新骨架顶掉）', oldHtml.includes('/assets/') && head.status === 200)

/**
 * SW 的放行名单。反向对照在这里：把取出来的正则当场跑一遍，
 * 它必须命中 `/next/` 与 `/next`，且**不许**命中 `/nothing`（命中了就是把整个站放掉了）。
 */
const swText = fs.existsSync(SW) ? fs.readFileSync(SW, 'utf8') : ''
check('已构建的 sw.js 存在（前端没构建就谈放行名单是空的）', swText.length > 0, SW)
const denySource = swText.match(/denylist:\s*(\[[^\]]*\])/)?.[1] ?? ''
const patterns = [...denySource.matchAll(/\/\^.*?(?<!\\)\/[gimsuy]*/g)].map(match => match[0])
check('sw.js 的导航放行名单里有 /next', patterns.some(source => source.includes('next')), patterns.join(' '))
const compiled = patterns.map(source => new RegExp(source.slice(1, source.lastIndexOf('/')), source.slice(source.lastIndexOf('/') + 1)))
check('放行名单真的匹配 /next/ 与 /next（当场跑一遍，不是看字符串）',
  compiled.some(re => re.test('/next/')) && compiled.some(re => re.test('/next')),
  `共 ${compiled.length} 条：${patterns.join(' ')}`)
check('反向对照：放行名单不许把整个站放掉（/nothing 必须不命中）',
  !compiled.some(re => re.test('/nothing')),
  '/nothing 命中数 ' + compiled.filter(re => re.test('/nothing')).length)

const failed = results.filter(row => !row.ok).length
console.log(`\n${results.length - failed}/${results.length} PASS（服务 ${BASE}）`)
process.exitCode = failed > 0 ? 1 : 0
