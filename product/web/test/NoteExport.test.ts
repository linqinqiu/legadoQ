import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * 笔记导出为 Markdown —— 补的是「能记下来却带不走」的缺口。
 *
 * 之前划线只存在 `book_note` 表里，界面上一条条看，想拿去别处用没有出路。
 * 这里钉的是导出结果的**形状**与**不丢信息**：
 * 1. 章名优先、缺了就退回「第 N 章」（不编造标题）；
 * 2. 原文一个字都不改（那是用户自己划的）；
 * 3. 多行原文要逐行加 `>`，否则引用块第二行就断了；
 * 4. 顺序按章、按章内位置 —— 导出的文件要是「读下来」的顺序；
 * 5. 空笔记也要出一份可读的文件，而不是空字符串。
 */

const require = createRequire(path.join(import.meta.dirname, '../package.json'))

// 走 tsx：直接 import 会被 tsconfig 的 jsx 影响，这里用 tsx 的 register 更稳。
const { notesToMarkdown, notesExportFileName, notesToMarkdown: render } = await import('../src/reader/noteExport.ts')

const note = (over: Record<string, unknown> = {}) => ({
  id: 1,
  sourceId: 'src',
  bookUrl: 'https://example.com/book/1',
  bookName: '测试书',
  chapterUrl: 'https://example.com/c1',
  chapterIndex: 0,
  startOffset: 0,
  endOffset: 10,
  excerpt: '原文一段',
  note: '',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

test('章名优先；没有章名时退回「第 N 章」，不编造标题', () => {
  const md = render(
    [note({ chapterIndex: 2, excerpt: '第三章的一句话' })],
    { bookName: '测试书' },
    { 2: '第二章 真正的标题' },
  )
  assert.match(md, /### 第二章 真正的标题/, '有章名就该用章名')

  const noTitle = render([note({ chapterIndex: 6, excerpt: 'x' })], { bookName: '书' })
  assert.match(noTitle, /### 第 7 章/, '缺章名时退回「第 N 章」（chapterIndex 0 起 → 显示 +1）')
  assert.doesNotMatch(noTitle, /### undefined/, '不许把 undefined 漏进文件')
})

test('原文一个字都不改', () => {
  const excerpt = '他说：「我不去。」——然后就走了。'
  const md = render([note({ excerpt })], { bookName: '书' })
  assert.ok(md.includes(`> ${excerpt}`), '原文必须原样出现在引用块里')
})

test('多行原文逐行加引用符，引用块不会断', () => {
  const md = render([note({ excerpt: '第一行\n第二行\n第三行' })], { bookName: '书' })
  assert.ok(md.includes('> 第一行'), '第一行要被引用')
  assert.ok(md.includes('> 第二行'), '第二行也要被引用 —— 只加第一行会让引用块断开')
  assert.ok(md.includes('> 第三行'), '第三行同理')
})

test('备注写在引用块之后', () => {
  const md = render([note({ excerpt: '原话', note: '我的批注' })], { bookName: '书' })
  const quoteAt = md.indexOf('> 原话')
  const remarkAt = md.indexOf('我的批注')
  assert.ok(quoteAt >= 0 && remarkAt > quoteAt, '备注要在原文下面')
})

test('顺序按章、再按章内位置 —— 导出的文件是「读下来」的顺序', () => {
  const md = render(
    [
      note({ id: 3, chapterIndex: 5, startOffset: 100, excerpt: '第五章靠后' }),
      note({ id: 1, chapterIndex: 1, startOffset: 50, excerpt: '第一章' }),
      note({ id: 2, chapterIndex: 5, startOffset: 10, excerpt: '第五章靠前' }),
    ],
    { bookName: '书' },
    { 1: '第一章标题', 5: '第五章标题' },
  )
  const i1 = md.indexOf('第一章')
  const i5a = md.indexOf('第五章靠前')
  const i5b = md.indexOf('第五章靠后')
  assert.ok(i1 < i5a && i5a < i5b, `顺序应为 1 → 5靠前 → 5靠后，实际 ${i1}/${i5a}/${i5b}`)
})

test('空笔记也出一份可读的文件，不是空字符串', () => {
  const md = render([], { bookName: '空书' })
  assert.ok(md.includes('# 空书'), '要有书名标题')
  assert.ok(md.includes('共 0 条'), '要说清一条都没有')
  assert.ok(md.length > 10, '不能是空字符串')
})

test('书名/作者/书源都写进头部', () => {
  const md = render([note()], { bookName: '书名甲', author: '作者乙', sourceId: 'https://src.example' })
  assert.ok(md.includes('# 书名甲'))
  assert.ok(md.includes('作者乙'))
  assert.ok(md.includes('https://src.example'))
})

test('文件名去掉文件系统不接受的字符', () => {
  assert.equal(notesExportFileName('正常书名'), '正常书名-笔记.md')
  const risky = notesExportFileName('a/b\\c:d*e?f"g<h>i|j')
  assert.doesNotMatch(risky, /[\\/:*?"<>|]/, `文件名不该含禁用字符：${risky}`)
  assert.ok(risky.endsWith('-笔记.md'))
  assert.equal(notesExportFileName(''), '未命名书籍-笔记.md', '空书名要有兜底')
})

test('导出不新增端点：仍是前端动作', () => {
  // 这条是护栏：若哪天有人把导出改成"加一个新端点"，这里会提醒他去核对 ApiCatalog 的 139 条。
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/reader/noteExport.ts'), 'utf8')
  assert.doesNotMatch(src, /api\.|fetch\(/, '导出必须是纯前端动作，不引入新的后端调用')
  assert.match(src, /export function notesToMarkdown/, '导出主函数要可单测')
})
