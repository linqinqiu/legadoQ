import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compareCustomSort, dropIndexAt, moveWithin } from '../src/shelf/shelfOrder'
import type { BookshelfItem } from '../src/lib/api'

/**
 * 「批量管理功能在，长按书籍可移动能排顺序（自定义）」（用户 2026-10-02）。
 * 手势本身没法在 node 里演，但"落到第几格、挪完是什么顺序"错了，用户看到的就是乱序，
 * 而且只在真拖起来之后才看得见 —— 所以这三件事单独钉。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const book = (name: string, over: Partial<BookshelfItem> = {}): BookshelfItem =>
  ({ sourceId: 's', bookUrl: `https://b/${name}`, name, tocUrl: '', lastReadAt: 0, cachedChapters: 0, totalChapters: 0, cacheState: 'idle', completed: false, ...over })
const row = (index: number) => ({ left: index * 100, top: 0, width: 100, height: 140 })

test('自定义排序 - 排过序的在前，没排过的按最后阅读跟在有序段之后', () => {
  const sorted = [
    book('甲', { sortOrder: 2, lastReadAt: 99 }),
    book('乙', { sortOrder: 1, lastReadAt: 1 }),
    book('丙', { lastReadAt: 50 }),
    book('丁', { lastReadAt: 80 }),
  ].sort(compareCustomSort)
  assert.deepEqual(sorted.map(item => item.name), ['乙', '甲', '丁', '丙'],
    '拖过的两本按拖出来的顺序，没拖过的两本按最后阅读 —— 不是把 null 当成 0 排到最前')
  // 反向对照：sortOrder 为 0 是"排过、排在第一"，不能和 null 混为一谈
  assert.equal([book('有零', { sortOrder: 0 }), book('没排过')].sort(compareCustomSort)[0].name, '有零')
})

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

test('书架确实接上了拖动排序（不只是一个没人调用的模块）', () => {
  // 0.8.2 拆组：书架页从 main.tsx 搬进 pages/ShelfPage.tsx，断言逐字不变
  const main = read('../src/pages/ShelfPage.tsx')
  assert.match(main, /case 'custom': sorted\.sort\(compareCustomSort\)/, '「自定义」这一档真的按 sortOrder 排')
  assert.match(main, /value: 'custom', label: '自定义（长按拖动）'/, '排序下拉里选得到')
  assert.match(main, /enabled: \(\) => sort === 'custom' && !batchMode/, '只在自定义档、且不在批量模式里可拖')
  assert.match(main, /api\.reorderShelf/, '拖完真的打到服务端，不只是本地重排')
  assert.match(main, /api\.clearShelfOrder/, '排乱了要有回到"从没拖过"的那条路（切档只是不看它，不清）')
  assert.match(main, /清除自定义顺序/)
  assert.match(main, /onPointerDown=\{onPointerDown\(index\)\}/)
  assert.match(main, /onClickCapture=\{onClickCapture\}/, '拖完那一下不能被当成"点开这本书"')
  const layout = read('../src/shelf/shelfLayout.ts')
  assert.match(layout, /SORT_VALUES: ShelfSort\[\] = \[[^\]]*'custom'/, 'custom 是合法持久值，否则刷新就弹回默认档')
  // 0.8.2 拆组：书架面住在 ShelfRoutes.kt
  const server = read('../..', 'app/src/main/kotlin/io/legado/http/ShelfRoutes.kt')
  assert.match(server, /put\("\/bookshelf\/order"\)/, '服务端有这条路由')
})

test('没动过就不写库 - moveWithin 用"返回同一个数组"说这件事', () => {
  const list = [book('甲'), book('乙'), book('丙')]
  assert.equal(moveWithin(list, 1, 1), list, '原地 = 同一个引用')
  assert.equal(moveWithin(list, 1, 2), list, '落到"第 2 格之前"就是原地，不该被当成挪了一次')
  assert.notEqual(moveWithin(list, 0, 2), list, '真挪了才是新数组，调用方据此决定要不要发请求')
})
