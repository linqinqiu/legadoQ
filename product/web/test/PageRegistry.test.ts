import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PAGES, PRIMARY_PAGES, pageFromHash } from '../src/app/pageMeta.ts'

/**
 * 路由表的判据。
 *
 * 从前路由散在三处：`main.tsx` 的 `pageFromHash` 三元链、`shortcuts.ts` 的
 * `PRIMARY_PAGES`、`AppHeader.tsx` 的 `AppPage` union。这里钉住「只剩一张表」：
 * 表里有什么、顶栏取哪些、hash 怎么解析，都从同一份数据来。
 */

test('页面表覆盖全部一级目的地，顺序就是顶栏顺序', () => {
  assert.deepEqual(
    PAGES.map(item => item.key),
    ['library', 'shelf', 'sources', 'explore', 'subscriptions', 'settings', 'reader'],
  )
  assert.equal(new Set(PAGES.map(item => item.key)).size, PAGES.length, 'key 不能重复')
})

test('顶栏只取 primary 的页面，阅读器不进顶栏', () => {
  assert.deepEqual(
    PRIMARY_PAGES.map(item => item.page),
    ['library', 'shelf', 'sources', 'explore', 'subscriptions', 'settings'],
  )
  assert.ok(!PRIMARY_PAGES.some(item => item.page === 'reader'), '阅读器是整屏态，不该占顶栏')
})

test('hash 解析由表驱动：每个 key 都能往返，不认识的回书库', () => {
  for (const item of PAGES) {
    assert.equal(pageFromHash(`#${item.key}`), item.key)
  }
  assert.equal(pageFromHash('#nope'), 'library')
  assert.equal(pageFromHash(''), 'library')
})

test('主壳不再自己写 hash 三元链', () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  assert.doesNotMatch(main, /location\.hash === '#(sources|subscriptions|shelf|explore|reader|settings)'/,
    '路由解析应只住在 app/pageMeta.ts')
})
