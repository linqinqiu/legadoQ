import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, launchOptions } from './env.mjs'

/**
 * `/next` 真渲染门禁 —— 用无头浏览器把整合包里的新骨架跑一遍。
 *
 * `next-mount-check.mjs` 判的是服务端返回的字节；这条判的是**浏览器拿到那些字节之后**
 * 到底画出了什么。两者盯的不是同一个坑：字节全对但界面空白，在这个项目里发生过不止一次
 * （资源前缀写错、portal 取不到主题变量、离线副本把请求兜住）。
 * 尤其现在多了 `/next` 这一格：base 前缀、SW 放行名单、同源闸门三处任一没对上，
 * 界面都会安静地停在"什么都没取到"上。
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errors = []
page.on('pageerror', error => errors.push(String(error.message ?? error)))
const failedRequests = []
page.on('requestfailed', request => failedRequests.push(`${request.url()} ${request.failure()?.errorText}`))

/** 等到某个选择器出现，最多等 ms 毫秒；不等固定秒数（固定 sleep 在冷 JVM 上必然假红）。 */
const waitFor = async (selector, ms = 25_000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await page.$(selector)) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

await page.goto(`${BASE}/next/`, { waitUntil: 'domcontentloaded', timeout: 40_000 })
const scriptSrc = await page.$eval('script[type="module"]', node => node.getAttribute('src'))
check('浏览器停在 /next 上，加载的是新骨架自己的 bundle（不是 SW 拿旧界面顶包）',
  /^\/next\/assets\/[\w.-]+\.js$/.test(scriptSrc ?? ''), `${BASE}${scriptSrc}`)
check('外壳画出来了：顶栏 + 一级导航', await waitFor('.app-shell') && (await page.$$('.shell-nav button')).length === 8,
  `${(await page.$$('.shell-nav button')).length} 个入口`)

const metaText = async () => (await page.$eval('.page-header .page-header-meta', node => node.textContent?.trim()).catch(() => '')) ?? ''
// 默认落在书架（A 网格原型）：先证明"接的是真数据"，再证明三种原型都拼得起来
check('A 网格原型：书架卡片按网格排（不是塌成一堵墙）', await waitFor('.grid-cards .card') &&
  (await page.$eval('.grid-cards', node => getComputedStyle(node).display)) === 'grid',
  await metaText())
const columns = await page.$eval('.grid-cards', node => getComputedStyle(node).gridTemplateColumns.split(' ').length)
check('网格真的多列', columns > 3, `${columns} 列`)

/**
 * 换页只能点导航：入口读 hash 只在挂载那一次，没有 hashchange 监听，
 * 所以 `location.hash = 'sources'` 会把地址改了而页面纹丝不动（探针第一次就是这么空的）。
 */
const gotoPage = label => page.evaluate(name => {
  [...document.querySelectorAll('.shell-nav button')].find(node => node.textContent?.includes(name))?.click()
}, label)

await gotoPage('书源')
await waitFor('.md-list .row')
const rows = (await page.$$('.md-list .row')).length
const sourcesMeta = await metaText()
const total = Number((sourcesMeta.match(/(\d+)\s*\/\s*(\d+)/) ?? [])[2] ?? 0)
check('B 主从原型：书源列表真的取回来了（走 /next 下的同源接口）', rows > 0 && total > 1000,
  `${rows} 行 · ${sourcesMeta || '(页头没数)'}`)
check('列表里那一行有名字与分组（不是 undefined 占位）', await page.$eval('.md-list .row .row-title',
  node => (node.textContent ?? '').trim().length > 1 && !/undefined/.test(node.textContent ?? '')))

/**
 * ── 详情栏不许是空面板（用户 2026-10-04 指出：没选中源时这里只有一行灰字）──
 *
 * 原来那条"点一行，详情面板跟着换"很弱：默认态只要有个 h2 就算过，所以把它换成
 * 下面这几条真判据 —— 默认是源库概况、概况那几行**点得动且真的在筛**、点一行之后详情
 * 说的是这一个源、启停那颗键**真的写进服务端**。
 * 顺序有讲究：概况那一段必须在"点行之前"跑，点过一次之后界面就进入单源详情了（第一版就栽在这）。
 * 启停只翻一条**探针源**（名字以 000 起头，服务端按名称排序时它就在第一行），不碰用户真库里的源，
 * 并且收尾放在 finally 里 —— 中途崩了也不能把探针留在库里。
 */
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)
const PROBE = { id: `https://000probe-next-${STAMP}.example`, name: `000新骨架探针 ${STAMP}` }
const detailTitle = () => page.$eval('.md-detail h2', node => (node.textContent ?? '').trim()).catch(() => '(没有标题)')
const metaNumerator = async () => Number(((await metaText()).match(/(\d+)\s*\//) ?? [])[1] ?? -1)
const clickOverviewRow = needle => page.evaluate(text => {
  [...document.querySelectorAll('.md-detail .detail-rows .ctl-row')]
    .find(node => node.textContent?.includes(text))?.click()
}, needle)
const enabledOf = id => page.evaluate(async target => (await (await fetch('/api/sources')).json())
  .find(item => item.id === target)?.enabled ?? null, id)

const overviewRows = await page.$$('.md-detail .detail-rows .ctl-row')
check('默认详情是源库概况，且有可点的档位行（不许是一行灰字占满一张卡）',
  (await detailTitle()) === '源库概况' && overviewRows.length >= 2, `${overviewRows.length} 行 · 标题「${await detailTitle()}」`)
const loginCount = await page.evaluate(() => fetch('/api/sources').then(r => r.json()).then(list => list.filter(s => s.hasLogin).length))
await clickOverviewRow('需要登录')
await new Promise(resolve => setTimeout(resolve, 400))
const filteredCount = await metaNumerator()
check('概况那一行真的在筛这一档（页头分子要对得上接口的 hasLogin 数）',
  filteredCount === loginCount && loginCount > 0, `页头 ${filteredCount} · 接口 ${loginCount}`)
await clickOverviewRow('全部源')
await new Promise(resolve => setTimeout(resolve, 400))
check('再点一次「全部源」把这一档松开（点一次是筛，再点一次是回全量）',
  await metaNumerator() === total, `页头 ${await metaNumerator()} / ${total}`)

try {
  const probeUp = await page.evaluate(async id => {
    const response = await fetch('/api/sources/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [JSON.stringify({ bookSourceUrl: id, bookSourceName: `000新骨架探针 ${id.slice(-6)}`, enabled: true })] }),
    })
    return response.status
  }, PROBE.id)
  check('探针源建得出来（POST /api/sources/import，收尾会删）', probeUp === 200, `HTTP ${probeUp}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await gotoPage('书源')
  await waitFor('.md-list .row')
  const probeTitle = await page.$eval('.md-list .row .row-title', node => (node.textContent ?? '').trim())
  await page.click('.md-list .row')
  check('点一行，详情说的就是这一个源（标题必须等于那一行的名字，也不是"源库概况"）',
    (await detailTitle()) === probeTitle && probeTitle !== '源库概况', `行「${probeTitle}」· 详情「${await detailTitle()}」`)
  const fields = await page.$$eval('.md-detail .detail-fields dd', nodes => nodes.map(node => node.textContent?.trim()))
  check('详情里的字段是真值（五档且没有 undefined 混进去）',
    fields.length >= 5 && !fields.some(value => /undefined|null|NaN/.test(value ?? '')), fields.join(' / '))
  const before = await enabledOf(PROBE.id)
  await page.click('.md-detail .detail-actions .ctl-button')
  await new Promise(resolve => setTimeout(resolve, 900))
  const after = await enabledOf(PROBE.id)
  const notice = await page.$eval('.md-detail .detail-notice', node => (node.textContent ?? '').trim()).catch(() => '')
  check('详情里那颗启停键真的写进服务端（不是只改了界面）',
    before === true && after === false && notice.includes('停用'), `接口 ${before} → ${after} · 界面「${notice}」`)
  await page.click('.md-detail .detail-actions .ctl-button')
  await new Promise(resolve => setTimeout(resolve, 900))
  check('再点一次换回来（这一档必须可逆）', (await enabledOf(PROBE.id)) === true, `接口 ${(await enabledOf(PROBE.id))}`)
} finally {
  const cleaned = await page.evaluate(async () => {
    const ids = (await (await fetch('/api/sources')).json()).filter(item => item.id.includes('probe-next-')).map(item => item.id)
    if (ids.length) await fetch('/api/sources/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids }),
    })
    return { deleted: ids.length, left: (await (await fetch('/api/sources')).json()).filter(item => item.id.includes('probe-next-')).length }
  })
  check('探针源已回收（库里不再留 probe-next- 的东西）', cleaned.left === 0, `删了 ${cleaned.deleted} 条 · 残留 ${cleaned.left}`)
}

await gotoPage('设置')
await waitFor('.list-body .ctl-row')
// "靠左不限宽"要量两头的空白：居中是左右各让一半，靠左是左边只留内边距、剩下的全甩到右边。
// 只断言"成组"证明不了这件事，只比 left 与视口 left 又会把页容器自己的内边距算成漂移。
const gaps = await page.$eval('.list-body', node => {
  const box = node.getBoundingClientRect()
  const viewport = document.querySelector('.shell-viewport').getBoundingClientRect()
  return { left: Math.round(box.left - viewport.left), right: Math.round(viewport.right - box.right) }
})
check('C 清单原型：设置页成组', (await page.$$('.list-group')).length === 3,
  `${(await page.$$('.list-group')).length} 组`)
check('C 清单原型靠左不居中（左侧只留内边距，剩下的空白全在右边）',
  gaps.left < 60 && gaps.right > gaps.left * 3, `左 ${gaps.left}px · 右 ${gaps.right}px`)

await gotoPage('书源')
await waitFor('.md-list .row')
await page.evaluate(() => { [...document.querySelectorAll('.page-header button')].find(b => b.textContent?.includes('分组管理'))?.click() })
const dialogUp = await waitFor('.dialog-shell', 6000)
check('浮层：弹窗外壳只有一套且真的挂上', dialogUp && (await page.$$('.dialog-shell')).length === 1)
if (dialogUp) {
  await page.keyboard.press('Escape')
  await new Promise(resolve => setTimeout(resolve, 250))
  check('浮层：Esc 关得掉（旧版 24 个弹窗只有 8 个接了 Esc）', (await page.$$('.dialog-shell')).length === 0)
}

check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '))
check('没有取失败的资源（base 前缀错了就是这里红）', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter(row => !row.ok).length
console.log(`\n${results.length - failed}/${results.length} PASS（${BASE}/next/）`)
process.exitCode = failed > 0 ? 1 : 0
