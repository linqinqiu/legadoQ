import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, launchOptions } from './env.mjs'

/**
 * 翻页（横版）模式的连续性门禁。
 *
 * 起因（用户 2026-10-02 说过两次，2026-10-03 第三次）：「书籍阅读竖版做好了，横板还是跳转」。
 * 前两轮都在改 JS（顶窗口、页码补偿、ResizeObserver 依赖），而真正的根因是一行 CSS：
 * `.reader-paginated-column-body h1` 上同时写着 `break-before: column` 和
 * `page-break-before: always` —— 后者是 `break-before: page` 的旧别名，写在后面把它顶掉了。
 * 章不换栏，三章就连成一片流，section 的矩形互相重叠，`measurePagination` 按
 * "两节左边缘之差 / 步长"算出来的每章页数是错的：footer 报 7/7 而窗口其实有 15 页宽，
 * 用户翻到"最后一页"就再也按不动，看起来完全是"横版没做好"。
 *
 * 所以这里第一条判据就是量**计算样式**，而不是读 CSS 源码 —— 源码里写着 column，
 * 计算值却是 page，这种覆盖只有浏览器知道。
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `翻页连续探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

/**
 * 一章十几段、每段两三句：保证一章在 1280×860 下要占好几页，翻页才有意义。
 * 正文里**不能出现 `第N章` 这种行首**（第一版就栽了：段落写成「第1章第14段。」，
 * 内置分章规则照着把它切成 137 章，每章一栏，整本变成一页一章，判据全在演空戏）。
 */
const syntheticBook = () => {
  const chapters = Array.from({ length: 8 }, (_, index) => {
    const paragraphs = Array.from({ length: 18 }, (_, part) =>
      `这是第${index + 1}节的第${part + 1}段落。${'这一句要写得足够长，好让它在默认字号下真的占满大半栏。'.repeat(4)}`).join('\n\n')
    return `第${index + 1}章 探针\n\n${paragraphs}`
  }).join('\n\n')
  // 书名取的是 TXT 的第一行 —— 把 STAMP 放进去，两次跑的门禁才不会互相认错书
  return `${BOOK_NAME}\n作者：门禁探针\n\n${chapters}\n`
}

const upload = async () => {
  const form = new FormData()
  form.append('file', new Blob([syntheticBook()], { type: 'text/plain; charset=utf-8' }), `${BOOK_NAME}.txt`)
  const response = await fetch(`${BASE}/api/bookshelf/import-local?tocRule=builtin`, { method: 'POST', body: form })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const removeProbe = async bookUrl => {
  if (!bookUrl) return false
  await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' })
  const after = await (await fetch(`${BASE}/api/bookshelf`)).json().catch(() => [])
  return !after.some(entry => entry.bookUrl === bookUrl)
}

let probeBookUrl = ''
let browser
try {
  const imported = await upload()
  const first = imported.body?.results?.[0]
  probeBookUrl = first?.bookUrl ?? ''
  check('探针书已导入（否则后面全是空判）', imported.status === 200 && !!first?.success && !!probeBookUrl, `${imported.status} ${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)
  if (!first?.success) throw new Error('导入失败，门禁无法继续')

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(registrations.map(entry => entry.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(key => caches.delete(key)))
  })
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ theme: 'light', pageMode: 'paginate' })), 'legado-reader-settings-v2')
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, first.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')].find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, first.name)

  await page.waitForSelector('.reader-paginated-column-body', { timeout: 60000 })
  await new Promise(resolve => setTimeout(resolve, 2500))

  // ① 根因本身：章标题必须真的换栏
  const geometry = await page.evaluate(() => {
    const body = document.querySelector('.reader-paginated-column-body')
    const viewport = document.querySelector('.reader-paginated-viewport')
    const sections = [...document.querySelectorAll('.reader-page-chapter')]
    const rects = sections.map(node => node.getBoundingClientRect())
    return {
      breakBefore: getComputedStyle(document.querySelector('.reader-page-chapter h1')).breakBefore,
      legacy: getComputedStyle(document.querySelector('.reader-page-chapter h1')).pageBreakBefore,
      sections: sections.length,
      lefts: rects.map(rect => Math.round(rect.left)),
      rights: rects.map(rect => Math.round(rect.right)),
      scrollWidth: body.scrollWidth,
      viewportWidth: viewport.clientWidth,
      footer: [...document.querySelectorAll('.reader-paginated-footer span')].map(node => node.textContent?.trim()).join(' · '),
    }
  })
  check('章标题的计算值是 column（旧别名 page-break-before: always 会把它顶成 page）',
    geometry.breakBefore === 'column', `实际 ${geometry.breakBefore} / 旧属性 ${geometry.legacy}`)
  check('翻页窗口里确实挂着不止一章', geometry.sections >= 2, `${geometry.sections} 章 · ${geometry.footer}`)
  const monotonic = geometry.lefts.every((left, index) => index === 0 || left >= geometry.lefts[index - 1])
  const noOverlap = geometry.rights.every((right, index) => index + 1 >= geometry.rights.length || right <= geometry.lefts[index + 1] + 2)
  check('各章的矩形按栏序排开、互不重叠（重叠=没换栏，页窗口算的是错的）', monotonic && noOverlap,
    `lefts=${geometry.lefts.join(',')} rights=${geometry.rights.join(',')}`)
  const pagesOfWindow = Math.ceil(geometry.scrollWidth / geometry.viewportWidth)
  const reported = Number(/(\d+) \/ (\d+)/.exec(geometry.footer)?.[2] ?? 0)
  check('footer 报的总页数覆盖整个窗口，不只是锚点那一章',
    reported >= pagesOfWindow - 1, `报 ${reported} 页，窗口 ${geometry.scrollWidth}px / 视口 ${geometry.viewportWidth}px ≈ ${pagesOfWindow} 页`)

  // ② 逐帧翻：不许卡住、不许空白帧、不许重挂子树
  const turnAndWatch = direction => page.evaluate(async key => {
    const viewport = document.querySelector('.reader-paginated-viewport')
    const before = { body: document.querySelector('.reader-paginated-column-body'), text: (viewport?.innerText ?? '').trim() }
    const counterOf = () => [...document.querySelectorAll('.reader-paginated-footer span')].map(node => node.textContent?.trim()).join(' · ')
    const startCounter = counterOf()
    // 左右半屏各自在读哪一段：跨章那一翻如果"上一步的右栏 == 这一步的左栏"，
    // 就是同一栏字被看了两遍（用户 2026-10-03 两张截图：页脚 6/19 → 1/20 而字没往前走）
    const halves = () => {
      const content = document.querySelector('.reader-paginated-column-body')
      const rect = viewport.getBoundingClientRect()
      const at = x => {
        for (const ratio of [0.5, 0.35, 0.65, 0.8]) {
          let node = document.elementFromPoint(x, rect.top + rect.height * ratio)
          for (let hop = 0; node && hop < 8; hop += 1) {
            if (node.dataset?.paragraphIndex !== undefined || node.tagName === 'P') break
            node = node.parentElement
          }
          if (node && content?.contains(node)) return (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 16)
        }
        return ''
      }
      return { left: at(rect.left + rect.width * 0.25), right: at(rect.left + rect.width * 0.75) }
    }
    const startHalves = halves()
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    let remounts = 0
    let blank = 0
    let minChars = Number.POSITIVE_INFINITY
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      if (document.querySelector('.reader-paginated-column-body') !== before.body) remounts += 1
      const chars = (viewport?.innerText ?? '').trim().length
      minChars = Math.min(minChars, chars)
      if (chars < 60) blank += 1
    }
    const endHalves = halves()
    return {
      startCounter, endCounter: counterOf(), remounts, blank, minChars,
      changed: counterOf() !== startCounter, startHalves, endHalves,
    }
  }, direction)

  // ② 逐帧翻：不许卡住、不许空白帧、不许重挂子树。**跨章的那几翻**单独挑出来判，
  // 因为"翻十页里有一页跨章"才是用户说的那件事，平均到十页里就看不见那一次了。
  const titleOf = counter => counter.split(' · ')[0] ?? ''
  let stuckAt = null
  const crossings = []
  for (let step = 0; step < 24; step += 1) {
    const outcome = await turnAndWatch('ArrowRight')
    if (!outcome.changed && !stuckAt) stuckAt = outcome.endCounter
    if (titleOf(outcome.startCounter) !== titleOf(outcome.endCounter)) crossings.push(outcome)
  }
  check('连翻 24 页不会停在"最后一页"按不动（原来 footer 7/7 而窗口有 15 页宽）',
    stuckAt === null, stuckAt ?? '每一下都在走')
  check('这一路真的跨了章（至少 2 次），否则后面的连续性判据是空判',
    crossings.length >= 2, `跨章 ${crossings.length} 次`)
  const badForward = crossings.filter(item => item.remounts > 0 || item.blank > 0)
  check('跨章那一翻不重挂子树、没有空白帧', badForward.length === 0,
    JSON.stringify(crossings.slice(0, 3)))

  // 跨章那一翻不许把同一栏字再摆一次：上一步右半格 == 这一步左半格 就是"往回跳半页"
  const repeated = crossings.filter(item => item.startHalves.right && item.startHalves.right === item.endHalves.left)
  check('跨章那一翻没有"同一栏看两次"（用户 2026-10-03：不要这样的跳转）',
    crossings.length >= 2 && repeated.length === 0,
    repeated.length ? repeated.map(item => `${item.startHalves.right} → ${item.endHalves.left}`).slice(0, 2).join(' | ')
      : `${crossings.length} 次跨章，逐次比对左右半格的段首文本`)

  // 页对齐不变量：每一章的起始栏必须是"一屏栏数"的倍数（奇数栏的章末要垫一整栏空白）
  const alignment = await page.evaluate(() => {
    const body = document.querySelector('.reader-paginated-column-body')
    if (!body) return { error: '没有分页容器' }
    const cs = getComputedStyle(body)
    const gap = parseFloat(cs.columnGap)
    const colStride = parseFloat(cs.columnWidth) + gap
    const columnsPerPage = Math.max(1, Math.round((document.querySelector('.reader-paginated-viewport').clientWidth + gap) / colStride))
    const bodyLeft = body.getBoundingClientRect().left
    const starts = [...body.querySelectorAll('.reader-page-chapter')]
      .map(node => Math.round((node.getBoundingClientRect().left - bodyLeft) / colStride))
    return {
      columnsPerPage,
      starts,
      aligned: starts.every(start => start % columnsPerPage === 0),
      fillers: body.querySelectorAll('.reader-column-filler').length,
    }
  })
  check('每一章的起始栏都对齐到整页（双栏时章末该垫的那一栏空白真的在）',
    alignment.aligned !== undefined && alignment.aligned !== false,
    `每屏 ${alignment.columnsPerPage} 栏 · 各章起始栏 ${JSON.stringify(alignment.starts)} · 垫了 ${alignment.fillers} 处`)

  // 反向对照：把垫的那几栏**临时收掉**再量一次 —— 起始栏必须变成"不是整页"。
  // 不这么做的话上面那条可能只是在量"章节本来就占偶数栏"的巧合，判据是空的。
  // 用 display:none 而不是删节点：删了就得靠 reload 恢复，而 reload 会把阅读位置
  // 甩回窗口开头，后面"往回跨章"那两条就没样本可判了（实测就是这样变红的）。
  const withoutPads = await page.evaluate(() => {
    const body = document.querySelector('.reader-paginated-column-body')
    const cs = getComputedStyle(body)
    const colStride = parseFloat(cs.columnWidth) + parseFloat(cs.columnGap)
    const bodyLeft = body.getBoundingClientRect().left
    const measure = () => [...body.querySelectorAll('.reader-page-chapter')]
      .map(node => Math.round((node.getBoundingClientRect().left - bodyLeft) / colStride))
    const before = measure()
    const pads = [...body.querySelectorAll('.reader-column-filler')]
    pads.forEach(node => { node.style.display = 'none' })
    void body.offsetHeight // 逼一次布局，别让浏览器拿旧矩形
    const after = measure()
    pads.forEach(node => { node.style.display = '' })
    void body.offsetHeight
    return {
      before, after,
      oddStarts: after.filter((start, index) => index > 0 && start % 2 !== 0).length,
      restored: measure(),
    }
  })
  check('反向对照：收掉垫栏，章节起始栏立刻不再对齐整页（上面那条不是空判）',
    withoutPads.oddStarts > 0,
    `收掉后起始栏 ${JSON.stringify(withoutPads.after)} · 其中 ${withoutPads.oddStarts} 处落在奇数栏`)
  check('放回去又对齐了（判据动作没留在界面上，阅读位置也没被动过）',
    JSON.stringify(withoutPads.restored) === JSON.stringify(withoutPads.before),
    `恢复后 ${JSON.stringify(withoutPads.restored)} vs 原本 ${JSON.stringify(withoutPads.before)}`)

  const backwards = []
  for (let step = 0; step < 24; step += 1) {
    const outcome = await turnAndWatch('ArrowLeft')
    if (titleOf(outcome.startCounter) !== titleOf(outcome.endCounter)) backwards.push(outcome)
    if (backwards.length >= 2) break
  }
  const badBack = backwards.filter(item => item.remounts > 0 || item.blank > 0)
  check('往回跨章同样不重挂、没有空白帧', backwards.length >= 1 && badBack.length === 0,
    JSON.stringify(backwards))

  // ③ 反向对照：注入旧别名（page-break-before: always），第②条判据必须变红。
  // 原来这条是量"矩形重叠"的 —— 垫栏上了之后它**再也触发不了**：章末的 break-after: column
  // 已经把换栏这件事定死了，h1 写 column 还是 page 都不改变栏序（实测 underPage 与 restored
  // 的碎片数一模一样）。留着一条不可能变红的对照等于没有对照，所以改成直接钉第②条的敏感度。
  const negative = await page.evaluate(async () => {
    const read = () => getComputedStyle(document.querySelector('.reader-page-chapter h1')).breakBefore
    const style = document.createElement('style')
    style.textContent = '.reader-paginated-column-body h1 { page-break-before: always !important; }'
    document.head.append(style)
    await new Promise(resolve => setTimeout(resolve, 500))
    const underLegacy = read()
    style.remove()
    await new Promise(resolve => setTimeout(resolve, 500))
    return { underLegacy, recovered: read() }
  })
  check('反向对照：注入旧别名 page-break-before: always，计算值立刻不再是 column（第②条不是空判）',
    negative.underLegacy !== 'column' && negative.recovered === 'column',
    `注入后=${negative.underLegacy} · 撤掉后=${negative.recovered}`)

  // ④ 往回翻（用户 2026-10-04：「你只是在两章之间起作用了，往回怎么办」）。
  // 前进那一侧②已经盯住了，这一侧原来没人管：走到窗口第一页再按上一页，正确做法是把上一章
  // **接到窗口前面**、页码整体后移它的页数，并落到上一章的最后一页 —— 与前进对称
  // （前进从本章末页进下一章首页）。
  // 旧实现是"换锚点 + 跳到最后一页"，而页数是当时量的（尾章还没挂上来），实测落到 `4/15`，
  // 也就是上一章的中间：往回翻一次，位置就丢了。接章补偿没跑成时页码停在 0，会显示接进来
  // 那章的**第一页**（「往回翻落到上一章开头」），这一条同时盯住这两种错法。
  const backward = await page.evaluate(async () => {
    const read = () => {
      const spans = [...document.querySelectorAll('.reader-paginated-footer span')].map(node => node.textContent?.trim())
      const match = /(\d+) \/ (\d+)/.exec(spans[1] ?? '')
      const viewport = document.querySelector('.reader-paginated-viewport')
      const rect = viewport.getBoundingClientRect()
      const body = document.querySelector('.reader-paginated-column-body')
      let node = document.elementFromPoint(rect.left + rect.width * 0.25, rect.top + rect.height * 0.5)
      for (let hop = 0; node && hop < 8; hop += 1) {
        if (body?.contains(node) && (node.dataset?.paragraphIndex !== undefined || node.tagName === 'P')) break
        node = node.parentElement
      }
      // 接章诊断：每节的实测起始栏（相对 body 左缘、按 stride 折算）、栏数、垫栏个数、track 位移。
      const bodyLeft = body?.getBoundingClientRect().left ?? 0
      const colWidth = Number(/(\d+(?:\.\d+)?)px/.exec(body?.style.columnWidth ?? '')?.[1] ?? 0)
      const stride = colWidth > 0 ? colWidth + 40 : 1
      const transform = /translateX\(-?(\d+(?:\.\d+)?)px\)/.exec(
        document.querySelector('.reader-paginated-track')?.getAttribute('style') ?? '')?.[1] ?? '0'
      const geometry = [...document.querySelectorAll('.reader-page-chapter')].map(node => {
        const range = document.createRange(); range.selectNodeContents(node)
        const rects = [...range.getClientRects()].filter(r => r.width > 1)
        const left = rects.length ? Math.min(...rects.map(r => r.left)) : bodyLeft
        return {
          t: node.querySelector('h1')?.textContent?.trim().slice(0, 4),
          col: Math.round((left - bodyLeft) / stride),
          cols: new Set(rects.map(r => Math.round(r.left))).size,
        }
      })
      return {
        page: Number(match?.[1] ?? -1),
        total: Number(match?.[2] ?? -1),
        sections: document.querySelectorAll('.reader-page-chapter').length,
        text: (node?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
        geometry, fillers: document.querySelectorAll('.reader-column-filler').length,
        transformCol: Math.round(Number(transform) / stride),
      }
    }
    const settle = async () => {
      for (let frame = 0; frame < 14; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve))
      await new Promise(resolve => setTimeout(resolve, 260))
    }
    const press = async key => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await settle()
    }
    // 先走到"窗口的第一页"（往回退到窗口开头，最多 40 次，避免死循环）
    for (let guard = 0; guard < 40 && read().page > 1; guard += 1) await press('PageUp')
    const atStart = read()
    await press('PageUp')
    const afterPrepend = read()
    await press('PageUp')
    const afterStepBack = read()
    return { atStart, afterPrepend, afterStepBack }
  })
  check('④窗口第一页上按上一页：上一章被接到窗口前面（章数加一，页数不缩）',
    backward.atStart.page === 1
      && backward.afterPrepend.sections === backward.atStart.sections + 1
      && backward.afterPrepend.total >= backward.atStart.total,
    `${backward.atStart.page}/${backward.atStart.total} ${backward.atStart.sections} 章 → `
    + `${backward.afterPrepend.page}/${backward.afterPrepend.total} ${backward.afterPrepend.sections} 章`)
  check('④接上之后直接落到上一章的最后一页（与前进对称，不再停在窗口第一页）',
    backward.afterPrepend.page > 1
      && backward.afterPrepend.text !== backward.atStart.text,
    `接之前「${backward.atStart.text}」 vs 之后「${backward.afterPrepend.text}」`
    + ` · 接前${JSON.stringify(backward.atStart.geometry)}垫${backward.atStart.fillers}位移${backward.atStart.transformCol}栏`
    + ` · 接后${JSON.stringify(backward.afterPrepend.geometry)}垫${backward.afterPrepend.fillers}位移${backward.afterPrepend.transformCol}栏`)
  check('④再按一次继续往回一页：页码再减一、字往前退',
    backward.afterStepBack.page === backward.afterPrepend.page - 1
      && backward.afterStepBack.text !== backward.afterPrepend.text,
    `${backward.afterPrepend.page} → ${backward.afterStepBack.page}，「${backward.afterPrepend.text}」→「${backward.afterStepBack.text}」`)

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close()
  const removed = await removeProbe(probeBookUrl)
  check('探针书已删除（不留残留在用户书架上）', removed, removed ? '已清' : '没删掉，需要手工清')
}

const failed = results.filter(item => !item.ok)
console.log(`\npaginate-flow-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
if (failed.length) process.exitCode = 1
