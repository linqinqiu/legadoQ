import test from 'node:test'
import assert from 'node:assert/strict'
import { chapterConsumed, flowAdvance, holdScroll, pageAlignmentPads, pageAlignmentStarts, pageProgress, pageWindowShift, prependLandingPage, SectionBox, sectionAtPage, sectionProgress } from '../src/reader/readerFlow'

/**
 * 连续滚动的算术（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
 *
 * 这几条为什么值得单独钉：产品的"跳"不是审美问题，是三处机制叠出来的
 * （整棵子树重挂 + 动画重播 + 强制 scrollTo）。改成续接之后，
 * 最容易做错的两件事是"摘掉顶部那几章之后怎么把画面按回原位"和"章内进度的分母"，
 * 两者错了都不会报错，只会让用户觉得"还是怪"或者"进度乱跳"。
 */
const VIEW = 800

const SECTIONS: SectionBox[] = [
  { top: 0, height: 2000 },
  { top: 2000, height: 1500 },
  { top: 3500, height: 900 },
]

test('chapterConsumed - 判据是"底边越过视口顶部再多留一点"，不是整页触底', () => {
  const first: SectionBox = { top: 0, height: 2000 }
  assert.equal(chapterConsumed(first, 0), false, '刚进这一章')
  assert.equal(chapterConsumed(first, 1200), false, '底边还在视口里，不该翻')
  assert.equal(chapterConsumed(first, 2010), false, '刚越过顶部 10px 还不摘：屏幕上那几行字仍然要留着')
  assert.equal(chapterConsumed(first, 2030), true, '越过顶部再多留 24px 才摘')
  // 反向对照：连续流里"文档底部到了"永远成立，拿触底判据会一路狂翻章节
  const whole: SectionBox = { top: 0, height: 60_000 }
  assert.equal(chapterConsumed(whole, 0), false, '窗口再高也不该被当成"这一章读完了"')
})

test('flowAdvance - 慢滚一次顶一章，拖滚动条一次可以顶过多章', () => {
  assert.equal(flowAdvance(SECTIONS, 2010), null, '第一章底边刚越过顶部，还没到该摘的时候')
  assert.deepEqual(flowAdvance(SECTIONS, 2100), { lead: 1, keepTop: -100 }, '顶掉第一章，第二章该停在视口顶部上方 100px')
  // 拖滚动条/程序化跳转一帧就能跨过去两章：只顶一章的话锚点会落后在视口上方，
  // 标题与进度对不上画面 —— 那还是"跳"，只是换了个原因。
  assert.deepEqual(flowAdvance(SECTIONS, 3600), { lead: 2, keepTop: -100 }, '一帧跨两章就一次顶两章')
  assert.equal(flowAdvance(SECTIONS, 3000)?.keepTop, SECTIONS[1].top - 3000, 'keepTop 是新锚点相对视口顶部的偏移（这一章已读掉一截时为负）')
})

test('flowAdvance 反向对照：永远给窗口留一章，否则就没有锚点了', () => {
  const deep = flowAdvance(SECTIONS, 99_999)
  assert.equal(deep?.lead, 2, '滚到天涯海角也只剩最后一节')
  assert.ok(deep!.lead < SECTIONS.length, '不许把窗口摘空')
  assert.equal(flowAdvance([SECTIONS[0]], 99_999), null, '窗口里只有一章时不许推进（否则会把自己摘没）')
  assert.equal(flowAdvance([], 100), null, '空窗口不该动')
})

test('顶完之后的锚点必须真的对着视口：flowAdvance 与 chapterConsumed 是同一把尺', () => {
  for (const y of [0, 900, 2100, 2400, 3600, 5000]) {
    const lead = flowAdvance(SECTIONS, y)?.lead ?? 0
    const anchor = SECTIONS[lead]
    // 摘多了：锚点整节跑到视口下方，屏幕上是空白；摘少了：上一章还压在上面，标题与进度对不上画面。
    assert.ok(anchor.top <= y + VIEW, `y=${y} 时锚点不该整节都在视口下方`)
    assert.ok(!chapterConsumed(anchor, y) || lead === SECTIONS.length - 1, `y=${y} 时锚点不该是已经翻过去的那一章`)
  }
})

test('holdScroll - 校正量来自"量出来的偏移"，不是摘掉那几节的高度', () => {
  assert.equal(holdScroll(3300, -3212, -1300), 1388)
  assert.equal(holdScroll(1000, 500, 500), 1000, '量出来就是目标，那一步都不许多')
  assert.equal(holdScroll(500, -4000, -1300), 0, '不许出现负滚动')
})

test('反向对照：按高度算就会漏掉分隔线的边距 —— 每跨一章小跳一次', () => {
  const MARGIN = 61 // 节与节之间那条分隔线的外边距（3.2em）：一节变成首节时它会消失
  const removedHeight = 2000
  const scrollTop = 3000
  const keepTop = (removedHeight + MARGIN) - scrollTop // 顶之前第二章在视口上方 939px
  // 摘掉第一章之后，第二章顶到文档 0 处；滚动位置还没动，所以量出来的偏移是 -3000
  const measuredTop = 0 - scrollTop
  const held = holdScroll(scrollTop, measuredTop, keepTop)
  const byHeight = scrollTop - removedHeight
  assert.equal(0 - held, keepTop, '按量校正之后，第二章应当严丝合缝回到原来那块屏幕')
  assert.equal(Math.abs((0 - byHeight) - keepTop), MARGIN, '按高度算会差出那条边距：跨十章就是十次肉眼可见的小跳')
})

test('sectionProgress - 分母是"这一章"，不是整篇文档', () => {
  const second: SectionBox = { top: 2000, height: 1500 }
  // 整篇 4400px；若按整篇算，滚到 2000 会报 0.45 —— 那正是进度契约被改坏的样子
  assert.equal(sectionProgress(second, 2000, VIEW), 0, '刚进这一章就是 0')
  assert.equal(sectionProgress(second, 2700, VIEW), 1, '这一章读完就是 1')
  assert.ok(Math.abs(sectionProgress(second, 2280, VIEW) - 0.4) < 1e-9, '中段按比例：可滚 700px，滚了 280px 就是 0.4')
  assert.equal(sectionProgress({ top: 0, height: 300 }, 900, VIEW), 1, '比一屏还短的一章：翻过去就是 1')
  assert.equal(sectionProgress({ top: 5000, height: 300 }, 0, VIEW), 0, '还没到就是 0')
})

/** 分页模式的同一件事，单位从像素换成页（用户 2026-10-02：「横板还是跳转」）。 */
const SPANS = [{ start: 0, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 12 }]

test('sectionAtPage / pageProgress - 页码落在哪一章、这一章读了几页', () => {
  assert.equal(sectionAtPage(SPANS, 0), 0)
  assert.equal(sectionAtPage(SPANS, 4), 0)
  assert.equal(sectionAtPage(SPANS, 5), 1, '起点是含的：第 5 页已经是第二章的第一页')
  assert.equal(sectionAtPage(SPANS, 99), 2, '翻过头也不许越界')
  assert.equal(pageProgress(SPANS, 0), 0)
  assert.equal(pageProgress(SPANS, 2), 0.5)
  assert.equal(pageProgress(SPANS, 4), 1, '这一章最后一页就是 1')
  assert.equal(pageProgress(SPANS, 8), 1)
})

test('pageProgress 反向对照：分母是这一章的页数，不是整个窗口的页数', () => {
  // 窗口共 12 页；第二章占 5..9。按窗口算第 8 页是 8/11≈0.73，
  // 而服务端存的进度语义是"这一章读了多少" —— 第二章的最后一页必须是 1。
  assert.equal(pageProgress(SPANS, 8), 1)
  assert.notEqual(pageProgress(SPANS, 8), 8 / 11)
})

test('pageWindowShift - 翻进挂着的下一章是顶窗口，页码减去被摘掉那几章的页数', () => {
  assert.equal(pageWindowShift(SPANS, 4), null, '还在第一章里就不该动窗口')
  assert.deepEqual(pageWindowShift(SPANS, 5), { lead: 1, pageIndex: 0 }, '刚进第二章：摘掉第一章，落在新窗口的第一页')
  assert.deepEqual(pageWindowShift(SPANS, 10), { lead: 2, pageIndex: 1 }, '一帧跨两章：摘两章，页码跟着减')
  // 反向对照：归零会把人甩回窗口开头（=跳），减去被摘页数才停在原来那一页上
  assert.notEqual(pageWindowShift(SPANS, 10)!.pageIndex, 0)
})

test('pageAlignmentPads - 双栏时每一章补齐到整页（用户 2026-10-03「不要这样的跳转」）', () => {
  // 垫的量算在**章末**：第一章占 5 栏（奇数）→ 它自己补 1 栏，第二章才落在整页开头
  assert.deepEqual(pageAlignmentPads([5, 4, 6], 2), [1, 0, 0],
    '奇数栏补一栏，偶数栏不补')
  assert.deepEqual(pageAlignmentStarts([5, 4, 6], 2), [0, 6, 10],
    '补完之后每一章的起始栏都是 2 的倍数')
  assert.deepEqual(pageAlignmentPads([5, 5, 5], 2), [1, 1, 1])
  // 窗口里最后一章也补：它只是下一张预览，不是书的末尾；开"最后一章不补"的口子
  // 会让"首屏只量到一节"时整个计划算成 0，之后没人回来补（第一版就栽在这儿）
  assert.deepEqual(pageAlignmentPads([4, 7], 2), [0, 1], '最后一章是奇数栏也照样补')
  assert.deepEqual(pageAlignmentStarts([5, 5, 5], 2), [0, 6, 12])
  // 单栏模式没有"半页"这回事，一律不补
  assert.deepEqual(pageAlignmentPads([5, 5], 1), [0, 0])
  // 反向对照：不补的话起始栏就是奇数 —— 那正是重复一栏的那个形状
  assert.deepEqual(pageAlignmentStarts([5, 4, 6], 1), [0, 5, 9])
  assert.equal(pageAlignmentStarts([5, 4, 6], 1)[1] % 2, 1, '不补时第二章从奇数列开始（会被看过一遍）')
})

test('pageAlignmentPads 的不变量：窗口往前挪（摘掉整章）之后仍然对齐 —— 第一版就是栽在这里', () => {
  const counts = [5, 4, 7, 3]
  const full = pageAlignmentStarts(counts, 2)
  assert.deepEqual(full, [0, 6, 10, 18])
  for (let lead = 1; lead < counts.length; lead += 1) {
    const shifted = pageAlignmentStarts(counts.slice(lead), 2)
    assert.deepEqual(shifted.map(start => start % 2), counts.slice(lead).map(() => 0),
      `摘掉前 ${lead} 章之后起始栏不再是整数页 —— 那一栏会被看两次`)
    // 挪窗口只是整体平移：相邻章之间的页距必须和没挪之前一致，
    // 否则 `页码 - 被摘章的页数` 就不指向原来那一栏了
    assert.deepEqual(shifted, full.slice(lead).map(start => start - full[lead]))
  }
})

test('prependLandingPage - 往回接上一章后落到上一章的最后一页（与前进对称）', () => {
  // 接章前窗口的第 0 节接完后排第 1 节：它第一页是第 4 页（起始栏 8 / 每页 2 栏）。
  // 「往回翻一页」就是第 3 页 —— 接进来那一章的最后一页。
  assert.equal(prependLandingPage(8, 2), 3)
  assert.equal(prependLandingPage(6, 2), 2, '起始栏 6 → 第 3 页 → 往回一页是第 2 页')
  assert.equal(prependLandingPage(2, 2), 0, '刚接进来就只剩一页时夹到第 0 页')
  assert.equal(prependLandingPage(0, 2), 0, '窗口最开头不许出现负页码')
  assert.equal(prependLandingPage(6, 1), 5, '单栏时起始栏就是页码，减一页')
  assert.equal(prependLandingPage(3, 0), 0, '每页栏数非法时退回第 0 页，不产生 NaN')
  // 反向对照：不减这一页，就停在接进来那章的**第一页** —— 那正是「往回翻落到上一章开头」。
  assert.notEqual(prependLandingPage(8, 2), 4)
  assert.equal(Math.round(8 / 2), 4, '旧写法（只除以每页栏数）落在第 4 页 = 上一章第一页')
})

test('pageAlignmentPads 与 pageWindowShift 接起来：跨章那一步页码归零但绝不重复一栏', () => {
  // 第一章 5 栏、第二章 4 栏，双栏一屏两栏 → 垫一栏后页号是 0 起 3 页、第二章从第 3 页开始
  const starts = pageAlignmentStarts([5, 4], 2)
  const spans = [{ start: starts[0] / 2, end: starts[1] / 2 }, { start: starts[1] / 2, end: 6 }]
  assert.deepEqual(spans, [{ start: 0, end: 3 }, { start: 3, end: 6 }])
  // 第二章第一页（窗口第 3 页）就是窗口挪动的那一步：新页码 0，且起点是第二章的第 0 栏
  assert.deepEqual(pageWindowShift(spans, 3), { lead: 1, pageIndex: 0 })
  // 关键不变量：每一章的起始栏都是"一屏栏数"的倍数 ⇒ 上一章的右半格不可能是下一章的第一栏
  assert.deepEqual(pageAlignmentStarts([5, 4], 2).map(start => start % 2), [0, 0])
  assert.equal(starts[1] % 2, 0, '第二章必须落在偶数栏上，否则右半格会被看两次')
})
