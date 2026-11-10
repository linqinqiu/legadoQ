import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 正文加载失败不能是死路（2026-11-10 前端审计 A7）。
 *
 * 从前失败只渲染一行 `.reader-error`：没有重试、没有换源提示，用户只能换章或刷新整页。
 * 这里钉三件事：错误态有入口、入口接到"重拉当前章"、重拉绕开预取缓存。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('错误态有「重新加载」，两处渲染分支都要有', () => {
  const body = read('../src/features/reader/ReaderBody.tsx')
  assert.match(body, /onRetryChapter: \(\) => void/, '动作要有类型，漏接会在编译期红')
  assert.match(body, /onClick=\{onRetryChapter\}/, '按钮要真的接上')
  assert.match(body, /className="reader-error-retry"/, '错的是"重试"，不是"换个章"')
  assert.equal(
    body.match(/className="reader-error-retry"/g)?.length ?? 0,
    2,
    '分页轨道与滚动续接各有一处错误渲染，都要给出口',
  )
})

test('重试接的是「重拉当前章」，不是刷新整页', () => {
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /reload: reloadChapter/, '重试来自章节加载 hook')
  assert.match(screen, /onRetryChapter: reloadChapter/, 'ReaderBody 要拿到它')

  const hook = read('../src/features/reader/useReaderChapterContent.ts')
  assert.match(hook, /const \[reloadToken, setReloadToken\]/, '靠自增 token 触发加载 effect')
  assert.match(hook, /progress\?\.positionChecksum, reloadToken\]/, 'token 要进依赖数组，否则重试不生效')
  assert.match(hook, /preloadedContentRef\.current\.delete\(chapter\.url\)/, '重试要绕开预取缓存，否则命中旧的那份')
})
