import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { toast } from '../src/components/Toast'
import { reportImportSummary } from '../src/plugins/backup/BackupPage'
import {
  LOCAL_BOOK_SOURCE_ID,
  resolveShelfSourceFallback,
  shelfFallbackActionLabel,
  shelfFallbackTitle,
  contentRecoveryLabel,
  resolveContentRecovery,
} from '../src/lib/shelfSourceFallback'
import type { BookshelfItem, SearchResult, SourceSummary } from '../src/lib/api'

const source = (id: string, name: string, enabled = true): SourceSummary => ({
  id, name, url: id, enabled, isJsSource: false, hasLogin: false, updatedAt: 0, version: 1,
})

const alt = (sourceId: string, bookUrl: string, name = '同名书'): SearchResult => ({ sourceId, bookUrl, name })

const shelfItem = (over: Partial<BookshelfItem> = {}): BookshelfItem => ({
  sourceId: 'https://gone.example/##源',
  bookUrl: 'https://gone.example/book/1',
  name: '测试书',
  tocUrl: 'https://gone.example/book/1',
  lastReadAt: 1,
  cachedChapters: 0,
  totalChapters: 0,
  cacheState: 'idle',
  completed: false,
  ...over,
})

test('书源还在且启用：不提示、不给动作（不能把正常书籍也标成不可读）', () => {
  const fallback = resolveShelfSourceFallback(shelfItem(), [source('https://gone.example/##源', '示例源')])
  assert.equal(fallback.kind, 'available')
  assert.equal(shelfFallbackTitle(fallback), null)
  assert.equal(shelfFallbackActionLabel(fallback), null)
})

test('书源不存在 + 备选指向现存启用书源：给「改用某书源继续读」，复用已有数据不联网', () => {
  const fallback = resolveShelfSourceFallback(
    shelfItem({ alternateSources: [alt('https://alive.example/##源', 'https://alive.example/book/9')] }),
    [source('https://alive.example/##源', '备选源')],
  )
  assert.equal(fallback.kind, 'switch-alternate')
  if (fallback.kind !== 'switch-alternate') return
  assert.equal(fallback.reason, 'missing')
  assert.equal(fallback.sourceName, '备选源')
  assert.equal(shelfFallbackTitle(fallback), '书源不存在')
  assert.ok(shelfFallbackActionLabel(fallback)?.includes('改用'), '动作必须是一键换源')
  assert.ok(shelfFallbackActionLabel(fallback)?.includes('备选源'), '按钮要写清改用哪个源')
})

test('书源只是被停用：说「已停用」而不是「不存在」，备选同样可一键换', () => {
  const fallback = resolveShelfSourceFallback(
    shelfItem({ sourceId: 'https://off.example/##源', alternateSources: [alt('https://alive.example/##源', 'https://alive.example/book/9')] }),
    [source('https://off.example/##源', '停用源', false), source('https://alive.example/##源', '备选源')],
  )
  assert.equal(fallback.kind, 'switch-alternate')
  assert.equal(fallback.kind === 'switch-alternate' && fallback.reason, 'disabled')
  assert.equal(shelfFallbackTitle(fallback), '书源已停用')
})

test('备选指向的书源也不存在/已停用：退回「在已拥有的书源里找这本书」', () => {
  const stale = resolveShelfSourceFallback(
    shelfItem({ alternateSources: [alt('https://dead.example/##源', 'https://dead.example/book/9')] }),
    [source('https://alive.example/##源', '存活源')],
  )
  assert.equal(stale.kind, 'search-owned')
  assert.equal(shelfFallbackTitle(stale), '书源不存在')
  assert.equal(shelfFallbackActionLabel(stale), '在已拥有的书源里找这本书')

  const disabledAlt = resolveShelfSourceFallback(
    shelfItem({ alternateSources: [alt('https://off2.example/##源', 'https://off2.example/book/9')] }),
    [source('https://off2.example/##源', '停用的备选', false)],
  )
  assert.equal(disabledAlt.kind, 'search-owned', '停用的备选不能当成可换的目标')
})

test('备选按顺序取第一个真正可用的；自引用（同源同书）跳过', () => {
  const item = shelfItem({
    alternateSources: [
      alt('https://gone.example/##源', 'https://gone.example/book/1'), // 自引用
      alt('https://dead.example/##源', 'https://dead.example/book/2'), // 源不存在
      alt('https://alive.example/##源', 'https://alive.example/book/3'),
      alt('https://alive2.example/##源', 'https://alive2.example/book/4'),
    ],
  })
  const fallback = resolveShelfSourceFallback(item, [
    source('https://alive.example/##源', '第一个可用'),
    source('https://alive2.example/##源', '第二个可用'),
  ])
  assert.equal(fallback.kind, 'switch-alternate')
  assert.equal(fallback.kind === 'switch-alternate' && fallback.sourceName, '第一个可用')
})

test('书源表还没加载（空数组）不下结论：不能因为启动竞态把整架书标成书源不存在', () => {
  const fallback = resolveShelfSourceFallback(shelfItem(), [])
  assert.equal(fallback.kind, 'unknown')
  assert.equal(shelfFallbackTitle(fallback), null)
  assert.equal(shelfFallbackActionLabel(fallback), null)
})

test('本地导入的书不参与书源判断（loc_book 永远可用）', () => {
  const fallback = resolveShelfSourceFallback(shelfItem({ sourceId: LOCAL_BOOK_SOURCE_ID }), [source('https://a/##源', '随便')])
  assert.equal(fallback.kind, 'available')
})

test('接线：书架卡片/书籍管理/详情都真的用这份口径（不是写了一盒纯函数没人接）', () => {
  const read = (...parts: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...parts), 'utf8')
  const shelf = read('features', 'bookshelf', 'ShelfPage.tsx')
  const manage = read('features', 'bookshelf', 'BookManageModal.tsx')
  const detail = read('components', 'BookDetailModal.tsx')
  assert.ok(shelf.includes('resolveShelfSourceFallback'), 'ShelfPage 没接 fallback 判定')
  assert.ok(detail.includes('resolveShelfSourceFallback'), 'BookDetailModal 没接 fallback 判定')
  assert.ok(manage.includes('shelfFallbackTitle'), 'BookManageModal 没接兜底文案判定')
  assert.ok(shelf.includes('switchBookshelfSource'), '书架的一键换源要走现成换源接口，不是自己拼一套')
  assert.ok(manage.includes('onSwitchAlternate') && manage.includes('onSearchInOwnedSources'), '书籍管理要给出两个兜底动作')
  assert.ok(detail.includes('SourceSwitchModal'), '没有备选时复用现成换源弹窗')
  assert.ok(!shelf.includes("search('.sources')") && !detail.includes('streamSearch('), '开书/开架时不许偷偷全源搜索')
})

test('导入播报：跳过「已从书架删除」的书要单独念出来，不能混进「书籍 N」让人以为复活了', () => {
  const shown: string[] = []
  const unsubscribe = toast.subscribe(items => { items.forEach(item => { if (!shown.includes(item.message)) shown.push(item.message) }) })
  try {
    reportImportSummary({
      sources: 1, sourcesUpdated: 0, rules: 0, rulesUpdated: 0,
      books: 0, booksUpdated: 0, booksSkippedDeleted: 2, progress: 0,
    })
  } finally {
    unsubscribe()
  }
  const all = shown.join('\n')
  assert.ok(all.includes('2 本你已从书架删除'), `跳过本数要报出来：${all}`)
  assert.ok(all.includes('按删除保留'), '要说明这 2 本没有被恢复，而不是偷偷跳过')
})

test('正文读不出来时的出路：有备选就一键换，没有才去已拥有书源里找', () => {
  const sources = [
    { id: 'alive', name: '可用源', enabled: true },
    { id: 'off', name: '停用源', enabled: false },
  ] as SourceSummary[]
  const base = { sourceId: 'dead', bookUrl: 'https://a/book' }

  // 备选指向现存且启用的源 → 一键换（与书架页同一个口径）
  const oneClick = resolveContentRecovery({
    ...base,
    alternateSources: [
      { sourceId: 'off', bookUrl: 'https://b/1', name: 'x' },
      { sourceId: 'alive', bookUrl: 'https://b/2', name: 'x' },
    ],
  } as never, sources)
  assert.equal(oneClick.kind, 'switch-alternate')
  assert.equal(contentRecoveryLabel(oneClick), '改用「可用源」继续读')

  // 备选全指向停用/不存在的源 → 退回换源弹窗那条路
  const none = resolveContentRecovery({
    ...base,
    alternateSources: [{ sourceId: 'off', bookUrl: 'https://b/1', name: 'x' }],
  } as never, sources)
  assert.equal(none.kind, 'search-owned')
  assert.equal(contentRecoveryLabel(none), '在已拥有的书源里找这本书')

  // 反向对照：正文已经失败了，**任何**输入都必须给出可点的动作 ——
  // 不许出现"没有出路"（这正是用户报的『加载正文失败没有书源』）。
  for (const input of [
    { ...base, alternateSources: [] },
    { ...base, alternateSources: undefined },
    { ...base, alternateSources: [{ sourceId: 'dead', bookUrl: 'https://a/book', name: 'self' }] },
  ]) {
    const recovery = resolveContentRecovery(input as never, sources)
    assert.ok(contentRecoveryLabel(recovery).length > 0, '每个结局都要有能点的话')
  }

  // 书源表还没到（启动竞态）也必须有出路：换源弹窗自己会去拉表。
  assert.equal(resolveContentRecovery({ ...base, alternateSources: [] } as never, []).kind, 'search-owned')
})

test('接线：阅读器的报错与卡住两处都真的给出了出路（不是只写了纯函数）', () => {
  const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, '..', ...parts), 'utf8')
  const readerScreen = read('src', 'features', 'reader', 'ReaderScreen.tsx')
  const readerBody = read('src', 'features', 'reader', 'ReaderBody.tsx')
  const main = read('src', 'main.tsx')

  // 阅读器要拿到书源表，否则永远只能给"去书源里找"，一键换源那条路等于是死的
  assert.match(readerScreen, /sources\?: SourceSummary\[\]/, '阅读器要能收到书源表')
  assert.match(main, /sources=\{sources\}/, '外壳要真的把书源表传下去')

  // 报错处与卡住处都要有出路按钮
  assert.match(readerBody, /renderRecovery\('error'\)/, '报错处要有出路')
  assert.match(readerBody, /renderRecovery\('slow'\)/, '长时间拉不回来时要有出路')
  assert.match(readerBody, /返回书架/, '卡住时必须能走得掉（用户报的"退不出去"）')

  // 「等了很久」要由阅读器计时，且只在真的在等的时候计时
  assert.match(readerScreen, /setSlowLoad\(true\), 8000\)|setSlowLoad\(true\), SLOW_LOAD_MS\)/, '要有卡住计时')
  assert.match(readerScreen, /if \(!loading \|\| content \|\| message\)/, '换章时上一章还在屏上，不算卡住')

  // 换源走既有链路，不另造一套
  assert.match(readerScreen, /await handleSwitchSource\(\{ result: candidate/, '一键换源要复用 handleSwitchSource')
  assert.match(readerScreen, /matchBestChapter\(chapters, chapter\?\.title, chapterIndex\)/, '按章名在新目录里找位置，与换源弹窗同口径')
})
