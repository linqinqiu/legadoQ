import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  SHELF_PAGE_SIZE,
  hasMoreOf,
  moreCountOf,
  visibleCountOf,
} from '../src/features/bookshelf/shelfPaging'

/**
 * 书架分页（2026-11-11）。
 *
 * 书架原来直接 `visibleItems.map(...)`：架上几百本时一次性建出全部卡片，每张还带封面 `<img>`。
 * 书源页早在用「120 本一屏 + 加载更多」，两处口径不一致，用户在同一套界面里遇到两种行为。
 * 这里钉的是**口径本身**（纯函数）以及接线（页面真的用了它），不是 React 渲染细节。
 */

test('ShelfPaging - 页大小与书源页同口径（120）', () => {
  assert.equal(SHELF_PAGE_SIZE, 120)
})

test('ShelfPaging - 可见条数不超过总数，也不会是负数', () => {
  assert.equal(visibleCountOf(0, 500), 0, '空书架渲染 0 条')
  assert.equal(visibleCountOf(-3, 500), 0, '负数总数按 0 处理')
  assert.equal(visibleCountOf(5, 500), 5, '总数比请求量少时只渲染真实存在的')
  assert.equal(visibleCountOf(500, 120), 120, '默认一屏 120')
  assert.equal(visibleCountOf(500, 0), 0)
  assert.equal(visibleCountOf(500, -1), SHELF_PAGE_SIZE, '非法请求量回落到默认一屏')
  assert.equal(visibleCountOf(500, Number.NaN), SHELF_PAGE_SIZE, 'NaN 同样回落')
  assert.equal(visibleCountOf(500, 120.9), 120, '小数向下取整，不渲染半条')
})

test('ShelfPaging - 「加载更多」只在真有剩余时出现', () => {
  assert.equal(hasMoreOf(0, 120), false, '空书架不出加载更多')
  assert.equal(hasMoreOf(120, 120), false, '刚好装满一屏不出')
  assert.equal(hasMoreOf(121, 120), true, '多一条就要给出口')
  assert.equal(hasMoreOf(500, 480), true)
  assert.equal(hasMoreOf(500, 500), false, '全部显示完不再出')
  assert.equal(hasMoreOf(500, 900), false, '请求量超过总数也算显示完')
})

test('ShelfPaging - 点一次「加载更多」按页递增，坏值不放大', () => {
  assert.equal(moreCountOf(120), 240)
  assert.equal(moreCountOf(240), 360)
  assert.equal(moreCountOf(120, 60), 180, '允许调用方给别的步长')
  assert.equal(moreCountOf(0), SHELF_PAGE_SIZE, '从 0 起步也至少前进一页')
  assert.equal(moreCountOf(Number.NaN), SHELF_PAGE_SIZE)
  assert.equal(moreCountOf(-50), SHELF_PAGE_SIZE)
})

test('ShelfPaging - 接线：ShelfPage 走分页、全选收窄到可见项、换筛选回第一页', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '../src/features/bookshelf/ShelfPage.tsx'),
    'utf8',
  )

  // 渲染必须用切片后的 shownItems，而不是 filter/sort 之后的整架
  assert.match(source, /visibleItems\.slice\(0, visibleCountOf\(/, '渲染前要按可见条数切片')
  assert.match(source, /\{shownItems\.map\(/, '列表渲染读 shownItems')
  assert.doesNotMatch(
    source,
    /\{visibleItems\.map\(/,
    '列表渲染不该再直接铺整架 —— 那会绕过分页',
  )

  // 全选跟着可见项走：批量删除只能动眼睛看得到的那些
  assert.match(
    source,
    /setSelectedBooks\(new Set\(shownItems\.map\(/,
    '全选要收窄到 shownItems，否则「加载更多」之前的批量删除会动到没显示的书',
  )

  // 换页签 / 排序 / 分组要回第一页，否则筛选后页码越界会显示空白
  assert.match(
    source,
    /useEffect\(\(\) => \{ setVisibleCount\(SHELF_PAGE_SIZE\) \}, \[view, sort, groupFilter\]\)/,
    '筛选条件变化要复位分页',
  )

  // 出口按钮必须真的接上 moreCountOf
  assert.match(source, /onClick=\{\(\) => setVisibleCount\(count => moreCountOf\(count\)\)\}/)
  assert.match(source, /已显示 \{shownItems\.length\} \/ \{visibleItems\.length\}/, '按钮要摊开"显示了多少/共多少"')
})