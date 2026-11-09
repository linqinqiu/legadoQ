import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 笔记 / 划线的接线判据（PROPOSAL-019 E）。行为那一条（划线后刷新仍在）在
 * `tools/verify/note-check.mjs`（要起真浏览器），这里钉的是"产品真的接了这些线"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('api 客户端有笔记的四条路（读 / 增 / 改 / 删）', () => {
  const api = read('../src/lib/api/domains/reader.ts')
  // 0.2.14：按域拆分后是 `notes = { list, add, update, remove }`，判据盯「四条路都在」。
  assert.match(api, /list: \(sourceId: string, bookUrl: string/)
  assert.match(api, /add: \(write: BookNoteWrite\)/)
  assert.match(api, /update: \(id: number, note: string\)/)
  assert.match(api, /remove: \(id: number\)/)
  assert.match(api, /'\/api\/notes'/, '路径要写对')
})

test('阅读器：选中正文 → 浮层 → 保存，且偏移按章节内字符算', () => {
  const reader = read('../src/features/reader/ReaderScreen.tsx')
  // 画布本身搬进了 ReaderBody；mouseup 接线在组件里，段落索引仍在阅读器。
  const body = read('../src/features/reader/ReaderBody.tsx')
  assert.match(body, /onMouseUp=\{events\.onMouseUp\}/, '阅读区要接 mouseup')
  assert.match(reader, /onMouseUp:\s*onReaderMouseUp/, '阅读器要把 mouseup 传给画布')
  assert.match(reader, /data-paragraph-index/, '段落要有索引（偏移换算的起点）')
  assert.match(reader, /paragraphStarts/, '段落起点表要在（章节内字符偏移）')
  assert.match(reader, /api\.addNote\(/, '保存要真的落库')
  // 浮层外壳在 PROPOSAL-019 F 里抽成了 `NoteToolbar.tsx`：这里钉"ReaderScreen 真的挂了它" +
  // "外壳标记在那一份里"，两边都判，抽走之后不许变成没人渲染的死组件。
  assert.match(reader, /<NoteToolbar/, '浮层要在（挂在 ReaderScreen 上）')
  assert.match(read('../src/features/reader/notes/NoteToolbar.tsx'), /reader-note-toolbar/, '浮层外壳标记要在')
  assert.match(reader, /reader-note-highlight/, '正文要能画高亮')
})

test('阅读器：抽屉里有「笔记」面板，按书查看', () => {
  const reader = read('../src/features/reader/ReaderScreen.tsx')
  // 0.2.15：目录抽屉整块拆进 ReaderCatalog.tsx（状态与渲染一起搬走），
  // 判据因此改成「父组件传 notesPanel / onJumpNote」+「抽屉那一份挂了 NotesPanel」。
  const catalog = read('../src/features/reader/ReaderCatalog.tsx')
  assert.match(reader, /notesPanel/, '面板开关要在')
  assert.match(reader, /onJumpNote=\{jumpToNote\}/, '点一条要能跳章')
  assert.match(catalog, /<NotesPanel/, '面板要挂在抽屉里')
  assert.match(read('../src/features/reader/notes/NotesPanel.tsx'), /reader-notes-list/, '面板要列得出来')
})
