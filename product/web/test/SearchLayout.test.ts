import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LAYOUT, DEFAULT_SEARCH_LAYOUT, readSearchLayout, readShelfLayout, writeSearchLayout, writeShelfLayout } from '../src/shelf/shelfLayout'
import { pickBlurb, SearchGroup } from '../src/lib/searchFilters'

/**
 * 搜索结果的三档展示（用户 2026-10-02：「搜索获得的书籍也能用不同的方式展示（网格，列表，紧凑列表）」
 * 「列表的右侧信息显示成简介怎么样，紧凑列表保存原样」）。
 *
 * 判的四件事：偏好各存各的、界面真的有三档入口、三档在样式表里都真的有规则、
 * 以及**门禁依赖的那两句文案不许被换档换掉**（`book-detail-check.mjs` 从 `.search-card-sources`
 * 里用正则抽「N 个书源」的数字，抽不到就永远攒不够 3 个候选而判红）。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const SEARCH_KEY = 'legado-search-layout-v1'
const SHELF_KEY = 'legado-shelf-layout-v2'

function withStorage(initial: Record<string, string>, body: (store: Map<string, string>) => void) {
  const previous = (globalThis as any).localStorage
  const store = new Map(Object.entries(initial))
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
  try {
    body(store)
  } finally {
    ;(globalThis as any).localStorage = previous
  }
}

test('pickBlurb - 有简介用简介，没简介退成最新章，两个都没有就空（整栏不渲染）', () => {
  const group = (sources: Array<{ intro?: string; lastChapter?: string }>) =>
    ({ key: 'k', name: '书', author: '作者', sources }) as SearchGroup
  assert.equal(pickBlurb(group([{ intro: '  一段真简介  ' }])), '一段真简介', '两端空白要清掉')
  assert.equal(pickBlurb(group([{ intro: '   ' }, { intro: '第二条才有字' }])), '第二条才有字', '空白的那条不算有简介')
  assert.equal(pickBlurb(group([{ intro: '  ', lastChapter: '第 9 章 结局' }])), '最新：第 9 章 结局', '没简介时退成最新章')
  assert.equal(pickBlurb(group([{ intro: '有简介', lastChapter: '某章' }])), '有简介', '简介优先，不被最新章抢掉')
  assert.equal(pickBlurb(group([{ intro: '', lastChapter: '' }])), '', '两个都没有就返回空串')
  assert.equal(pickBlurb(group([])), '', '一个来源都没有也是空')
})

test('搜索布局 - 默认是网格（搜索页原来就是封面网格，改默认等于替用户做决定）', () => {
  assert.deepEqual(DEFAULT_SEARCH_LAYOUT, { mode: 'grid' })
  withStorage({}, () => {
    assert.deepEqual(readSearchLayout(), DEFAULT_SEARCH_LAYOUT)
  })
})

test('搜索布局 - 三档都能存回读出，非法值回落到默认', () => {
  for (const mode of ['grid', 'list', 'compact'] as const) {
    withStorage({ [SEARCH_KEY]: mode }, () => {
      assert.deepEqual(readSearchLayout(), { mode })
    })
  }
  withStorage({ [SEARCH_KEY]: 'LIST' }, () => {
    assert.deepEqual(readSearchLayout(), DEFAULT_SEARCH_LAYOUT, '认不出的值当没填，别把界面搞成没有布局')
  })
})

test('搜索布局 - 与书架布局各存各的（在书架看封面不代表搜索时也想先看封面）', () => {
  withStorage({}, () => {
    writeSearchLayout({ mode: 'list' })
    assert.deepEqual(readSearchLayout(), { mode: 'list' })
    assert.deepEqual(readShelfLayout(), DEFAULT_LAYOUT, '书架不该跟着变')
    writeShelfLayout({ mode: 'compact' })
    assert.deepEqual(readSearchLayout(), { mode: 'list' }, '反过来也不该串')
  })
})

test('搜索布局 - localStorage 不可用时不抛', () => {
  const previous = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = undefined
  try {
    assert.deepEqual(readSearchLayout(), DEFAULT_SEARCH_LAYOUT)
    assert.doesNotThrow(() => writeSearchLayout({ mode: 'compact' }))
  } finally {
    ;(globalThis as any).localStorage = previous
  }
})

test('搜索页 - 三档入口都在、无障碍名齐、且都写进同一份 DOM', () => {
  const source = read('../src/pages/LibraryPage.tsx')
  assert.match(source, /aria-label="搜索结果布局"/, 'picker 要有自己的无障碍名（书架那颗叫「书架布局」）')
  for (const label of ['封面网格', '列表', '紧凑列表']) {
    assert.ok(source.includes(`aria-label="${label}"`), `少了「${label}」这一档入口`)
  }
  assert.match(source, /search-grid search-mode-\$\{resultLayout\.mode\}/, '容器要带 mode 类名（三档共用一份卡片 DOM，切换不重排）')
  assert.match(source, /readSearchLayout\(\)/, '偏好从 localStorage 读')
  assert.match(source, /writeSearchLayout\(next\)/, '换档要落盘')
})

test('搜索页 - 换档不许弄丢门禁与无障碍依赖的文案', () => {
  const source = read('../src/pages/LibraryPage.tsx')
  // book-detail-check.mjs 用 /(\d+)\s*个书源/ 从 .search-card-sources 抽数字挑候选书
  assert.match(source, /className="search-card-sources"/, '类名不许消失')
  assert.match(source, /个书源/, '「N 个书源」这句不许消失')
  assert.ok(source.includes('className={`search-card'), '卡片根类名不许消失')
  // 简介：有就渲染，没有就整栏不出现（不刷一排"暂无简介"）
  assert.match(source, /\{blurb && <small className="search-card-intro">\{blurb\}<\/small>\}/, '简介栏要按有无内容决定渲染')
  assert.ok(!source.includes('这本书没有简介'), '不要给每本书都挂一句占位话')
})

test('搜索页 - 样式表里三档都真的有规则，且隐藏规则的特异性压得过全局 small', () => {
  const css = read('../src/styles.css')
  for (const selector of ['.search-mode-list .search-card', '.search-mode-compact .search-card', '.search-mode-list .search-card-intro']) {
    assert.ok(css.includes(selector), `缺 ${selector} 规则`)
  }
  // `.library-results small { display: block }` 是"一个类 + 一个元素"，
  // 裸写 `.search-card-intro { display: none }` 会被它压过 → 简介在网格档漏出来。
  assert.match(css, /\.search-grid \.search-card-intro \{ display: none; \}/, '隐藏简介必须带容器类，否则特异性不够')
  assert.match(css, /\.search-mode-list \.search-card-hover \{ display: none; \}/, '列表档不需要 hover 层（信息本来就在明面上）')
})
