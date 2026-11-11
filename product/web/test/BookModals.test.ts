import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

/**
 * 第 2 批拆分（ShelfPage 两模态外移，2026-11-12）的结构判据，
 * 外加一个随之修复的真实 bug：管理弹窗用 blockedBy='.book-info-edit-modal' 让位 Esc，
 * 但编辑弹窗根上从来没有这个类 —— querySelector 永远落空，一次 Esc 两层一起关。
 * 现在类名补在编辑弹窗根上（纯行为锚点，无样式，已登记 UiContract 的 MARKER_CLASSES），
 * 这条判据钉住「让位选择器 ↔ 根类名」的契约，谁改谁红。
 */
test('书架两模态外移：结构归位，Esc 让位选择器真的命中编辑层', () => {
  const shelf = read('../src/features/bookshelf/ShelfPage.tsx')
  const manage = read('../src/features/bookshelf/BookManageModal.tsx')
  const info = read('../src/features/bookshelf/BookInfoEditModal.tsx')

  // 结构：页面只导出一个组件，两个模态各自独立成文件、按调用关系引入
  assert.match(shelf, /import \{ BookManageModal \} from '\.\/BookManageModal'/)
  assert.doesNotMatch(shelf, /export function Book(InfoEdit|Manage)Modal/, '模态定义不该再留在页面文件里')
  assert.equal((shelf.match(/^export function /gm) || []).length, 1, 'ShelfPage 只导出一个页面组件')
  assert.match(manage, /export function BookManageModal/)
  assert.match(info, /export function BookInfoEditModal/)
  assert.match(manage, /import \{ BookInfoEditModal \} from '\.\/BookInfoEditModal'/, '管理弹窗内嵌编辑弹窗')

  // Esc 分层契约：blockedBy 的选择器必须命中编辑弹窗根上的类
  const blocked = /useEscapeClose\(onClose, editingInfo \? '\.([a-z-]+)' : undefined\)/.exec(manage)
  assert.ok(blocked, '管理弹窗要保留「编辑层打开时 Esc 让位」的接线')
  assert.equal(blocked[1], 'book-info-edit-modal')
  assert.ok(info.includes(`className="dialog-shell size-s ${blocked[1]}"`),
    '编辑弹窗根上必须有让位选择器对应的类，否则一次 Esc 会连管理带编辑两层一起关')
})