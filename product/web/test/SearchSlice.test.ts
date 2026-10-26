import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { searchStore } from '../src/lib/searchStore.ts'

/**
 * 搜索状态的订阅粒度。
 *
 * 来历：`main.tsx` 在 App 根上调 `useSearchStore()` 拿**整份快照**，而根组件实际只用一个
 * `loading` 布尔。整库搜索期间进度每 250ms 写一次 store（`PROGRESS_FLUSH_MS`），于是整棵
 * App 树每秒被重渲染四次 —— 搜索越忙，界面越卡，卡的还是与搜索无关的那半棵树。
 *
 * 这里钉两件事：
 * 1. 结构上：根组件必须换成切片订阅（`useSearchSlice`），不许再回到整份快照；
 * 2. 行为上：一次"与 loading 无关"的写入，必须让整份快照换引用、而 `loading` 切片不换 ——
 *    这正是选择器能挡住重渲染的机制本身，不是靠读代码看着对。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('store 提供切片订阅，且仍然走 useSyncExternalStore', () => {
  const src = read('../src/lib/searchStore.ts')
  assert.match(src, /export function useSearchSlice/, '要有 useSearchSlice 这个导出')
  assert.match(src, /useSearchSlice[\s\S]{0,400}useSyncExternalStore/, '切片订阅要建立在 useSyncExternalStore 上')
  // 整份订阅的入口保留给真正需要全量的组件（搜索页本身），不能顺手删掉
  assert.match(src, /export function useSearchStore/, 'useSearchStore 要留着，搜索页需要整份状态')
})

test('App 根不再整份订阅搜索 store', () => {
  const main = read('../src/main.tsx')
  assert.doesNotMatch(main, /const search = useSearchStore\(\)/, '根组件不许再拿整份快照')
  assert.match(main, /useSearchSlice\(\(state\) => state\.loading\)/, '根组件只订阅 loading')
  assert.match(main, /searching=\{searching\}/, 'AppHeader 用那个布尔，而不是 search.loading')
})

test('无关写入会换整份快照，但不换 loading 切片', () => {
  const pickLoading = (s: { loading: boolean }) => s.loading
  const before = searchStore.getSnapshot()
  assert.equal(pickLoading(before), false, '用例前提：没有搜索在跑')

  // 走一次真实的 setState 路径（改关键词会写进同一份快照）
  searchStore.setKeyword('重渲染判据')
  const after = searchStore.getSnapshot()

  assert.notEqual(after, before, '整份快照换了引用 —— 整份订阅者必然重渲染')
  assert.equal(pickLoading(after), pickLoading(before), 'loading 切片没变 —— 选择器订阅者不该重渲染')
  assert.equal(after.keyword, '重渲染判据', '写入本身要真的生效，别变成空断言')

  searchStore.setKeyword('')
})
