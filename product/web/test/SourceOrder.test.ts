import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「自定义书源排序，优化书源编辑功能」（用户 2026-10-02）。
 * 拖动的算术由 `ShelfDragOrder.test.ts` 判（书架与书源现在共用同一个 `useDragSort`），
 * 这里判的是"书源这一侧真的接上了，而且顺序只有一个来源"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
// 0.8.2 拆组：书源页从 main.tsx 搬进 pages/SourcesPage.tsx；这三条读的书源页代码都在那里。
// 相对 import 因层级变化（./shelf → ../shelf），正则收两种写法，断言的事实不变。
const sourcesPage = () => read('../src/pages/SourcesPage.tsx')

test('顺序只有一个来源：服务端排，客户端只做原位回填', () => {
  const main = sourcesPage()
  assert.doesNotMatch(main, /filteredSources[\s\S]{0,200}\.sort\(/,
    '客户端不写第二套比较器 —— 中文书名上 SQLite 的 nocase 与 localeCompare 本来就会分歧')
  assert.match(main, /const queue = \[\.\.\.ordered\]/,
    '松手后要就地回填，否则"拖了但那一行没动"，只有刷新才看得见结果')
  assert.match(main, /if \(!rank\.has\(item\.id\)\) return item/, '没在这一列里的源保持原位，不跟着重排')
  assert.match(main, /items: visibleSources,\s*\n\s*onReorder: applySourceOrder/, '拖的是屏幕上这一列，写的也是这一列')
  // 0.8.2 DAO 拆组：这条 SQL 住在 SourcesDao.kt（Database.kt 只剩连接/建表/迁移）
  const server = read('../../app/src/main/kotlin/io/legado/data/SourcesDao.kt')
  assert.match(server, /order by sort_order is null, sort_order, name collate nocase/,
    '排过序的在前、没排过的按名称跟在后面（全 NULL 时等价于原来的按名称排）')
})

test('书源拖动与书架共用同一份手势，且批量模式让路', () => {
  const main = sourcesPage()
  assert.match(main, /from '[.][./]*shelf\/dragSort'/, '手势在 dragSort.ts 里，两处共用一份')
  assert.match(main, /itemSelector: '\.source-list-item'/)
  assert.match(main, /enabled: \(\) => !isBatchMode/, '批量模式里点按是勾选，不能抢成拖动')
  assert.match(main, /onPointerDown=\{onSourcePointerDown\(index\)\}/)
  assert.match(main, /onClickCapture=\{onSourceClickCapture\}/, '松手那一下不能同时被当成"选中这本书源"')
  assert.match(read('../src/styles.css'), /\.source-item-drop-before::before \{/)
})

test('有位置才给"清除自定义顺序"，并且说的是条数', () => {
  const main = sourcesPage()
  assert.match(main, /orderedCount > 0 && \(/)
  assert.match(main, /个书源有自定义位置；其余按名称排在后面/, '不能只说"已自定义"而不讲清其余那批还是按名称')
  assert.match(main, /api\.clearSourceOrder/)
  assert.match(read('../src/lib/api.ts'), /reorderSources: \(ids: string\[\]\) => request<\{ updated: number \}>\('\/api\/sources\/order', \{ method: 'PUT', body: JSON\.stringify\(\{ ids \}\) \}\)/)
})

test('路由注册在 /sources/{id} 之前，PUT /sources/order 不会被当成某个源', () => {
  // 0.8.2 拆组：order 与 {id} 两条同住 SourcesRoutes.kt，先后关系仍然当场可证
  const routes = read('../../app/src/main/kotlin/io/legado/http/SourcesRoutes.kt')
  const order = routes.indexOf('put("/sources/order")')
  const parameterized = routes.indexOf('route("/sources/{id}")')
  assert.ok(order > 0, '要有这条路由')
  assert.ok(order < parameterized, '顺序摆在读得懂的位置，不靠路由树的优先级')
  assert.match(routes, /delete\("\/sources\/order"\)/)
})
