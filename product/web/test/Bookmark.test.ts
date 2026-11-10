import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { BookNote } from '../src/lib/api'
import { bookmarkExcerpt, bookmarkPayload, findBookmarkAt } from '../src/features/reader/notes/bookmark'
import { filterNotes, noteCounts } from '../src/features/reader/notes/noteFilter'

/**
 * 书签（product/docs/待定功能.md 的「待定」落地，2026-11-06）。
 *
 * 边界：**只标位置，不要求选中正文**；同一段落只留一条；再点一次取消。
 * 手势与浮层没法在 node 里演，所以这里钉三件能算错的事：判重、摘要、写入体；
 * 另外钉住"三处入口都真的接上了"，防止只加了个没人调用的模块。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const note = (over: Partial<BookNote> = {}): BookNote => ({
  id: 1, sourceId: 's', bookUrl: 'https://b/1', bookName: '书', chapterUrl: 'https://b/1/2',
  chapterIndex: 2, startOffset: 100, endOffset: 100, excerpt: '那一段的开头', note: '',
  createdAt: 0, updatedAt: 0, bookmark: true, paragraphAnchor: 'p-0007', ...over,
})

test('判重 - 同一段落只留一条书签，划线不算', () => {
  const list = [
    note({ id: 1, chapterIndex: 2, paragraphAnchor: 'p-0007' }),
    note({ id: 2, chapterIndex: 2, paragraphAnchor: 'p-0009' }),
    note({ id: 3, chapterIndex: 3, paragraphAnchor: 'p-0007' }),
    note({ id: 4, chapterIndex: 2, paragraphAnchor: 'p-0007', bookmark: false }),
  ]
  assert.equal(findBookmarkAt(list, 2, 'p-0007', 0)?.id, 1, '同章同段落命中')
  assert.equal(findBookmarkAt(list, 2, 'p-0009', 0)?.id, 2)
  assert.equal(findBookmarkAt(list, 3, 'p-0007', 0)?.id, 3, '别的章的同名段落不算')
  assert.equal(findBookmarkAt(list, 2, 'p-0011', 0), undefined)
})

test('判重 - 老数据没有段落锚点时退回字符偏移，不是永远判不重', () => {
  const list = [note({ id: 5, paragraphAnchor: null, startOffset: 321 })]
  assert.equal(findBookmarkAt(list, 2, null, 321)?.id, 5)
  assert.equal(findBookmarkAt(list, 2, null, 322), undefined)
})

test('摘要 - 压掉换行与多余空白，超过 40 字截断', () => {
  assert.equal(bookmarkExcerpt('第一行\n第二行'), '第一行 第二行')
  assert.equal(bookmarkExcerpt('  前后都有空格  '), '前后都有空格')
  const long = '一'.repeat(60)
  assert.equal(bookmarkExcerpt(long), `${'一'.repeat(40)}…`)
  assert.equal(bookmarkExcerpt(''), '')
})

test('写入体 - 偏移落在段落首字符上，bookmark 为真，摘要来自正文', () => {
  const payload = bookmarkPayload({
    sourceId: 's', bookUrl: 'https://b/1', bookName: '书',
    chapterIndex: 2, chapterUrl: 'https://b/1/2',
    charOffset: 100, paragraphAnchor: 'p-0007', positionChecksum: 'abc',
    text: '那一段的开头，后面还有很多字。',
  })
  assert.ok(payload)
  assert.equal(payload!.startOffset, 100)
  assert.equal(payload!.endOffset, 100, '书签不是区间：起止相同')
  assert.equal(payload!.bookmark, true)
  assert.equal(payload!.note, '')
  assert.equal(payload!.excerpt, '那一段的开头，后面还有很多字。')
  assert.equal(payload!.paragraphAnchor, 'p-0007')
})

test('写入体 - 没有章节地址或没有正文时不写库（不造假书签）', () => {
  const base = {
    sourceId: 's', bookUrl: 'https://b/1', bookName: '书', chapterIndex: 0,
    charOffset: 0, paragraphAnchor: 'p-0000', positionChecksum: null, text: '正文',
  }
  assert.equal(bookmarkPayload({ ...base, chapterUrl: '' }), null)
  assert.equal(bookmarkPayload({ ...base, chapterUrl: 'https://b/1/0', text: '   ' }), null)
})

test('筛选 - 三档计数与列表一致，书签不混进划线里', () => {
  const list = [note({ id: 1 }), note({ id: 2, bookmark: false }), note({ id: 3, bookmark: false })]
  assert.deepEqual(noteCounts(list), { all: 3, marks: 2, bookmarks: 1 })
  assert.deepEqual(filterNotes(list, 'all').map(n => n.id), [1, 2, 3])
  assert.deepEqual(filterNotes(list, 'marks').map(n => n.id), [2, 3])
  assert.deepEqual(filterNotes(list, 'bookmarks').map(n => n.id), [1])
})

test('三处入口都接上了：顶栏 / 旧工具栏 / 笔记面板', () => {
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /const toggleBookmark = async/, '阅读器要有加 / 取消书签的动作')
  assert.match(screen, /api\.addNote\(payload\)/, '新建走同一条笔记接口，不另造端点')
  assert.match(screen, /api\.deleteNote\(existing\.id\)/, '再点一次是取消')
  assert.match(screen, /readLogicalPosition\(chapter\)/, '位置取当前视口第一段，与保存进度同一套算法')
  assert.match(read('../src/features/reader/Md3Chrome.tsx'), /md3-topbar-bookmark/, '默认 MD3 顶栏有入口')
  assert.match(read('../src/features/reader/ReaderHeader.tsx'), /label="书签"/, '旧工具栏也有入口')
  const panel = read('../src/features/reader/notes/NotesPanel.tsx')
  assert.match(panel, /onBookmarkHere/, '窄屏顶栏藏掉后，面板上有入口')
  assert.match(panel, /reader-notes-tabs/, '三档筛选在面板上')
  assert.match(read('../src/features/reader/ReaderCatalog.tsx'), /onBookmarkHere=\{onBookmarkHere\}/, '面板拿得到父组件的动作')
})

test('跳到书签要落到那一段，不是只切章；书签不画正文高亮', () => {
  const pos = read('../src/features/reader/useReaderPositionJump.ts')
  assert.match(pos, /const jumpToNotePosition = useCallback/, '跳转要有自己的落点函数')
  assert.match(pos, /if \(pageMode !== 'paginate'\) \{/, '滚动模式走自己的分支')
  assert.match(pos, /return scrollToLogicalPosition\(position\)/, '滚动模式滚视口')
  assert.match(pos, /setPageIndex\(Math\.min\(pageCount - 1/, '分页模式换页码，与朗读跟读同一套矩形差')
  assert.match(pos, /pendingNoteJumpRef\.current = target/, '跨章要等正文挂进 DOM 再滚')
  assert.match(pos, /jumpToNotePosition\(target\)/, '同章直接滚')
  assert.match(read('../src/features/reader/NoteHighlights.tsx'), /!note\.bookmark/, '书签不进高亮渲染')
})
