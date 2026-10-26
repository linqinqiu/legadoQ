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
  const api = read('../src/lib/api.ts')
  assert.match(api, /notes: \(sourceId: string, bookUrl: string/)
  assert.match(api, /addNote: \(write: BookNoteWrite\)/)
  assert.match(api, /updateNote: \(id: number, note: string\)/)
  assert.match(api, /deleteNote: \(id: number\)/)
  assert.match(api, /'\/api\/notes'/, '路径要写对')
})

test('阅读器：选中正文 → 浮层 → 保存，且偏移按章节内字符算', () => {
  const reader = read('../src/reader/ReaderScreen.tsx')
  assert.match(reader, /onMouseUp=\{onReaderMouseUp\}/, '阅读区要接 mouseup')
  assert.match(reader, /data-paragraph-index/, '段落要有索引（偏移换算的起点）')
  assert.match(reader, /paragraphStarts/, '段落起点表要在（章节内字符偏移）')
  assert.match(reader, /api\.addNote\(/, '保存要真的落库')
  // 浮层外壳在 PROPOSAL-019 F 里抽成了 `NoteToolbar.tsx`：这里钉"ReaderScreen 真的挂了它" +
  // "外壳标记在那一份里"，两边都判，抽走之后不许变成没人渲染的死组件。
  assert.match(reader, /<NoteToolbar/, '浮层要在（挂在 ReaderScreen 上）')
  assert.match(read('../src/reader/NoteToolbar.tsx'), /reader-note-toolbar/, '浮层外壳标记要在')
  assert.match(reader, /reader-note-highlight/, '正文要能画高亮')
})

test('阅读器：抽屉里有「笔记」面板，按书查看', () => {
  const reader = read('../src/reader/ReaderScreen.tsx')
  assert.match(reader, /notesPanel/, '面板开关要在')
  // 面板清单在 PROPOSAL-019 F 里抽成了 NotesPanel.tsx：钉「ReaderScreen 挂了它」+「清单在那一份里」。
  assert.match(reader, /<NotesPanel/, '面板要挂在抽屉里')
  assert.match(read('../src/reader/NotesPanel.tsx'), /reader-notes-list/, '面板要列得出来')
  assert.match(reader, /jumpToNote/, '点一条要能跳章')
})
