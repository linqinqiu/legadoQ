import { useCallback, useEffect, useRef, useState } from 'react'
import { book, sources } from '../../../lib/api'
import type { ChapterReview } from '../../../lib/api'
import { Icon } from '../../../icons'
import { useEscapeClose } from '../../../lib/useEscapeClose'
import { zh } from '../../../i18n/zh'

/**
 * 段评详情浮层（第三阶段「段评 UI」第一刀，**只读**）。
 *
 * 形状对着上游 gedoor 的三层 schema 来的：统计层（整章有多少条）/ 详情层（这一页的条目）/
 * 回复层。**这一刀只做详情层**，且只读 —— 统计徽章、子评论、发帖/点赞/删除全都不是本刀范围，
 * 界面上也不给对应的按钮（承诺一个渲染不出来的能力比不做更糟）。
 *
 * 数据来自既有的 `POST /api/books/reviews`（服务端执行书源的 `ruleReview.detailListRule`，
 * 沙箱与 SSRF 闸门全在服务端那条通道上）。书源没配段评规则时服务端回空列表，
 * 这里显示「这个书源没有段评」，不是报错 —— 那是**没有这个能力**，不是失败。
 *
 * 为什么拆成两个组件：负责取数的这一层会接触网络与分页状态；展示层是纯 props 渲染，
 * 判据可以离线摆出加载 / 失败 / 空 / 有数据四种形态（见 `web/test/ChapterReviews.test.ts`）。
 */

export interface ReviewsViewState {
  items: ChapterReview[]
  page: number
  loading: boolean
  /** 上一次加载失败的原因（说人话，不吐堆栈）。 */
  error: string | null
  /** 服务端是否可能还有下一页 —— 只有当某一页取满一整页时才认为「可能还有」。 */
  hasMore: boolean
}

export const REVIEWS_PAGE_SIZE = 20

const initial: ReviewsViewState = { items: [], page: 1, loading: false, error: null, hasMore: false }

/**
 * 取到一页之后的状态推进（纯函数，判据直接调）。
 *
 * 三条口径：① 第 1 页替换、后续页追加；② 只有**取满一整页**才认为可能还有下一页
 * ——这是猜，所以界面上的按钮写「再取一页」而不是「下一页」；③ 失败只记原因、保留已取到的条目
 * （已经读到的不该因为翻页失败被清空）。
 */
export function applyPage(prev: ReviewsViewState, items: ChapterReview[], page: number): ReviewsViewState {
  return {
    items: page === 1 ? items : [...prev.items, ...items],
    page,
    loading: false,
    error: null,
    hasMore: items.length >= REVIEWS_PAGE_SIZE,
  }
}

/** 失败推进：保留已读条目与页码，只把原因挂上去。 */
export function applyError(prev: ReviewsViewState, error: unknown): ReviewsViewState {
  return { ...prev, loading: false, error: reviewErrorText(error) }
}

/**
 * 从书源 JSON 里取「段评详情地址」这条规则。
 *
 * 服务端的 `POST /api/books/reviews` 要的是**规则里的那条地址**（`reviewDetailUrl` 解析后的地址），
 * 不是当前章节地址 —— 段评页往往跟章节页不是一个 URL。取不到就返回 null，
 * 界面上说成「这个书源没有段评」而不是报错：那是**没有这个能力**，不是失败。
 *
 * 优先级照上游语义：详情层用 `reviewDetailUrl`，只配了统计层 `reviewSummaryUrl` 的源退用它。
 */
export function reviewUrlRuleOf(sourceJson: string): string | null {
  try {
    const parsed = JSON.parse(sourceJson) as { ruleReview?: Record<string, unknown> }
    const review = parsed.ruleReview
    if (!review || typeof review !== 'object') return null
    for (const key of ['reviewDetailUrl', 'reviewSummaryUrl']) {
      const value = review[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return null
  } catch {
    return null
  }
}

/** 把服务端（也就是书源规则）给的错因收成一句人话：不念类名、不念堆栈。 */
export function reviewErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim()
    // 后端把「书源没配段评规则」当成空列表返回；走到这里的是真失败，但错误体里可能带 JSON。
    if (message.length > 120 || message.includes('{')) return '这段的段评取不回来，稍后再试'
    return message
  }
  return '这段的段评取不回来，稍后再试'
}

export function ChapterReviewsDialog(props: {
  /** 浮层标题里要显示的书名与章节名（取当前阅读位置，不是选中的那一段）。 */
  bookName: string
  chapterTitle: string
  onClose: () => void
  sourceId: string
  /** 取段评列表，默认走 `POST /api/books/reviews`；判据里注入桩函数，避免碰网络。 */
  fetchReviews?: (sourceId: string, url: string, page: number, signal?: AbortSignal) => Promise<ChapterReview[]>
  /** 取书源 JSON（用来读 `ruleReview.reviewDetailUrl`），默认走 `GET /api/sources/{id}`。 */
  fetchSourceJson?: (sourceId: string) => Promise<string>
}) {
  const { bookName, chapterTitle, onClose, sourceId } = props
  const load = props.fetchReviews ?? book.reviews
  const readSource = props.fetchSourceJson
    ?? ((id: string) => sources.get(id).then(record => record.json))
  const [state, setState] = useState<ReviewsViewState>(initial)
  /** 段评地址规则：`undefined` 正在确认；`null` 这个书源没配段评。 */
  const [urlRule, setUrlRule] = useState<string | null | undefined>(undefined)
  const alive = useRef(true)

  // 这一层也必须能被 Esc 关掉（与其它浮层同一条规矩：遮罩与关闭键走统一那一套）。
  useEscapeClose(onClose)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 先问书源：这条规则在不在。不在就是「没有这个能力」，不当作失败。
  useEffect(() => {
    void readSource(sourceId).then(
      json => { if (alive.current) setUrlRule(reviewUrlRuleOf(json)) },
      () => { if (alive.current) setUrlRule(null) },
    )
  }, [readSource, sourceId])

  const loadPage = useCallback(async (page: number) => {
    if (!urlRule) return
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const items = await load(sourceId, urlRule, page)
      if (!alive.current) return
      setState(prev => applyPage(prev, items, page))
    } catch (error) {
      if (!alive.current) return
      setState(prev => applyError(prev, error))
    }
  }, [load, sourceId, urlRule])

  useEffect(() => { void loadPage(1) }, [loadPage])

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-m"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`段评 · ${chapterTitle}`}
      >
        <header className="dialog-head">
          <div className="source-login-title">
            <span><Icon name="file" /></span>
            <div>
              <h2>段评</h2>
              <small>{bookName} · {chapterTitle}</small>
            </div>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label={zh.common.close}>
            <Icon name="close" />
          </button>
        </header>
        {urlRule === undefined && (
          <div className="chapter-reviews">
            <div className="chapter-reviews-note">正在确认这个书源有没有段评…</div>
          </div>
        )}
        {urlRule === null && (
          <div className="chapter-reviews">
            <div className="chapter-reviews-note">
              这个书源没有段评（没配 ruleReview 段评规则）。
              <br />
              段评内容来自书源自己，不是本程序生成的。
            </div>
          </div>
        )}
        {typeof urlRule === 'string' && (
          <ChapterReviewsList
            state={state}
            onRetry={() => void loadPage(1)}
            onLoadMore={() => void loadPage(state.page + 1)}
          />
        )}
      </div>
    </div>
  )
}

/** 纯展示层：四种形态都在这儿，判据直接摆 props 验。 */
export function ChapterReviewsList(props: {
  state: ReviewsViewState
  onRetry: () => void
  onLoadMore: () => void
}) {
  const { state, onRetry, onLoadMore } = props
  return (
    <div className="chapter-reviews">
      {state.error && (
        <div className="chapter-reviews-note" role="alert">
          <span>{state.error}</span>
          <button type="button" className="subtle-button" onClick={onRetry}>重试</button>
        </div>
      )}
      {!state.error && state.loading && state.items.length === 0 && (
        <div className="chapter-reviews-note">正在取这一章的段评…</div>
      )}
      {!state.error && !state.loading && state.items.length === 0 && (
        <div className="chapter-reviews-note">
          这个书源没有段评（要么没配段评规则，要么这一章确实没人评）。
          <br />
          段评内容来自书源自己，不是本程序生成的。
        </div>
      )}
      {state.items.length > 0 && (
        <ul className="chapter-reviews-list">
          {state.items.map((item, index) => (
            <li key={item.id || `review-${index}`} className="chapter-reviews-item">
              <div className="chapter-reviews-meta">
                {item.avatar
                  ? <img src={item.avatar} alt="" loading="lazy" />
                  : <span className="chapter-reviews-avatar-placeholder" aria-hidden="true" />}
                <span className="chapter-reviews-name">{item.name || '读者'}</span>
                {item.badge && <span className="chapter-reviews-badge">{item.badge}</span>}
                {item.content.time && <span className="chapter-reviews-time">{item.content.time}</span>}
              </div>
              {item.content.text && <p className="chapter-reviews-text">{item.content.text}</p>}
              {item.content.img && <img className="chapter-reviews-img" src={item.content.img} alt="" loading="lazy" />}
              {item.content.audio && (
                <audio className="chapter-reviews-audio" controls preload="none" src={item.content.audio} />
              )}
              <div className="chapter-reviews-foot">
                {item.content.replyToName && <span>回复 {item.content.replyToName}</span>}
                <span>赞 {item.content.likeCount}</span>
                <span>回复 {item.content.replyCount}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.hasMore && !state.loading && (
        <div className="chapter-reviews-more">
          <button type="button" className="subtle-button" onClick={onLoadMore}>再取一页</button>
        </div>
      )}
      {state.loading && state.items.length > 0 && <div className="chapter-reviews-note">正在取下一页…</div>}
    </div>
  )
}
