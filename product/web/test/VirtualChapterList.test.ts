import test from 'node:test'
import assert from 'node:assert/strict'
import { assertScalesLinearly, assertWithinCeiling } from './perfCriteria.ts'
import fs from "node:fs"
import path from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { VirtualChapterList } from "../src/reader/VirtualChapterList"
import { TOC_ROW_HEIGHT } from "../src/reader/readerInteractions"

import { computeCenterScrollOffset, computeVirtualWindow } from '../src/reader/virtualSlice.js'

/**
 * 判据沿用这两个名字，但**实现是产品那一份**：以前这里手写一份 `computeVirtualSlice` 去对
 * `ReaderScreen.tsx` 里内联的那一行算式，两边各改各的都不会红 —— 现在只有一个实现。
 */
const computeVirtualSlice = computeVirtualWindow
const computeAutoScrollOffset = computeCenterScrollOffset

// -----------------------------------------------------------------------------
// Tier 1: Core Feature Tests (5,000 Chapter TOC & Virtualization Math)
// -----------------------------------------------------------------------------

test('VirtualChapterList - Tier 1: Total scroll height linear scaling (5,000 chapters)', () => {
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 180000, '5000 * 36px must equal 180,000px')
})

test('VirtualChapterList - Tier 1: Initial viewport renders bounded slice (<= 25-30 nodes)', () => {
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 20) // ceil(500/36) + 6 = 14 + 6 = 20
  assert.equal(slice.renderedCount, 20)
  assert.equal(slice.offsetY, 0)
  assert.ok(slice.renderedCount <= 30, `Expected <= 30 nodes, got ${slice.renderedCount}`)
})

test('VirtualChapterList - Tier 1: Middle-scroll slice calculation (chapter 1,000) and item offset', () => {
  const chapter1000ScrollTop = 1000 * 36 // 36,000px
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: chapter1000ScrollTop,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.startIndex, 994) // 1000 - 6
  assert.equal(slice.endIndex, 1020) // ceil(36500/36) + 6 = 1014 + 6 = 1020
  assert.equal(slice.renderedCount, 26)
  assert.equal(slice.offsetY, 994 * 36) // 35,784px
  assert.ok(slice.renderedCount <= 30)

  // Verify specific item absolute position
  const itemIndex = 1000
  const itemTop = itemIndex * 36
  assert.equal(itemTop, 36000)
  assert.ok(itemIndex >= slice.startIndex && itemIndex < slice.endIndex, 'Target chapter 1000 must be in slice')
})

test('VirtualChapterList - Tier 1: End-of-list scroll clamping & boundary protection', () => {
  const maxScrollTop = 5000 * 36 - 500 // 179,500px
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: maxScrollTop,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.endIndex, 5000)
  assert.equal(slice.startIndex, 4980) // floor(179500/36) - 6 = 4986 - 6 = 4980
  assert.equal(slice.renderedCount, 20)
  assert.equal(slice.offsetY, 4980 * 36)
  assert.ok(slice.renderedCount <= 30)
})

test('VirtualChapterList - Tier 1: Auto-scroll viewport centering math', () => {
  // Center chapter 2,500 in a 500px viewport with 36px item height
  const offset = computeAutoScrollOffset(2500, 36, 500, 5000)
  // Expected: 2500 * 36 - (500/2 - 36/2) = 90000 - (250 - 18) = 90000 - 232 = 89,768px
  assert.equal(offset, 89768)

  // Validate centering condition: scrollTop + halfViewport == itemCenter
  const viewportCenterInContainer = offset + 500 / 2
  const itemCenterInContainer = 2500 * 36 + 36 / 2
  assert.equal(viewportCenterInContainer, itemCenterInContainer)

  // Near top boundary: chapter 2 should clamp cleanly without negative offset
  const topOffset = computeAutoScrollOffset(2, 36, 500, 5000)
  // 2 * 36 - 232 = 72 - 232 = -160 => clamped to 0
  assert.equal(topOffset, 0)

  // Near bottom boundary: chapter 4998 should clamp to maxScroll (179,500px)
  const bottomOffset = computeAutoScrollOffset(4998, 36, 500, 5000)
  assert.equal(bottomOffset, 179500)
})

// -----------------------------------------------------------------------------
// Tier 2: Boundary & Corner Cases
// -----------------------------------------------------------------------------

test('VirtualChapterList - Tier 2: Zero chapters handling (empty list)', () => {
  const slice = computeVirtualSlice({
    totalCount: 0,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 0)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 0)
  assert.equal(slice.renderedCount, 0)
  assert.equal(slice.offsetY, 0)

  const offset = computeAutoScrollOffset(0, 36, 500, 0)
  assert.equal(offset, 0)
})

test('VirtualChapterList - Tier 2: Single chapter boundary handling', () => {
  const slice = computeVirtualSlice({
    totalCount: 1,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 36)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 1)
  assert.equal(slice.renderedCount, 1)
  assert.equal(slice.offsetY, 0)

  const offset = computeAutoScrollOffset(0, 36, 500, 1)
  assert.equal(offset, 0)
})

test('VirtualChapterList - Tier 2: Viewport height exceeding total content height', () => {
  const slice = computeVirtualSlice({
    totalCount: 10,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 1000, // content height is 360px < 1000px
  })
  assert.equal(slice.totalHeight, 360)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 10)
  assert.equal(slice.renderedCount, 10)
  assert.equal(slice.offsetY, 0)
})

test('VirtualChapterList - Tier 2: Negative/overscroll scrollTop & NaN defense', () => {
  // Negative scrollTop (e.g. mobile rubber-band bounce)
  const negSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: -350,
    viewportHeight: 500,
  })
  assert.equal(negSlice.startIndex, 0)
  assert.equal(negSlice.offsetY, 0)

  // Excessive overscroll past bottom
  const overSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 999999,
    viewportHeight: 500,
  })
  assert.equal(overSlice.endIndex, 5000)
  assert.ok(overSlice.renderedCount <= 30)

  // NaN scrollTop defense
  const nanSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: NaN,
    viewportHeight: 500,
  })
  assert.equal(nanSlice.startIndex, 0)
  assert.equal(nanSlice.renderedCount, 20)
})

test('VirtualChapterList - Tier 2: Extreme scale benchmark (50,000 chapters)', () => {
  // 预热一轮：第一次跑付 V8 冷编译的账，直接拿它当分母会让比值假性偏小
  for (let i = 0; i < 200; i++) computeVirtualSlice({ totalCount: 50000, itemHeight: 36, scrollTop: i * 36, viewportHeight: 600, overscan: 6 })
  const start = performance.now()
  const iterations = 1000
  for (let i = 0; i < iterations; i++) {
    const scrollTop = (i / iterations) * (50000 * 36 - 600)
    const slice = computeVirtualSlice({
      totalCount: 50000,
      itemHeight: 36,
      scrollTop,
      viewportHeight: 600,
      overscan: 6,
    })
    assert.ok(slice.renderedCount <= 32, `Rendered count ${slice.renderedCount} must stay bounded`)
    assert.ok(slice.startIndex >= 0 && slice.endIndex <= 50000)
  }
  const elapsed = performance.now() - start
  // 原来钉的是"1,000 次切片 < 50ms"，那测的是这台机器此刻有多闲（见 web/test/perfCriteria.ts）。
  // 换成量级判据：切片次数 4 倍，时间不许超线性涨；结构性上限（renderedCount <= 32）上面逐次在判。
  const againStart = performance.now()
  for (let i = 0; i < iterations * 4; i++) {
    const scrollTop = (i / (iterations * 4)) * (50000 * 36 - 600)
    const slice = computeVirtualSlice({
      totalCount: 50000,
      itemHeight: 36,
      scrollTop,
      viewportHeight: 600,
      overscan: 6,
    })
    assert.ok(slice.renderedCount <= 32, `Rendered count ${slice.renderedCount} must stay bounded`)
    assert.ok(slice.startIndex >= 0 && slice.endIndex <= 50000)
  }
  assertScalesLinearly({ name: '50,000 项虚拟切片 1,000→4,000 次', smallMs: elapsed, bigMs: performance.now() - againStart, dataFactor: 4 })
})


// ———— AI-2 任务 C·模块 3「目录虚拟列表」补的两条（撞 key 与行高双写）————

test('同 url 的两章都要渲染得出：key 带章节序号（服务端不按地址去重）', () => {
  const chapters = [
    { index: 0, title: '第1章 上', url: '/c/dup' },
    { index: 1, title: '第1章 下', url: '/c/dup' },
  ]
  const html = renderToStaticMarkup(React.createElement(VirtualChapterList, {
    chapters, activeChapterIndex: 0, onSelect: () => {}, itemHeight: TOC_ROW_HEIGHT, overscan: 8,
  }))
  assert.match(html, /第1章 上/, '第一行在')
  assert.match(html, /第1章 下/, '同址的第二行不能因为撞 key 就消失')
  // 反向对照：裸 url 当 key 的写法不许回来 —— React 重复 key 只 warning，门禁与页面都看不见
  // 0.8.2 拆组：组件搬进了 VirtualChapterList.tsx，两面都扫（ReaderScreen 那半是防它把行内联回去）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'reader', 'VirtualChapterList.tsx'), 'utf8')
    + fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'reader', 'ReaderScreen.tsx'), 'utf8')
  assert.doesNotMatch(src, /key=\{chapter\.url\}/)
})

test('行高只有一个来源：TOC_ROW_HEIGHT 必须等于样式表里的 --row-h-list', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
  const declared = Number(css.match(/--row-h-list:\s*(\d+(?:\.\d+)?)px/)?.[1])
  assert.ok(declared > 0, '`--row-h-list` 得在样式表里真存在着')
  assert.equal(TOC_ROW_HEIGHT, declared,
    `虚拟化按 ${TOC_ROW_HEIGHT}px 算「第 i 行位移 = i × 行高」，样式却画 ${declared}px —— 5,000 章滚到底会差出整屏`)
})

/**
 * 这套判据从前是"手写一份切片算式对镜自照"：产品里 `ReaderScreen.tsx` 内联一行
 * `Math.floor(scrollTop / itemHeight) - overscan`，测试里另写一份 `computeVirtualSlice`，
 * 两边各改各的、谁也红不了（AGENTS §5「按键表与处理器必须同源」同一个病）。
 * 现在实现只有一份，所以这条判的是"不许再长回两份"。
 */
test('目录切片只有一份实现：产品引 src/virtualSlice，判据不许自己手写', () => {
  // 0.8.2 拆组：切片算式随 VirtualChapterList 搬进 VirtualChapterList.tsx，两面都读 ——
  // 正向三条由新那份满足，反向「内联不许回来」两面同扫（更严：ReaderScreen 也不能内联）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'reader', 'VirtualChapterList.tsx'), 'utf8')
    + fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'reader', 'ReaderScreen.tsx'), 'utf8')
  assert.match(src, /from '\.\/virtualSlice'/, '阅读器没再引那份共用算式 —— 是不是又内联回去了？')
  assert.match(src, /computeVirtualWindow\(/, '目录窗口不是算出来的，就是硬写的')
  assert.match(src, /computeCenterScrollOffset\(/, '「跳到正在读那一章」的定位算式也要走同一处')
  // 反向对照：把内联算式改回来必须当场红 —— 否则这三条是恒真的
  assert.doesNotMatch(src, /Math\.floor\(scrollTop \/ itemHeight\)/,
    '内联的 `Math.floor(scrollTop / itemHeight)` 又回来了，那份共用的 virtualSlice 就成了没人引的死代码')

  const judge = fs.readFileSync(path.resolve(import.meta.dirname, 'VirtualChapterList.test.ts'), 'utf8')
  assert.match(judge, /from '\.\.\/src\/reader\/virtualSlice(\.js)?'/, '判据必须引 src 那一份实现')
  assert.doesNotMatch(judge, /function computeVirtual(Slice|Window)/,
    '判据里不许再定义第二份切片算式，它只能 import 产品那一份')

  // 判据之间互相 import 实现 = 一处改了另一处不会红（同形状的病，登记着还没收干净）
  const scenario = fs.readFileSync(path.resolve(import.meta.dirname, 'TOCPerformanceScenario.test.ts'), 'utf8')
  assert.doesNotMatch(scenario, /from '\.\/VirtualChapterList\.test/,
    '另一份测试里借实现已经过一次，这条不许它回来')
})

/**
 * 改的是产品那份算式，所以判据得真渲染一次产品组件：
 * "只挂窗口内那几十行"与"上下垫高凑出总滚动高度"这两件事必须由 DOM 说。
 */
test('5,000 章的目录真渲染时只挂窗口内那些行，其余靠垫高', () => {
  const chapters = Array.from({ length: 5000 }, (_, i) => ({ index: i, title: `第${i + 1}章`, url: `/c/${i}` }))
  const html = renderToStaticMarkup(React.createElement(VirtualChapterList, {
    chapters, activeChapterIndex: 0, onSelect: () => {}, itemHeight: TOC_ROW_HEIGHT, overscan: 8,
  }))
  const slice = computeVirtualSlice({
    totalCount: 5000, itemHeight: TOC_ROW_HEIGHT, scrollTop: 0, viewportHeight: 600, overscan: 8,
  })
  const rows = (html.match(/reader-chapter-item/g) ?? []).length
  assert.equal(rows, slice.renderedCount, `挂了 ${rows} 行，而共用算式说该挂 ${slice.renderedCount} 行`)
  assert.ok(rows > 0 && rows <= 40, `5,000 章的目录不该把整本挂上 DOM（实际 ${rows} 行）`)
  assert.match(html, /第1章/, '窗口开头那几行要在')
  assert.ok(!html.includes('第5000章'), '窗口外的行不许出现在 DOM 里')
  assert.ok(html.includes(`height:${slice.bottomSpacer}px`), '底下那段垫高得凑出整表高度，否则滚不动也不报错')
  // 样本自证：窗口必须远小于全表，否则"只挂几十行"这条是在演空戏
  assert.ok(5000 - slice.renderedCount > 4_000, '夹具坏了 —— 窗口没比全表小，前面的判据不算证据')
})
