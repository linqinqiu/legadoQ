/**
 * RSS 订阅端到端探针（打真服务，验证部署后的这条链路）：
 * 手机备份包里的 `rssSources.json` → WebDAV 导入 → `rss_source` 表 → 「订阅」页的 RSS 那张能看见能点。
 *
 * 单测（RssSubscriptionTest / BackupImportTest）只证明解压器和规则映射对；这条证明**线上部署**对：
 * 前端 bundle 已经是新的、路由真的在、启停开关真的会挡住请求、skippedSections 真的不再报 rsssources。
 * 一次性源用完必删，绝不动用户真实书源、订阅与凭据。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'
import { multipartUpload } from './multipart.mjs'
import { makeZip } from './zip-make.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const PORT = Number(new URL(BASE).port || 80)
const HOST = new URL(BASE).hostname
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()

// RSS 源主键是 sourceUrl 整串，且 `.test` 两标签即自身注册域，不会和真实域撞桶
const A_HOST = `probe-rss-a-${STAMP}.test`
const B_HOST = `probe-rss-b-${STAMP}.test`
const C_HOST = `probe-rss-c-${STAMP}.test`
const A_ID = `https://${A_HOST}/`
const B_ID = `https://${B_HOST}/`
const C_ID = `https://${C_HOST}/`
const SOURCE_BOOK = `probe-rss-booksrc-${STAMP}.test`
const SOURCE_BOOK_ID = `https://${SOURCE_BOOK}/`
const ZIP_NAME = `probe-rss-${STAMP}.zip`

let cookie = ''
let csrf = ''
let pass = 0
let fail = 0
function ok(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}

function raw(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    if (csrf) h['X-CSRF-Token'] = csrf
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json'
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    if (payload) h['content-length'] = String(payload.length)
    const req = http.request({ host: HOST, port: PORT, path: urlPath, method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json: safeJson(buf) })
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

function safeJson(buf) { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }

const rssA = { sourceUrl: A_ID, sourceName: `探针RSS甲-${STAMP}`, sourceGroup: '探针,常用', enabled: true, sortUrl: `资讯::${A_ID}news`, ruleArticles: 'div.item', ruleTitle: 'a@text', ruleLink: 'a@href' }
const rssB = { sourceUrl: B_ID, sourceName: `探针RSS乙-${STAMP}`, enabled: false, ruleArticles: 'div.item', ruleTitle: 'a@text' }
const rssC = { sourceUrl: C_ID, sourceName: `探针RSS丙-${STAMP}`, ruleTitle: 'a@text' }

async function listRss() {
  const res = await raw('GET', '/api/rss/sources')
  return res.json ?? []
}

async function main() {
  console.log(`RSS 订阅端到端探针  目标 ${BASE}  戳 ${STAMP}`)
  // 不设身份：只要服务在就能测（写操作只看 Origin，脚本不带 Origin）
  const alive = await raw('GET', '/healthz')
  if (alive.status !== 200) throw new Error('服务没在跑：' + alive.status)

  const before = await listRss()
  ok('探针开始前先读一次 RSS 列表（后面的"多出来几条"以此为准）', Array.isArray(before), `现有 ${before.length} 条`)

  const zip = makeZip([
    {
      name: 'bookSource.json',
      data: JSON.stringify([{ bookSourceUrl: SOURCE_BOOK_ID, bookSourceName: `探针RSS书源-${STAMP}`, enabled: false, ruleSearch: { bookList: '.book' } }]),
    },
    { name: 'rssSources.json', data: JSON.stringify([rssA, rssB, rssC]) },
    { name: 'readRecord.json', data: JSON.stringify([{ bookName: '探针阅读记录-' + STAMP, readTime: 100 }]) },
    { name: 'keyboardAssists.json', data: JSON.stringify([{ name: `探针按键-${STAMP}`, value: 'x' }]) },
  ])
  const upload = multipartUpload(STAMP, ZIP_NAME, zip)

  const imported = await raw('POST', '/api/backup/import', upload.body, upload.headers)
  ok('导入回报：包内 3 个 RSS 源全部新增', imported.status === 200 && imported.json?.rssSources === 3,
    `${imported.status} rssSources=${imported.json?.rssSources}`)
  const skipped = imported.json?.skippedSections ?? []
  ok('rssSources.json 不再算"承接不了的条目"', !skipped.some(name => name.includes('rsssources')), skipped.join(','))
  // 反向对照：真没承接的条目必须照旧报出来，否则上一条断言只是"整个列表都不报了"。
  // 探针造包时先用的 readRecord.json 现在已经被服务端原样收进数据目录了（#66），
  // 所以这一栏的反向对照换成 keyboardAssists.json —— 它在"只上报、不收下"那份名单里。
  ok('其它不承接的条目照旧如实上报', skipped.includes('keyboardassists.json') && !skipped.includes('readrecord.json'), skipped.join(','))
  const kept = imported.json?.keptSections ?? []
  const keptRecord = kept.find(item => String(item.name).toLowerCase() === 'readrecord.json')
  ok('阅读记录这类"没有原生界面"的条目改成原样收下并回报',
    Boolean(keptRecord) && keptRecord.label === '阅读记录' && keptRecord.items === 1 && keptRecord.bytes > 0,
    kept.map(item => `${item.name}:${item.label}:${item.items}`).join(' '))
  ok('收下的条目不算可套用的（阅读记录这边没有界面去用它）', keptRecord?.appliable === false, String(keptRecord?.appliable))

  const listed = (await listRss()).filter(item => item.sourceUrl.includes(STAMP))
  ok('三个探针源都进了表', listed.length === 3, listed.map(i => i.sourceUrl).join(','))
  const gotA = listed.find(item => item.sourceUrl === A_ID) ?? {}
  const gotC = listed.find(item => item.sourceUrl === C_ID) ?? {}
  ok('RSS 字段按上游名字取（sourceName / sourceGroup，不是书源那套）',
    gotA.name === `探针RSS甲-${STAMP}` && (gotA.group ?? '').includes('常用'), `${gotA.name} / ${gotA.group}`)
  ok('没写 ruleArticles 的源标出来，界面据此说"只能打开原页"', gotC.hasListRule === false && gotA.hasListRule === true,
    `甲=${gotA.hasListRule} 丙=${gotC.hasListRule}`)

  const again = await raw('POST', '/api/backup/import', upload.body, upload.headers)
  const afterSecond = (await listRss()).filter(item => item.sourceUrl.includes(STAMP))
  ok('重复导入按 sourceUrl 覆盖，不堆重复行',
    again.json?.rssSources === 0 && again.json?.rssSourcesUpdated === 3 && afterSecond.length === 3,
    `新增=${again.json?.rssSources} 覆盖=${again.json?.rssSourcesUpdated} 表内=${afterSecond.length}`)

  const disabledTabs = await raw('GET', `/api/rss/tabs?sourceUrl=${encodeURIComponent(B_ID)}`)
  ok('停用的源不会替它发起抓取（409 而不是照常跑）', disabledTabs.status === 409,
    `${disabledTabs.status} ${(disabledTabs.json?.code ?? '') + ' ' + (disabledTabs.json?.message ?? '')}`)

  // 反向对照：不存在与停用必须是两种回答，否则"409"可能只是查不到东西
  const missingTabs = await raw('GET', `/api/rss/tabs?sourceUrl=${encodeURIComponent('https://probe-none-' + STAMP + '.test/')}`)
  ok('不存在的源回 404，与停用的 409 分得开', missingTabs.status === 404 && disabledTabs.status === 409,
    `不存在=${missingTabs.status} 停用=${disabledTabs.status}`)

  const enabled = await raw('POST', '/api/rss/sources/enabled', { sourceUrl: B_ID, enabled: true })
  const reopened = await raw('GET', `/api/rss/tabs?sourceUrl=${encodeURIComponent(B_ID)}`)
  ok('启用开关是真开关：启用后同样地址不再是 409', enabled.status === 204 && reopened.status === 200,
    `启用=${enabled.status} 之后=${reopened.status}`)
  // 乙没配 sortUrl：上游直接拿 sourceUrl 当唯一栏目页，界面因此不会出现空页签条
  ok('没配 sortUrl 的源回落成单栏目（栏目名 = 源名）',
    reopened.json?.length === 1 && reopened.json[0].url === B_ID && reopened.json[0].title.includes('乙'),
    `${reopened.status} ${String(reopened.text).slice(0, 90)}`)
  const articles = await raw('POST', '/api/rss/articles', { sourceUrl: B_ID, url: B_ID, page: 1 })
  ok('真去取文章：不存在的域给出结构化失败而不是崩或挂住',
    articles.status === 502 && typeof articles.json?.message === 'string' && articles.json.message.length > 0,
    `${articles.status} ${String(articles.text).slice(0, 110)}`)

  const tabs = await raw('GET', `/api/rss/tabs?sourceUrl=${encodeURIComponent(A_ID)}`)
  ok('sortUrl 按发现页同一方言解析成栏目',
    tabs.status === 200 && tabs.json?.length === 1 && tabs.json[0].title === '资讯' && tabs.json[0].url === `${A_ID}news`,
    `${tabs.status} ${String(tabs.text).slice(0, 90)}`)
  const noRuleContent = await raw('POST', '/api/rss/content', { sourceUrl: A_ID, link: `${A_ID}post/1` })
  ok('没配 ruleContent 时直说"只能打开原页"',
    noRuleContent.status === 502 && /ruleContent/.test(noRuleContent.json?.message ?? ''),
    `${noRuleContent.status} ${String(noRuleContent.text).slice(0, 110)}`)

  await uiCheck()
}

/** 界面实测：订阅页要真的分成两张，RSS 那张能看见探针源、点进去有正文区的错误说明。 */
async function uiCheck() {
  const browser = await puppeteer.launch(launchOptions())
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', event => errors.push(event.message))
    await page.setViewport({ width: 1440, height: 900 })
    await page.evaluateOnNewDocument((c) => { document.cookie = c }, cookie)
    await page.goto(`${BASE}/#subscriptions`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rss-panel', { timeout: 40000 })
    // 「订阅」这一页只剩 RSS（书源订阅搬到「书源」页的一档里，见 PROPOSAL-021 §3）。
    // 页签这个类名现在**不该存在**，所以反扫用属性选择器写，避免钉一个死锚点。
    const shape = await page.evaluate(() => ({
      pageHeading: document.querySelector('.rss-page > .page-title h1')?.textContent?.trim() ?? '',
      tabs: document.querySelectorAll('[class*="subscription-tabs"]').length,
      subForm: !!document.querySelector('input[aria-label="书源订阅地址"]'),
    }))
    ok('订阅页是一张 RSS 页，没有页签、也没有书源订阅那一张',
      shape.pageHeading === '订阅' && shape.tabs === 0 && !shape.subForm, JSON.stringify(shape))

    // 这一页只发自己的那份请求，首帧不再被别处的条数预取拖延；等行出现，等不到才算失败
    await page.waitForFunction(() => document.querySelectorAll('.rss-panel .rss-source-main').length > 0, { timeout: 20000 }).catch(() => null)

    // 「只看能读的」默认是勾上的（普查：176 条里只有 65 条配了 ruleArticles）。
    // 本门禁的三条探针里有一条故意不配规则，所以先断言默认把它收掉，再取消勾选看全量。
    const hiddenByDefault = await page.$$eval('.rss-panel .rss-source-main strong', nodes => nodes
      .map(node => node.textContent.trim()))
    const hiddenProbes = hiddenByDefault.filter(name => name.includes(STAMP)).length
    ok('默认视图收掉了没配列表规则的探针源（只看能读的）', hiddenProbes === 2, `${hiddenProbes}/3 条探针可见`)
    await page.evaluate(() => document.querySelector('.rss-readable-toggle input')?.click())
    // waitForFunction 的回调在浏览器里求值，闭包不到 Node 侧的变量 —— 必须当参数传进去
    await page.waitForFunction(
      minimum => document.querySelectorAll('.rss-panel .rss-source-main').length > minimum,
      { timeout: 10000 }, hiddenByDefault.length).catch(() => null)

    const names = await page.$$eval('.rss-panel .rss-source-main strong', nodes => nodes.map(n => n.textContent.trim()))
    // 只数自己那三条：本机 RSS 表里有用户的真订阅（导入手机包后有一百多条），
    // 拿整张列表下"长度等于 3"的全称结论必然假红
    const probeNames = names.filter(name => name.includes(STAMP))
    ok('RSS 那张列出导入来的探针源', probeNames.length === 3, `${probeNames.length}/3（表内共 ${names.length} 条）`)
    const warnCount = await page.$$eval('.rss-panel article', (nodes, stamp) => nodes
      .filter(node => node.querySelector('.rss-source-main strong')?.textContent?.includes(stamp))
      .filter(node => !!node.querySelector('.rss-warn')).length, STAMP)
    ok('没写列表规则的源在界面上就说明了原因', warnCount === 1, `${warnCount} 条探针源带"没写列表规则"标记`)

    await page.screenshot({ path: path.join(SHOTS, `rss-panel-${STAMP}.png`) })

    await page.evaluate(stamp => {
      // 表里有用户导入的真订阅，只按「甲」找会撞名，必须带上探针戳
      const row = [...document.querySelectorAll('.rss-panel .rss-source-main strong')].find(n => n.textContent.includes('甲-') && n.textContent.includes(stamp))
      row?.closest('button')?.click()
    }, STAMP)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const articleHeader = await page.evaluate(() => document.querySelector('.rss-articles h2')?.textContent?.trim() ?? '')
    ok('点订阅源进入它的文章视图', articleHeader.includes('甲') && articleHeader.includes(STAMP), articleHeader)
    const message = await page.evaluate(() => document.querySelector('.rss-articles .explore-message')?.textContent?.trim() ?? '')
    ok('取不到文章时给出人话说明（.test 域本来就解析不了）', message.length > 0, message)
    await page.screenshot({ path: path.join(SHOTS, `rss-articles-${STAMP}.png`) })

    const back = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.rss-articles button')].find(b => b.textContent.includes('订阅源'))
      btn?.click()
      return !!btn
    })
    await page.waitForFunction(() => document.querySelectorAll('.rss-panel .rss-source-main').length > 0, { timeout: 20000 }).catch(() => null)
    const listAgain = await page.$$eval('.rss-panel .rss-source-main strong', nodes => nodes.map(n => n.textContent.trim()))
    // 数量为 0 时要说清是"接口失败、面板给了提示"还是"列表真的空了"：RssPanel 的实现是失败走 setNotice
    // （RssPanel.tsx:40），不会静默清空列表 —— 把那句话带进详情，下一次红就不必从头猜。
    // 顺带把详情里写死的"探针 3 条"改成真数出来的条数（原判据在这里报的是不该报的数字）。
    const listWhy = await page.evaluate(() => document.querySelector('.notice-error, .sidebar-notice')?.textContent?.trim() ?? '')
    const probeSeen = listAgain.filter(name => name.includes(STAMP)).length
    ok('能退回订阅源列表', back && probeSeen === 3,
      `退回后共 ${listAgain.length} 条、探针 ${probeSeen} 条${listWhy ? ` · 面板说：${listWhy.slice(0, 90)}` : ''}`)
    ok('界面过程没有抛未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }
}

main()
  .catch(error => { fail++; console.error('  FAIL 探针异常：', error.message) })
  .finally(async () => {
    for (const id of [A_ID, B_ID, C_ID]) {
      const del = await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(id)}`).catch(() => null)
      const left = (await listRss()).filter(item => item.sourceUrl === id)
      ok(`删掉探针 RSS 源 ${id}`, [200, 204].includes(del?.status ?? 0) && left.length === 0,
        `DELETE=${del?.status} 残留=${left.length}`)
    }
    const gone = await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(A_ID)}`)
    ok('再删一次回 404（删没删干净一目了然）', gone.status === 404, `${gone.status}`)
    await raw('DELETE', `/api/sources/${encodeURIComponent(SOURCE_BOOK_ID)}`).catch(() => {})
    const goneSource = await raw('GET', `/api/sources/${encodeURIComponent(SOURCE_BOOK_ID)}`)
    ok('探针书源已回收', goneSource.status === 404, `复查=${goneSource.status}`)
    const storageDir = path.join(ROOT, 'data', 'webdav')
    const goneZip = { status: fs.existsSync(storageDir) && fs.readdirSync(storageDir).some(name => name.includes(STAMP)) ? 200 : 404 }
    ok('探针备份包没有落盘（直传读完即删）', goneZip.status === 404, `status=${goneZip.status}`)
    const strays = (await listRss()).filter(item => item.sourceUrl.includes(STAMP))
    ok('本探针没有留下 RSS 垃圾', strays.length === 0, strays.map(i => i.sourceUrl).join(',') || '无')
    // #66 之后导入会把 readRecord.json 原样收进 data/backup_kept/ —— 探针造的条目探针自己收掉。
    // 删之前先核对内容确实是自己的夹具：用户对得上号的真实阅读记录（同名文件）绝不许被这条门禁删掉。
    const keptFile = path.join(ROOT, 'data', 'backup_kept', 'readRecord.json')
    const ownFixture = JSON.stringify([{ bookName: '探针阅读记录-' + STAMP, readTime: 100 }])
    if (fs.existsSync(keptFile)) {
      const text = fs.readFileSync(keptFile, 'utf8')
      if (text === ownFixture) fs.rmSync(keptFile)
      ok('探针收进数据目录的 readRecord.json 已回收（只删内容是自己夹具的那份）',
        !fs.existsSync(keptFile) || fs.readFileSync(keptFile, 'utf8') !== ownFixture,
        text === ownFixture ? '内容不是本探针的夹具，保留不动' : '已删除')
    } else {
      ok('探针收进数据目录的 readRecord.json 已回收', true, '数据目录里没有这个条目')
    }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    if (fail > 0) process.exitCode = 1
  })
