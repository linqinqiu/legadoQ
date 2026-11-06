import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dropIndexAt, moveWithin } from '../src/lib/dragSortMath'

/**
 * 长按拖动排序的算术（书源列表在用；书架那一档已于 0.2.21 移除）。
 * 手势本身没法在 node 里演，但"落到第几格、挪完是什么顺序"错了，用户看到的就是乱序，
 * 而且只在真拖起来之后才看得见 —— 所以这两件事单独钉。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const row = (index: number) => ({ left: index * 100, top: 0, width: 100, height: 140 })

test('落点 - 命中某一格时按左右半边分插到它前面还是后面', () => {
  const rects = [row(0), row(1), row(2)]
  assert.equal(dropIndexAt(rects, 30, 60), 0, '第一格左半边 = 插到最前面')
  assert.equal(dropIndexAt(rects, 70, 60), 1, '第一格右半边 = 插到第二格之前')
  assert.equal(dropIndexAt(rects, 260, 60), 3, '最后一格右半边 = 插到末尾')
  assert.equal(dropIndexAt([], 10, 10), -1, '量不到格子就是没有落点，不许瞎猜 0')
  assert.equal(dropIndexAt(rects, 40, 900), 0, '落在格子外面（下方空隙）取最近的那一格')
})

test('挪位置 - 前移与后移的下标语义一致，越界原样返回', () => {
  const list = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveWithin(list, 0, 3), ['b', 'c', 'a', 'd'], '插到第 3 格之前 = 落到原来第 3 位后面')
  assert.deepEqual(moveWithin(list, 3, 1), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveWithin(list, 1, 1), list, '原地不动返回同一个数组')
  assert.deepEqual(moveWithin(list, 0, 99), ['b', 'c', 'd', 'a'], '落点超出末尾就夹到末尾')
  assert.deepEqual(moveWithin(list, -1, 2), list)
  assert.deepEqual(moveWithin(list, 9, 2), list)
})

test('没动过就不写库 - moveWithin 用"返回同一个数组"说这件事', () => {
  const list = ['甲', '乙', '丙']
  assert.equal(moveWithin(list, 1, 1), list, '原地 = 同一个引用')
  assert.equal(moveWithin(list, 1, 2), list, '落到"第 2 格之前"就是原地，不该被当成挪了一次')
  assert.notEqual(moveWithin(list, 0, 2), list, '真挪了才是新数组，调用方据此决定要不要发请求')
})

/**
 * 书架的自定义排序已经拆掉，别再被谁顺手加回来：下拉里没有那一档、页面上没有拖拽接线、
 * 服务端也没有 `/bookshelf/order` 那两条路由。书源的自定义排序仍在，别误伤。
 */
test('书架不再提供自定义排序（书源那一档不受影响）', () => {
  const shelf = read('../src/features/bookshelf/ShelfPage.tsx')
  assert.doesNotMatch(shelf, /'custom'/, '书架排序下拉里不该再有自定义档')
  assert.doesNotMatch(shelf, /useDragSort|reorderShelf|clearShelfOrder/, '书架页不该再接拖动与排序接口')
  const layout = read('../src/lib/shelfLayout.ts')
  assert.doesNotMatch(layout, /'custom'/, '自定义不再是合法的持久排序值')
  const server = read('../..', 'app/src/main/kotlin/io/legado/http/ShelfRoutes.kt')
  assert.doesNotMatch(server, /bookshelf\/order/, '服务端不该再有书架排序路由')
  const sources = read('../src/features/source-editor/SourcesPage.tsx')
  assert.match(sources, /useDragSort/, '书源的自定义排序还在，这条判据不是把两者一起删掉')
})
