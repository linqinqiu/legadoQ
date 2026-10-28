import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type SourceSubscription } from '../lib/api'
import { describeSyncError } from '../lib/syncErrors'
import { Icon } from '../icons'
import { Notice } from '../components/Notice'
import { EmptyGuide } from '../shelf/EmptyGuide'

/**
 * 书源订阅（远程书源 JSON 直链 → 同步进书源库，上游 `RuleSub` / `sourceSub.json`）。
 *
 * 它长在**书源域**里，不在「订阅」页：这件事的产物是书源，用户做它时人就在书源页，
 * 而「订阅」页那一栏是 `RssSource`（要读的文章），两者数据模型与用途都不同。
 * 以前它们焊在同一页的两个页签里，于是「订阅」这个词同时指两件事（PROPOSAL-021 §3）。
 */
/**
 * 书源订阅面板。现在长在顶栏「订阅」页里（书源订阅 / RSS 文章源 两块并列），
 * 所以「收起」不再是它的职责 —— `onClose` 变成可选，只有宿主想提供收起时才传。
 */
export function SourceSubscriptionPanel({ onSourcesChange, onClose }: {
  onSourcesChange: () => void
  onClose?: () => void
}) {
  const [items, setItems] = useState<SourceSubscription[]>([])
  const [url, setUrl] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try { setItems(await api.subscriptions()) }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法载入订阅') }
  }, [])
  useEffect(() => { void load() }, [load])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    setBusy('all')
    try {
      await api.saveSubscription(url.trim())
      setUrl('')
      setNotice('订阅已保存，等下一次自动同步或点「立即同步」')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '保存订阅失败') }
    finally { setBusy(null) }
  }
  const update = async (id: number) => {
    setBusy(id)
    setNotice('')
    try {
      const result = await api.updateSubscription(id)
      setNotice(`同步完成：新增 ${result.imported || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}`)
      onSourcesChange()
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '同步失败') }
    finally { setBusy(null) }
  }
  const updateAll = async () => {
    setBusy('all')
    setNotice('')
    try {
      const result = await api.updateSubscriptions()
      setNotice(result.failed
        ? `全部同步完成：成功 ${result.updated}，失败 ${result.failed}（原因看每条订阅下面那行）`
        : `全部同步完成：成功 ${result.updated}`)
      onSourcesChange()
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '同步失败') }
    finally { setBusy(null) }
  }
  const toggle = async (item: SourceSubscription) => {
    setBusy(item.id)
    try { await api.saveSubscription(item.url, !item.enabled); await load() }
    catch (error) { setNotice(error instanceof Error ? error.message : '更新失败') }
    finally { setBusy(null) }
  }
  const remove = async (item: SourceSubscription) => {
    if (!confirm(`删除订阅“${item.url}”？已导入的书源会保留。`)) return
    setBusy(item.id)
    try { await api.removeSubscription(item.id); await load() }
    catch (error) { setNotice(error instanceof Error ? error.message : '删除失败') }
    finally { setBusy(null) }
  }

  const focusInput = () => {
    inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    inputRef.current?.focus()
  }

  return (
    <section className="subscription-panel">
      <header>
        <div>
          <h2>书源订阅地址</h2>
          <p>放的是<b>返回书源 JSON 的直链</b>（Legado「书源管理 · 订阅」里那种链接），不是网页地址。每 6 小时自动同步一次，同一地址的书源会整体覆盖更新。</p>
        </div>
        {/* 空订阅时页头不摆一颗恒定灰着的「全部同步」：它在窄屏会掉到说明文字下面，
            看上去像"还有个动作没做完"。有订阅（或宿主给了收起）才出现。 */}
        {(items.length > 0 || onClose) && (
          <div className="subscription-actions">
            {items.length > 0 && (
              <button className="subtle-button" onClick={() => void updateAll()} disabled={busy !== null}>
                {busy === 'all' ? '同步中…' : '全部同步'}
              </button>
            )}
            {onClose && <button type="button" className="subtle-button" onClick={onClose}>收起</button>}
          </div>
        )}
      </header>
      <form onSubmit={add}>
        <input ref={inputRef} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/sources.json" inputMode="url" aria-label="书源订阅地址" />
        <button className="primary-button" disabled={busy !== null}>添加订阅</button>
      </form>
      <Notice text={notice} />
      <div className="subscription-list">
        {items.length === 0 && !notice && (
          <EmptyGuide
            icon="globe"
            title="还没有订阅地址"
            body={<>填一个能直接打开书源 JSON 的地址即可开始同步；只想临时加几个源，用「导入 JSON」直接导一份也行。要读文章类的订阅源（RSS），在顶栏「订阅」那一页。</>}
            actions={[
              { label: '填一个订阅地址', onClick: focusInput, primary: true, icon: 'plus' },
              ...(onClose ? [{ label: '收起这一档', onClick: onClose }] : []),
            ]}
          />
        )}
        {items.map(item => {
          const failure = item.lastError ? describeSyncError(item.lastError) : null
          return (
            <article key={item.id} className={item.enabled ? '' : 'sub-off'}>
              <div className="sub-main">
                <strong title={item.url}>{item.url}</strong>
                {failure ? (
                  <>
                    <small className="sub-error">
                      <b>{`同步失败：${failure.headline}`}</b>
                      {failure.hint && <span>{` ${failure.hint}`}</span>}
                      {item.lastAttemptAt && <em>{` 最近尝试 ${new Date(item.lastAttemptAt).toLocaleString()}`}</em>}
                    </small>
                    <details className="sub-raw"><summary>原始报错</summary><code>{item.lastError}</code></details>
                  </>
                ) : (
                  <small>{item.lastSuccessAt
                    ? `最近同步 ${new Date(item.lastSuccessAt).toLocaleString()} · 处理 ${item.lastImported} 个书源`
                    : '尚未同步；点「立即同步」马上拉一次'}</small>
                )}
                {!item.enabled && <small className="sub-muted">已停用：自动同步会跳过这一条</small>}
              </div>
              <div className="subscription-actions">
                <button className="subtle-button" onClick={() => void toggle(item)} disabled={busy !== null}>{item.enabled ? '已启用' : '已停用'}</button>
                <button
                  className="subtle-button"
                  title={item.enabled ? undefined : '停用中的订阅也可以手动试一次'}
                  onClick={() => void update(item.id)}
                  disabled={busy !== null}
                >
                  {busy === item.id ? '同步中…' : '立即同步'}
                </button>
                <button className="shelf-remove" aria-label="删除订阅" onClick={() => void remove(item)} disabled={busy !== null}><Icon name="close" /></button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
