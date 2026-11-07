// 书源页：清单、批量整理、编辑与调试的挂载点
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { Select } from '../../components/Select'
import { SourceDebugModal } from './SourceDebugModal'
import { SourceEditor } from './SourceEditorPanel'
import { SourceGroupModal } from './SourceGroupModal'
import { SourceHealthModal } from './SourceHealthModal'
import { SourceLoginModal } from './SourceLoginModal'
import { SourceShareModal } from './SourceShareModal'
import { SourceSummary, api } from '../../lib/api'
import { parseSourceJsonText } from '../../lib/sourceImport'
import { decodeImportText, fetchImportText } from '../../lib/importFromUrl'
import { showContextMenu } from '../../components/ContextMenu'
import { toast } from '../../components/Toast'
import { useDragSort } from '../../lib/dragSort'
import { useHealthRun } from './sourceHealthRun'
import { useSearchStore } from '../../lib/searchStore'
import { splitSourceGroups } from '../../lib/sourceGrouping'
import { takePendingSourceFocus } from '../../lib/sourceFocus'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  readStoredSidebarWidth,
  storeSidebarWidth,
} from '../../lib/sidebarWidth'

/** 书源侧栏一次渲染的条数上限：整库导入常有数千个源，全量挂载会让首屏和滚动一起变卡。 */
export const SOURCE_PAGE_SIZE = 120

/* 目录预览不再分水位：一次全给（用户 2026-10-09：「目录预览直接展示全部目录，不需要展开了」）。 */

export function SourcesPage({ selected, onSelect, onSourcesChange, sources: hostedSources }: {
  selected: SourceSummary | null
  onSelect: (source: SourceSummary | null) => void
  onSourcesChange: (sources: SourceSummary[]) => void
  /** 宿主启动时已取过的整份清单（~1MB）：有就直接铺上，别再为同一份数据跑第二趟。 */
  sources?: SourceSummary[]
}) {
  const [sources, setSources] = useState<SourceSummary[]>(hostedSources ?? [])
  const [query, setQuery] = useState('')
  const loadGeneration = useRef(0)
  const [groupFilter, setGroupFilter] = useState('')
  const [notice, setNotice] = useState('')
  const [importing, setImporting] = useState(false)
  /** 「导入」面板是否展开：低频动作，默认收起，别让两块整行控件常年占着列表的位置。 */
  const [importOpen, setImportOpen] = useState(false)
  /** 「从地址导入」的地址输入；与文件选择是两条并存的入口。 */
  const [importUrl, setImportUrl] = useState('')
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
  const [sourcesState, setSourcesState] = useState<'loading' | 'ready' | 'failed'>(
    hostedSources && hostedSources.length > 0 ? 'ready' : 'loading',
  )

  /**
   * 左栏宽度（用户 2026-11-07：「书源管理界面，左侧位置太狭窄」）。
   *
   * 拖动中只改 state，松手才写 localStorage —— 每帧写一次存储既没必要，也会让
   * 隐私模式下每次移动都抛一次异常。宽度靠 CSS 变量下发给栅格，DOM 里不留行内 width。
   */
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const sidebarWidthRef = useRef(sidebarWidth)
  const sidebarRef = useRef<HTMLElement | null>(null)

  const applySidebarWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
  }, [])

  const resetSidebarWidth = useCallback(() => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT)
    storeSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
  }, [applySidebarWidth])

  const onResizerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const sidebar = sidebarRef.current
    if (!sidebar) return
    event.preventDefault()
    // 以左栏自己的左缘为原点：壁纸模式给 .sources-page 加过 14px 内边距，
    // 拿整页的 left 当原点会让宽度凭空多出那 14px。
    const originLeft = sidebar.getBoundingClientRect().left
    const onMove = (moveEvent: PointerEvent) => applySidebarWidth(moveEvent.clientX - originLeft)
    const onEnd = () => {
      document.body.classList.remove('is-resizing-source-sidebar')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      storeSidebarWidth(sidebarWidthRef.current)
    }
    document.body.classList.add('is-resizing-source-sidebar')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  const onResizerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      applySidebarWidth(sidebarWidthRef.current + (event.key === 'ArrowRight' ? step : -step))
      storeSidebarWidth(sidebarWidthRef.current)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      resetSidebarWidth()
    }
  }

  /**
   * 窄屏是纵向堆叠（页头 → 列表 → 编辑器）：点一条书源后，编辑器在列表下面几百像素，
   * 不滚过去就等于"点了没反应"。宽屏两栏并排，不需要动。
   */
  const revealEditorOnPhone = () => {
    if (!window.matchMedia('(max-width: 720px)').matches) return
    const target = document.querySelector<HTMLElement>('.sources-page .sources-content')
    if (!target) return

    // 用即时滚动而不是 smooth：内容异步换上来时文档高度会变，平滑动画会被取消。
    // 顶栏补偿交给 CSS 的 scroll-margin-top（56px + 安全区）。
    const align = () => target.scrollIntoView({ block: 'start', behavior: 'auto' })
    align()

    // 刚点下去时编辑器还是空壳（文档只有 ~1200px 高），上面的对齐会被浏览器截在
    // 最大滚动位置（实测 contentTop 停在 406，目标是 56）。等内容长高一点再对一次；
    // 用户一旦自己滚（wheel / touch）就立刻停手，别把人拽回来。
    let lastHeight = target.offsetHeight
    const observer = new ResizeObserver(() => {
      if (target.offsetHeight === lastHeight) return
      lastHeight = target.offsetHeight
      align()
    })
    observer.observe(target)
    const stop = () => {
      observer.disconnect()
      window.clearTimeout(timer)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
    }
    const timer = window.setTimeout(stop, 2500)
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchstart', stop, { passive: true })
  }

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

  /*
    首屏只取一次：宿主启动探活一过就取过整份清单（5,598 条、~1MB），书源页挂载时
    如果那份已经到手，直接铺开就行 —— 再为同一份数据跑一趟，等于开机就多花一次
    1MB 的传输与解析。搜索、增删改、保存后的刷新仍照常走 load()。
  */
  const skipFirstLoad = useRef((hostedSources?.length ?? 0) > 0)
  const firstLoad = useRef(true)
  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      firstLoad.current = false
      return
    }
    // 挂载即取：宿主启动时那份整表请求通常还在路上，两处会合流成一次（api.sources）。
    // 180ms 防抖只留给之后的输入，别让首屏白白多等一个防抖窗口。
    if (firstLoad.current) {
      firstLoad.current = false
      void load()
      return
    }
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

  /**
   * 删除一条书源。右键菜单与编辑器操作行共用这一条 —— 原来两处各写一份
   * （一处 `api.remove`、一处 `batchSources('delete')`），确认文案也不一样。
   */
  const deleteSource = async (source: SourceSummary) => {
    if (!confirm(`删除「${source.name}」？这本书源的规则、登录态会被移除，已缓存的书籍不受影响。`)) return
    try {
      await api.remove(source.id)
      if (selected?.id === source.id) onSelect(null)
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

  /**
   * 「只剩元数据」的源有多少条。
   *
   * 兄弟包的备份里真实存在这种条目（本机 5,600 条里 582 条）：导入不报错、列表里也看得见，
   * 但搜索 / 目录 / 正文一步都跑不出来。给一个能筛出来的入口，用户才清得掉。
   */
  const noRulesCount = useMemo(() => sources.filter(source => source.hasRules === false).length, [sources])

  const filteredSources = useMemo(() => {
    return sources.filter(source => {
      if (groupFilter === '__norules__') return source.hasRules === false
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

  /** 导入核心：拿到文本后统一解析、入库并刷新列表；文件选择与地址导入共用这一条。 */
  const applySourceImport = async (rawText: string) => {
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
  }

  const importSources = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    try {
      await applySourceImport(decodeImportText(await file.arrayBuffer()))
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '导入失败'
      toast.error(errMsg)
      setNotice(`导入失败：${errMsg}`)
    } finally {
      setImporting(false)
    }
  }

  /** 从地址导入：走同源代理取回文本，再交给上面同一条解析/入库逻辑。 */
  const importSourcesFromUrl = async () => {
    setImporting(true)
    try {
      await applySourceImport(await fetchImportText(importUrl))
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '导入失败'
      toast.error(errMsg)
      setNotice(`导入失败：${errMsg}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <main
      className={`sources-page ${isBatchMode ? 'batch-mode-active' : ''}`}
      style={{ '--source-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="source-sidebar" ref={sidebarRef}>
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

        {(allGroups.length > 0 || noRulesCount > 0) && (
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
                // 排在最后：它不是分组，是"这条源跑不起来"的体检式入口。
                ...(noRulesCount > 0 ? [{ value: '__norules__', label: `无规则 (${noRulesCount})` }] : []),
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

        <div className="source-sidebar-actions">
          <button
            type="button"
            className="primary-button source-create-btn"
            onClick={() => { setCreating(true); onSelect(null); revealEditorOnPhone() }}
          >
            <Icon name="plus" />
            新建书源
          </button>
          <button
            type="button"
            className={`subtle-button source-import-toggle${importOpen ? ' is-open' : ''}`}
            aria-expanded={importOpen}
            aria-controls="source-import-panel"
            title={importOpen ? '收起导入' : '导入书源：本地 JSON 文件，或一个能返回书源 JSON 的地址'}
            onClick={() => setImportOpen(value => !value)}
          >
            <Icon name="upload" />
            导入
          </button>
        </div>

        {/* 导入是低频动作：收起时只占一行按钮，展开才出现文件选择与地址输入。
            原来这两块各占一整行，加上分组与筛选，列表被压到侧栏的下半截。 */}
        {importOpen && (
          <div className="source-import-panel" id="source-import-panel">
            <label className={`import-button ${importing ? 'disabled' : ''}`}>
              <Icon name="upload" />
              {importing ? '导入中…' : '选择 JSON 文件'}
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

            <form
              className="source-filter"
              aria-label="从地址导入书源"
              onSubmit={event => { event.preventDefault(); void importSourcesFromUrl() }}
            >
              <Icon name="globe" />
              <input
                value={importUrl}
                onChange={event => setImportUrl(event.target.value)}
                placeholder="书源 JSON 地址"
                inputMode="url"
                aria-label="书源 JSON 地址"
                disabled={importing}
              />
              <button type="submit" className="subtle-button" disabled={importing}>
                {importing ? '导入中…' : '从地址导入'}
              </button>
            </form>
          </div>
        )}

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
                      {source.hasRules === false && <span className="source-norules-badge" title="只有元数据、没有任何规则：搜不到书，也取不到目录与正文">无规则</span>}
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
                onClick={() => { setCreating(false); onSelect(source); revealEditorOnPhone() }}
                onContextMenu={event => showContextMenu(event, [
                  { label: '编辑此书源', icon: 'edit', onSelect: () => { setCreating(false); onSelect(source); revealEditorOnPhone() } },
                  { label: '分阶段调试', icon: 'activity', onSelect: () => setDebugModalSource(source) },
                  ...(source.hasLogin ? [{ label: '登录 / Cookie', icon: 'logOut' as const, onSelect: () => setLoginModalSource(source) }] : []),
                  {
                    label: source.enabled ? '停用此书源' : '启用此书源',
                    icon: source.enabled ? 'close' : 'check',
                    onSelect: () => void flipOne(source),
                  },
                  { label: '分享书源', icon: 'copy', onSelect: () => setShareIds([source.id]) },
                  { label: '删除此书源', icon: 'trash', danger: true, onSelect: () => void deleteSource(source) },
                ])}
              >
                <div className="source-list-item-title">
                  <span>{source.name}</span>
                  {!source.enabled && <span className="source-disabled-badge">已停用</span>}
                  {source.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
                  {source.hasRules === false && <span className="source-norules-badge" title="只有元数据、没有任何规则：搜不到书，也取不到目录与正文">无规则</span>}
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

      {/* 两栏之间的拖拽把手：拖动改左栏宽度，方向键 ±16（Shift ±32），双击或 Home 回默认。 */}
      <div
        className="source-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整书源列表宽度"
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        tabIndex={0}
        title="拖动调整书源列表宽度，双击恢复默认"
        onPointerDown={onResizerPointerDown}
        onKeyDown={onResizerKeyDown}
        onDoubleClick={resetSidebarWidth}
      />

      <div className="sources-main">
        {/* 书源页只承载**书源本身**：页头 + 编辑器。
            书源订阅（远程书源 JSON 直链）已搬到顶栏「订阅」页 —— 那里才是"订阅"这件事的家，
            书源页不再挂任何订阅面板或「订阅地址」按钮，右栏因此只剩编辑区，不再被挤。 */}
        <div className="editor-region">
          {/* 页头只留标题与一句说明。「删除书源」原先挂在这栏右上角：
              一个红色按钮离"要删的是哪一条"隔着整块版面，看着像在删这一页 ——
              现在跟着 登录/调试/校验/保存 一起进编辑器的操作行。 */}
          <header className="page-title">
            <div>
              <h1>书源管理</h1>
              <p>导入、校验与维护你的阅读来源。</p>
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
            onDelete={source => void deleteSource(source)}
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
