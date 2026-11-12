import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  TransitionEvent as ReactTransitionEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { Fragment } from 'react'
import type { Chapter } from '../../lib/api'
import { describeLoadError } from '../../lib/loadErrors'
import { Icon } from '../../icons'
import { MediaBlock } from './content/MediaBlock'
import { ReaderContentSkeleton } from './ReaderContentSkeleton'
import type { ReaderSettings } from './settingsPanel/readerSettings'

export interface PageCoverTurn {
  to: number
  direction: 1 | -1
}

export interface ReaderBodyProps {
  pageMode: ReaderSettings['pageMode']
  uiV2: boolean
  flowKey: string
  /** 画布之后的附加内容（如边界提示），仍留在 `.reader-main` 里。 */
  children?: ReactNode
  refs: {
    main: RefObject<HTMLElement | null>
    viewport: RefObject<HTMLDivElement | null>
    body: RefObject<HTMLDivElement | null>
    anchor: RefObject<HTMLElement | null>
    sentinel: RefObject<HTMLDivElement | null>
  }
  events: {
    onMouseUp: (event: ReactMouseEvent<HTMLElement>) => void
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
  }
  pagination: {
    pageIndex: number
    pageCount: number
    stride: number
    columnWidth: number
    columnGap: number
    isDoubleColumn: boolean
    pageAnim: ReaderSettings['pageAnim']
    fading: boolean
    slideAnimOn: boolean
    coverTurn: PageCoverTurn | null
    coverEntered: boolean
    onCoverTransitionEnd: (event: ReactTransitionEvent) => void
    footerTitle: string
  }
  content: {
    chapter: Chapter
    chapterIndex: number
    totalChapters: number
    head: { chapter: Chapter; content: string }[]
    tail: { chapter: Chapter; content: string }[]
    pageFillers: number[]
    shownTitle: string
    incomingTitle: string
    stale: boolean
    loading: boolean
    hasContent: boolean
    chapterLoaded: boolean
    message: string
    mediaSrc: string | null
    sourceType: number
    isMangaMode: boolean
    paragraphs: string[]
    shownParagraphs: string[]
    /**
     * 「等了很久还没出来」。由阅读器计时（8s）而不是这里：展示层不该持有计时器，
     * 而这条要跨两种渲染形态（分页轨道与滚动续接）保持一致。
     */
    slowLoad: boolean
    chunked: boolean
    renderLimit: number
    nextChapterTitle: string
    chapterProgress: number
    shownChapterIndex: number
    scrubIndex: number | null
  }
  actions: {
    convert: (text: string) => string
    splitBody: (content: string) => string[]
    renderLine: (line: string, index: number, owner?: Chapter) => ReactNode
    renderManga: () => ReactNode
    onMediaEnded: () => void
    onNextChapter: (index: number, position?: 'first' | 'last') => void
    onMore: () => void
    onScrub: (index: number) => void
    onScrubCommit: () => void
    /** 正文加载失败时"重新加载"：重拉当前章（不是换章、不是刷新整页）。 */
    onRetryChapter: () => void
    /**
     * 读不出来时的"往哪走"。文案由 `recoveryLabel` 给（换用备选源 / 去已拥有书源里找），
     * 具体做什么由阅读器决定 —— 展示层不知道书源表长什么样。
     */
    onRecover: () => void
    recoveryLabel: string
    /** 返回书架。加载卡住时这是最后一条出路，必须始终可点。 */
    onExit: () => void
  }
}

/**
 * 正文渲染：分页轨道（含 cover 覆盖层）与滚动续接两种形态。
 *
 * 从 `ReaderScreen.tsx` 搬出来的纯展示层：这里不取数、不测量、不写状态，
 * 所有数据与动作由阅读器传进来。两处共用 `renderSections`，避免"主轨道改了、覆盖层忘改"。
 *
 * 几条不能动的结构约定：
 * - 分页模式是一篇连续文档：一章一个 `<section>` 排在同一条分栏流里，翻页跨章只是下一页；
 *   容器 key 只在主动跳章/换书时换（续接推进不换），否则每跨一章白闪一次。
 * - 滚动模式把后续章节续接在同一棵容器里，读完一章是"顶上来"，不是"跳过去"。
 * - 垫栏（`reader-column-filler`）的下标是"这一章在窗口里的绝对位置"：head 占 0..K-1、锚点 K、尾巴 K+1..。
 */
export function ReaderBody({ pageMode, uiV2, flowKey, refs, events, pagination, content, actions, children }: ReaderBodyProps) {
  const {
    chapter, chapterIndex, totalChapters, head, tail, pageFillers,
    shownTitle, incomingTitle, stale, loading, hasContent, chapterLoaded, message,
    mediaSrc, sourceType, isMangaMode, paragraphs, shownParagraphs,
    chunked, renderLimit, nextChapterTitle, chapterProgress, shownChapterIndex, scrubIndex,
    slowLoad,
  } = content
  const { convert, splitBody, renderLine, renderManga, onMediaEnded, onNextChapter, onMore, onScrub, onScrubCommit, onRetryChapter, onRecover, recoveryLabel, onExit } = actions
  // 原始报错翻一句人话：内网被拦 / 要登录 / 站点挂了 三类修法完全不同，
  // 直接把 `message` 糊上去时用户只看到"书源执行失败"，不知道该改哪里。
  const loadError = describeLoadError(message)

  /**
   * 正文读不出来 / 迟迟不回来时的出路。两处渲染形态共用一份，理由同 `renderSections` 的注释：
   * 分页轨道与滚动续接各写一份，迟早只改一处。
   *
   * 三条出路对应三种真实处境，缺一不可：
   * - 「重新加载」：源站抽了一下，重拉就好；
   * - 「换源」：这本书在这个源读到一半没了（下架／地址变了）——用户自己唯一的修法；
   * - 「返回书架」：前两条都不管用，得让人走得掉（用户 2026-11-12：正文长时间拉不出来时
   *   退不出去）。它只在**卡住**时出现：正常情况下阅读器有自己的返回控件。
   */
  const renderRecovery = (variant: 'error' | 'slow') => (
    <span className="reader-recovery-actions">
      {variant === 'error' && (
        <button type="button" className="reader-error-retry" onClick={onRetryChapter}>重新加载</button>
      )}
      <button type="button" className="reader-error-recover" onClick={onRecover}>{recoveryLabel}</button>
      {variant === 'slow' && (
        <button type="button" className="reader-error-retry" onClick={onExit}>返回书架</button>
      )}
    </span>
  )

  const renderSections = () => (
    <>
      {head.map((item, headIndex) => (
        <Fragment key={item.chapter.url}>
          {headIndex > 0 && (pageFillers[headIndex - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
          <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
            <h1>{convert(item.chapter.title)}</h1>
            {splitBody(item.content).map((line, index) => renderLine(line, index, item.chapter))}
          </section>
        </Fragment>
      ))}
      {head.length > 0 && (pageFillers[head.length - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
      <section className="reader-page-chapter" data-chapter-index={chapter?.index ?? 0}>
        <h1>{convert(shownTitle ?? '')}</h1>
        {stale && <p className="reader-chapter-incoming" role="status">正在载入：{convert(incomingTitle)}</p>}
        {/* 出路排在骨架屏**上面**：骨架屏占满一屏，排在它下面等于"首屏之外"，
            实测截图确认过（2026-11-13）——用户的抱怨本来就是"走不掉"，
            把按钮摆到他看不见的地方等于没修。 */}
        {loading && !hasContent && slowLoad && !message && (
          <div className="reader-slow-load" role="status">
            <span>正文还没拉回来。可以再等等，也可以换一个书源，或先回书架。</span>
            {renderRecovery('slow')}
          </div>
        )}
        {loading && !hasContent && <ReaderContentSkeleton />}
        {message && (
          <p className="reader-error" role="alert">
            {loadError.headline}
            {loadError.hint && <span className="reader-error-hint">{loadError.hint}</span>}
            {renderRecovery('error')}
          </p>
        )}
        {mediaSrc
          ? <MediaBlock mediaSrc={mediaSrc} sourceType={sourceType} onEnded={onMediaEnded} />
          : isMangaMode
            ? renderManga()
            : paragraphs.map((line, index) => renderLine(line, index))}
      </section>
      {tail.map((item, tailIndex) => (
        <Fragment key={item.chapter.url}>
          {(pageFillers[head.length + tailIndex] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
          <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
            <h1>{convert(item.chapter.title)}</h1>
            {splitBody(item.content).map((line, index) => renderLine(line, index, item.chapter))}
          </section>
        </Fragment>
      ))}
    </>
  )

  return (
    <section ref={refs.main} className="reader-main" onMouseUp={events.onMouseUp}>
      {pageMode === 'paginate' ? (
        <div className="reader-paginated-wrap" onPointerDown={events.onPointerDown} onPointerUp={events.onPointerUp} onWheel={events.onWheel} onContextMenu={events.onContextMenu}>
          <div ref={refs.viewport} className={`reader-paginated-viewport ${pagination.isDoubleColumn ? 'is-double-column' : ''}${pagination.pageAnim === 'fade' && pagination.fading ? ' is-fading' : ''}`}>
            <div className={`reader-paginated-track${pagination.slideAnimOn ? ' is-anim-slide' : ''}`} style={{ transform: `translateX(-${pagination.pageIndex * pagination.stride}px)` }}>
              <article ref={refs.body} key={flowKey} className={`reader-paginated-column-body chapter-enter${stale ? ' is-stale' : ''}`} style={{ columnWidth: `${pagination.columnWidth}px`, columnGap: `${pagination.columnGap}px` }}>
                {renderSections()}
              </article>
            </div>
            {/*
              覆盖动画（pageAnim === 'cover'）的进场层：新页从一侧盖上来，旧页原地不动。
              平时不占 DOM；`reader-paginated-column-body` 与主轨道同款，测量只认主轨道的 bodyRef。
            */}
            {pagination.coverTurn && (
              <div
                className={`reader-page-cover is-from-${pagination.coverTurn.direction === 1 ? 'next' : 'prev'}${pagination.coverEntered ? ' is-entered' : ''}`}
                aria-hidden="true"
                onTransitionEnd={pagination.onCoverTransitionEnd}
              >
                <div className="reader-paginated-track" style={{ transform: `translateX(-${pagination.coverTurn.to * pagination.stride}px)` }}>
                  <div className="reader-paginated-column-body" style={{ columnWidth: `${pagination.columnWidth}px`, columnGap: `${pagination.columnGap}px` }}>
                    {renderSections()}
                  </div>
                </div>
              </div>
            )}
          </div>
          {/* 页脚只留状态，不再放「上一页 / 下一页」两颗键：点按区、键盘、滚轮与滑动都能翻页。 */}
          <footer className="reader-paginated-footer">
            <span className="reader-paginated-chapter">{convert(pagination.footerTitle || '')}</span>
            <span className="reader-paginated-pagecount">{pagination.pageIndex + 1} / {pagination.pageCount}</span>
          </footer>
        </div>
      ) : (
        <article className={`reading-content chapter-enter${stale ? ' is-stale' : ''}`} key={flowKey} onPointerDown={events.onPointerDown} onPointerUp={events.onPointerUp} onContextMenu={events.onContextMenu}>
          <section ref={refs.anchor} className="reader-flow-chapter" data-chapter-index={chapter?.index ?? 0}>
            <h1>{convert(shownTitle ?? '')}</h1>
            {stale && <p className="reader-chapter-incoming" role="status">正在载入：{convert(incomingTitle)}</p>}
            {loading && !hasContent && slowLoad && !message && (
              <div className="reader-slow-load" role="status">
                <span>正文还没拉回来。可以再等等，也可以换一个书源，或先回书架。</span>
                {renderRecovery('slow')}
              </div>
            )}
            {loading && !hasContent && <ReaderContentSkeleton />}
            {message && (
          <p className="reader-error" role="alert">
            {loadError.headline}
            {loadError.hint && <span className="reader-error-hint">{loadError.hint}</span>}
            {renderRecovery('error')}
          </p>
        )}
            {mediaSrc
              ? <MediaBlock mediaSrc={mediaSrc} sourceType={sourceType} onEnded={onMediaEnded} />
              : isMangaMode
                ? renderManga()
                : shownParagraphs.map((line, index) => renderLine(line, index))}
            {chunked && renderLimit < paragraphs.length && (
              <div className="reader-chunk-more" ref={refs.sentinel}>
                <button type="button" className="subtle-button" onClick={onMore}>
                  继续加载（已显示 {Math.min(renderLimit, paragraphs.length)} / {paragraphs.length} 段）
                </button>
              </div>
            )}
          </section>
          {tail.map(item => (
            <section key={item.chapter.url} className="reader-flow-chapter reader-flow-tail" data-chapter-index={item.chapter.index}>
              <h1>{convert(item.chapter.title)}</h1>
              {splitBody(item.content).map((line, index) => renderLine(line, index, item.chapter))}
            </section>
          ))}
          {hasContent && !loading && chapterLoaded && !!nextChapterTitle && tail.length === 0 && (
            <div className="reader-next-hint">
              <button type="button" onClick={() => onNextChapter(chapterIndex + 1, 'first')}>
                <span>下一章 · {convert(nextChapterTitle)}</span>
                <Icon name="chevronDown" />
              </button>
              <small>这是最后一章之前唯一没有续接上的位置：滚到底再向下滑即进入</small>
            </div>
          )}
          {/* 旧界面的章节导航页脚：MD3 外壳已有顶栏与目录，不再挂第二份入口。 */}
          {!uiV2 && hasContent && <footer className="reader-navigation"><button disabled={chapterIndex === 0 || loading} onClick={() => onNextChapter(chapterIndex - 1)}><Icon name="arrowLeft" />上一章</button><div className="chapter-progress"><i style={{ width: `${chapterProgress}%` }} /><input className="chapter-scrub" type="range" min={0} max={Math.max(0, totalChapters - 1)} step={1} value={shownChapterIndex} disabled={loading || totalChapters < 2} aria-label={`章节进度：第 ${shownChapterIndex + 1} 章，共 ${totalChapters} 章`} onChange={event => onScrub(Number(event.target.value))} onPointerUp={onScrubCommit} onKeyUp={onScrubCommit} /><span>{shownChapterIndex + 1} / {totalChapters}</span></div><button disabled={chapterIndex === totalChapters - 1 || loading} onClick={() => onNextChapter(chapterIndex + 1)}>下一章<Icon name="arrowRight" /></button></footer>}
        </article>
      )}
      {children}
    </section>
  )
}
