import test from 'node:test'
import assert from 'node:assert/strict'
import { formatIntro } from '../src/lib/searchFilters.ts'

/**
 * 简介显示（用户 2026-10-09：「怎么这么显示，不大好，这简介有些不对」）。
 *
 * 00小说网的简介规则是「模板 + 尾部 `##(^|[。！？……；]+…)##$1<br>`」——服务端把替换
 * 应用后，简介里每个句末就带一个 `<br>`。前端按纯文本渲染，必须把 `<br>` 当断行、
 * 不能当字面量排出来。同时**不能**顺手剥任意尖括号：简介里 `3<5` 这种写法很常见。
 */

test('`<br>`（含自闭合与大小写）都换成换行，不留在正文里', () => {
  assert.equal(formatIntro('第一句。<br>第二句。'), '第一句。\n第二句。')
  assert.equal(formatIntro('甲<br/>乙'), '甲\n乙')
  assert.equal(formatIntro('甲<br />乙'), '甲\n乙')
  assert.equal(formatIntro('甲<BR>乙'), '甲\n乙')
})

test('去掉已知排版标签，但保留换行结构', () => {
  assert.equal(formatIntro('<p>一段话</p>'), '一段话')
  assert.equal(formatIntro('前<span class="x">中</span>后'), '前中后')
  assert.equal(formatIntro('<b>粗</b>与<i>斜</i>'), '粗与斜')
})

test('常见实体解码，`&amp;` 放最后避免二次解码', () => {
  assert.equal(formatIntro('a&nbsp;b'), 'a b')
  assert.equal(formatIntro('1&lt;2&gt;3'), '1<2>3')
  assert.equal(formatIntro('&quot;引号&quot;'), '"引号"')
  assert.equal(formatIntro('a&amp;b'), 'a&b')
  // 若是先解 &amp; 再解 &lt;，`&amp;lt;` 会被错解成 `<`；顺序对就仍是字面量
  assert.equal(formatIntro('&amp;lt;'), '&lt;')
})

test('不剥任意尖括号：`3<5` 这种正常文字不许被吃掉', () => {
  assert.equal(formatIntro('3<5 且 7>2'), '3<5 且 7>2')
})

test('多余空行收成一段、首尾空行去掉', () => {
  assert.equal(formatIntro('\n\n开头\n\n\n\n结尾\n\n'), '开头\n\n结尾')
})
