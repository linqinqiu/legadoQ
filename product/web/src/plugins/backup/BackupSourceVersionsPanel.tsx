import React, { useEffect, useRef, useState } from 'react'
import { backup } from '../../lib/api/domains/backup'
import type {
  SourceVersionAlias, SourceVersionGroup, SourceVersionLink, SourceVersionList,
  SourceVersionPreview, SourceVersionResult,
} from '../../lib/api/types'

const linkKey = (link: SourceVersionLink) => JSON.stringify([link.sourceId, link.bookUrl])
type Selection = SourceVersionGroup['variants'][number] & { sourceId: string }

/** 仅识别服务端生成的书源版本留档，不将普通 kept 文件当作可执行规则。 */
export const isSourceVersionArchive = (name: string) => /^source-variants-[a-f0-9]{64}\.json$/.test(name)

export function SourceVersionReview({ preview, aliases, relink, blocked, selected, onToggle, onPreview, onActivate }: {
  preview: SourceVersionPreview | null
  aliases: SourceVersionAlias[]
  relink: SourceVersionLink[]
  blocked: boolean
  selected: boolean
  onToggle: (alias: SourceVersionAlias, checked: boolean) => void
  onPreview: () => void
  onActivate: () => void
}) {
  return <>
    {preview && <div className="backup-hint" role="status">
      <p>即将启用「{preview.name}」{preview.sourceVersion != null ? `（规则版本 ${preview.sourceVersion}）` : ''}。</p>
      <p style={{ overflowWrap: 'anywhere' }}>标准化书源 ID：{preview.sourceId}</p>
      <p>影响全部 {preview.affectedBooks} 本关联书籍，现有缓存 {preview.cacheEntries} 条。</p>
      {preview.affectedBookNames.length > 0 && <p>关联书籍（最多列出 20 本）：{preview.affectedBookNames.join('、')}</p>}
      {preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    </div>}
    {aliases.length > 0 && <fieldset disabled={blocked}>
      <legend>可选：关联原始别名下的书籍</legend>
      <p className="backup-hint">默认不迁移。仅关联勾选的原始书源别名与精确书籍 URL；冲突项不可选。更改勾选后需重新预览。</p>
      {aliases.map(alias => <label key={linkKey(alias)} style={{ display: 'block', overflowWrap: 'anywhere' }}>
        <input type="checkbox" checked={relink.some(link => linkKey(link) === linkKey(alias))}
          disabled={blocked || alias.conflict} onChange={event => onToggle(alias, event.target.checked)} />
        {alias.name || '未命名书籍'}{alias.conflict ? '（目标或关联记录冲突，无法关联）' : ''}
        <small style={{ display: 'block' }}>{alias.sourceId} → {alias.bookUrl}</small>
      </label>)}
    </fieldset>}
    <div className="backup-actions">
      <button type="button" className="subtle-button" disabled={blocked || !selected} onClick={onPreview}>预览启用影响</button>
      <button type="button" className="primary-button" disabled={blocked || !selected || !preview?.previewToken} onClick={onActivate}>确认启用此版本</button>
    </div>
    {selected && !preview && <p className="backup-hint">请先预览当前版本与关联选择，核对影响后再确认。</p>}
  </>
}

export function BackupSourceVersionsPanel({ archive, disabled, onClose, onBusyChange, onActivated }: {
  archive: string
  disabled: boolean
  onClose: () => void
  onBusyChange: (busy: boolean) => void
  onActivated: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [listedQuery, setListedQuery] = useState('')
  const [list, setList] = useState<SourceVersionList | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [aliases, setAliases] = useState<SourceVersionAlias[]>([])
  const [relink, setRelink] = useState<SourceVersionLink[]>([])
  const [review, setReview] = useState<{ fingerprint: string; value: SourceVersionPreview } | null>(null)
  const [result, setResult] = useState<SourceVersionResult | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const workingRef = useRef(false)
  const blocked = disabled || working
  const fingerprint = JSON.stringify([archive, selection?.index, relink.map(linkKey).sort()])
  const preview = review?.fingerprint === fingerprint ? review.value : null

  const begin = () => {
    if (disabled || workingRef.current) return null
    workingRef.current = true
    setWorking(true); setError(''); onBusyChange(true)
    return ++generation.current
  }
  const finish = (id: number) => {
    if (generation.current !== id) return
    workingRef.current = false
    setWorking(false); onBusyChange(false)
  }
  const clearSelection = () => {
    setSelection(null); setAliases([]); setRelink([]); setReview(null)
  }
  const load = async (offset: number, filter: string) => {
    const id = begin()
    if (id == null) return
    clearSelection(); setList(null)
    try {
      const value = await backup.sourceVersions({ archive, offset, query: filter })
      if (generation.current !== id) return
      setList(value); setListedQuery(filter)
    } catch (cause) {
      if (generation.current === id) { setReview(null); setError(cause instanceof Error ? cause.message : '版本清单读取失败') }
    } finally { finish(id) }
  }
  useEffect(() => {
    setQuery(''); setListedQuery(''); setResult(null)
    void load(0, '')
    return () => {
      ++generation.current; workingRef.current = false; onBusyChange(false)
    }
  }, [archive])

  const select = (group: SourceVersionGroup, variant: SourceVersionGroup['variants'][number]) => {
    if (blocked) return
    ++generation.current
    setSelection({ ...variant, sourceId: group.sourceId }); setAliases([]); setRelink([]); setReview(null); setError('')
  }
  const toggle = (alias: SourceVersionAlias, checked: boolean) => {
    if (blocked || alias.conflict) return
    ++generation.current; setReview(null); setError('')
    setRelink(previous => checked
      ? [...previous.filter(link => linkKey(link) !== linkKey(alias)), { sourceId: alias.sourceId, bookUrl: alias.bookUrl }]
      : previous.filter(link => linkKey(link) !== linkKey(alias)))
  }
  const inspect = async () => {
    if (!selection) return
    const id = begin()
    if (id == null) return
    setReview(null)
    try {
      const value = await backup.sourceVersionPreview({ archive, index: selection.index, relink })
      if (generation.current !== id) return
      setAliases(value.aliases)
      if (relink.some(link => !value.aliases.some(alias => !alias.conflict && linkKey(alias) === linkKey(link)))) {
        setRelink(previous => previous.filter(link => value.aliases.some(alias => !alias.conflict && linkKey(alias) === linkKey(link))))
        setError('部分书籍的关联条件已变化，已取消对应勾选，请重新预览。')
        return
      }
      setReview({ fingerprint, value })
    } catch (cause) {
      if (generation.current === id) { setReview(null); setError(cause instanceof Error ? cause.message : '预览失败') }
    } finally { finish(id) }
  }
  const activate = async () => {
    if (!selection || !preview?.previewToken) return
    const id = begin()
    if (id == null) return
    setReview(null)
    let activated = false
    try {
      const value = await backup.activateSourceVersion({ archive, index: selection.index, relink, previewToken: preview.previewToken })
      if (generation.current !== id) return
      activated = true; setResult(value); clearSelection()
      await onActivated()
    } catch (cause) {
      if (generation.current === id) {
        setReview(null)
        setError(`${activated ? '书源已启用，但刷新页面数据失败：' : ''}${cause instanceof Error ? cause.message : '启用失败，请重新预览后重试'}`)
      }
    } finally { finish(id) }
  }

  return <section className="backup-panel" aria-label="书源历史版本">
    <div className="backup-actions"><h2>书源历史版本</h2><button type="button" className="subtle-button" disabled={blocked} onClick={onClose}>关闭版本列表</button></div>
    <p className="backup-hint" style={{ overflowWrap: 'anywhere' }}>留档：{archive}</p>
    <p className="backup-hint">启用会全局替换同一标准化书源 ID 的可执行规则，影响全部关联书籍，并非仅影响勾选书籍。保留当前启用状态、排序、缓存、登录与脚本状态。</p>
    <p className="backup-hint">启用前服务端必须创建完整数据库快照；快照或写入失败则不改动数据。回滚请到下方「启动快照（回滚点）」选择返回的快照并排定恢复，重启后执行整库回滚，不是单书撤销。</p>
    <fieldset disabled={blocked}>
      <label>按书源 ID 或名称筛选<input value={query} onChange={event => { setQuery(event.target.value); setReview(null) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void load(0, query.trim()) } }} /></label>
      <div className="backup-actions"><button type="button" className="subtle-button" onClick={() => void load(0, query.trim())}>查询版本</button></div>
      {list && <>
        <p className="backup-hint">共 {list.total} 组{list.total > 0 ? `，当前第 ${list.offset + 1}–${Math.min(list.offset + list.groups.length, list.total)} 组` : '，没有匹配的书源版本'}。每页最多 20 组。</p>
        <ul className="backup-kept-list">{list.groups.map(group => <li key={group.sourceId} style={{ display: 'block', overflowWrap: 'anywhere' }}>
          <p>{group.sourceId}</p>
          {group.variants.map(variant => <label key={variant.index} style={{ display: 'block' }}>
            <input type="radio" name="archived-source-version" checked={selection?.index === variant.index} onChange={() => select(group, variant)} />
            {variant.name || '未命名书源'}{variant.winner ? '（导入时采用）' : '（留档版本）'}
            <small style={{ display: 'block' }}>原始 ID：{variant.originalId}</small>
          </label>)}
        </li>)}</ul>
        <div className="backup-actions">
          <button type="button" className="subtle-button" disabled={list.offset === 0} onClick={() => void load(Math.max(0, list.offset - 20), listedQuery)}>上一页</button>
          <button type="button" className="subtle-button" disabled={list.offset + 20 >= list.total} onClick={() => void load(list.offset + 20, listedQuery)}>下一页</button>
        </div>
      </>}
    </fieldset>
    {selection && <p className="backup-hint" style={{ overflowWrap: 'anywhere' }}>已选「{selection.name || '未命名书源'}」：{selection.sourceId}</p>}
    <SourceVersionReview preview={preview} aliases={aliases} relink={relink} blocked={blocked} selected={selection != null}
      onToggle={toggle} onPreview={() => void inspect()} onActivate={() => void activate()} />
    {working && <p role="status" className="backup-hint">正在读取、预览或启用，请等待完成…</p>}
    {error && <p role="alert" className="backup-hint">{error}</p>}
    {result && <div role="status" className="backup-hint" style={{ overflowWrap: 'anywhere' }}>
      <p>已启用书源 {result.sourceId}，关联 {result.relinked} 本原始别名书籍。</p>
      <p>启用前完整快照：<code>{result.snapshot}</code>。如需整库回滚，请在下方启动快照中选取并排定恢复，然后重启。</p>
    </div>}
  </section>
}
