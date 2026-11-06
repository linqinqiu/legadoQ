import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReaderScreen } from '../src/features/reader/ReaderScreen'
import { defaultReaderSettings } from '../src/features/reader/readerSettings'
import type { OpenBook } from '../src/lib/openBook'

/**
 * 阅读器冒烟渲染 —— 这条判据是补上的，因为它缺了整整两天。
 *
 * 2026-11-04 的架构重排把 TTS 从 `ReaderScreen` 拆成 `ReaderTtsManager` + `TtsContext`，
 * 但把 Provider 留在了 `ReaderTtsManager`（`ReaderScreen` 的子节点），而 `ReaderScreen`
 * 自己又 `useTts()` 去读它。父组件读不到子组件提供的 Context，于是**每开一本书**都抛
 * `useTts 必须在 <ReaderTtsManager> 内部使用`，被 ErrorBoundary 收成"阅读器崩了"。
 *
 * 当时全站 118 份前端判据没有一份渲染过阅读器：`tsc` 不跑组件，现有测试只查源码字符串，
 * 于是"编译通过 + 判据全绿 + 核心功能全崩"同时成立。这条测试就是那个缺口的补丁。
 *
 * 判据分两层：
 * ① 渲染层 —— 静态渲染必须画出骨架（章名 / 书名 / 五个入口），且不含兜底文案；
 * ② 结构层 —— 朗读状态只能有一个持有者：ReaderScreen 调 hook 并下发，ReaderTtsManager 消费。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src', 'features', 'reader')
const read = (name: string) => fs.readFileSync(path.join(SRC, name), 'utf8')

const openBook: OpenBook = {
  bookUrl: 'https://smoke.example/book/1',
  details: {
    name: '冒烟书',
    author: '作者甲',
    coverUrl: '',
    intro: '',
    kind: '',
    lastChapter: '',
    tocUrl: 'https://smoke.example/toc/1',
  } as never,
  chapters: [
    { title: '第一章 起点', url: 'https://smoke.example/c/1' },
    { title: '第二章 出发', url: 'https://smoke.example/c/2' },
  ] as never,
}

const render = () =>
  renderToStaticMarkup(
    React.createElement(ReaderScreen, {
      openBook,
      startIndex: 0,
      settings: defaultReaderSettings,
      onSettingsChange: () => undefined,
      onClose: () => undefined,
    }),
  )

test('阅读器能静态渲染：章名、书名、五个入口都在，且不落到兜底面板', () => {
  const html = render()

  // 反向对照放在最前：崩掉时 ErrorBoundary 的文案就是这句，出现即失败
  assert.doesNotMatch(html, /阅读器崩了/, '渲染期抛错被兜底接住了 —— 先看控制台那行原始错误')
  assert.doesNotMatch(html, /useTts 必须在/, '朗读上下文没接上：Provider 必须在 ReaderScreen 这一层')

  assert.match(html, /class="reader-workspace/, '阅读器外壳没画出来')
  assert.match(html, /第一章 起点/, '当前章名没渲染（目录与页眉都要用它）')
  assert.match(html, /冒烟书/, '书名没渲染')
  for (const entry of ['目录', '搜书', '笔记', '朗读', '设置']) {
    assert.match(html, new RegExp(entry), `顶栏入口「${entry}」不见了`)
  }
})

test('朗读状态只有一个持有者：ReaderScreen 调 hook 并下发，ReaderTtsManager 只消费', () => {
  const screen = read('ReaderScreen.tsx')
  const manager = read('ReaderTtsManager.tsx')

  // ① 阅读器自己调 hook（参数齐全），并且不再从 Context 读状态
  assert.match(screen, /const ttsCtx = useReaderTts\(/, '朗读 hook 必须由阅读器自己调用')
  assert.match(screen, /<TtsContext\.Provider value=\{ttsCtx\}>/, 'Provider 必须由阅读器往下发')
  assert.doesNotMatch(screen, /=\s*useTts\(\)/, '阅读器不该消费 Context：它才是提供方')

  // ② 浮层只消费，不再自己调 hook —— 两个实例就是两条声音、两份播放进度
  assert.match(manager, /const tts = useTts\(\)/, '浮层应从 Context 取朗读状态')
  assert.doesNotMatch(manager, /useReaderTts\(/, '浮层不能再调 useReaderTts：hook 只能有一个实例')
  assert.doesNotMatch(manager, /<TtsContext\.Provider/, 'Provider 不该再出现在浮层里（父组件读不到）')
})
