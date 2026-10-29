import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 手动刷新正文（0.2.0）的界面判据：
 *
 * 1. 入口只在目录抽屉顶部，本地书（loc_book）没有「回源」可言，入口不出现；
 * 2. 单章走 force=true（绕过缓存），批量走 /api/books/content-refresh，每批 5 章；
 * 3. 失败章节保留旧正文、可重试；停止只停后续批次，不谎报成功；
 * 4. 刷新完成后阅读器要重载当前章与续接段，并清掉预取缓存，不能还显示旧正文。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8')

test('正文刷新入口在目录顶栏，本地书不出这颗键', () => {
  const header = read('reader', 'TocDrawerHeader.tsx')
  assert.match(header, /onOpenRefresh\?: \(\) => void/, '刷新入口是可选回调')
  assert.match(header, /\{onOpenRefresh && \(/, '不传就不渲染按钮')
  assert.match(header, /icon="refresh"/, '用刷新图标')

  const screen = read('reader', 'ReaderScreen.tsx')
  assert.match(screen, /onOpenRefresh=\{currentBook\.details\.sourceId === 'loc_book' \? undefined : \(\) => setShowRefreshChapters\(true\)\}/,
    '本地书没有书源可回，不给刷新入口')
  assert.match(screen, /<RefreshChaptersModal/, '刷新浮层要挂上')
  assert.match(screen, /cachedUrls=\{cachedChapterUrls\}/, '「已缓存章节」这个范围要拿到真实缓存集合')
})

test('单章也走批量接口（一批一章），content 接口保留 force 语义', () => {
  const api = read('lib', 'api.ts')
  assert.match(api, /refreshChapters: \(sourceId: string, bookUrl: string, chapterUrls: string\[\]\) =>/, '批量刷新的 API 形状')
  assert.match(api, /'\/api\/books\/content-refresh'/, '批量刷新走 content-refresh')
  assert.match(api, /content: async \(sourceId: string, chapterUrl: string, bookUrl\?: string, signal\?: AbortSignal, force = false\)/, '单章内容接口要能带 force')
  assert.match(api, /if \(!force && bookUrl\)/, 'force 失败不能拿本地旧正文冒充成功')

  const modal = read('reader', 'RefreshChaptersModal.tsx')
  assert.match(modal, /const CHUNK_SIZE = 5/, '每批 5 章')
  assert.match(modal, /for \(let offset = 0; offset < urls\.length; offset \+= CHUNK_SIZE\)/, '分批循环')
  assert.match(modal, /api\.refreshChapters\(sourceId, bookUrl, chunk\)/, '批量请求按批发出')
  assert.match(modal, /if \(stoppedRef\.current\) break/, '停止只拦住后续批次')
  assert.match(modal, /refreshed\.push\(\.\.\.result\.refreshed\)/, '成功章节如实累积')
  assert.match(modal, /failed\.push\(\.\.\.result\.failed\.map\(item => \(\{ url: item\.chapterUrl, message: item\.message \}\)\)\)/, '失败章节带原因')
  assert.match(modal, /if \(refreshed\.length > 0\) onRefreshed\(refreshed\)/, '有成功才通知调用方重载')
})

test('刷新完成后当前章与续接段都换新，失败不冒充成功', () => {
  const screen = read('reader', 'ReaderScreen.tsx')
  assert.match(screen, /const handleChaptersRefreshed = useCallback\(\(chapterUrls: string\[\]\) => \{/, '刷新回调')
  assert.match(screen, /chapterUrls\.forEach\(url => preloadedContentRef\.current\.delete\(url\)\)/, '要清预取缓存，否则翻页又回旧正文')
  assert.match(screen, /setCachedChapterUrls\(prev => \{/, '缓存集合要补上刚刷新的章节')
  assert.match(screen, /const tailBefore = flowTailRef\.current/, '续接段要重载')
  assert.match(screen, /const headBefore = flowHeadRef\.current/, '向前接的段也要重载')
  assert.match(screen, /if \(currentChapterUrlRef\.current !== currentUrl\) return/, '重载回来时用户已经翻走就别覆盖当前章')
  assert.match(screen, /本章缓存已更新，但界面重载失败/, '重载失败要单独说清楚，不能装作刷新失败')

  const modal = read('reader', 'RefreshChaptersModal.tsx')
  assert.match(modal, /失败章节的旧正文没有被改坏/, '失败时的说明要讲清楚缓存没被动过')
  assert.match(modal, /重试失败章节/, '失败可重试')
  assert.match(modal, /disabled=\{selection\.length === 0\}/, '没选中章节不能开始')
  assert.match(modal, /max-height: min\(52vh, 480px\)|refresh-chapters-body/, '长列表要能滚')
})
