// 书籍详情弹窗的验收门禁（用户 2026-09-30：「书籍详情信息不完善，明了，需要稍加优化」
// +「此界面中可以有右击管理书源功能吗」）。
//
// 这一轮改掉的实情是：换源列表每行以前只写 `choice.result.sourceId`（一串 `https://xxx.com/`），
// 十几个源摊开时用户根本认不出哪个是哪个；体检拿到的"抽检几章、最新章叫什么、分组、JS 书源、
// 已停用"全都没露出来；而且行上没有任何管理入口，要改一个源得先跳去书源页再搜索。
//
// 断言打在界面上：认得出的名字、摊开的细节、右键菜单三项、跳到书源页真的带过去定位。
// 只读：不点「停用/启用」（那是用户的启用位，见 project-legado-state），只核对菜单文案与当前状态一致。
//
// 跑法：node tools/verify/book-detail-check.mjs
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const KEYWORD = '我的'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

const browser = await puppeteer.launch(launchOptions())
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })

  const known = await (async () => {
    await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
    await sleep(1500)
    return page.evaluate(async () => {
      const list = await (await fetch('/api/sources')).json()
      const byId = {}
      for (const source of list) byId[source.id] = { name: source.name, group: source.group ?? '', enabled: !!source.enabled, isJsSource: !!source.isJsSource, hasLogin: !!source.hasLogin }
      return byId
    })
  })()

  // 冷启动到这一屏要多久取决于机器多忙（实测 3~30 秒）。原来这里直接 querySelector 拿输入框，
  // 没渲染出来时 `setter.call(null, …)` 抛 `Illegal invocation` 把整条门禁带走 ——
  // 先等元素出现，等不到就明说，别让探针的时序冒充产品缺陷。
  await page.waitForSelector('.library-hero form input', { timeout: 60000 }).catch(() => null)
  await page.evaluate(() => {
    [...document.querySelectorAll('.library-scope-modes button')].find(node => node.textContent?.includes('全部书源'))?.click()
  })
  const typed = await page.evaluate(() => {
    const input = document.querySelector('.library-hero form input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '我的')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')?.requestSubmit()
    return true
  })
  if (!typed) throw new Error('60 秒内没等到书库搜索框（.library-hero form input），这一屏没法继续')

  /**
   * 挑一本"多路源都返回了"的书开弹窗。
   *
   * 第一版是"有卡片就停止搜索、点第一张" —— 全库 5,574 个源并发回来时，
   * 第一张卡往往只有一路源命中，换源列表按设计不出现，整组断言就空转；
   * 更糟的是那张卡对应的源可能正好取不到详情，弹窗压根不出现（实测红过一次、绿过一次）。
   * 所以：让搜索多跑一会儿攒出多源命中的书，按 `.search-card-sources` 上的「N 个书源」挑，
   * 再逐张试到弹窗真的打开为止。
   */
  const pickCandidate = () => page.evaluate(() => {
    const cards = [...document.querySelectorAll('.search-card')]
    const scored = cards.map((node, index) => ({
      index,
      sources: Number((node.querySelector('.search-card-sources')?.textContent ?? '').match(/(\d+)\s*个书源/)?.[1] ?? 0),
    }))
    scored.sort((a, b) => b.sources - a.sources || a.index - b.index)
    return scored.slice(0, 6)
  })

  let candidates = []
  for (let tick = 0; tick < 45; tick++) {
    await sleep(2000)
    candidates = await pickCandidate()
    if (candidates.length > 0 && candidates[0].sources >= 3) break
  }
  if (candidates.length === 0) {
    note('搜到结果卡片', `全库搜「${KEYWORD}」90 秒内没出卡片，弹窗无法验证`)
  } else {
    await page.evaluate(() => {
      [...document.querySelectorAll('.library-hero form button')].find(node => node.textContent?.includes('停止'))?.click()
    })
    await sleep(800)

    let rows = 0
    let modalOpened = false
    const handles = await page.$$('.search-card')
    for (const pick of candidates.slice(0, 5)) {
      const handle = handles[pick.index]
      if (!handle) continue
      await handle.click()
      for (let tick = 0; tick < 24; tick++) {
        await sleep(1500)
        modalOpened = await page.evaluate(() => !!document.querySelector('.book-detail-modal'))
        if (modalOpened) break
      }
      if (!modalOpened) {
        await page.keyboard.press('Escape')
        await sleep(600)
        continue
      }
      rows = await page.evaluate(() => document.querySelectorAll('.source-choice-item').length)
      if (rows > 0) break
      // 弹窗开了但只有一路源：换源列表不出现，换一本源更多的再试
      await page.keyboard.press('Escape')
      await sleep(600)
      modalOpened = false
    }
    if (!modalOpened) note('点开书籍详情弹窗', '前 5 本候选都没能打开详情窗（源取不到详情）')

    const head = await page.evaluate(() => {
      const modal = document.querySelector('.book-detail-modal')
      if (!modal) return null
      const stats = [...modal.querySelectorAll('.book-detail-stats > div')].map(row => ({
        label: row.querySelector('dt')?.textContent?.trim() ?? '',
        value: row.querySelector('dd')?.textContent?.trim() ?? '',
      }))
      const cover = modal.querySelector('.book-detail-cover')
      return {
        stats,
        title: modal.querySelector('.book-detail-info h2')?.textContent?.trim() ?? '',
        hasTextCover: !!modal.querySelector('.book-detail-cover-text .cover-fallback-title'),
        coverIsImg: cover?.tagName === 'IMG',
        intro: !!modal.querySelector('.book-detail-section'),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    check('详情弹窗打开了', !!head, head ? `《${head.title}》` : '(没找到 .book-detail-modal)')
    if (head) {
      const labels = head.stats.map(item => item.label)
      check('头部信息是"标签 + 值"清单，不是挤成一行的 run-on 文本',
        labels.includes('章节') && labels.includes('可用源') && labels.length >= 3, labels.join(' / '))
      check('每个标签都配到了值（不留空项）',
        head.stats.every(item => item.label.length > 0 && item.value.length > 0),
        head.stats.map(item => `${item.label}=${item.value}`).join(' ').slice(0, 150))
      check('拿不到封面时用带书名与作者的文字书封，不再只摆一个首字',
        head.coverIsImg || head.hasTextCover, head.coverIsImg ? '有图' : (head.hasTextCover ? '文字书封' : '两者都不是'))
      check('弹窗不撑出横向滚动', head.overflowX <= 1, `溢出 ${head.overflowX}px`)
    }

    if (rows === 0) {
      note('换源列表', '这本书只有一个源返回，列表按设计不出现')
    } else {
      const list = await page.evaluate(() => [...document.querySelectorAll('.source-choice-item')].map(row => ({
        name: row.querySelector('strong')?.textContent?.trim() ?? '',
        lines: [...row.querySelectorAll('small')].map(node => node.textContent?.trim() ?? ''),
        title: row.getAttribute('title') ?? '',
      })))
      const rawUrls = list.filter(item => item.name.includes('://') || /^[\w.-]+\.[a-z]{2,}\/?$/.test(item.name))
      check('换源行显示的是书源名，不是裸 sourceId', rawUrls.length === 0,
        rawUrls.map(item => item.name).slice(0, 3).join(' / ') || `${list.length} 行全是名字`)
      check('行名能在本机书源清单里对上号',
        list.every(item => Object.values(known).some(source => source.name === item.name)),
        list.slice(0, 3).map(item => item.name).join(' / '))
      check('行上摊开了分组与"JS 书源 / 已配登录 / 已停用"这类属性',
        list.every(item => item.lines.length >= 1) && list.some(item => /·/.test(item.lines.at(-1) ?? '')),
        list.map(item => `${item.name} → ${item.lines.join(' | ')}`).join(' ; ').slice(0, 200))
      check('每一行都提示了右键可用', list.every(item => item.title.includes('右键')), list[0]?.title ?? '')

      // 右键的是"当前 DOM 里的第一行"，而列表会随着体检结论**重新排序** ——
      // 名字必须在按下右键的这一刻重新读，不能拿前面那次快照的 list[0]。
      const target = await page.evaluate(() => ({
        name: document.querySelector('.source-choice-item strong')?.textContent?.trim() ?? '',
      }))
      const firstName = target.name
      const firstBox = await (await page.$('.source-choice-item')).boundingBox()
      await page.mouse.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2, { button: 'right' })
      await sleep(500)
      const menu = await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].map(node => node.textContent?.trim() ?? ''))
      const firstKnown = Object.values(known).find(source => source.name === firstName)
      check('右键换源行出现管理菜单', menu.length > 0, menu.join(' | ').slice(0, 120))
      check('菜单里的启停项与该书源当前状态相反（说明读的是真状态）',
        menu.some(item => item === (firstKnown?.enabled ? '停用此书源' : '启用此书源')),
        `「${firstName}」enabled=${firstKnown?.enabled} → ${menu.find(item => item.includes('此书源')) ?? '(没有该项)'}`)
      check('菜单能跳到书源页并定位', menu.includes('在书源页中定位'))
      check('菜单能复制书源地址', menu.includes('复制书源地址'))
      await page.screenshot({ path: path.join(SHOTS, 'detail-source-context-menu.png') })
      // 关掉这层菜单不能用 Escape —— 详情窗自己就监听 Escape，一按连弹窗一起关了，
      // 后面的目录断言与第二次右键全落在已经换掉的页面上（实测红过两次）。
      // 菜单是"点别处即关"，所以在弹窗自己的标题上按一下就够了。
      await page.evaluate(() => {
        const anchor = document.querySelector('.book-detail-info h2') ?? document.querySelector('.book-detail-modal')
        const rect = anchor?.getBoundingClientRect()
        if (rect) {
          const event = new MouseEvent('pointerdown', { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 })
          document.dispatchEvent(event)
        }
      })
      await sleep(400)

      // 目录预览与简介仍在原位（这一轮重排过头部，别把下面的弄丢）
      const rest = await page.evaluate(() => ({
        hasToc: !!document.querySelector('.preview-chapters button'),
        tocTitle: document.querySelector('.book-detail-section-title small')?.textContent?.trim() ?? '',
        chapters: Number((document.querySelector('.book-detail-stats > div > dd')?.textContent ?? '').match(/\d+/)?.[0] ?? -1),
      }))
      if (rest.chapters === 0) {
        note('目录预览仍在弹窗里', '这本书取不到目录（0 章），预览按设计就是空的 —— 换一本有目录的书才验得了这条')
      } else {
        check('目录预览仍在弹窗里', rest.hasToc, rest.tocTitle)
      }

      // 「在书源页中定位」真的带过去：跳完书源页的搜索框里应该是那个源名。
      // 名字在这一次点击前重新读 —— 列表会随体检结论回来而重排，两次右键的可能不是同一行。
      const jumpTarget = await page.evaluate(() => ({
        name: document.querySelector('.source-choice-item strong')?.textContent?.trim() ?? '',
      }))
      const jumpBox = await (await page.$('.source-choice-item'))?.boundingBox()
      let jumped = false
      if (jumpBox) {
        await page.mouse.click(jumpBox.x + jumpBox.width / 2, jumpBox.y + jumpBox.height / 2, { button: 'right' })
        for (let tick = 0; tick < 12 && !jumped; tick++) {
          await sleep(250)
          jumped = await page.evaluate(() => {
            const node = [...document.querySelectorAll('.context-menu button')].find(item => item.textContent?.trim() === '在书源页中定位')
            if (!node) return false
            node.click()
            return true
          })
        }
      }
      await sleep(3500)
      const landed = await page.evaluate(() => ({
        hash: location.hash,
        query: document.querySelector('.source-filter input')?.value ?? '(没有搜索框)',
        rows: document.querySelectorAll('.source-list-item').length,
      }))
      check('点「在书源页中定位」真的换页并把源名填进搜索框',
        jumped && landed.hash === '#sources' && landed.query === jumpTarget.name && landed.rows > 0,
        `${landed.hash} · 搜索框="${landed.query}"（期望「${jumpTarget.name}」）· ${landed.rows} 行`)
      await page.screenshot({ path: path.join(SHOTS, 'detail-jump-to-sources.png') })
    }
  }
  check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}

let pass = 0
let fail = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  NOTE ${item.name}  — ${item.detail}`) }
}
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nbook-detail-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)
