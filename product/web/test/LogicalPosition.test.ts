import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildParagraphStarts,
  checksumText,
  offsetToParagraph,
  paragraphAnchor,
} from '../src/reader/logicalPosition'
import { findFirstIntersectingParagraphIndex } from '../src/reader/readerInteractions'

test('LogicalPosition - starts: 段与段之间按一个换行累计', () => {
  assert.deepEqual(buildParagraphStarts([]), [])
  assert.deepEqual(buildParagraphStarts(['ab']), [0])
  assert.deepEqual(buildParagraphStarts(['ab', 'cde']), [0, 3])
  // 空字符串段不会来自 splitParagraphs，但纯函数仍要给出稳定结果
  assert.deepEqual(buildParagraphStarts(['', 'x']), [0, 1])
})

test('LogicalPosition - offsetToParagraph: 起点边界归属下一段', () => {
  const starts = [0, 6, 14]
  assert.deepEqual(offsetToParagraph(starts, 0), { index: 0, within: 0 })
  assert.deepEqual(offsetToParagraph(starts, 5), { index: 0, within: 5 })
  assert.deepEqual(offsetToParagraph(starts, 6), { index: 1, within: 0 })
  assert.deepEqual(offsetToParagraph(starts, 13), { index: 1, within: 7 })
  assert.deepEqual(offsetToParagraph(starts, 14), { index: 2, within: 0 })
})

test('LogicalPosition - offsetToParagraph: 越界与非法值夹取', () => {
  const starts = [0, 6]
  assert.deepEqual(offsetToParagraph(starts, 999), { index: 1, within: 993 })
  assert.deepEqual(offsetToParagraph(starts, -5), { index: 0, within: 0 })
  assert.deepEqual(offsetToParagraph(starts, Number.NaN), { index: 0, within: 0 })
  assert.deepEqual(offsetToParagraph([], 10), { index: 0, within: 0 })
})

test('LogicalPosition - anchor: 稳定且不为负', () => {
  assert.equal(paragraphAnchor(0), 'p0')
  assert.equal(paragraphAnchor(12), 'p12')
  assert.equal(paragraphAnchor(-1), 'p0')
  assert.equal(paragraphAnchor(2.9), 'p2')
})

test('LogicalPosition - checksum: 同文同值、改一个字就变', () => {
  assert.equal(checksumText(''), '811c9dc5')
  assert.equal(checksumText('abc'), checksumText('abc'))
  assert.notEqual(checksumText('abc'), checksumText('abd'))
  assert.match(checksumText('正文'), /^[0-9a-f]{8}$/)
})

test('LogicalPosition - 视口相交段：页首半段也要算，而不是跳到下一段', () => {
  const viewport = { top: 100, bottom: 300, left: 0, right: 500 }
  const paragraphs = [
    { index: 0, rect: { top: 20, bottom: 180, left: 0, right: 500 } },
    { index: 1, rect: { top: 190, bottom: 260, left: 0, right: 500 } },
  ]
  assert.equal(findFirstIntersectingParagraphIndex(paragraphs, viewport), 0)
  assert.equal(
    findFirstIntersectingParagraphIndex([{ index: 2, rect: { top: 320, bottom: 360, left: 0, right: 500 } }], viewport),
    0,
    '一段都不在视口里时回 0，交给调用方兜底',
  )
})
