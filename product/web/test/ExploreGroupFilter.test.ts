import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { filterByGroup, sourceGroups, UNGROUPED } from '../src/lib/exploreGroups'
import type { SourceSummary } from '../src/lib/api'

/**
 * 「发现页书源也能按照分组搜索」（用户 2026-10-02）。
 * 发现页原来只有一个"按名称或分组搜书源"的下拉，两千多个配了发现页的源里，
 * 人其实是按分组挑源的 —— 和「书源」页那套分组筛选得是同一把尺。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const src = (id: string, name: string, group?: string): SourceSummary =>
  ({ id, name, url: `https://${id}/`, group, enabled: true, isJsSource: false, hasLogin: false, updatedAt: 0, version: 1 })

test('分组统计 - trim 之后才算分组，纯空白等于没有', () => {
  const sources = [src('a', '甲', '玄幻'), src('b', '乙', ' 玄幻 '), src('c', '丙', '都市'), src('d', '丁', '   '), src('e', '戊')]
  const stats = sourceGroups(sources)
  assert.deepEqual(stats.groups.map(([name]) => name), ['都市', '玄幻'], '按中文排序，不是按出现顺序')
  assert.deepEqual(stats.groups.map(([, count]) => count), [1, 2], '带空白的和干净的是同一组')
  assert.equal(stats.ungrouped, 2, '空白分组和没有分组都算未分组')
  assert.equal(stats.groups.reduce((sum, [, count]) => sum + count, 0) + stats.ungrouped, sources.length,
    '每一条源都要被算进去，漏一条下拉里的计数就说谎了')
})

test('筛选 - 全部分组给回全部，未分组只给没组的', () => {
  const sources = [src('a', '甲', '玄幻'), src('b', '乙', '   '), src('c', '丙')]
  assert.equal(filterByGroup(sources, '').length, 3)
  assert.deepEqual(filterByGroup(sources, '玄幻').map(item => item.id), ['a'])
  assert.deepEqual(filterByGroup(sources, UNGROUPED).map(item => item.id), ['b', 'c'])
  assert.deepEqual(filterByGroup(sources, '不存在的组'), [], '没匹配就是空，不许回落到全部')
})

test('发现页确实接上了这套筛选（不只是一个没人调用的模块）', () => {
  const page = read('../src/pages/ExplorePage.tsx')
  assert.match(page, /ariaLabel="按分组筛选发现页书源"/, '页面上有这颗分组选择器')
  assert.match(page, /value=\{group\}[\s\S]*?onChange=\{chooseGroup\}/, '它绑的是本页的分组状态')
  assert.match(page, /options=\{pickable\.map/, '选源下拉列的是**筛过**的那批，不是全部 sources')
  assert.match(page, /if \(!list\.some\(item => item\.id === sourceId\)\) setSourceId/,
    '换组之后当前那本不在组里就要换一个，否则下拉显示的和实际加载的分栏对不上')
})
