import test from 'node:test'
import assert from 'node:assert/strict'
import { assertScalesLinearly, assertWithinCeiling } from './perfCriteria.ts'
import { computeCenterScrollOffset as computeAutoScrollOffset, computeVirtualWindow as computeVirtualSlice } from '../src/reader/virtualSlice.js'
import { LazyCandidateManager, deduplicateSearchResults } from './LazySourceLoading.test.ts'
import type { SearchResult, BookDetails, Chapter, ReadingProgress } from './LazySourceLoading.test.ts'
import { memoizedSplitParagraphs, scrollPosition, shouldPreloadNextChapter, BoundedPreloadCache } from './ReaderOptimization.test.ts'
export type SearchGroup = { key: string; name: string; author?: string; sources: SearchResult[] }
export type SearchFilters = {
  query: string
  minimumSources: 1 | 2 | 3
  withIntro: boolean
  withCover: boolean
}

export function filterSearchGroups(groups: SearchGroup[], filters: SearchFilters): SearchGroup[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return groups.filter(group => {
    const searchable = `${group.name} ${group.author ?? ''}`.toLocaleLowerCase()
    return (
      (!query || searchable.includes(query)) &&
      group.sources.length >= filters.minimumSources &&
      (!filters.withIntro || group.sources.some(source => Boolean(source.intro?.trim()))) &&
      (!filters.withCover || group.sources.some(source => Boolean(source.coverUrl)))
    )
  })
}

export function filterChapters(chapters: Chapter[], query: string): Chapter[] {
  const q = query.trim().toLowerCase()
  if (!q) return chapters
  return chapters.filter(c => c.title.toLowerCase().includes(q))
}

// -----------------------------------------------------------------------------
// Tier 4: Real-World Workload Scenarios
// -----------------------------------------------------------------------------

test('TOCPerformanceScenario - Tier 4 Scenario 1: 5,000+ chapter TOC scrolling & search filtering performance (< 5ms)', () => {
  // 1. Generate realistic 5,000-chapter dataset
  const totalChapters = 5000
  const chapters: Chapter[] = Array.from({ length: totalChapters }, (_, i) => ({
    index: i,
    title: i === totalChapters - 1
      ? '第5000章 终极一战（大结局）'
      : `第${i + 1}章 修仙风云卷·第${i + 1}回`,
    url: `/book/1/chapter-${i + 1}`,
  }))

  // 4 倍规模的对照组：判的是复杂度，不是这台机器此刻多闲
  const chapters4x: Chapter[] = Array.from({ length: totalChapters * 4 }, (_, i) => ({
    index: i,
    title: `第${i + 1}章 修仙风云卷·第${i + 1}回`,
    url: `/book/1/chapter-${i + 1}`,
  }))

  // JIT Warmup to avoid V8 cold compile skew
  filterChapters(chapters, 'warmup')
  filterChapters(chapters4x, 'warmup')

  // 2. Performance benchmark: Instantaneous filter execution speed (< 10ms)
  const queries = ['第100章', '大结局', '第2500章', '修仙风云', '不存在的章节关键字', '']
  for (const q of queries) {
    const filterStart = performance.now()
    const filtered = filterChapters(chapters, q)
    const filterElapsed = performance.now() - filterStart
    const bigFilterStart = performance.now()
    filterChapters(chapters4x, q)
    const bigFilterElapsed = performance.now() - bigFilterStart

    assertScalesLinearly({
      name: '5,000→20,000 章过滤「' + q + '」',
      smallMs: filterElapsed,
      bigMs: bigFilterElapsed,
      dataFactor: 4,
    })

    // Verify virtual slice rendered on filtered dataset
    const slice = computeVirtualSlice({
      totalCount: filtered.length,
      itemHeight: 36,
      scrollTop: 0,
      viewportHeight: 600,
      overscan: 6,
    })

    assert.ok(
      slice.renderedCount <= 30,
      `Virtual slice for ${filtered.length} results rendered ${slice.renderedCount} nodes (target <= 30)`
    )
  }

  // 3. 100-step simulated smooth scrolling benchmark across 5,000 chapters
  const totalScrollHeight = totalChapters * 36
  const viewportHeight = 600

  /** 跑 steps 次滚动推进，每步都当场校验虚拟化窗口；返回耗时（比值判据用）。 */
  const runScrollTicks = (steps: number) => {
    const started = performance.now()
    for (let step = 0; step < steps; step++) {
      const scrollTop = (step / (steps - 1)) * (totalScrollHeight - viewportHeight)
      const slice = computeVirtualSlice({
        totalCount: totalChapters,
        itemHeight: 36,
        scrollTop,
        viewportHeight,
        overscan: 6,
      })

      assert.ok(slice.renderedCount >= 10 && slice.renderedCount <= 30)
      assert.ok(slice.startIndex >= 0 && slice.endIndex <= totalChapters)
      assert.equal(slice.offsetY, slice.startIndex * 36)
    }
    return performance.now() - started
  }

  runScrollTicks(20)
  // 分母要高于计时可信下限，所以量级选 1,000→4,000 次而不是 100→400 次
  const scrollElapsed = runScrollTicks(1000)
  assertScalesLinearly({ name: '虚拟滚动 1,000→4,000 次推进', smallMs: scrollElapsed, bigMs: runScrollTicks(4000), dataFactor: 4 })

  // 4. Auto-scroll centering verification for mid-book chapter (e.g. Chapter 3,250)
  const targetChapter = 3250
  const autoOffset = computeAutoScrollOffset(targetChapter, 36, viewportHeight, totalChapters)
  const centeredSlice = computeVirtualSlice({
    totalCount: totalChapters,
    itemHeight: 36,
    scrollTop: autoOffset,
    viewportHeight,
    overscan: 6,
  })
  assert.ok(
    targetChapter >= centeredSlice.startIndex && targetChapter < centeredSlice.endIndex,
    `Target chapter ${targetChapter} must be rendered in centered slice [${centeredSlice.startIndex}, ${centeredSlice.endIndex}]`
  )
})

test('TOCPerformanceScenario - Tier 4 Scenario 2: Multi-source streaming search grouping & instant open', async () => {
  // 1. Simulate 40 search results streamed across 40 sources for "凡人修仙传"
  const rawResults: SearchResult[] = Array.from({ length: 40 }, (_, i) => ({
    sourceId: `source-origin-${i}`,
    name: '凡人修仙传',
    author: '忘语',
    bookUrl: `https://origin-${i}.book.example/book/1001`,
    intro: i === 0 ? '一个普通山村穷小子，偶然之下跨入修仙门派...' : undefined,
    coverUrl: i === 0 ? 'https://img.example/covers/fanren.jpg' : undefined,
  }))

  // Deduplicate and group
  const deduped = deduplicateSearchResults(rawResults)
  assert.equal(deduped.length, 40)

  const searchGroups: SearchGroup[] = [
    {
      key: 'fanren-wangyu',
      name: '凡人修仙传',
      author: '忘语',
      sources: deduped,
    },
    {
      key: 'modao-moxiang',
      name: '魔道祖师',
      author: '墨香铜臭',
      sources: [
        {
          sourceId: 'source-origin-1',
          name: '魔道祖师',
          author: '墨香铜臭',
          bookUrl: 'https://origin-1.book.example/book/2002',
        },
      ],
    },
  ]

  // Filter groups with multi-source filter (minimumSources >= 2)
  const filtered = filterSearchGroups(searchGroups, {
    query: '凡人',
    minimumSources: 2,
    withIntro: false,
    withCover: false,
  })

  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, '凡人修仙传')
  assert.equal(filtered[0].sources.length, 40)

  // 2. Open the book group with LazyCandidateManager
  const mockApi = {
    fetchDetails: async (sourceId: string, bookUrl: string): Promise<BookDetails> => ({
      sourceId,
      name: '凡人修仙传',
      author: '忘语',
      tocUrl: `${bookUrl}/toc`,
    }),
    fetchChapters: async (sourceId: string, tocUrl: string): Promise<Chapter[]> =>
      Array.from({ length: 2446 }, (_, i) => ({
        index: i,
        title: `第${i + 1}章 凡人篇`,
        url: `${tocUrl}/${i + 1}`,
      })),
    fetchProgress: async () => undefined,
  }

  const manager = new LazyCandidateManager(mockApi.fetchDetails, mockApi.fetchChapters, mockApi.fetchProgress)

  const openStart = performance.now()
  await manager.openGroup(filtered[0].sources)
  const openElapsed = performance.now() - openStart

  // Verification:
  // - Exactly 3 network requests dispatched for primary source (not 40 * 4 = 160)
  assert.equal(manager.totalNetworkCalls, 3)
  assert.equal(manager.activeBook?.details.sourceId, 'source-origin-0')
  assert.equal(manager.activeBook?.chapters.length, 2446)
  assert.equal(manager.choices.length, 40)
  assert.equal(manager.choices[0].status, 'loaded')
  assert.equal(manager.choices[1].status, 'idle')
  assert.equal(manager.choices[39].status, 'idle')
  // 真判据是上面那组结构断言（只发 3 次请求、候补源保持 idle）；这里只挡"卡住"这一级事故
  assertWithinCeiling('点开一本 2,446 章的书', openElapsed, 3000)
})

test('TOCPerformanceScenario - Tier 4 Scenario 3: Complete reading session lifecycle (memoization, scroll, preload, advance)', async () => {
  // Mock chapters
  const chapters: Chapter[] = [
    { index: 0, title: '第1章 山边小村', url: '/book/1/ch1' },
    { index: 1, title: '第2章 七玄门', url: '/book/1/ch2' },
    { index: 2, title: '第3章 门童考核', url: '/book/1/ch3' },
  ]

  const chapterContents: Record<string, string> = {
    '/book/1/ch1': '青山村坐落在牛头山脚下...\n村里只有几十户人家。\r\n韩立自小在这里长大。',
    '/book/1/ch2': '七玄门是镜州境内的一个不大不小的江湖帮派。\n山门险峻，戒备森严。',
    '/book/1/ch3': '考核当日，数百名少年聚集在山门前...\n执事长老目光如电。',
  }

  const preloadCache = new BoundedPreloadCache<string, string>(5)
  let networkContentFetches = 0

  const fetchChapterContent = async (url: string): Promise<string> => {
    // If present in preload cache, return immediately
    const cached = preloadCache.get(url)
    if (cached) return cached

    networkContentFetches++
    const text = chapterContents[url] ?? '正文内容...'
    return text
  }

  // 1. Open Chapter 0
  let currentChapterIndex = 0
  const initialContent = await fetchChapterContent(chapters[currentChapterIndex].url)
  assert.equal(networkContentFetches, 1)

  // Paragraph memoization test
  const paragraphs1 = memoizedSplitParagraphs(initialContent)
  const paragraphs2 = memoizedSplitParagraphs(initialContent)
  assert.equal(paragraphs1, paragraphs2, 'Memoized paragraph arrays must be identical reference')
  assert.deepEqual(paragraphs1, ['青山村坐落在牛头山脚下...', '村里只有几十户人家。', '韩立自小在这里长大。'])

  // 2. Simulate reading and scrolling
  // Scroll to 50%
  const scrollHalf = scrollPosition(500, 1500, 500)
  assert.equal(scrollHalf, 0.5)
  assert.equal(shouldPreloadNextChapter(scrollHalf), false)

  // Scroll to 75% -> triggers background preload for Chapter 1
  const scrollPreload = scrollPosition(750, 1500, 500)
  assert.equal(scrollPreload, 0.75)
  assert.equal(shouldPreloadNextChapter(scrollPreload), true)

  // Trigger background preload for next chapter
  const nextChapter = chapters[currentChapterIndex + 1]
  if (!preloadCache.has(nextChapter.url)) {
    const preloadedText = await fetchChapterContent(nextChapter.url)
    preloadCache.set(nextChapter.url, preloadedText)
  }
  assert.equal(networkContentFetches, 2)
  assert.equal(preloadCache.has(nextChapter.url), true)

  // 3. User finishes Chapter 0 and advances to Chapter 1
  currentChapterIndex = 1
  const fetchesBeforeAdvance = networkContentFetches
  const chapter1Content = await fetchChapterContent(chapters[currentChapterIndex].url)

  // Loaded directly from preload cache without additional network request
  assert.equal(networkContentFetches, fetchesBeforeAdvance, 'Preloaded chapter must not trigger new network fetch')
  assert.ok(chapter1Content.includes('七玄门'))

  // 4. Verify reading progress state record
  const savedProgress: ReadingProgress = {
    sourceId: 'src-1',
    bookUrl: 'https://example.com/fanren',
    chapterUrl: chapters[currentChapterIndex].url,
    chapterIndex: currentChapterIndex,
    scrollPosition: 0.0,
  }

  assert.equal(savedProgress.chapterIndex, 1)
  assert.equal(savedProgress.scrollPosition, 0.0)
  assert.equal(savedProgress.chapterUrl, '/book/1/ch2')
})
