/**
 * 正文加载中的骨架屏（正文还没取回来时铺在阅读区上）。从 `ReaderScreen` 抽出来
 * （PROPOSAL-019 F）：纯呈现，没有任何 props。
 */
export function ReaderContentSkeleton() {
  return (
    <div className="reader-loading-container" aria-label="正在加载正文">
      <div className="reader-loading-badge">
        <span className="reader-loading-spinner-ring" />
        <span>正在从书源拉取正文…</span>
      </div>
      <div className="reader-skeleton-paragraphs">
        <div className="skeleton-line" style={{ width: '100%' }} />
        <div className="skeleton-line" style={{ width: '94%' }} />
        <div className="skeleton-line" style={{ width: '98%' }} />
        <div className="skeleton-line" style={{ width: '91%' }} />
        <div className="skeleton-line" style={{ width: '62%' }} />
        <div className="skeleton-gap" />
        <div className="skeleton-line" style={{ width: '100%' }} />
        <div className="skeleton-line" style={{ width: '96%' }} />
        <div className="skeleton-line" style={{ width: '92%' }} />
        <div className="skeleton-line" style={{ width: '48%' }} />
      </div>
    </div>
  )
}
