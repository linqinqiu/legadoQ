// 滚动模式「连续文档」的实测门禁（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
//
// 这条门禁只判一件事：**跨过章边界的那一两帧，屏幕上看到的是不是同一块内容**。
// 单元判据（web/test/ReaderFlow.test.ts）钉的是算术，这里钉的是画面 —— 因为"跳"这个字
// 从来不在算术里出错，它出在提交与绘制之间：摘掉顶部那一节的 DOM 与把滚动位置校正回来
// 如果不是同一帧完成，用户就看到内容往上飞一截；差一条分隔线的边距就是每次 60px 的小跳。
//
// 所以每条滚完之后按 rAF 逐帧采样同一个段落（用它自己的标记文本找，节点会被 React 重建），
// 判三件事：① 这一段从来不消失；② 各帧之间它的屏幕偏移不散开（尖峰=晚到的校正）；
// ③ 校正之后它停在"滚这一步之前该有的位置"。三条各自对应一种坏法。
//
// 夹具是自己造的一本 5 章本地书（每章 30 段、带〔章-段〕标记），跑完从书架删掉：
// 不依赖外网正文，也不动用户书架上那几本。
// 跑法：node tools/verify/reader-flow-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const FILE_NAME = `连续流探针${STAMP}`
const SETTINGS_KEY = 'legado-reader-settings-v2'
const CHAPTERS = 5
const PARAGRAPHS = 30
const STEP = 500
/** 段落标记的屏幕上容差：小于一条分隔线的边距（60px），也小于字号的一行。 */
const TOLERANCE = 8

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 一本每章都超过两屏的 TXT：〔章-段〕开头，方便在浏览器里按文本认出"当前屏幕中间是第几章"。 */
function probeTxt() {
  const lines = []
  for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
    lines.push(`第${'一二三四五'[chapter - 1]}章 连续流第${chapter}站`)
    for (let p = 1; p <= PARAGRAPHS; p += 1) {
      lines.push(`〔${chapter}-${p}〕这一段是用来定位画面落在第几章第几段的填充文字，重复三遍以增加行数：`
        + `第${chapter}章第${p}段。第${chapter}章第${p}段。第${chapter}章第${p}段。`)
    }
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

/** 当前画面：锚点章、视口顶上那一章、渲染了几节、有没有「下一章」按钮。 */
const readScreen = page => page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.reading-content .reader-flow-chapter')]
  const anchor = nodes[0]
  const anchorRect = anchor?.getBoundingClientRect()
  // "屏幕顶上那一段"用的是视口顶部往下 4px：标题该报的就是它（用户正在读的那一章）。
  const top = [...document.querySelectorAll('.reading-content p')]
    .find(node => { const rect = node.getBoundingClientRect(); return rect.top <= 4 && rect.bottom >= 4 })
  const mid = window.innerHeight * 0.55
  const middle = [...document.querySelectorAll('.reading-content p')]
    .find(node => { const rect = node.getBoundingClientRect(); return rect.top <= mid && rect.bottom >= mid })
  const topSection = top?.closest('.reading-content .reader-flow-chapter')
  return {
    scrollY: Math.round(window.scrollY),
    viewport: window.innerHeight,
    docHeight: document.documentElement.scrollHeight,
    sections: nodes.length,
    anchorIndex: anchor ? Number(anchor.getAttribute('data-chapter-index')) : null,
    anchorTitle: anchor?.querySelector('h1')?.textContent?.trim() ?? '',
    anchorHeight: anchor ? anchor.offsetHeight : 0,
    // 锚点还留在屏幕上的那一截（<=0 表示它其实已经完全滚出去了，下一格窗口就该顶上来）
    anchorBottom: anchorRect ? Math.round(anchorRect.bottom) : null,
    topMarker: top ? (top.textContent ?? '').slice(0, 12) : '',
    topIndex: topSection ? Number(topSection.getAttribute('data-chapter-index')) : null,
    marker: middle ? (middle.textContent ?? '').slice(0, 12) : '',
    probeTop: middle ? Math.round(middle.getBoundingClientRect().top) : null,
    hint: !!document.querySelector('.reader-next-hint'),
  }
})

/**
 * 滚一步，并从这一步起逐帧盯住同一个段落。
 * 采样在页面里跑（rAF），所以"晚一帧的校正"这种只有 16ms 的现象也落得进数据里。
 *
 * 盯的那一段是**滚完这一步之后顶部仍在 0 以下、且没贴到屏幕底**的那一段：
 * 摘章的判据是"底边越过视口顶部再多 24px"，凡是滚完之后已经跑到屏幕上方的段落，
 * 都可能整段属于被摘走的那一章 —— 那本来就该消失，拿它当"画面空洞"是判据自己冤枉产品。
 */
const stepAndSample = page => page.evaluate(({ step, floor, tailGap }) => new Promise(resolve => {
  const at = text => [...document.querySelectorAll('.reading-content p')]
    .find(node => (node.textContent ?? '').startsWith(text))
  const probe = [...document.querySelectorAll('.reading-content p')].find(node => {
    const top = node.getBoundingClientRect().top
    return top >= floor && top <= window.innerHeight - tailGap
  })
  const marker = probe ? (probe.textContent ?? '').slice(0, 14) : ''
  const before = probe?.getBoundingClientRect().top ?? null
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight
  const clamped = before !== null && window.scrollY + step > maxScroll
  const frames = []
  window.scrollBy(0, step)
  const start = performance.now()
  const tick = () => {
    const node = marker ? at(marker) : undefined
    const anchor = document.querySelector('.reading-content .reader-flow-chapter')
    frames.push({
      top: node ? Math.round(node.getBoundingClientRect().top) : null,
      // 尖峰到底出在"内容自己动了"还是"滚动位置动了"，把两个量都记下来才分得开
      y: Math.round(window.scrollY),
      anchorTop: anchor ? Math.round(anchor.getBoundingClientRect().top) : null,
      sections: document.querySelectorAll('.reading-content .reader-flow-chapter').length,
      anchor: Number(anchor?.getAttribute('data-chapter-index') ?? -1),
    })
    if (performance.now() - start < 600) window.requestAnimationFrame(tick)
    else resolve({
      marker,
      before: before === null ? null : Math.round(before),
      clamped,
      series: frames.slice(0, 10).map(frame => `${frame.top ?? 'x'}/y${frame.y}/顶${frame.anchorTop ?? 'x'}`).join(' '),
      frames,
    })
  }
  window.requestAnimationFrame(tick)
}), { step: STEP, floor: STEP + 20, tailGap: 40 })

/**
 * 一次大跳跃（拖滚动条那种）：只逐帧记"视口中段有没有字 + 锚点是第几章"。
 * 判"有没有字"用的是一个带而不是一条线：段与段之间本来就有间距，卡在间距上会被误判成空洞。
 */
const jumpAndSample = (page, delta) => page.evaluate(({ delta }) => new Promise(resolve => {
  const nodes = [...document.querySelectorAll('.reading-content .reader-flow-chapter')]
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight
  // 默认按当前这节的高度算："跨过两章"这件事必须由几何决定，写死一个像素数会随字号失效
  const step = delta > 0 ? delta : Math.min(maxScroll - window.scrollY, Math.round((nodes[0]?.offsetHeight ?? 800) * 2 + 400))
  const snap = () => {
    const top = window.innerHeight * 0.42
    const bottom = window.innerHeight * 0.68
    const anchor = document.querySelector('.reading-content .reader-flow-chapter')
    return {
      anchor: Number(anchor?.getAttribute('data-chapter-index') ?? -1),
      sections: document.querySelectorAll('.reading-content .reader-flow-chapter').length,
      hasMidText: [...document.querySelectorAll('.reading-content p')].some(node => {
        const rect = node.getBoundingClientRect()
        return rect.top <= bottom && rect.bottom >= top
      }),
      y: Math.round(window.scrollY),
    }
  }
  const frames = [snap()]
  window.scrollBy(0, step)
  const start = performance.now()
  const tick = () => {
    frames.push(snap())
    if (performance.now() - start < 900) window.requestAnimationFrame(tick)
    else resolve({ step: Math.round(step), frames })
  }
  window.requestAnimationFrame(tick)
}), { delta })

/**
 * 删掉这本书在浏览器离线正文库（IndexedDB）里的副本。
 * 拦请求 ≠ 拿不到：`api.content` 失败会回落到这份缓存，不清掉的话拦截会被兜住、判据空转。
 */
const clearOfflineChapters = (page, bookUrl) => page.evaluate(target => new Promise(resolve => {
  // 不带版本号打开：带上写死的 1 会在应用已经把库升到 2 之后抛 VersionError（这条一直是假红）。
  const open = indexedDB.open('legado_offline_db')
  open.onerror = () => resolve(-1)
  open.onsuccess = () => {
    const db = open.result
    if (!db.objectStoreNames.contains('chapters')) { resolve(0); return }
    const tx = db.transaction('chapters', 'readwrite')
    const store = tx.objectStore('chapters')
    const all = store.index('by_book').getAllKeys(['loc_book', target])
    all.onerror = () => resolve(-1)
    all.onsuccess = () => {
      for (const key of all.result) store.delete(key)
      tx.oncomplete = () => resolve(all.result.length)
    }
  }
}), bookUrl)

let probeBookUrl = ''
let browser = null
const errors = []
try {
  // ─────────────── 夹具：一本每章多屏的本地书 ───────────────
  const form = new FormData()
  form.append('file', new Blob([probeTxt()], { type: 'text/plain' }), `${FILE_NAME}.txt`)
  const imported = await fetch(`${BASE}/api/bookshelf/import-local`, { method: 'POST', body: form })
  const importBody = await imported.json().catch(() => null)
  const bookName = importBody?.results?.[0]?.name ?? FILE_NAME
  probeBookUrl = importBody?.results?.[0]?.bookUrl ?? ''
  check('夹具导入成功且有 5 章', imported.status === 200 && !!probeBookUrl && importBody?.results?.[0]?.totalChapters === CHAPTERS,
    `HTTP ${imported.status} · 章数 ${importBody?.results?.[0]?.totalChapters ?? 0} · ${importBody?.results?.[0]?.error ?? ''}`)

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error.message)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

  // Service Worker 会把 bundle 钉在上一版：先注销再测，否则量的可能是旧包。
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(regs.map(reg => reg.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(key => caches.delete(key)))
  })
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ pageMode: 'scroll' })), SETTINGS_KEY)

  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(name => !!document.querySelector(`[aria-label="继续阅读 ${name}"]`), { timeout: 45000 }, bookName)
  await page.evaluate(name => document.querySelector(`[aria-label="继续阅读 ${name}"]`)?.click(), bookName)
  await page.waitForSelector('.reading-content .reader-flow-chapter', { timeout: 45000 })
  await sleep(1500)

  const start = await readScreen(page)
  check('进得去这本探针书，而且第一章还是第一章', start.sections >= 1 && /^第一章/.test(start.anchorTitle),
    `第一节的标题是「${start.anchorTitle}」（自动选规则如果漏掉了文件开头那条标题，整章会变成「前言」）`)
  check('夹具的每一章确实超过一屏（不然"连续"是假的）', start.anchorHeight > start.viewport * 1.5,
    `本章 ${start.anchorHeight}px / 视口 ${start.viewport}px`)
  check('滚动模式一进来就是连续文档：同一容器里挂着不止一节', start.sections > 1,
    `渲染 ${start.sections} 节（旧行为：一次只挂一章）`)
  check('中途不出现「下一章」按钮（那是最后一章才该有的位置）', !start.hint, start.hint ? '出现了' : '没有')

  // ─────────────── 反向对照：一帧跨过多章（拖滚动条 / 快速甩动） ───────────────
  // 逐节推进的版本在这里会露馅：视口已经落在第三章，窗口却只摘掉第一章，
  // 于是标题、进度、目录高亮全对不上画面 —— 用户说的"不是一体的"就是这么来的。
  const jumped = await jumpAndSample(page, 0)
  await sleep(300)
  const afterJump = await readScreen(page)
  const holes = jumped.frames.filter(frame => !frame.hasMidText)
  check('一次滚过大段时会连着顶掉多章（不是逐章慢慢追）',
    afterJump.anchorIndex - jumped.frames[0].anchor >= 2,
    `一跳 ${jumped.step}px · 锚点 ${jumped.frames[0].anchor} → ${afterJump.anchorIndex} · 挂着 ${afterJump.sections} 节`)
  check('顶过多章的每一帧视口里都有正文（没有"摘完了还没补上"的空洞）', holes.length === 0,
    holes.length ? `${holes.length}/${jumped.frames.length} 帧中间是空的` : `${jumped.frames.length} 帧都有字`)

  // ─────────────── 一路向下，逐帧盯住画面 ───────────────
  let screen = afterJump
  let promotions = 0
  let tracked = 0
  let worstSpread = 0
  let worstSpreadSeries = ''
  let worstQuietSpread = 0
  let worstDrift = 0
  let vanishedFrames = 0
  let jumpedToTop = false
  const mismatched = []
  const log = []
  const lastIndex = (importBody?.results?.[0]?.totalChapters ?? CHAPTERS) - 1
  for (let i = 0; i < 40; i += 1) {
    const previousY = screen.scrollY
    const sampled = await stepAndSample(page)
    const next = await readScreen(page)
    const tops = sampled.frames.filter(frame => frame.top !== null).map(frame => frame.top)
    const spread = tops.length >= 2 ? Math.max(...tops) - Math.min(...tops) : 0
    const advanced = next.anchorIndex > screen.anchorIndex
    if (sampled.marker && !sampled.clamped) {
      tracked += 1
      vanishedFrames += sampled.frames.length - tops.length
      // 跨章那一步与不跨章那一步分开量：界面顶栏在第一次下滚时自己收起，那是另一件事
      // （它动的是所有帧，不是"只有换章那一跳"），混进同一条判据里就会把产品判红在界面上。
      if (advanced) {
        if (spread > worstSpread) { worstSpread = spread; worstSpreadSeries = `${screen.anchorIndex}→${next.anchorIndex}：${sampled.series}` }
      } else {
        worstQuietSpread = Math.max(worstQuietSpread, spread)
      }
      // 期望位置 = 滚这一步之前它在哪 - 这一步滚了多少（摘除与校正互相抵消，画面不该动）
      worstDrift = Math.max(worstDrift, Math.abs(tops[tops.length - 1] - ((sampled.before ?? 0) - STEP)))
    }
    if (next.scrollY === 0 && screen.scrollY > 0) jumpedToTop = true
    if (advanced) {
      promotions += 1
      log.push(`第 ${i} 步 ${screen.anchorIndex}→${next.anchorIndex} · 挂着 ${next.sections} 节 · 逐帧散布 ${spread}px`)
    }
    // 标题必须报"屏幕顶上那一章"。唯一的例外是锚点已经整节滚出屏幕（剩不到 0px）——
    // 那是 24px 的容忍带，下一个滚动事件就会把窗口顶上来，不该算不一致。
    if (next.topIndex !== null && next.topIndex !== next.anchorIndex && (next.anchorBottom ?? 0) > 0) {
      mismatched.push(`第 ${i} 步 顶上「${next.topMarker}」属于第 ${next.topIndex + 1} 章，标题却是第 ${next.anchorIndex + 1} 章（锚点还剩 ${next.anchorBottom}px 在屏幕上）`)
    }
    screen = next
    if (screen.anchorIndex >= lastIndex) break
    if (!advanced && screen.scrollY <= previousY) break // 滚不动了 = 到文档尽头
  }

  check('一路向下滚到了最后一章（不是一步一停）', screen.anchorIndex >= lastIndex,
    `锚点第 ${screen.anchorIndex + 1} / ${lastIndex + 1} 章 · 盯了 ${tracked} 步 · scrollY ${screen.scrollY}`)
  check('确实发生了跨章推进（没推进的话下面几条都是空判）', promotions > 0, `跨章 ${promotions} 次 · ${log.slice(0, 3).join('；')}`)
  check('跨章时画面不跳：被盯着那一段每一帧都还在屏幕上', vanishedFrames === 0,
    vanishedFrames ? `${vanishedFrames} 帧里那段文字整块消失了` : `${tracked} 步逐帧都在`)
  check('跨章那一两帧之间没有尖峰（摘除与校正同一帧完成）', worstSpread <= TOLERANCE,
    `跨章步逐帧最大散布 ${worstSpread}px（容差 ${TOLERANCE}px；不跨章的步散布 ${worstQuietSpread}px 是顶栏收起带来的整体位移，不是换章的跳）· ${worstSpreadSeries}`)
  check('滚一步之后那段文字停在该停的位置（校正不多不少）', worstDrift <= TOLERANCE,
    `最大偏差 ${worstDrift}px（不补偿的话这里会是整章的高度）`)
  check('标题报的是屏幕顶上那一章（进度与画面对得上）', mismatched.length === 0,
    mismatched.length ? `${mismatched.length} 次不一致：${mismatched.slice(0, 2).join('；')}` : '一致')
  check('跨章不是"跳回顶部"（scrollTo(0) 是旧行为的根）', !jumpedToTop, jumpedToTop ? '有一次滚动位置被归零' : '从未归零')
  check('到了最后一章就不再挂续接（不留着下一章都不存在的空节）',
    screen.anchorIndex >= lastIndex && screen.sections === 1 && !screen.hint,
    `锚点第 ${screen.anchorIndex + 1} 章 · 挂着 ${screen.sections} 节`)

  // ─────────── 右键不许动正文（用户 2026-10-04：「鼠标右键点击正文页面取消后正文莫名向上移动」）───────────
  // 原来 `onPointerDown/onPointerUp` 不判鼠标按钮，右键也走"上/中/下"那三区 ——
  // 于是"叫出菜单再取消"之后页面已经往上滚了一屏。挑最坏那一格判（上三分之一 = 上一页）。
  const screenState = () => ({
    y: Math.round(window.scrollY),
    top: (document.querySelector('.reading-content')?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    menu: !!document.querySelector('.context-menu'),
  })
  const beforeRight = await page.evaluate(screenState)
  const spot = await page.evaluate(() => {
    const rect = document.querySelector('.reading-content').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width * 0.5), y: Math.round(rect.top + rect.height * 0.12) }
  })
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await new Promise(resolve => setTimeout(resolve, 700))
  const onRight = await page.evaluate(screenState)
  check('右键点正文上三分之一那一格：页面不许动（旧版会往上滚一屏）',
    onRight.y === beforeRight.y && onRight.top === beforeRight.top,
    `scrollY ${beforeRight.y} → ${onRight.y} · 首屏文字「${beforeRight.top.slice(0, 12)}…」→「${onRight.top.slice(0, 12)}…」`)
  check('右键出的是应用内菜单，不是没反应', onRight.menu, `菜单挂到 DOM 上=${onRight.menu}`)
  await page.keyboard.press('Escape')
  await new Promise(resolve => setTimeout(resolve, 500))
  const afterClose = await page.evaluate(screenState)
  check('菜单关得掉，且关掉之后正文仍然没动过',
    !afterClose.menu && afterClose.y === beforeRight.y && afterClose.top === beforeRight.top,
    `菜单还在=${afterClose.menu} · scrollY=${afterClose.y}`)

  // ─────────────── 兜底：续接取不到时，章末提示条要回来 ───────────────
  // 连续流把"下一章"从按钮变成了挂在下面的内容，那"取不到下一章"这条路径就必须还在：
  // 否则用户滚到章末就是死路一条（没得点、也没得滚）。
  const cleanRunErrors = errors.length
  const toc = await fetch(`${BASE}/api/books/chapters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl }),
  }).then(res => res.json()).catch(() => [])
  const secondChapterUrl = toc[1]?.url ?? ''
  const cleared = await clearOfflineChapters(page, probeBookUrl)
  await fetch(`${BASE}/api/reading-progress`, {
    method: 'PUT', headers: { 'content-type': 'application/json', Origin: BASE },
    body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl, chapterUrl: toc[0]?.url ?? '', chapterIndex: 0, scrollPosition: 0 }),
  })
  await page.setRequestInterception(true)
  let refused = 0
  let seen = 0
  page.on('request', request => {
    // 正文是 POST，章节地址在请求体里 —— 拿 URL 去比会一条都拦不住（然后整条判据空转）
    if (request.url().includes('/api/books/content')) seen += 1
    if (secondChapterUrl && (request.postData() ?? '').includes(secondChapterUrl)) {
      refused += 1
      request.abort().catch(() => {})
      return
    }
    request.continue().catch(() => {})
  })
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => !!document.querySelector(`[aria-label="继续阅读 ${name}"]`), { timeout: 45000 }, bookName)
  await page.evaluate(name => document.querySelector(`[aria-label="继续阅读 ${name}"]`)?.click(), bookName)
  await page.waitForSelector('.reading-content .reader-flow-chapter', { timeout: 45000 })
  await sleep(2500)
  const fallback = await readScreen(page)
  await page.setRequestInterception(false)
  check('续接取不到时章末提示条回来（滚到章末不是死路）',
    cleared >= 0 && refused > 0 && fallback.sections === 1 && fallback.hint,
    `清掉 ${cleared} 章离线副本 · 拦掉 ${refused}/${seen} 次正文请求 · 从第 ${fallback.anchorIndex + 1} 章「${fallback.anchorTitle}」进来 · 挂着 ${fallback.sections} 节 · 提示条 ${fallback.hint ? '在' : '不在'}`)

  // 门禁用的 Chrome profile 是复用的（IndexedDB 不在每次启动要清的目录清单里）：
  // 探针书的离线副本要自己收掉，否则一路跑下去 profile 里攒出一整本书。
  await clearOfflineChapters(page, probeBookUrl)
  const residue = await clearOfflineChapters(page, probeBookUrl)
  check('探针不留离线正文副本', residue === 0, `第二次清掉 ${residue} 章`)

  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `reader-flow-${STAMP}.png`) })
  // 兜底那一段是故意把请求打断的，控制台必然有噪音：只判"正常跑完的那一段"有没有异常
  check('连续流全程没有页面异常', cleanRunErrors === 0, errors.slice(0, 3).join(' | ') || '无')
} catch (error) {
  check('探针脚本自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  if (probeBookUrl) {
    const removed = await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const left = await fetch(`${BASE}/api/bookshelf`).then(res => res.json()).catch(() => [])
    check('收尾删掉探针书（不给用户书架留垃圾）',
      removed.status < 400 && !(left ?? []).some(item => item.bookUrl === probeBookUrl), `HTTP ${removed.status}`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => row.ok === false)
  const skipped = results.filter(row => row.ok === null)
  fs.writeFileSync(path.join(OUT, `reader-flow-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) {
    const flag = row.ok === true ? 'PASS' : row.ok === false ? 'FAIL' : 'NOTE'
    console.log(`${flag}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  }
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} PASS`
    + `${skipped.length ? ` · ${skipped.length} NOTE` : ''}${failed.length ? ` · ${failed.length} FAIL` : ''}`
    + ` · 详情 tools/verify/out/reader-flow-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
