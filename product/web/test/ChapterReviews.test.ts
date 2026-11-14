import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { book } from '../src/lib/api.ts'
import {
  applyError,
  applyPage,
  ChapterReviewsDialog,
  ChapterReviewsList,
  REVIEWS_PAGE_SIZE,
  reviewErrorText,
  reviewUrlRuleOf,
  type ReviewsViewState,
} from '../src/features/reader/reviews/ChapterReviewsDialog.tsx'
import { MarkingMenu } from '../src/features/reader/interaction/MarkingMenu.tsx'
import type { ChapterReview } from '../src/lib/api.ts'

/**
 * 段评（第三阶段第一刀：**只读详情层**）的判据。
 *
 * 这一刀最容易出的三种错，全在这儿钉住：
 * ① 把「书源没配段评规则」当成报错弹出来 —— 那是**没有这个能力**，界面上要平静说明；
 * ② 翻页失败把已经读到的段评清空 —— 读到的就该留在屏幕上；
 * ③ 把服务端/书源给的原始错因（类名、堆栈、JSON）直接念给用户。
 *
 * 判据全部离线跑：展示层是纯 props 渲染，取数与分页由纯函数推进。
 */

const empty: ReviewsViewState = { items: [], page: 1, loading: false, error: null, hasMore: false }

function review(overrides: Partial<ChapterReview> = {}, content: Partial<ChapterReview['content']> = {}): ChapterReview {
  return {
    id: 'r1',
    name: '读者甲',
    badge: '书友',
    content: { text: '这段写得真好', likeCount: 3, replyCount: 1, ...content },
    ...overrides,
  }
}

test('reviewErrorText - 原始错因收成一句人话，不念类名/JSON/长堆栈', () => {
  assert.equal(reviewErrorText(new Error('取段评超时')), '取段评超时')
  // 长消息（多半是服务端把异常体整段塞进 message）→ 通用句
  assert.equal(reviewErrorText(new Error('x'.repeat(200))), '这段的段评取不回来，稍后再试')
  // 带 JSON 的错误体 → 通用句
  assert.equal(reviewErrorText(new Error('{"error":"java.lang.NullPointerException at io.legado.rules.RuleRunner.kt:88"}')),
    '这段的段评取不回来，稍后再试')
  // 空 message / 非 Error → 通用句（不许渲染成「取不回来：」这种半截话）
  assert.equal(reviewErrorText(new Error('   ')), '这段的段评取不回来，稍后再试')
  assert.equal(reviewErrorText('字符串原因'), '这段的段评取不回来，稍后再试')
  assert.equal(reviewErrorText(undefined), '这段的段评取不回来，稍后再试')
})

test('applyPage - 第 1 页替换、后续页追加；只有取满一整页才认为可能还有下一页', () => {
  const first = applyPage(empty, [review(), review({ id: 'r2' })], 1)
  assert.equal(first.items.length, 2)
  assert.equal(first.page, 1)
  assert.equal(first.hasMore, false, '两条不满一页，不该出现「再取一页」')

  const second = applyPage(first, [review({ id: 'r3' })], 2)
  assert.deepEqual(second.items.map(i => i.id), ['r1', 'r2', 'r3'], '第二页要追加，不能覆盖')
  assert.equal(second.page, 2)

  const full = Array.from({ length: REVIEWS_PAGE_SIZE }, (_, index) => review({ id: `p${index}` }))
  assert.equal(applyPage(empty, full, 1).hasMore, true, '取满一整页才敢显示「再取一页」')

  // 回头再取第 1 页（重试路径）要换掉而不是叠加
  assert.equal(applyPage(second, [review({ id: 'fresh' })], 1).items.length, 1)
})

test('applyError - 失败只挂原因，已读到的段评不清空', () => {
  const loaded = applyPage(empty, [review(), review({ id: 'r2' })], 1)
  const failed = applyError({ ...loaded, loading: true }, new Error('取段评超时'))
  assert.equal(failed.items.length, 2, '翻页失败不该把已经读到的清空')
  assert.equal(failed.loading, false)
  assert.equal(failed.error, '取段评超时')
  assert.equal(failed.page, 1, '页码不该前进')
})

test('空态说的是「这个书源没有段评」，不是报错', () => {
  const html = renderToStaticMarkup(React.createElement(ChapterReviewsList, {
    state: empty, onRetry: () => {}, onLoadMore: () => {},
  }))
  assert.match(html, /没有段评/, '空态要平静说明，而不是弹错误')
  assert.match(html, /段评内容来自书源自己/, '要看得出内容不是本程序生成的')
  assert.doesNotMatch(html, /role="alert"/, '空态不许当错误提示')
})

test('加载中与失败：失败要有可点的重试，且按钮是 type="button"', () => {
  const loadingHtml = renderToStaticMarkup(React.createElement(ChapterReviewsList, {
    state: { ...empty, loading: true }, onRetry: () => {}, onLoadMore: () => {},
  }))
  assert.match(loadingHtml, /正在取这一章的段评/)

  const errorHtml = renderToStaticMarkup(React.createElement(ChapterReviewsList, {
    state: { ...empty, error: '这段的段评取不回来，稍后再试' }, onRetry: () => {}, onLoadMore: () => {},
  }))
  assert.match(errorHtml, /role="alert"/)
  assert.match(errorHtml, /重试/)
  for (const button of errorHtml.match(/<button[^>]*>/g) ?? []) {
    assert.match(button, /type="button"/, '辅助按钮必须显式 type="button"（AGENTS §5）')
  }
})

test('有数据时逐条渲染正文/赞/回复，图片与音频只在服务端给了才出现', () => {
  const state = applyPage(empty, [
    review(),
    review({ id: 'r2', name: '读者乙', content: { text: '这条带图', likeCount: 0, replyCount: 2, img: 'https://img.example/a.png', audio: 'https://img.example/a.mp3' } }),
    review({ id: 'r3', name: '', content: { text: '匿名', likeCount: 1, replyCount: 0 } }),
  ], 1)
  const html = renderToStaticMarkup(React.createElement(ChapterReviewsList, {
    state, onRetry: () => {}, onLoadMore: () => {},
  }))
  assert.match(html, /这段写得真好/)
  assert.match(html, /赞 3/)
  assert.match(html, /回复 1/)
  assert.match(html, /<img[^>]*a\.png/, '带了图就要渲染图')
  assert.match(html, /<audio[^>]*a\.mp3/, '带了音频就要渲染播放器')
  assert.match(html, /读者/, '没名字的条目要有个默认称呼，不许渲染成空白')
  assert.equal((html.match(/<audio/g) ?? []).length, 1, '没给音频的条目不该凭空多一个播放器')
})

test('可能还有下一页时给「再取一页」，且不承诺是最后一页', () => {
  const state = applyPage(empty, Array.from({ length: REVIEWS_PAGE_SIZE }, (_, index) => review({ id: `p${index}` })), 1)
  const html = renderToStaticMarkup(React.createElement(ChapterReviewsList, {
    state, onRetry: () => {}, onLoadMore: () => {},
  }))
  assert.match(html, /再取一页/)
  assert.doesNotMatch(html, /最后一页/, '服务端没说到底，界面就不许替它下结论')
})

test('选中浮层里多了一个「段评」入口，其余四个动作照旧', () => {
  const html = renderToStaticMarkup(React.createElement(MarkingMenu, {
    x: 10, y: 20,
    onHighlight: () => {}, onNote: () => {}, onCopy: () => {}, onAi: () => {}, onReviews: () => {}, onDismiss: () => {},
  }))
  assert.match(html, /aria-label="段评"/)
  for (const label of ['划线', '笔记', '复制', 'AI']) {
    assert.match(html, new RegExp(`aria-label="${label}"`), `原有动作 ${label} 不该被这一刀挤掉`)
  }
  const buttons = html.match(/<button[^>]*>/g) ?? []
  assert.equal(buttons.length, 6, `选中断层应是 5 个动作 + 关闭，实际 ${buttons.length}`)
  for (const button of buttons) assert.match(button, /type="button"/)
})

test('reviewUrlRuleOf - 读的是段评规则地址，不是章节地址；没配就是 null 而不是报错', () => {
  // 详情层优先
  assert.equal(
    reviewUrlRuleOf(JSON.stringify({ bookSourceUrl: 'https://s.example', ruleReview: { reviewDetailUrl: '/reviews/{{page}}', reviewSummaryUrl: '/summary' } })),
    '/reviews/{{page}}',
  )
  // 只配统计层的源退用它
  assert.equal(
    reviewUrlRuleOf(JSON.stringify({ ruleReview: { reviewSummaryUrl: '/summary' } })),
    '/summary',
  )
  // 配了但为空 → 当作没配
  assert.equal(reviewUrlRuleOf(JSON.stringify({ ruleReview: { reviewDetailUrl: '   ' } })), null)
  // 没有 ruleReview / 结构不对 / 坏 JSON → 一律 null（界面上说「没有段评」，不报错）
  assert.equal(reviewUrlRuleOf(JSON.stringify({ bookSourceUrl: 'https://s.example' })), null)
  assert.equal(reviewUrlRuleOf(JSON.stringify({ ruleReview: 'enabled' })), null)
  assert.equal(reviewUrlRuleOf('{不是 json'), null)
  assert.equal(reviewUrlRuleOf(''), null)
})

test('段评浮层先确认书源有没有这条规则，不预设「取不回就是坏」', () => {
  const html = renderToStaticMarkup(React.createElement(ChapterReviewsDialog, {
    bookName: '某书',
    chapterTitle: '第一章',
    sourceId: 'https://s.example',
    onClose: () => {},
    fetchSourceJson: async () => '{}',
    fetchReviews: async () => [],
  }))
  // 首帧只敢说「正在确认」：规则还没读回来时不许先摆「没有段评」或报错
  assert.match(html, /正在确认这个书源有没有段评/)
  assert.doesNotMatch(html, /没有段评（没配/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="段评 · 第一章"/)
})

test('取数走既有的 POST /api/books/reviews（不新造接口、不裸 fetch）', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method?: string; body: any; credentials?: RequestCredentials }[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input.toString(),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      credentials: init?.credentials,
    })
    return new Response(JSON.stringify([review()]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const items = await book.reviews('https://src.example', 'https://src.example/ch1', 2)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/books/reviews')
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, { sourceId: 'https://src.example', url: 'https://src.example/ch1', page: 2 })
    assert.equal(calls[0].credentials, 'same-origin')
    assert.equal(items.length, 1)
    assert.equal(items[0].content.text, '这段写得真好')
  } finally {
    globalThis.fetch = originalFetch
  }
})
