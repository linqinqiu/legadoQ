// 书籍详情弹窗：搜索/发现/书架共用，含加架与换源入口
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CoverFallback } from '../shelf/Cover'
import { Icon } from '../icons'
import type { OpenBook } from '../reader/openBook'
import { SourceChoice } from '../lib/searchStore'
import { SourceHealthInspection, clearStoredInspections, getInitialOrStoredInspections, inspectAllSourcesConcurrently } from '../sources/sourceInspector'
import { SourceSummary, api } from '../lib/api'
import { bookTypeMeta } from '../shelf/bookType'
import { cleanAuthor, cleanTitle, formatIntro } from '../lib/searchFilters'
import { sanitizeImageUrl } from '../sources/sourceImport'
import { scrollPosition } from '../reader/readerSettings'
import { toast } from './Toast'
import { SourceChoiceList } from './SourceChoiceList'
import { useEscapeClose } from '../lib/useEscapeClose'

export function BookDetailModal({
  book,
  choices,
  sources,
  onSourcesChanged,
  resumeIndex,
  onOpen,
  onChooseSource,
  onClose,
}: {
  book: OpenBook
  choices: SourceChoice[]
  /** 本机书源清单：换源行要靠它把 sourceId 反查成名字与分组。 */
  sources: SourceSummary[]
  onSourcesChanged?: () => void
  resumeIndex: number
  onOpen: (index: number) => void
  onChooseSource: (choice: SourceChoice) => void
  onClose: () => void
}) {
  const [introExpanded, setIntroExpanded] = useState(false)
  const [inspections, setInspections] = useState<Map<string, SourceHealthInspection>>(() =>
    getInitialOrStoredInspections(choices.map(c => c.result))
  )
  const [checking, setChecking] = useState(false)
  const [inShelf, setInShelf] = useState<boolean | null>(null)
  const [shelfBusy, setShelfBusy] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const cancelInspectRef = useRef(false)

  const latestChapter = book.chapters.at(-1)
  const availableSources = choices.length
  /**
   * 详情页封面优先于搜索结果封面，但源站详情页常给出一个打不开的地址（防盗链、http、已失效），
   * 直接渲染就是一个破图框。这里排好候选队列，onError 逐级降级到别的源拿到的封面。
   */
  const coverCandidates = useMemo(() => {
    const seen = new Set<string>()
    return [book.details.coverUrl, ...choices.map(choice => choice.result.coverUrl)]
      .map(url => sanitizeImageUrl(url ?? undefined))
      .filter((url): url is string => {
        if (!url || seen.has(url)) return false
        seen.add(url)
        return true
      })
  }, [book.details.coverUrl, choices])
  const [coverTried, setCoverTried] = useState(0)
  const cover = coverCandidates[coverTried]
  /** 外域封面走服务端代理（0.6.22），浏览器只加载同源地址 */
  const coverSrc = cover ? api.coverProxy(cover, book.details.sourceId) : null
  /** 点详情封面放大查看（用户 2026-10-09：只在书籍详情页放大，其余地方不动）。 */
  const [coverZoom, setCoverZoom] = useState(false)
  /** 换源/换书时弹窗不卸载：上一本书的封面报错计数不复位，下一本的有效封面永远显示不出来。 */
  useEffect(() => {
    setCoverTried(0)
    setIntroExpanded(false)
  }, [book.bookUrl])

  /** 体检只认"这一批源是谁"（key），不认 choices 数组的身份 —— 搜索 store 每次状态更新都会
      重建数组，按身份依赖会让体检被中止后**从零重新联网复检**。 */
  const choicesKey = useMemo(
    () => choices.map(c => `${c.result.sourceId}\u0000${c.result.bookUrl}`).join('\u0001'),
    [choices],
  )
  const choicesRef = useRef(choices)
  choicesRef.current = choices
  const runInspection = useCallback((forceRefresh = false) => {
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    cancelInspectRef.current = false
    const rawSources = choicesRef.current.map(c => c.result)
    if (forceRefresh) {
      clearStoredInspections(rawSources)
      setInspections(getInitialOrStoredInspections(rawSources))
    }
    setChecking(true)
    void inspectAllSourcesConcurrently(
      rawSources,
      3,
      updated => {
        if (!cancelInspectRef.current && !controller.signal.aborted) {
          setInspections(updated)
        }
      },
      () => cancelInspectRef.current || controller.signal.aborted,
      undefined,
      controller.signal
    ).finally(() => {
      if (!cancelInspectRef.current && !controller.signal.aborted) {
        setChecking(false)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choicesKey])

  useEffect(() => {
    runInspection()
    return () => {
      cancelInspectRef.current = true
      abortControllerRef.current?.abort()
    }
  }, [runInspection])

  const handleClose = useCallback(() => {
    cancelInspectRef.current = true
    abortControllerRef.current?.abort()
    onClose()
  }, [onClose])

  const handleOpenReader = useCallback((idx: number) => {
    cancelInspectRef.current = true
    abortControllerRef.current?.abort()
    onOpen(idx)
  }, [onOpen])

  /**
   * 目录预览一次全给（0.6.21）：整份目录都挂成按钮，不再分水位。
   * 离屏行靠 CSS content-visibility 不参与布局与绘制，大目录也不会卡。
   */
  const visibleChapters = useMemo(() => book.chapters.map(item => (
    <button
      className={item.index === resumeIndex ? 'resume-chapter' : ''}
      key={item.url}
      onClick={() => handleOpenReader(item.index)}
    >
      <span>{item.title}</span>
      {item.index === resumeIndex && book.progress && <small>上次阅读</small>}
    </button>
  )), [book.chapters, book.progress, handleOpenReader, resumeIndex])

  useEffect(() => {
    let active = true
    void api.bookshelf().then(items => {
      if (!active) return
      const found = items.some(
        item => (item.sourceId === book.details.sourceId && item.bookUrl === book.bookUrl) ||
                (cleanTitle(item.name).toLowerCase() === cleanTitle(book.details.name).toLowerCase() &&
                 (cleanAuthor(item.author) || '').toLowerCase() === (cleanAuthor(book.details.author) || '').toLowerCase())
      )
      setInShelf(found)
    }).catch(() => {
      if (active) setInShelf(false)
    })
    return () => {
      active = false
    }
  }, [book.details.sourceId, book.bookUrl, book.details.name, book.details.author])

  const toggleShelf = async () => {
    if (shelfBusy) return
    setShelfBusy(true)
    try {
      if (inShelf) {
        await api.removeFromBookshelf(book.details.sourceId, book.bookUrl)
        setInShelf(false)
        toast.info(`《${book.details.name}》已移出书架`)
      } else {
        const fallbackCover = book.details.coverUrl || choices.find(c => c.result.coverUrl?.trim())?.result.coverUrl?.trim()
        await api.addToBookshelf({
          sourceId: book.details.sourceId,
          bookUrl: book.bookUrl,
          name: book.details.name,
          author: book.details.author,
          tocUrl: book.details.tocUrl,
          coverUrl: fallbackCover || undefined,
          alternateSources: choices.map(c => c.result).filter(s => s.sourceId !== book.details.sourceId || s.bookUrl !== book.bookUrl),
        })
        setInShelf(true)
        toast.success(`《${book.details.name}》已加入书架`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作书架失败')
    } finally {
      setShelfBusy(false)
    }
  }

  // Esc 分层关闭：封面大图叠在详情弹窗之上时，一次 Esc 只收最上面那层，不穿透。
  // 第一条负责收大图（没开就什么都不做）；第二条带 blockedBy —— 大图还挂在 DOM 上时它让位。
  useEscapeClose(() => { if (coverZoom) setCoverZoom(false) })
  useEscapeClose(handleClose, '[aria-label="封面预览"]')

  const handleSelectChoice = (choice: SourceChoice) => {
    const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
    const insp = inspections.get(key)
    const fallbackCover = book.details.coverUrl || choices.find(c => c.result.coverUrl?.trim())?.result.coverUrl?.trim()
    const fallbackIntro = book.details.intro || choices.find(c => c.result.intro?.trim())?.result.intro?.trim()

    if (insp?.book) {
      const mergedBook: OpenBook = {
        ...insp.book,
        details: {
          ...insp.book.details,
          name: (cleanTitle(insp.book.details.name) && cleanTitle(insp.book.details.name) !== '未命名书籍' && cleanTitle(insp.book.details.name) !== '未知书名')
            ? cleanTitle(insp.book.details.name)
            : book.details.name,
          author: cleanAuthor(insp.book.details.author) || book.details.author,
          coverUrl: insp.book.details.coverUrl || fallbackCover || undefined,
          intro: insp.book.details.intro || fallbackIntro || undefined,
          alternateSources: choices.map(c => c.result).filter(s => s.sourceId !== choice.result.sourceId || s.bookUrl !== choice.result.bookUrl),
        }
      }
      onChooseSource({ ...choice, book: mergedBook, status: 'loaded' })
    } else {
      onChooseSource(choice)
    }
  }

  return (
    <div className="overlay-backdrop" onClick={handleClose}>
      <div
        className="dialog-shell size-m book-detail-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`书籍详情: ${book.details.name}`}
      >
        <header className="dialog-head book-detail-modal-header">
          <div className="book-detail-heading">
            {coverSrc ? (
              <button type="button" className="book-detail-cover-btn" aria-label="放大查看封面" title="放大查看封面" onClick={() => setCoverZoom(true)}>
                <img className="book-detail-cover" src={coverSrc} alt="" referrerPolicy="no-referrer" onError={() => setCoverTried(count => count + 1)} />
              </button>
            ) : (
              // 以前这里只有书名第一个字，等于一块带字的色板；换成与书架同一套文字书封
              <div className="book-detail-cover book-detail-cover-text"><CoverFallback name={book.details.name} author={book.details.author} /></div>
            )}
            <div className="book-detail-info">
              <h2>{book.details.name}</h2>
              <p>
                {book.details.author || '未知作者'}
                {bookTypeMeta(book.details.sourceType) && (
                  <span className={`book-type-badge type-${book.details.sourceType}`}>{bookTypeMeta(book.details.sourceType)!.label}</span>
                )}
              </p>
              {/*
                一行 run-on 的 span 读不出主次（用户：「书籍详情信息不完善，明了」）：
                改成"标签 + 值"两列，并把书架上才有、这里一直没说过的阅读进度补进来。
              */}
              <dl className="book-detail-stats">
                <div><dt>章节</dt><dd>{book.chapters.length} 章</dd></div>
                <div><dt>可用源</dt><dd>{availableSources || 1} 个</dd></div>
                {!!book.details.kind && <div><dt>分类</dt><dd>{book.details.kind}</dd></div>}
                {!!book.details.wordCount && <div><dt>篇幅</dt><dd>{book.details.wordCount}</dd></div>}
                {(book.details.lastChapter || latestChapter?.title) && <div><dt>最新</dt><dd>{book.details.lastChapter || latestChapter?.title}</dd></div>}
                {book.progress && book.chapters.length > 0 && (
                  <div>
                    <dt>读到</dt>
                    <dd>
                      第 {Math.min(book.progress.chapterIndex + 1, book.chapters.length)} 章 ·{' '}
                      {Math.min(100, Math.round((((book.progress.chapterIndex + 1) / book.chapters.length) + book.progress.scrollPosition / Math.max(1, book.chapters.length)) * 100))}%
                      {' '}· {new Date(book.progress.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
          <div className="book-detail-header-actions">
            <button
              type="button"
              className={`subtle-button shelf-toggle-btn ${inShelf ? 'in-shelf' : ''}`}
              onClick={toggleShelf}
              disabled={shelfBusy || inShelf === null}
              title={inShelf ? '从书架中移出' : '加入书架'}
            >
              <Icon name="book" />
              <span>{inShelf ? '已在书架' : '加入书架'}</span>
            </button>
            <button className="primary-button read-btn" onClick={() => handleOpenReader(resumeIndex)}>
              {book.progress ? '继续阅读' : '开始阅读'}
              <Icon name="arrowRight" />
            </button>
            <button type="button" className="overlay-close" onClick={handleClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="book-detail-modal-body">
          {choices.length > 1 && (
            <div className="book-detail-section">
              <SourceChoiceList
                choices={choices}
                inspections={inspections}
                sources={sources}
                active={book.bookUrl}
                onChoose={handleSelectChoice}
                onRecheck={() => runInspection(true)}
                onSourcesChanged={onSourcesChanged}
                checking={checking}
              />
            </div>
          )}

          {book.details.intro && (
            <div className="book-detail-section">
              <div className={`book-intro ${introExpanded ? 'expanded' : ''}`}>
                <p>{formatIntro(book.details.intro)}</p>
                {book.details.intro.length > 120 && (
                  <button className="intro-toggle" onClick={() => setIntroExpanded(value => !value)}>
                    {introExpanded ? '收起简介' : '展开简介'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="book-detail-section">
            <div className="book-detail-section-title">
              <span>目录预览</span>
              <small>共 {book.chapters.length} 章</small>
            </div>
            {/* 一次全给（用户 2026-10-09：「目录预览直接展示全部目录，不需要展开了」）。
                离屏行靠 CSS content-visibility 不参与布局与绘制，所以不必再分水位 ——
                "继续展开 / 收起"那种做法让大目录看着像只显示了一小截。 */}
            <div className="preview-chapters">
              {visibleChapters}
            </div>
          </div>
        </div>
      </div>
      {coverZoom && coverSrc && (
        /* 与阅读器正文配图同一套看图层（.overlay-backdrop.is-viewer） */
        <div
          className="overlay-backdrop is-viewer"
          onClick={event => { event.stopPropagation(); setCoverZoom(false) }}
          role="dialog"
          aria-label="封面预览"
        >
          <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={() => setCoverZoom(false)}><Icon name="close" /></button>
          <img src={coverSrc} alt="" onClick={event => event.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

