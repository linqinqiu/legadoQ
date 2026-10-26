import test from 'node:test'
import assert from 'node:assert/strict'
import { layout, charWidth } from '../src/reader/typeset/layoutEngine'
import { hashContent, serializePaginationKey, type TypesetParams } from '../src/reader/typeset/typesetParams'

/**
 * 无 DOM 布局引擎的判据（用户 2026-10-24：用纯数学排版替换基于 DOM 测量的分页）。
 *
 * 引擎不碰任何 DOM / Canvas，所以这里能在 Node 下直接跑，且结果与 Worker、主线程一致。
 * 几条判据分别钉住：字符宽度模型、单调递增与合法索引、图片占位不推进字符偏移且增加页数、
 * 双栏约 2x 单栏、空文本兜底。
 */

const base: TypesetParams = {
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.5,
  paragraphSpacing: 12,
  marginX: 50,
  marginTop: 40,
  marginBottom: 40,
  viewportWidth: 800,
  viewportHeight: 1000,
  columnMode: 'single',
  imagePlaceholderRatio: 0.3,
}

const cn = (n: number) => '中'.repeat(n)

test('charWidth - 纯数学宽度模型（CJK / ASCII / 空格 / 其它）', () => {
  assert.equal(charWidth('中', base), base.fontSize, 'CJK 宽 = fontSize')
  assert.equal(charWidth('A', base), base.fontSize * 0.6, 'ASCII 字母宽 = fontSize*0.6')
  assert.equal(charWidth('1', base), base.fontSize * 0.6, 'ASCII 数字宽 = fontSize*0.6')
  assert.equal(charWidth(' ', base), base.fontSize * 0.5, 'ASCII 空格宽 = fontSize*0.5')
  // '!' 属 ASCII 常见半角符号 → 0.6；0.5 分支留给非 ASCII、非 CJK 的字符（如中间点 ·）
  assert.equal(charWidth('!', base), base.fontSize * 0.6, 'ASCII 半角符号宽 = fontSize*0.6')
  assert.equal(charWidth('·', base), base.fontSize * 0.5, '非 ASCII/非 CJK 字符宽 = fontSize*0.5')
  assert.equal(charWidth('　', base), base.fontSize, '全角空格归入 CJK')
})

test('hashContent / serializePaginationKey - 指纹与缓存键', () => {
  assert.equal(hashContent('abc'), hashContent('abc'), '相同内容指纹一致')
  assert.notEqual(hashContent('abc'), hashContent('abd'), '不同内容指纹不同')
  assert.equal(typeof hashContent(''), 'string')

  const key = serializePaginationKey('book1', 'url1', 'h1', base)
  const parts = key.split('|')
  // 顺序：bookId|chapterUrl|contentHash|fontFamily|fontSize|lineHeight|marginX|
  // marginTop|marginBottom|viewportWidth|viewportHeight|columnMode|imagePlaceholderRatio
  assert.deepEqual(parts, [
    'book1', 'url1', 'h1',
    'serif', '18', '1.5', '50', '40', '40', '800', '1000', 'single', '0.3',
  ])
  assert.equal(parts.length, 13, '键固定 13 段（不含 paragraphSpacing）')
})

test('layout 纯中文 - startOffsets 单调递增、索引合法、columnCount>0、lineCount 合理', () => {
  // 用小视口逼出多栏，让单调性真正被检验
  const params: TypesetParams = { ...base, viewportHeight: 200 }
  const text = cn(200)
  const r = layout(text, params)

  assert.ok(r.columnCount > 0, '至少有一栏')
  assert.equal(r.columnCount, r.startOffsets.length, 'columnCount === startOffsets.length')
  assert.ok(r.lineCount >= r.columnCount, '总行数不少于栏数')
  assert.ok(r.lineCount > 0, '非空章节行数 > 0')

  // 单调递增
  for (let i = 1; i < r.startOffsets.length; i++) {
    assert.ok(r.startOffsets[i] > r.startOffsets[i - 1], `startOffsets 必须严格递增 @${i}`)
  }
  // 每一项都是 text 的合法字符索引
  for (const o of r.startOffsets) {
    assert.ok(o >= 0 && o <= text.length, `offset ${o} 越界`)
  }
  // 首栏恒为 0
  assert.equal(r.startOffsets[0], 0)
})

test('layout 含图片占位 - 图片不推进字符偏移，且因占位高度增加页数', () => {
  const params: TypesetParams = { ...base, viewportHeight: 300 } // 小视口：一栏约 8 行
  const before = cn(300)
  const after = cn(300)
  const imageLine = '![封面](https://example.com/a.png)'
  const text = `${before}\n${imageLine}\n${after}`

  const imgStart = before.length + 1            // before 之后是 '\n'
  const imgEnd = imgStart + imageLine.length    // 图片段在 text 中的真实区间 [imgStart, imgEnd)

  const r = layout(text, params)

  // 没有一栏的 startOffsets 落在图片段的字符区间内（图片非文本，不计入字符偏移）
  for (const o of r.startOffsets) {
    assert.ok(o <= imgStart || o >= imgEnd, `offset ${o} 不应落在图片区间内 [${imgStart}, ${imgEnd})`)
  }
  assert.ok(r.columnCount > 0, '至少一栏')

  // 对照：把图片段删掉（换成空段落），页数应减少、行数应减少 —— 证明图片确实贡献了占位高度
  const textNoImage = `${before}\n\n${after}`
  const rNo = layout(textNoImage, params)
  assert.ok(r.columnCount > rNo.columnCount, '图片占位高度使页数增加')
  assert.ok(r.lineCount > rNo.lineCount, '图片占位行使总行数增加')
})

test('layout 双栏 vs 单栏 - 同文本下双栏栏数约为单栏的 2 倍', () => {
  const text = cn(2000)
  const single = layout(text, { ...base, columnMode: 'single' })
  const double = layout(text, { ...base, columnMode: 'double' })

  assert.ok(single.columnCount > 0, '单栏至少一栏')
  assert.ok(double.columnCount > single.columnCount, '双栏栏数必须多于单栏')
  const ratio = double.columnCount / single.columnCount
  // 双栏单栏宽约减半，行数翻倍；扣除中央 40px 间隙，比值稳定在 ~2.1x
  assert.ok(ratio >= 1.5 && ratio <= 3.0, `双栏/单栏比值应约 2x，实际 ${ratio.toFixed(2)}`)
})

test('layout 空文本 - 兜底返回一栏、零行', () => {
  const r = layout('', base)
  assert.deepEqual(r.startOffsets, [0])
  assert.equal(r.columnCount, 1)
  assert.equal(r.lineCount, 0)
})
