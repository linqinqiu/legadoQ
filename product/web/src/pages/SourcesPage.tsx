// 书源页：清单、批量整理、编辑与调试的挂载点
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Select } from '../components/Select'
import { SourceDebugModal } from '../sources/SourceDebugModal'
import { SourceEditor } from '../sources/SourceEditorPanel'
import { SourceGroupModal } from '../sources/SourceGroupModal'
import { SourceHealthModal } from '../sources/SourceHealthModal'
import { SourceLoginModal } from '../sources/SourceLoginModal'
import { SourceShareModal } from '../sources/SourceShareModal'
import { SourceSummary, api } from '../lib/api'
import { parseSourceJsonText } from '../sources/sourceImport'
import { showContextMenu } from '../components/ContextMenu'
import { toast } from '../components/Toast'
import { useDragSort } from '../shelf/dragSort'
import { useHealthRun } from '../sources/sourceHealthRun'
import { useSearchStore } from '../lib/searchStore'
import { splitSourceGroups } from '../sources/sourceGrouping'
import { takePendingSourceFocus } from '../lib/sourceFocus'

/** 书源侧栏一次渲染的条数上限：整库导入常有数千个源，全量挂载会让首屏和滚动一起变卡。 */
export const SOURCE_PAGE_SIZE = 120

/* 目录预览不再分水位：一次全给（用户 2026-10-09：「目录预览直接展示全部目录，不需要展开了」）。 */

export function SourcesPage({ selected, onSelect, onSourcesChange }: { selected: SourceSummary | null; onSelect: (source: SourceSummary | null) => void; onSourcesChange: (sources: SourceSummary[]) => void }) {
  const [sources, setSources] = useState<SourceSummary[]>([])
  const [query, setQuery] = useState('')
  const loadGeneration = useRef(0)
  const [groupFilter, setGroupFilter] = useState('')
  const [notice, setNotice] = useState('')
  const [importing, setImporting] = useState(false)
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showHealthModal, setShowHealthModal] = useState(false)
  // 体检跑在组件之外（见 sourceHealthRun.ts）：这一栏只是订阅者，窗口关了也继续显示进度
  const healthRun = useHealthRun()
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [busyBatch, setBusyBatch] = useState(false)
  const [debugModalSource, setDebugModalSource] = useState<SourceSummary | null>(null)
  const [loginModalSource, setLoginModalSource] = useState<SourceSummary | null>(null)
  const search = useSearchStore()
  /**
   * 「在书库搜」（用户 2026-10-09 的建议）：把书库的搜索范围设成「指定书源 + 这一条」再跳过去。
   * 不自动开搜 —— 关键词由用户自己填（跳过去只是想"就用这个源试一下"）。
   */
  const searchInLibrary = (source: SourceSummary) => {
    search.setSelectedSourceId(source.id)
    search.setScopeMode('single')
    location.hash = '#library'
  }
  const [shareIds, setShareIds] = useState<string[] | null>(null)
  const [creating, setCreating] = useState(false)
  /**
   * 书源清单到没到手。体检弹窗要读这个：清单还在路上时 `sources` 是空数组，
   * 于是界面会一本正经地写「探测『启用中』的 0 个书源」—— 把"还没取到"说成"一个都没有"。
   */
  const [sourcesState, setSourcesState] = useState<'loading' | 'ready' | 'failed'>('loading')

  // 从别处（书籍详情的换源行）右键跳过来时，把目标填进搜索框并选中它
  useEffect(() => {
    const name = takePendingSourceFocus()
    if (!name) return
    setQuery(name)
  }, [])

  const load = useCallback(async () => {
    // 防抖只挡键盘连击，不挡"慢的旧响应晚到"：'a' 的请求比 'ab' 的晚回来会把列表覆盖回旧结果
    const generation = ++loadGeneration.current
    try {
      const values = await api.sources(query)
      if (generation !== loadGeneration.current) return
      setSources(values)
      setSourcesState('ready')
      onSourcesChange(values)
    } catch (error) {
      if (generation !== loadGeneration.current) return
      setSourcesState('failed')
      setNotice(error instanceof Error ? error.message : '无法载入书源')
    }
  }, [onSourcesChange, query])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 180)
    return () => window.clearTimeout(timer)
  }, [load])

  // 右键菜单走的是「单源」动作：复用批量接口，但只传一个 id，因此不需要批量确认框。
  const flipOne = async (source: SourceSummary) => {
    try {
      await api.batchSources(source.enabled ? 'disable' : 'enable', [source.id])
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败')
    }
  }
  const removeOne = async (source: SourceSummary) => {
    if (!confirm(`删除「${source.name}」？这本书源的规则、登录态会被移除，已缓存的书籍不受影响。`)) return
    try {
      await api.batchSources('delete', [source.id])
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    }
  }

  const groupStats = useMemo(() => {
    const counts = new Map<string, number>()
    let ungrouped = 0
    for (const source of sources) {
      const tags = splitSourceGroups(source.group)
      if (!tags.length) { ungrouped++; continue }
      for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return { groups: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')), ungrouped }
  }, [sources])

  const allGroups = useMemo(() => groupStats.groups.map(([name]) => name), [groupStats])

  const filteredSources = useMemo(() => {
    return sources.filter(source => {
      if (groupFilter) {
        const tags = splitSourceGroups(source.group)
        if (groupFilter === '__none__') { if (tags.length) return false }
        else if (!tags.includes(groupFilter)) return false
      }
      if (query) {
        const q = query.toLowerCase()
        return source.name.toLowerCase().includes(q) || source.url.toLowerCase().includes(q) || (source.group ?? '').toLowerCase().includes(q)
      }
      return true
    })
  }, [sources, groupFilter, query])

  // 4876 个书源全量铺进 DOM 时，侧栏首屏和滚动都会卡：先渲染一屏，按需再续。
  const [visibleSourceCount, setVisibleSourceCount] = useState(SOURCE_PAGE_SIZE)
  useEffect(() => { setVisibleSourceCount(SOURCE_PAGE_SIZE) }, [query, groupFilter])
  const visibleSources = useMemo(
    () => filteredSources.slice(0, visibleSourceCount),
    [filteredSources, visibleSourceCount],
  )

  /*
    自定义书源排序（用户 2026-10-02：「自定义书源排序，优化书源编辑功能」）。
    服务端返回的就是「排过序的在前，没编号的按名称跟在后面」，所以这里只负责拖完写回去 ——
    客户端再排一遍就会有第二个事实来源，两边一漂，界面顺序和刷新后的顺序就不一样。
  */
  const sourceListRef = useRef<HTMLElement | null>(null)
  const applySourceOrder = useCallback((ordered: SourceSummary[]) => {
    const rank = new Map(ordered.map((item, index) => [item.id, index + 1]))
    // 就地回填：可见那几条按新顺序换回来，没在这一列里的保持原位。
    // 这里**不写比较器** —— 顺序是服务端排的（`sort_order is null, sort_order, name`），
    // 客户端再排一遍就有两套规则，中文书名上 SQLite 的 nocase 与 localeCompare 本来就会分歧。
    setSources(current => {
      const queue = [...ordered]
      return current.map(item => {
        if (!rank.has(item.id)) return item
        const next = queue.shift()
        return next ? { ...next, sortOrder: rank.get(next.id) ?? null } : item
      })
    })
    void api.reorderSources(ordered.map(item => item.id)).catch(() => {
      setNotice('书源顺序没能保存，刷新后会回到原来的顺序')
      void load()
    })
  }, [load])
  const { drag: sourceDrag, onPointerDown: onSourcePointerDown, onClickCapture: onSourceClickCapture } = useDragSort({
    enabled: () => !isBatchMode,
    gridRef: sourceListRef,
    itemSelector: '.source-list-item',
    items: visibleSources,
    onReorder: applySourceOrder,
  })
  const orderedCount = useMemo(() => sources.filter(item => item.sortOrder != null).length, [sources])
  const clearSourceOrder = () => {
    setSources(current => current.map(item => ({ ...item, sortOrder: null })))
    void api.clearSourceOrder().catch(() => { setNotice('自定义顺序没能清掉，刷新后会回到原样'); void load() })
  }
  /**
   * 统计带。「JS 书源」那一档量的是 `mainJs` 非空 —— 本机 5,574 份里 **0 份**带这个键，
   * 上游 `BookSource` 也根本没有这个字段（`legado-out/upstream` 全仓 0 命中），所以它永远是 0，
   * 而"永远为 0 的统计"暗示的是"你的库里没有 JS 源"—— 真相是有 2,105 份（37.8%）在用 JS 规则。
   * 拿掉它；要真给一个 JS 数字得先有"规则含 JS 方言"这一列（PROPOSAL-023 的 A 档）。
   */
  const sourceStats = useMemo(() => ({
    total: sources.length,
    enabled: sources.filter(s => s.enabled).length,
    login: sources.filter(s => s.hasLogin).length,
    groups: allGroups.length,
  }), [sources, allGroups])

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedIds(new Set(filteredSources.map(s => s.id)))
  }

  const handleClearAll = () => {
    setSelectedIds(new Set())
  }

  const handleInvertSelection = () => {
    setSelectedIds(prev => {
      const next = new Set<string>()
      for (const s of filteredSources) {
        if (!prev.has(s.id)) next.add(s.id)
      }
      return next
    })
  }

  /**
   * 批量启停会一次改写整库状态，而「停用」不报错 —— 表现只是搜索慢慢没结果。
   * 「全选」又是跨分页选中全部筛选结果（几千个），所以必须让数量先露面再动手。
   */
  const confirmBatch = (verb: string) =>
    confirm(`将对 ${selectedIds.size} 个书源执行「${verb}」，确定继续吗？`)

  const handleBatchEnable = async () => {
    if (selectedIds.size === 0) return
    if (!confirmBatch('批量启用')) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('enable', Array.from(selectedIds))
      toast.success(resp.message || `已批量启用 ${resp.affected} 个书源`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启用失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchDisable = async () => {
    if (selectedIds.size === 0) return
    if (!confirmBatch('批量停用')) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('disable', Array.from(selectedIds))
      toast.success(resp.message || `已批量停用 ${resp.affected} 个书源`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '停用失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    const selectedSources = sources.filter(s => selectedIds.has(s.id))
    const namesSummary = selectedSources.slice(0, 3).map(s => s.name).join('、') + (selectedSources.length > 3 ? ` 等共 ${selectedSources.length} 项` : '')
    if (!confirm(`确定要彻底删除选中的 ${selectedIds.size} 个书源吗？\n（${namesSummary}）\n删除后不可恢复！`)) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('delete', Array.from(selectedIds))
      toast.success(resp.message || `已删除 ${resp.affected} 个书源`)
      setSelectedIds(new Set())
      if (selected && selectedIds.has(selected.id)) {
        onSelect(null)
      }
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchExport = async () => {
    if (selectedIds.size === 0) return
    setBusyBatch(true)
    try {
      const exportStrings = await api.exportSources(Array.from(selectedIds))
      const parsedList = exportStrings.map(str => {
        try { return JSON.parse(str) } catch { return null }
      }).filter(Boolean)
      const blob = new Blob([JSON.stringify(parsedList, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `legado_sources_export_${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(`已成功导出 ${parsedList.length} 个书源`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchGroupConfirm = async (newGroup: string | null) => {
    if (selectedIds.size === 0) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('set_group', Array.from(selectedIds), newGroup ?? undefined)
      toast.success(resp.message || `已更新 ${resp.affected} 个书源的分组`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改分组失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const importSources = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    try {
      const rawText = await file.text()
      const rawList = parseSourceJsonText(rawText)
      if (rawList.length === 0) {
        toast.error('未在文件中识别到有效的书源配置')
        setNotice('导入失败：未在文件中识别到有效的书源配置')
        return
      }
      const serialized = rawList
        .filter(item => item && typeof item === 'object')
        .map(item => JSON.stringify(item))
      if (serialized.length === 0) {
        toast.error('书源格式无效')
        setNotice('导入失败：书源格式无效')
        return
      }
      const result = await api.import(serialized)
      const importedCount = result.imported || 0
      const updatedCount = result.updated || 0
      const skippedCount = result.skipped || 0
      const parts = [`新增 ${importedCount} 个`, `更新 ${updatedCount} 个`]
      if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个`)
      let msg = `导入完成：${parts.join('，')}`
      if (result.errors && result.errors.length > 0) {
        const errorSummary = result.errors.slice(0, 3).join('；') + (result.errors.length > 3 ? ` 等共 ${result.errors.length} 项错误` : '')
        msg += ` (${errorSummary})`
      }
      setNotice(msg)
      if (importedCount > 0 || updatedCount > 0) {
        toast.success(`已导入/更新 ${importedCount + updatedCount} 个书源`)
      } else if (skippedCount > 0) {
        toast.error(result.errors?.[0] || '书源未能导入，请检查格式')
      }
      await load()
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '导入失败'
      toast.error(errMsg)
      setNotice(`导入失败：${errMsg}`)
    } finally {
      setImporting(false)
    }
  }

  const remove = async () => {
    if (!selected || !confirm(`删除“${selected.name}”？`)) return
    try {
      await api.remove(selected.id)
      onSelect(null)
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <main className={`sources-page ${isBatchMode ? 'batch-mode-active' : ''}`}>
      <aside className="source-sidebar">
        <div className="source-sidebar-heading">
          <div className="source-sidebar-title-row">
            <span>书源</span>
            <small>{sources.length}</small>
          </div>
          <div className="source-sidebar-top-actions">
            <button
              type="button"
              className={`subtle-button health-probe-btn ${healthRun.running ? 'is-running' : ''}`}
              title={healthRun.running
                ? `体检正在后台跑：已检测 ${healthRun.checked} / ${healthRun.total}，途中已给 ${healthRun.autoTagged} 个不能正常使用的打上标签。点开看进度，收起不会停。`
                : '批量联网体检：每个源拿关键词试搜一次，只看能不能出条目。想先确认 JSON 写没写坏用编辑器里的「校验」（不联网），要看搜索→详情→目录→正文每一步用「调试」。'}
              onClick={() => setShowHealthModal(true)}
            >
              <Icon name="activity" />
              <span>{healthRun.running ? `体检中 ${healthRun.checked} / ${healthRun.total}` : '体检'}</span>
            </button>
            <button
              type="button"
              className={`subtle-button ${isBatchMode ? 'active-batch-btn' : ''}`}
              onClick={() => {
                setIsBatchMode(prev => !prev)
                setSelectedIds(new Set())
              }}
            >
              {isBatchMode ? '退出批量' : '批量管理'}
            </button>
          </div>
        </div>

        {allGroups.length > 0 && (
          <div className="source-group-filter-bar">
            <Select
              className="source-group-select"
              ariaLabel="按分组筛选书源"
              value={groupFilter}
              onChange={setGroupFilter}
              options={[
                { value: '', label: `全部分组 (${sources.length})` },
                ...groupStats.groups.map(([name, count]) => ({ value: name, label: `${name} (${count})` })),
                { value: '__none__', label: `未分组 (${groupStats.ungrouped})` },
              ]}
            />
          </div>
        )}

        <div className="source-filter">
          <Icon name="search" />
          <input placeholder="筛选书源" value={query} onChange={event => setQuery(event.target.value)} />
        </div>

        {orderedCount > 0 && (
          <div className="source-order-bar">
            <small>{orderedCount} 个书源有自定义位置；其余按名称排在后面</small>
            <button type="button" className="subtle-button" onClick={clearSourceOrder}
              title="清掉全部自定义位置，回到只按名称排（切分组、筛选都不会清）">
              清除自定义顺序
            </button>
          </div>
        )}

        <button
          type="button"
          className="primary-button source-create-btn"
          onClick={() => { setCreating(true); onSelect(null) }}
        >
          <Icon name="plus" />
          新建书源
        </button>

        <label className={`import-button ${importing ? 'disabled' : ''}`}>
          <Icon name="upload" />
          {importing ? '导入中…' : '导入 JSON'}
          <input
            type="file"
            accept="application/json,.json,text/plain,.txt,*"
            disabled={importing}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void importSources(file)
            }}
          />
        </label>

        {notice && <p className="sidebar-notice">{notice}</p>}

        <nav ref={sourceListRef} className={`source-list ${isBatchMode ? '' : 'source-list-sortable'}`} aria-label="书源列表">
          {visibleSources.map((source, index) => {
            const isChecked = selectedIds.has(source.id)
            const isCurrent = selected?.id === source.id

            if (isBatchMode) {
              return (
                <div
                  key={source.id}
                  className={`source-list-item batch-item ${isChecked ? 'checked' : ''}`}
                  onClick={() => toggleSelect(source.id)}
                >
                  <label className="batch-checkbox-wrap" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`选择《${source.name}》加入批量操作`}
                      checked={isChecked}
                      onChange={() => toggleSelect(source.id)}
                    />
                  </label>
                  <div className="source-list-item-content">
                    <div className="source-list-item-title">
                      <span>{source.name}</span>
                      {!source.enabled && <span className="source-disabled-badge">已停用</span>}
                      {source.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
                    </div>
                    <small>{splitSourceGroups(source.group).join(' · ') || '未分组'}</small>
                  </div>
                </div>
              )
            }

            return (
              <button
                className={`source-list-item${isCurrent ? ' selected' : ''}${sourceDrag?.from === index ? ' source-item-dragging' : ''}${sourceDrag && sourceDrag.at === index && sourceDrag.from !== index ? ' source-item-drop-before' : ''}`}
                key={source.id}
                type="button"
                onPointerDown={onSourcePointerDown(index)}
                onClickCapture={onSourceClickCapture}
                onClick={() => { setCreating(false); onSelect(source) }}
                onContextMenu={event => showContextMenu(event, [
                  { label: '编辑此书源', icon: 'edit', onSelect: () => { setCreating(false); onSelect(source) } },
                  { label: '分阶段调试', icon: 'activity', onSelect: () => setDebugModalSource(source) },
                  ...(source.hasLogin ? [{ label: '登录 / Cookie', icon: 'logOut' as const, onSelect: () => setLoginModalSource(source) }] : []),
                  {
                    label: source.enabled ? '停用此书源' : '启用此书源',
                    icon: source.enabled ? 'close' : 'check',
                    onSelect: () => void flipOne(source),
                  },
                  { label: '分享书源', icon: 'copy', onSelect: () => setShareIds([source.id]) },
                  { label: '删除此书源', icon: 'trash', danger: true, onSelect: () => void removeOne(source) },
                ])}
              >
                <div className="source-list-item-title">
                  <span>{source.name}</span>
                  {!source.enabled && <span className="source-disabled-badge">已停用</span>}
                  {source.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
                </div>
                <small>{splitSourceGroups(source.group).join(' · ') || '未分组'}</small>
                <span
                  className={`source-enable-switch${source.enabled ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={source.enabled}
                  tabIndex={0}
                  title={source.enabled ? '点击停用此书源' : '点击启用此书源'}
                  aria-label={source.enabled ? `停用 ${source.name}` : `启用 ${source.name}`}
                  onClick={event => { event.stopPropagation(); void flipOne(source) }}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void flipOne(source) } }}
                >
                  <span className="source-enable-switch-knob" />
                </span>
              </button>
            )
          })}
          {visibleSources.length < filteredSources.length && (
            <button type="button" className="source-list-more" onClick={() => setVisibleSourceCount(count => count + SOURCE_PAGE_SIZE)}>
              已显示 {visibleSources.length} / {filteredSources.length}，点击加载更多
            </button>
          )}
        </nav>
      </aside>

      <div className="sources-main">
        {/* 书源页只承载**书源本身**：页头 + 编辑器。
            书源订阅（远程书源 JSON 直链）已搬到顶栏「订阅」页 —— 那里才是"订阅"这件事的家，
            书源页不再挂任何订阅面板或「订阅地址」按钮，右栏因此只剩编辑区，不再被挤。 */}
        <div className="editor-region">
          <header className="page-title">
            <div>
              <h1>书源管理</h1>
              <p>导入、校验与维护你的阅读来源。</p>
            </div>
            <div className="page-title-actions">
              {selected && (
                <button type="button" className="danger-button" onClick={() => void remove()}>
                  删除书源
                </button>
              )}
            </div>
          </header>
        </div>
        <section className="sources-content">
          <SourceEditor
            selected={selected}
            creating={creating}
            summary={sourceStats}
            onSaved={() => void load()}
            onCreateCancel={() => setCreating(false)}
            onCreated={source => {
              setCreating(false)
              onSelect(source)
            }}
            onOpenLogin={source => setLoginModalSource(source)}
            onOpenDebug={source => setDebugModalSource(source)}
            onSearchInLibrary={searchInLibrary}
          />
        </section>
      </div>

      {/* Floating Batch Action Bar */}
      {isBatchMode && (
        <aside className="source-batch-bar" aria-label="书源批量操作工具栏">
          <div className="batch-bar-left">
            <span className="batch-bar-count">
              已选 <strong>{selectedIds.size}</strong> / {filteredSources.length}
            </span>
            <div className="batch-select-helpers">
              <button type="button" className="subtle-button compact" onClick={handleSelectAll}>
                全选
              </button>
              <button type="button" className="subtle-button compact" onClick={handleClearAll}>
                全不选
              </button>
              <button type="button" className="subtle-button compact" onClick={handleInvertSelection}>
                反选
              </button>
            </div>
          </div>
          <div className="batch-bar-right">
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchEnable()}
            >
              批量启用
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchDisable()}
            >
              批量停用
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => setShowGroupModal(true)}
            >
              修改分组
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchExport()}
            >
              导出选中
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => setShareIds(Array.from(selectedIds))}
            >
              分享选中
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchDelete()}
            >
              批量删除
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setIsBatchMode(false)
                setSelectedIds(new Set())
              }}
            >
              完成
            </button>
          </div>
        </aside>
      )}

      {showHealthModal && (
        <SourceHealthModal
          sources={sources}
          sourcesState={sourcesState}
          onClose={() => setShowHealthModal(false)}
          onSourcesChange={() => void load()}
          onToast={(msg, type) => {
            if (type === 'error') toast.error(msg)
            else if (type === 'success') toast.success(msg)
            else toast.info(msg)
          }}
        />
      )}

      {showGroupModal && (
        <SourceGroupModal
          selectedCount={selectedIds.size}
          existingGroups={allGroups}
          onConfirm={handleBatchGroupConfirm}
          onClose={() => setShowGroupModal(false)}
        />
      )}

      {debugModalSource && (
        <SourceDebugModal
          sourceId={debugModalSource.id}
          sourceName={debugModalSource.name}
          onClose={() => setDebugModalSource(null)}
        />
      )}

      {loginModalSource && (
        <SourceLoginModal
          sourceId={loginModalSource.id}
          sourceName={loginModalSource.name}
          onClose={() => setLoginModalSource(null)}
          onToast={(msg, type) => {
            if (type === 'error') toast.error(msg)
            else if (type === 'success') toast.success(msg)
            else toast.info(msg)
          }}
        />
      )}
      {shareIds && (
        <SourceShareModal
          sourceIds={shareIds}
          sources={sources}
          onClose={() => setShareIds(null)}
          onToast={(msg, type) => { if (type === 'error') toast.error(msg); else if (type === 'success') toast.success(msg); else toast.info(msg) }}
        />
      )}
    </main>
  )
}

/** 关键词 → 编译好的正则：每张结果卡每次渲染都 new RegExp 纯属浪费，按关键词缓存（小型 FIFO）。 */
