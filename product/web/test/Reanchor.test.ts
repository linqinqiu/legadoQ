import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { BookNote } from '../src/lib/api'
import { normalizeWithMap, reanchorNotes, relocateNote } from '../src/features/reader/notes/reanchor'

/**
 * 批注锚点重定位（STATUS 缺口：「锚点失效后无模糊重匹配」）。
 *
 * 源站改正文是常态：补一句、删个广告、把全角标点换成半角。偏移一漂，高亮画错行、
 * 点进去跳别处。这里钉的是「漂了要拉回来、拉不回来要说实话」这两件事。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const note = (over: Partial<BookNote> = {}): BookNote => ({
  id: 1, sourceId: 's', bookUrl: 'https://b/1', bookName: '书', chapterUrl: 'https://b/1/2',
  chapterIndex: 2, startOffset: 0, endOffset: 3, excerpt: '关键词', note: '',
  createdAt: 0, updatedAt: 0, paragraphAnchor: 'p0', positionChecksum: 'old', ...over,
})

test('归一化：去掉空白与标点，且每个字都记得回原文的下标', () => {
  const { text, map } = normalizeWithMap('他说：你好，世界')
  assert.equal(text, '他说你好世界')
  assert.deepEqual(map.slice(0, 4), [0, 1, 3, 4], '冒号与逗号被跳过，映射指回原文下标')
})

test('校验值相同就不动，返回同一个对象（调用方靠引用相等判断没变）', () => {
  const original = note({ positionChecksum: 'same' })
  const result = relocateNote(original, '关键词', 'same')
  assert.equal(result.status, 'exact')
  assert.equal(result.note, original)
})

test('正文前面插了字：按原文找到新位置，不是继续用旧偏移', () => {
  const result = relocateNote(note(), '前言两字：关键词。', 'new')
  assert.equal(result.status, 'relocated')
  assert.equal(result.note.startOffset, '前言两字：'.length)
  assert.equal(result.note.endOffset, result.note.startOffset + '关键词'.length)
  assert.equal(result.note.positionChecksum, 'new')
  assert.equal(result.note.stale, false)
})

test('标点与空白被改过：归一化后仍能找回，偏移落回原文', () => {
  const result = relocateNote(note({ excerpt: '他说：你好' }), '开头 他说 你好 结尾', 'new')
  assert.equal(result.status, 'relocated')
  assert.equal('开头 他说 你好 结尾'.slice(result.note.startOffset, result.note.startOffset + 5), '他说 你好')
})

test('同一句话出现多次：挪到离旧偏移最近的那一次', () => {
  const content = '关键词…中间隔开…关键词'
  const nearFirst = relocateNote(note({ startOffset: 0 }), content, 'new')
  assert.equal(nearFirst.note.startOffset, 0, '旧位置就在第一处，不该被甩到后面')
  const nearSecond = relocateNote(note({ startOffset: content.length - 3 }), content, 'new')
  assert.equal(nearSecond.note.startOffset, content.lastIndexOf('关键词'))
})

test('认不出来时说实话：位置不动，标 stale，界面据此提示「原文已变」', () => {
  const original = note({ startOffset: 40, endOffset: 43 })
  const result = relocateNote(original, '这一章整段被重写了，一个字都对不上。', 'new')
  assert.equal(result.status, 'stale')
  assert.equal(result.note.stale, true)
  assert.equal(result.note.startOffset, 40, '猜不出来就别乱挪')
  assert.equal(result.note.positionChecksum, 'new', '校验值要更新，否则每次渲染都重算一遍')
})

test('别的章的笔记不参与这一章的复算', () => {
  const other = note({ id: 9, chapterIndex: 7, positionChecksum: 'old' })
  const list = [other, note({ id: 1 })]
  const next = reanchorNotes(list, 2, '前言两字：关键词。', 'new')
  assert.equal(next[0], other, '第 7 章的笔记原样带过')
  assert.equal(next[1].startOffset, '前言两字：'.length)
})

test('没有任何笔记需要改时返回同一个数组，避免无谓重渲染', () => {
  const list = [note({ positionChecksum: 'same' })]
  assert.equal(reanchorNotes(list, 2, '关键词', 'same'), list)
})

test('接线：正文加载后重定位，面板把「原文已变」说出来', () => {
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /reanchorNotes\(list, chapter\.index, content, positionChecksum\)/, '正文与校验值变了就重算这一章')
  assert.match(screen, /只改内存，不写库/, '不把一次猜测固化进库')
  assert.match(read('../src/features/reader/notes/NotesPanel.tsx'), /原文已变，位置可能不准/, '认不出来要说出来')
})
