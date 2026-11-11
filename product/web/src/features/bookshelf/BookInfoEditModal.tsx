// 书籍信息编辑弹窗：书名 / 作者 / 封面（URL、备选书源封面、清除与恢复）。
// 从 ShelfPage.tsx 拆出（2026-11-12 第 2 批降成本）：组件体逐字未动，import 按导出面补全。
// 由 BookManageModal 在「编辑书籍信息」时渲染；全仓无其他调用点。

import { FormEvent, useMemo, useState } from 'react'
import { zh } from '../../i18n/zh'
import { BookshelfItem, api } from '../../lib/api'
import { Icon } from '../../icons'
import { sanitizeImageUrl } from '../../lib/sourceImport'
import { toast } from '../../components/Toast'
import { useEscapeClose } from '../../lib/useEscapeClose'

export function BookInfoEditModal({
  item,
  onSaved,
  onClose,
}: {
  item: BookshelfItem
  onSaved: (updated: BookshelfItem) => void
  onClose: () => void
}) {
  const [name, setName] = useState(item.name)
  const [author, setAuthor] = useState(item.author || '')
  const [coverUrl, setCoverUrl] = useState<string | null>(null) // null = keep existing, '' = clear, string = new URL
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEscapeClose(onClose)

  const candidateCovers = useMemo(() => {
    const map = new Map<string, { sourceId: string; coverUrl: string }>()
    for (const alt of item.alternateSources || []) {
      const url = sanitizeImageUrl(alt.coverUrl)
      if (url && !map.has(url)) {
        map.set(url, { sourceId: alt.sourceId, coverUrl: url })
      }
    }
    return Array.from(map.values())
  }, [item.alternateSources])

  const previewSrc = useMemo(() => {
    if (coverUrl === '') return null
    if (coverUrl) return sanitizeImageUrl(coverUrl)
    if (item.coverKey) return api.cover(item.coverKey)
    return null
  }, [coverUrl, item.coverKey])

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('书名不能为空')
      return
    }

    setSaving(true)
    setError('')
    try {
      const updated = await api.updateBookshelfInfo({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        name: trimmedName,
        author: author.trim() || undefined,
        coverUrl: coverUrl === null ? undefined : coverUrl,
      })
      toast.success(`《${updated.name}》信息已更新`)
      onSaved(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新书籍信息失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay-backdrop is-topped" onClick={onClose}>
      {/* book-info-edit-modal 是行为锚点（无样式）：管理弹窗的 useEscapeClose 按它让位 Esc */}
      <div
        className="dialog-shell size-s book-info-edit-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`编辑书籍信息: ${item.name}`}
      >
        <header className="dialog-head">
          <div>
            <h2>编辑书籍信息</h2>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label={zh.common.close}>
            <Icon name="close" />
          </button>
        </header>

        <form onSubmit={handleSave} className="book-info-edit-form">
          <div className="book-info-edit-body">
            {/* Cover Preview & Options */}
            <div className="edit-cover-section">
              <div className="edit-cover-preview-box">
                {previewSrc ? (
                  <img src={previewSrc} alt="封面预览" referrerPolicy="no-referrer" />
                ) : (
                  <div className="edit-cover-fallback">
                    <span>{name.trim().slice(0, 1) || '书'}</span>
                  </div>
                )}
                {coverUrl !== '' && (item.coverKey || coverUrl) && (
                  <button
                    type="button"
                    className="subtle-button clear-cover-btn"
                    onClick={() => setCoverUrl('')}
                    title="清除并使用文字占位封面"
                  >
                    清除封面
                  </button>
                )}
                {coverUrl === '' && (
                  <button
                    type="button"
                    className="subtle-button reset-cover-btn"
                    onClick={() => setCoverUrl(null)}
                    title="恢复原封面"
                  >
                    恢复原封面
                  </button>
                )}
              </div>

              <div className="edit-cover-inputs">
                <label className="edit-form-label">
                  <span>封面图片 URL</span>
                  <div className="input-with-icon">
                    <Icon name="image" />
                    <input
                      type="url"
                      placeholder="https://example.com/cover.jpg"
                      value={coverUrl === null ? '' : coverUrl}
                      onChange={e => setCoverUrl(e.target.value)}
                    />
                  </div>
                  <small>可粘贴图片网络地址，保存时将自动拉取并缓存到服务器</small>
                </label>

                {candidateCovers.length > 0 && (
                  <div className="candidate-covers-picker">
                    <span className="candidate-covers-title">从备选书源选择封面 ({candidateCovers.length})：</span>
                    <div className="candidate-covers-grid">
                      {candidateCovers.map(c => {
                        const isSelected = coverUrl === c.coverUrl
                        return (
                          <button
                            key={c.coverUrl}
                            type="button"
                            className={`candidate-cover-card ${isSelected ? 'selected' : ''}`}
                            onClick={() => setCoverUrl(c.coverUrl)}
                            title={`使用来自【${c.sourceId}】的封面`}
                          >
                            <img src={c.coverUrl} alt={c.sourceId} referrerPolicy="no-referrer" />
                            <small>{c.sourceId}</small>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Title & Author Fields */}
            <div className="edit-fields-section">
              <label className="edit-form-label">
                <span>书名 <span className="required-mark">*</span></span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="请输入书名"
                />
              </label>

              <label className="edit-form-label">
                <span>作者</span>
                <input
                  type="text"
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                  placeholder="作者（可选）"
                />
              </label>
            </div>

            {error && <p className="form-error">{error}</p>}
          </div>

          <footer className="book-info-edit-footer">
            <button type="button" className="subtle-button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '保存中…' : '保存修改'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}