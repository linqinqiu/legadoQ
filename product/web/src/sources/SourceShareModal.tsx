import { useEffect, useMemo, useState } from 'react'
import { api, SourceSummary } from '../lib/api'
import { Icon } from '../icons'

/** 当前访问来源；导出链接要按它拼绝对地址。 */
const currentOrigin = () => (typeof location === 'undefined' ? '' : location.origin)
import { useEscapeClose } from '../lib/useEscapeClose'

interface SourceShareModalProps {
  /** 要分享的书源 id；一个就是单源分享，多个打包成数组。 */
  sourceIds: string[]
  sources: SourceSummary[]
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/**
 * 书源分享。
 *
 * 上游安卓端的网络一键导入格式是 `legado://import/{path}?src={url}`
 * （`ui/association/OnLineImportActivity.kt` 文件头注释），`src` 必须是**手机能访问到的地址**，
 * 所以这里能立刻用的是「剪贴板导入」：手机 Legado 的书源管理里有从剪贴板导入，
 * 不依赖任何网络暴露。真正的 `legado://` 链接要能落地，得先有一个手机可达的服务地址。
 */
export function SourceShareModal({ sourceIds, sources, onClose, onToast }: SourceShareModalProps) {
  const [payload, setPayload] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'json' | 'link' | null>(null)

  useEscapeClose(onClose)
  const picked = useMemo(
    () => sourceIds.map(id => sources.find(item => item.id === id)).filter(Boolean) as SourceSummary[],
    [sourceIds, sources]
  )

  useEffect(() => {
    let cancelled = false
    setPayload('')
    setError('')
    void api.exportSources(sourceIds).then(list => {
      if (cancelled) return
      const parsed = list.map(item => runCatchingParse(item))
      const missing = list.length - parsed.filter(Boolean).length
      const single = sourceIds.length === 1 ? parsed[0] : parsed.filter(Boolean)
      // 单源且那条存储不是合法 JSON：宁可不给内容，也不能把 `null` 当成"能复制的分享体"
      setPayload(single ? JSON.stringify(single, null, 2) : '')
      if (missing) setError(`有 ${missing} 个书源的存储内容不是合法 JSON，已从分享结果里跳过`)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '导出失败')
    })
    return () => { cancelled = true }
  }, [sourceIds])

  const shareLink = useMemo(() => {
    if (!payload) return ''
    // 深链里的 src 指向本机导出接口：只有手机能访问到这个地址时才打得开
    const src = `${currentOrigin()}/api/sources/export?${sourceIds.map(id => `id=${encodeURIComponent(id)}`).join('&')}`
    return `legado://import/bookSource?src=${encodeURIComponent(src)}`
  }, [payload, sourceIds])

  const copy = async (text: string, which: 'json' | 'link') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      onToast(which === 'json' ? '书源 JSON 已复制，到目标设备的 Legado「书源管理 · 本地导入 · 剪贴板导入」里粘贴即可' : '分享链接已复制', 'success')
      window.setTimeout(() => setCopied(null), 2000)
    } catch {
      onToast('浏览器拒绝了剪贴板写入，请手动选中框内内容复制', 'error')
    }
  }

  const download = () => {
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const stem = sourceIds.length === 1 ? (picked[0]?.name || 'source') : `legado-sources-${sourceIds.length}`
    link.download = `legado-source-${stem.replace(/[\\/:*?"<>|]/g, '_')}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="分享书源">
        <header className="dialog-head source-share-header">
          <div>
            <h2>分享书源</h2>
            <small>
              {picked.length === 1
                ? `${picked[0].name}${picked[0].group ? `｜${picked[0].group}` : ''}`
                : `已选 ${picked.length} 个书源，打包成一个 JSON 数组`}
            </small>
          </div>
          <button type="button" className="overlay-close" title="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="source-share-body">
          <p className="source-share-tip">
            复制下面这份 JSON，粘贴到另一台设备 Legado 的「书源管理 · 本地导入 · 剪贴板导入」里即可，
            <strong>不需要那台设备能访问这台电脑</strong>。下面的 <code>legado://</code> 深链要能打开，
            前提是那台设备访问得到 <code>{currentOrigin().replace(/^https?:\/\//, '')}</code>
            —— 服务默认只绑 127.0.0.1，这种情况下深链打不开，剪贴板那条仍然可用。
          </p>
          {error && <p className="form-error">{error}</p>}
          <textarea className="source-share-text" readOnly value={payload} onFocus={event => event.currentTarget.select()} />
        </div>

        <footer className="source-share-footer">
          <button type="button" className="primary-button" disabled={!payload} onClick={() => void copy(payload, 'json')}>
            {copied === 'json' ? '已复制' : '复制书源 JSON'}
          </button>
          <button type="button" className="subtle-button" disabled={!payload} onClick={download}>
            下载 .json
          </button>
          <button type="button" className="subtle-button" disabled={!shareLink} onClick={() => void copy(shareLink, 'link')}>
            {copied === 'link' ? '已复制' : '复制 legado:// 链接'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function runCatchingParse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
