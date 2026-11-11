// 书架页：分组/排序/批量管理与换源
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookCover } from '../../components/Cover'
import { BookGroup, BookshelfItem, Chapter, SearchResult, SourceSummary, api } from '../../lib/api'
import { Icon } from '../../icons'
import { Select } from '../../components/Select'
import { ShelfLayout, ShelfSort, readShelfLayout, readShelfSort, writeShelfLayout, writeShelfSort } from '../../lib/shelfLayout'
import { SHELF_PAGE_SIZE, hasMoreOf, moreCountOf, visibleCountOf } from './shelfPaging'
import { SourceSwitchModal } from '../../components/SourceSwitchModal'
import { TocRulesModal } from '../../components/TocRulesModal'
import { bookTypeMeta } from '../../lib/bookType'
import { cleanAuthor, cleanTitle } from '../../lib/searchFilters'
import { showContextMenu } from '../../components/ContextMenu'
import { toast } from '../../components/Toast'
import { openSourceMenu } from '../../components/SourceChoiceList'
import { BookDetailModal } from '../../components/BookDetailModal'
import { BookManageModal } from './BookManageModal'

export function ShelfPage({
  onOpen,
  sources,
  txtTocRule,
  onTxtTocRuleChange,
  tocRulesSignal,
}: {
  onOpen: (item: BookshelfItem) => void
  sources: SourceSummary[]
  txtTocRule: string
  onTxtTocRuleChange: (value: string) => void
  /** 从「设置 → TXT 分章规则」过来的"去开一下"信号（0 = 还没人点过）。 */
  tocRulesSignal: number
}) {
  const [items, setItems] = useState<BookshelfItem[]>([])
  /** 还没到手 ≠ 一条都没有：空态卡只能由"取到了且是空的"触发。 */
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [switchingItem, setSwitchingItem] = useState<BookshelfItem | null>(null)
  const [managingItem, setManagingItem] = useState<BookshelfItem | null>(null)
  const [view, setView] = useState<'reading' | 'completed' | 'all'>('reading')
  const [groups, setGroups] = useState<BookGroup[]>([])
  /** 分组接口失败 ≠ 一个组都没有；界面必须把这两件事分开说。 */
  const [groupsFailed, setGroupsFailed] = useState(false)
  /** null = 不按分组筛（全部分组）；0 = 未分组；其余是 book_group.group_id */
  const [groupFilter, setGroupFilter] = useState<number | null>(null)
  const [layout, setLayout] = useState<ShelfLayout>(() => readShelfLayout())
  const [sort, setSort] = useState<ShelfSort>(() => readShelfSort())
  const chooseSort = (next: ShelfSort) => { setSort(next); writeShelfSort(next) }
  const [batchMode, setBatchMode] = useState(false)
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set())
  
  // 批量操作辅助函数
  const toggleBookSelection = (sourceId: string, bookUrl: string) => {
    setSelectedBooks(prev => {
      const next = new Set(prev)
      const key = `${sourceId}::${bookUrl}`
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  
  const isBookSelected = (sourceId: string, bookUrl: string) => {
    return selectedBooks.has(`${sourceId}::${bookUrl}`)
  }
  
  const handleBatchDelete = async () => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要删除的书籍')
      return
    }
    if (!confirm(`确定要删除选中的 ${selectedBooks.size} 本书吗？此操作不可恢复。`)) return
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchDeleteBooks(books)
      toast.success(`已删除 ${result.deleted} 本书`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量删除失败')
    }
  }
  
  const handleBatchMoveToGroup = async (groupId: number | null) => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要移动的书籍')
      return
    }
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchMoveToGroup(books, groupId)
      toast.success(`已将 ${result.moved} 本书移动到${groupId === null ? '未分组' : '指定分组'}`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量移动失败')
    }
  }
  
  const handleBatchMarkAsRead = async (isRead: boolean) => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要标记的书籍')
      return
    }
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchMarkAsRead(books, isRead)
      toast.success(`已将 ${result.marked} 本书标记为${isRead ? '已读完' : '未读完'}`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量标记失败')
    }
  }
  
  
  const clearSelection = () => {
    setSelectedBooks(new Set())
  }
  
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** 「本地书分章规则」弹窗：从书架的导入动作旁边打开，不在外观浮层里。 */
  const [showTocRules, setShowTocRules] = useState(false)
  // 「设置」页那一行点过来时信号会 +1；第一次挂载（0）不弹，否则刷新一下页面就跳出弹窗
  useEffect(() => {
    if (tocRulesSignal > 0) setShowTocRules(true)
  }, [tocRulesSignal])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previousStateRef = useRef<Map<string, string>>(new Map())

  const load = useCallback(async () => {
    try {
      // 分组请求失败不能当成"一个分组都没有"：那样书架会把"没载入成功"渲染成"你还没建分组"，
      // 右键菜单里的归组快捷项也会凭空消失（全库搜索压满工作线程时最容易撞上）。
      const [list, groupResult] = await Promise.all([
        api.bookshelf(),
        api.shelfGroups()
          .then(items => ({ items, failed: false }))
          .catch(() => ({ items: [] as BookGroup[], failed: true })),
      ])
      setGroups(groupResult.items)
      setGroupsFailed(groupResult.failed)
      list.forEach(curr => {
        const key = `${curr.sourceId}\u0000${curr.bookUrl}`
        const prevState = previousStateRef.current.get(key)
        if (prevState === 'caching' && curr.cacheState === 'ready') {
          toast.success(`《${curr.name}》全本离线缓存完成（共 ${curr.cachedChapters} 章）`)
        } else if (prevState === 'caching' && curr.cacheState === 'failed') {
          toast.warning(`《${curr.name}》缓存中断：${curr.cacheError || '未全部完成'}`)
        }
        previousStateRef.current.set(key, curr.cacheState)
      })
      setItems(list)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法载入书架')
    } finally {
      setItemsLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleImportFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => {
      const n = f.name.toLowerCase()
      return n.endsWith('.txt') || n.endsWith('.epub') || n.endsWith('.text')
    })
    if (list.length === 0) {
      toast.warning('请选择 .txt 或 .epub 格式的电子书文件')
      return
    }
    setUploading(true)
    toast.info(`正在解析并导入 ${list.length} 本本地书籍…`)
    try {
      // 导入时用「分章规则」那一档选中的规则；它是 App 那一份阅读设置里的同一个字段，
      // 不是书架自己另存的偏好（两处各存一份就会出现"选了却没生效"）。
      const resp = await api.importLocalBooks(list, txtTocRule)
      if (resp.imported > 0) {
        // 只报数量的 toast 等于没说：哪几本进来了、进到哪一组，要当场看得见
        const names = resp.results.filter(r => r.success).map(r => `《${r.name}》`).slice(0, 3).join('、')
        const more = resp.imported > 3 ? ` 等 ${resp.imported} 本` : ''
        toast.success(`已导入 ${resp.imported} 本并归到「本地」分组：${names}${more}`)
        await load()
      }
      if (resp.failed > 0) {
        const errorMsg = resp.results.filter(r => !r.success).map(r => `${r.filename}: ${r.error}`).join('; ')
        toast.error(`部分书籍导入失败（${resp.failed} 本）: ${errorMsg}`)
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入本地书籍失败')
    } finally {
      setUploading(false)
    }
  }

  const caching = items.some(item => item.cacheState === 'caching')
  useEffect(() => {
    if (!caching) return
    const timer = window.setInterval(load, 1200)
    return () => window.clearInterval(timer)
  }, [caching, load])

  const remove = async (item: BookshelfItem) => {
    if (!confirm(`移出“${item.name}”将清除书架、阅读进度和缓存封面，确定继续吗？`)) return
    try {
      await api.removeFromBookshelf(item.sourceId, item.bookUrl)
      setItems(values => values.filter(value => value.sourceId !== item.sourceId || value.bookUrl !== item.bookUrl))
      toast.info(`《${item.name}》已移出书架`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移出失败')
    }
  }

  const cache = async (item: BookshelfItem) => {
    try {
      await api.cacheBookshelfBook(item.sourceId, item.bookUrl)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? { ...value, cacheState: 'caching', cacheError: undefined } : value))
      previousStateRef.current.set(`${item.sourceId}\u0000${item.bookUrl}`, 'caching')
      toast.info(`已加入离线缓存队列，正在下载《${item.name}》…`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始缓存')
    }
  }

  const cancelCache = async (item: BookshelfItem) => {
    try {
      await api.cancelBookCache(item.sourceId, item.bookUrl)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? { ...value, cacheState: 'failed', cacheError: '已取消缓存' } : value))
      previousStateRef.current.set(`${item.sourceId}\u0000${item.bookUrl}`, 'failed')
      toast.info(`已取消《${item.name}》的离线缓存`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消缓存失败')
    }
  }

  const handleSwitchShelfSource = async (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => {
    if (!switchingItem) return
    const details = await api.details(chosen.result.sourceId, chosen.result.bookUrl)
    const fallbackCover = details.coverUrl?.trim() ||
      chosen.result.coverUrl?.trim() ||
      switchingItem.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()

    await api.switchBookshelfSource({
      oldSourceId: switchingItem.sourceId,
      oldBookUrl: switchingItem.bookUrl,
      book: {
        sourceId: details.sourceId,
        bookUrl: chosen.result.bookUrl,
        name: cleanTitle(details.name?.trim() || switchingItem.name) || switchingItem.name,
        author: cleanAuthor(details.author?.trim() || switchingItem.author) || switchingItem.author,
        tocUrl: details.tocUrl,
        coverUrl: fallbackCover || undefined,
      },
      alternateSources: switchingItem.alternateSources,
    })
    setSwitchingItem(null)
    await load()
  }

  const setCompleted = async (item: BookshelfItem, completed: boolean) => {
    try {
      const updated = await api.setBookshelfCompleted(item.sourceId, item.bookUrl, completed)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? updated : value))
      toast.success(completed ? `已将《${item.name}》标记为已读完` : `已将《${item.name}》恢复为正在阅读`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新阅读状态失败')
    }
  }

  /**
   * 缓存状态在 hover 层里用一句话说清楚，不再压三色徽章在封面上。
   * 值要短：这一层压在 111~180px 宽的封面上，「已缓存 1364 / 1364 章」这种整句
   * 在窄屏上会把 dl 顶出封面边界（source-scale-check 实测过 834 / 390 两档溢出）。
   */
  const cacheText = (item: BookshelfItem) => {
    if (item.cacheState === 'caching') return `缓存中 ${Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))}%`
    if (item.cacheState === 'ready') return `${item.cachedChapters}${item.totalChapters ? ` / ${item.totalChapters}` : ''} 章`
    if (item.cacheState === 'failed') return item.cacheError ? `中断：${item.cacheError}` : '中断，可重试'
    return '未缓存'
  }
  const groupOf = (item: BookshelfItem) => groups.find(group => group.id === (item.groupId ?? 0) && group.id !== 0)
  /** 来源只显示主机名，并且去掉 `www.`：整串 `https://www.x.com/` 在 111px 的窄封面上要换三行。 */
  const sourceHostOf = (sourceId?: string) => {
    if (!sourceId) return '未知来源'
    const host = sourceId.replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./i, '')
    return host || sourceId
  }
  const groupNameOf = (item: BookshelfItem) => groupOf(item)?.name ?? ''
  /** 悬停「来源」要显示书源的中文名而非裸 host：用全局 sources 建 id→name 映射，取不到再退回 host。 */
  const sourceNameById = useMemo(() => new Map(sources.map(s => [s.id, s.name])), [sources])

  const visibleItems = useMemo(() => {
    const byStatus = view === 'all' ? items : items.filter(item => view === 'completed' ? item.completed : !item.completed)
    const filtered = groupFilter === null ? byStatus : byStatus.filter(item => (item.groupId ?? 0) === groupFilter)
    const progressOf = (item: BookshelfItem) => ((item.chapterIndex ?? 0) + 1) / Math.max(1, item.totalChapters || 1)
    const sorted = [...filtered]
    switch (sort) {
      case 'name': sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); break
      case 'author': sorted.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh-CN')); break
      case 'progress': sorted.sort((a, b) => progressOf(b) - progressOf(a)); break
      default: sorted.sort((a, b) => b.lastReadAt - a.lastReadAt)
    }
    return sorted
  }, [items, view, sort, groupFilter])
  // 分页：默认只渲染前 120 本。换个页签/分组/排序后回到第一页 ——
  // 否则"按分组筛完还剩 3 本"却因为页码还停在 5 而显示空白，看着像筛选坏了。
  const [visibleCount, setVisibleCount] = useState(SHELF_PAGE_SIZE)
  useEffect(() => { setVisibleCount(SHELF_PAGE_SIZE) }, [view, sort, groupFilter])
  const shownItems = useMemo(
    () => visibleItems.slice(0, visibleCountOf(visibleItems.length, visibleCount)),
    [visibleItems, visibleCount],
  )
  const hasMore = hasMoreOf(visibleItems.length, visibleCount)
  // 「全选」全选的是**看得见的那一列**：按钮 title 写着"全选当前页所有书籍"，而页签与分组
  // 只作用于 visibleItems —— 按 items 整架选会让批量删除动到当前筛不出来的书。
  // 分页后跟着收窄到 shownItems：多选的目标必须和眼睛看到的一致，
  // 否则"加载更多"之前的批量删除会动到还没显示出来的书。
  const selectAllBooks = () => {
    setSelectedBooks(new Set(shownItems.map(item => `${item.sourceId}::${item.bookUrl}`)))
  }
  /** 取失败时上面那行 form-error 已经把原因说了，列表区不能再声称"书架是空的"。 */
  const shelfFailedEmpty = !!message && items.length === 0
  const counts = { reading: items.filter(item => !item.completed).length, completed: items.filter(item => item.completed).length, all: items.length }

  const chooseLayout = (next: ShelfLayout) => { setLayout(next); writeShelfLayout(next) }
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [busyGroup, setBusyGroup] = useState(false)

  const submitGroup = async () => {
    const name = groupName.trim()
    if (!name) return
    setBusyGroup(true)
    try {
      const created = await api.createShelfGroup(name)
      setGroupName('')
      setAddingGroup(false)
      setGroupFilter(created.id)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '建组失败')
    } finally {
      setBusyGroup(false)
    }
  }

  const removeGroup = async (id: number) => {
    const group = groups.find(item => item.id === id)
    if (!group) return
    if (!confirm(`删除分组「${group.name}」？${group.bookCount ? `组里 ${group.bookCount} 本书会回到「未分组」，书本身不删。` : ''}`)) return
    setBusyGroup(true)
    try {
      await api.removeShelfGroup(id)
      setGroupFilter(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除分组失败')
    } finally {
      setBusyGroup(false)
    }
  }

  /**
   * 归组。既给「书籍管理」弹窗用，也给书架右键的快捷项用 ——
   * 快捷项要有一句反馈，否则改了分组界面上看不出来（书还在原来的筛选结果里）。
   */
  const assignGroup = async (item: BookshelfItem, groupId: number, label?: string) => {
    try {
      const updated = await api.setBookGroup(item.sourceId, item.bookUrl, groupId)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? updated : value))
      setManagingItem(current => (current && current.sourceId === item.sourceId && current.bookUrl === item.bookUrl ? updated : current))
      setGroups((await api.shelfGroups().catch(() => groups)))
      if (label) toast.success(`《${item.name}》已移到「${label}」`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移动分组失败')
    }
  }
  // 上游书架头就是「继续阅读 + 统计」：最想看的是上次读到哪儿，而不是再挑一次封面。
  const resume = useMemo(() => items.filter(item => !item.completed).sort((a, b) => b.lastReadAt - a.lastReadAt)[0] ?? null, [items])
  const resumePercent = resume ? Math.min(100, Math.round((((resume.chapterIndex ?? 0) + 1) / Math.max(1, resume.totalChapters || 1)) * 100)) : 0

  return (
    <main
      className={`shelf-page ${dragOver ? 'drag-active' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          void handleImportFiles(e.dataTransfer.files)
        }
      }}
    >
      <header className="shelf-bar">
        <h1>书架<small>{counts.all} 本</small></h1>
        <div className="shelf-header-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.epub,.text,application/epub+zip,text/plain"
            style={{ display: 'none' }}
            onChange={e => {
              if (e.target.files && e.target.files.length > 0) {
                void handleImportFiles(e.target.files)
                e.target.value = ''
              }
            }}
          />
          <button
            type="button"
            className="shelf-import-btn"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            title="导入本地 TXT 或 EPUB 小说"
          >
            <Icon name="upload" />
            <span>{uploading ? '导入中…' : '导入本地'}</span>
          </button>
          {/* 分章规则跟着导入走（用户 2026-10-03：「『自定义』弹窗成了杂物间」）：
              只有准备导一本书时才会想起它，所以入口就放在那颗导入按钮旁边。 */}
          <button
            type="button"
            className="shelf-import-btn"
            onClick={() => setShowTocRules(true)}
            title="本地 TXT 按哪条规则切章节"
          >
            <Icon name="list" />
            <span>分章规则</span>
          </button>
          <div className="shelf-layout-picker" role="group" aria-label="书架布局">
            <button
              type="button"
              className={layout.mode === 'grid' ? 'active' : ''}
              aria-label="封面网格"
              title="封面网格：列数随窗口宽度自动排布"
              onClick={() => chooseLayout({ mode: 'grid' })}
            >
              <Icon name="columns" />
            </button>
            <button
              type="button"
              className={layout.mode === 'list' ? 'active' : ''}
              aria-label="列表"
              title="列表：封面在左，含作者/进度/最后阅读"
              onClick={() => chooseLayout({ mode: 'list' })}
            >
              <Icon name="list" />
            </button>
            <button
              type="button"
              className={layout.mode === 'compact' ? 'active' : ''}
              aria-label="紧凑列表"
              title="紧凑列表：只看书名与进度"
              onClick={() => chooseLayout({ mode: 'compact' })}
            >
              <Icon name="menu" />
            </button>
          </div>
          <button
            type="button"
            className={`shelf-batch-btn ${batchMode ? 'active' : ''}`}
            title={batchMode ? '退出批量管理' : '进入批量管理模式'}
            onClick={() => {
              setBatchMode(prev => !prev)
              setSelectedBooks(new Set()) // 切换模式时清空选择
            }}
          >
            <Icon name={batchMode ? 'checkSquare' : 'square'} />
            <span>{batchMode ? '完成' : '批量管理'}</span>
          </button>
          {batchMode && (
            <div className="shelf-batch-toolbar">
              <button
                type="button"
                className="shelf-batch-action"
                onClick={selectAllBooks}
                title="全选当前页所有书籍"
              >
                全选
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={clearSelection}
                title="清空选择"
              >
                清空
              </button>
              <span className="shelf-batch-separator">|</span>
              <button
                type="button"
                className="shelf-batch-action shelf-batch-danger"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchDelete()}
                title="删除选中的书籍"
              >
                <Icon name="trash" />
                删除 ({selectedBooks.size})
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchMarkAsRead(true)}
                title="标记为已读完"
              >
                标已读
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchMarkAsRead(false)}
                title="标记为未读完"
              >
                标未读
              </button>
              <Select
                ariaLabel="把选中的书移到分组"
                className="shelf-batch-group-select"
                placeholder="移到分组…"
                searchable
                disabled={selectedBooks.size === 0}
                value=""
                onChange={value => void handleBatchMoveToGroup(value === 'none' ? null : Number(value))}
                options={[
                  { value: 'none', label: '未分组' },
                  ...groups.map(group => ({ value: String(group.id), label: group.name, hint: `${group.bookCount} 本` })),
                ]}
              />
            </div>
          )}
          <div className="shelf-sort">
            <Select
              ariaLabel="书架排序"
              value={sort}
              onChange={value => chooseSort(value as ShelfSort)}
              options={[
                { value: 'recent', label: '按最后阅读' },
                { value: 'name', label: '按书名' },
                { value: 'author', label: '按作者' },
                { value: 'progress', label: '按阅读进度' },
              ]}
            />
          </div>
        </div>
      </header>

      <nav className="shelf-tabs" aria-label="书架分组">
        {([['reading', '正在阅读'], ['completed', '已读完'], ['all', '全部']] as const).map(([key, label]) => (
          <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
            {label}<small>{counts[key]}</small>
          </button>
        ))}
      </nav>

      {groups.length > 0 && (
        /*
          分组条是**横滑**的（分组可能几十个，换行会把书架顶下去），但「新建分组」不能跟它一起滑：
          它原来靠 `position: sticky; right: 0` 钉在右端，390px 实测（clientW 354 / scrollW 539）
          直接压在「本地 0」这颗 chip 上 —— 计数被盖住，看上去像分组名丢了数字。
          所以拆成两层：里层横滑，外层那颗按钮是普通 flex 子项，永远在滑轨右侧、不遮内容。
        */
        <div className="shelf-group-bar">
          <div className="shelf-group-scroll">
            <button type="button" className={groupFilter === null ? 'active' : ''} onClick={() => setGroupFilter(null)}>全部分组</button>
            {groups.map(group => (
              <button key={group.id} type="button" className={groupFilter === group.id ? 'active' : ''} onClick={() => setGroupFilter(group.id)}>
                {group.name}<small>{group.bookCount}</small>
              </button>
            ))}
            <button type="button" className={groupFilter === 0 ? 'active' : ''} onClick={() => setGroupFilter(0)}>
              未分组<small>{items.filter(item => !item.groupId).length}</small>
            </button>
          </div>
          {groupFilter === null || groupFilter === 0 ? (
            <button type="button" className="ghost-button shelf-group-new" onClick={() => setAddingGroup(true)}>新建分组</button>
          ) : (
            <button type="button" className="ghost-button shelf-group-remove" onClick={() => void removeGroup(groupFilter)}>删除分组</button>
          )}
        </div>
      )}
      {groups.length === 0 && (
        <div className="shelf-group-bar">
          {/* 分组没读出来时不许冒充"你还没建分组"——那会让用户去建第二个同名组，也不知道右键少了什么 */}
          {groupsFailed && (
            <span className="shelf-group-failed">
              分组没载入
              <button type="button" className="link-button" onClick={() => void load()}>重试</button>
            </span>
          )}
          <button type="button" className="ghost-button shelf-group-new" onClick={() => setAddingGroup(true)}>新建分组</button>
        </div>
      )}
      {addingGroup && (
        <form className="shelf-group-form" onSubmit={event => { event.preventDefault(); void submitGroup() }}>
          <input
            value={groupName}
            onChange={event => setGroupName(event.target.value)}
            placeholder="分组名（最长 24 字）"
            aria-label="新分组名称"
            maxLength={24}
            autoFocus
          />
          <button type="submit" className="primary-button" disabled={busyGroup}>建组</button>
          <button type="button" className="subtle-button" onClick={() => setAddingGroup(false)}>取消</button>
        </form>
      )}

      {resume && (
        <section className="shelf-resume" aria-label="继续阅读">
          <span className="shelf-resume-cover" onClick={() => onOpen(resume)} role="button" tabIndex={0} aria-label={`继续阅读 ${resume.name}`}>
            <BookCover coverKey={resume.coverKey} name={resume.name} author={resume.author} compact />
          </span>
          <div className="shelf-resume-info">
            <strong title={resume.name}>{resume.name}</strong>
            <small>
              {resume.completed ? '已读完' : `上次读到第 ${(resume.chapterIndex ?? 0) + 1} 章${resume.totalChapters ? ` / 共 ${resume.totalChapters} 章` : ''}`}
              {' · '}
              {new Date(resume.lastReadAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </small>
            <span className="shelf-resume-track" aria-hidden="true"><i style={{ width: `${resumePercent}%` }} /></span>
          </div>
          <button type="button" className="primary-button" onClick={() => onOpen(resume)}>继续阅读</button>
        </section>
      )}

      {message && <p className="form-error">{message}</p>}

      {!itemsLoaded && !message ? (
        <section className="shelf-empty" aria-live="polite">
          <Icon name="book" />
          <h2>正在读书架…</h2>
        </section>
      ) : shelfFailedEmpty ? (
        null
      ) : items.length === 0 ? (
        <section className="shelf-empty">
          <Icon name="book" />
          <h2>书架还是空的</h2>
          <p>在书库检索添加在线小说，或直接导入本地 TXT / EPUB 文件。</p>
          <button
            type="button"
            className="shelf-import-btn"
            style={{ marginTop: '12px' }}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" />
            <span>{uploading ? '正在解析导入…' : '导入本地 TXT / EPUB'}</span>
          </button>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="shelf-empty">
          <Icon name="book" />
          <h2>这个分组还是空的</h2>
        </section>
      ) : (
        <section
          className={`shelf-grid shelf-mode-${layout.mode}${batchMode ? ' is-batching' : ''}`}
        >
          {shownItems.map((item, index) => {
            const isCaching = item.cacheState === 'caching'
            const isLocal = item.sourceId === 'loc_book'
            const percent = Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))

            return (
              <article
                key={`${item.sourceId}-${item.bookUrl}`}
                className={`shelf-card ${batchMode && isBookSelected(item.sourceId, item.bookUrl) ? 'selected' : ''}`}
                onContextMenu={event => {
                  // 分组超过 8 个时，右键菜单里只放前 7 个 + "更多分组…"，避免菜单过长
                  const availableGroups = groups.filter(group => group.id !== 0 && group.id !== (item.groupId ?? 0))
                  const showAllGroups = availableGroups.length <= 8
                  const visibleGroups = showAllGroups ? availableGroups : availableGroups.slice(0, 7)
                  const hasMore = !showAllGroups

                  showContextMenu(event, [
                    { label: item.completed ? '重新阅读' : '继续阅读', icon: 'book', onSelect: () => onOpen(item) },
                    { label: '书籍管理', icon: 'settings', onSelect: () => setManagingItem(item) },
                    { label: '换源', icon: 'refresh', disabled: isLocal, onSelect: () => setSwitchingItem(item) },
                    { label: isCaching ? '取消缓存' : '缓存全本', icon: isCaching ? 'close' : 'download', onSelect: () => void (isCaching ? cancelCache(item) : cache(item)) },
                    { label: item.completed ? '标记未读完' : '标记已读完', icon: 'check', onSelect: () => void setCompleted(item, !item.completed) },
                    { label: '复制书名', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(`${item.name}${item.author ? ` — ${item.author}` : ''}`) },
                    ...visibleGroups.map(group => ({ label: `移到「${group.name}」`, icon: 'bookmark' as const, onSelect: () => void assignGroup(item, group.id, group.name) })),
                    ...(hasMore ? [{ label: `更多分组（还有 ${availableGroups.length - 7} 个）…`, icon: 'folder' as const, onSelect: () => setManagingItem(item) }] : []),
                    ...(item.groupId ?? 0) !== 0 ? [{ label: '移到「未分组」', icon: 'folder' as const, onSelect: () => void assignGroup(item, 0, '未分组') }] : [],
                    { label: '移出书架', icon: 'trash', danger: true, onSelect: () => void remove(item) },
                  ])
                }}
              >
                {/* 批量模式下的复选框 */}
                {batchMode && (
                  <div 
                    className="shelf-card-checkbox"
                    onClick={event => {
                      event.stopPropagation()
                      toggleBookSelection(item.sourceId, item.bookUrl)
                    }}
                    role="checkbox"
                    aria-checked={isBookSelected(item.sourceId, item.bookUrl)}
                    tabIndex={0}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleBookSelection(item.sourceId, item.bookUrl)
                      }
                    }}
                  >
                    <Icon name={isBookSelected(item.sourceId, item.bookUrl) ? 'checkSquare' : 'square'} />
                  </div>
                )}
                
                {/*
                  封面：点它 = 继续阅读。徽章（「N章已缓存」「本地」）以前直接压在封面上，
                  一张卡三种底色，整架看下去很吵 —— 现在收进 hover 信息层：封面在背后模糊，
                  信息浮在上面（用户 2026-09-29 的口径）。触屏没有 hover，所以下方信息区
                  仍然常驻书名/进度，并且点它 = 打开「书籍管理」，动作一个都不少。
                */}
                <div
                  className="shelf-card-cover"
                  onClick={() => { if (batchMode) toggleBookSelection(item.sourceId, item.bookUrl); else onOpen(item) }}
                  role="button"
                  tabIndex={0}
                  aria-label={batchMode ? `${isBookSelected(item.sourceId, item.bookUrl) ? '取消选择' : '选择'} ${item.name}` : `继续阅读 ${item.name}`}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      if (batchMode) toggleBookSelection(item.sourceId, item.bookUrl); else onOpen(item)
                    }
                  }}
                >
                  <BookCover coverKey={item.coverKey} name={item.name} author={item.author} />
                  {isCaching && (
                    <div className="shelf-card-progress-track">
                      <div className="shelf-card-progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  {/* 封面下沿不再画阅读进度（用户 2026-10-03）：读到哪儿在下面的章数/百分比、
                      hover 信息层与顶部「继续阅读」那条里都有。样式那边也删了，别只删一半。 */}
                  <div className="shelf-card-hover" aria-hidden="true">
                    <strong>{item.name}</strong>
                    <p>{item.author || '未知作者'}</p>
                    {/*
                      值要短：这一层压在 111~180px 宽的封面上，「已缓存 1364 / 1364 章」这种
                      整句在窄屏上会把 dl 顶出封面边界（source-scale-check 实测过 834/390 两档溢出）。
                      标签已经说了是什么，值就只留数字与结论。
                    */}
                    <dl>
                      <div><dt>进度</dt><dd>{item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入' : `${item.chapterIndex + 1}${item.totalChapters ? ` / ${item.totalChapters}` : ''} 章${item.totalChapters ? ` · ${Math.min(100, Math.round(((item.chapterIndex + 1) / item.totalChapters) * 100))}%` : ''}`}</dd></div>
                      <div><dt>缓存</dt><dd>{cacheText(item)}</dd></div>
                      <div><dt>上次</dt><dd>{new Date(item.lastReadAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
                      {(item.tocUpdatedAt ?? 0) > 0 && <div><dt>更新</dt><dd>{new Date(item.tocUpdatedAt!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>}
                      {/* 来源：本地书直说；在线书给书源显示名（sources 传入后建 id→name 映射），取不到再退回 host */}
                      <div><dt>来源</dt><dd>{isLocal ? '本地导入' : (sourceNameById.get(item.sourceId) || sourceHostOf(item.sourceId))}</dd></div>
                      {!isLocal && !!item.alternateSources?.length && <div><dt>换源</dt><dd>{item.alternateSources.length} 个源</dd></div>}
                      {!!groupNameOf(item) && <div><dt>分组</dt><dd>{groupNameOf(item)}</dd></div>}
                      {!!item.author && <div><dt>作者</dt><dd>{item.author}</dd></div>}
                    </dl>
                  </div>
                </div>

                <div
                  className="shelf-card-info"
                  role="button"
                  tabIndex={0}
                  aria-label={`管理《${item.name}》：缓存、换源、分组、移出书架`}
                  title="点击打开书籍管理"
                  onClick={() => setManagingItem(item)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setManagingItem(item) } }}
                >
                  <h3 className="shelf-card-name" title={item.name}>{item.name}</h3>
                  <p className="shelf-card-author">{item.author || '未知作者'}</p>
                  <div className="shelf-card-meta">
                    {bookTypeMeta(item.sourceType) && (
                      <span className={`book-type-badge type-${item.sourceType}`}>{bookTypeMeta(item.sourceType)!.label}</span>
                    )}
                    <span className={`shelf-meta-chapter ${item.completed ? 'completed' : ''}`}>
                      {item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入书架' : `第 ${item.chapterIndex + 1} 章`}
                    </span>
                    {item.totalChapters > 0 && <span className="shelf-meta-percent">{Math.min(100, Math.round((((item.chapterIndex ?? 0) + 1) / item.totalChapters) * 100))}%</span>}
                    <time className="shelf-meta-when" dateTime={new Date(item.lastReadAt).toISOString()}>
                      {new Date(item.lastReadAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                    </time>
                  </div>
                </div>
              </article>
            )
          })}
          {hasMore && (
            <button
              type="button"
              className="shelf-more"
              onClick={() => setVisibleCount(count => moreCountOf(count))}
            >
              已显示 {shownItems.length} / {visibleItems.length}，点击加载更多
            </button>
          )}
        </section>
      )}

      {/* Book Management Modal */}
      {managingItem && (
        <BookManageModal
          item={managingItem}
          onClose={() => setManagingItem(null)}
          onSwitchSource={() => {
            const target = managingItem
            setManagingItem(null)
            setSwitchingItem(target)
          }}
          onCache={() => {
            void cache(managingItem)
            setManagingItem(prev => prev ? { ...prev, cacheState: 'caching' } : null)
          }}
          onCancelCache={() => {
            void cancelCache(managingItem)
            setManagingItem(prev => prev ? { ...prev, cacheState: 'failed', cacheError: '已取消缓存' } : null)
          }}
          onToggleCompleted={() => setCompleted(managingItem, !managingItem.completed)}
          groups={groups}
          onAssignGroup={groupId => void assignGroup(managingItem, groupId)}
          onUpdateInfo={updated => {
            setItems(values => values.map(v => v.sourceId === updated.sourceId && v.bookUrl === updated.bookUrl ? updated : v))
            setManagingItem(updated)
          }}
          onRemove={() => remove(managingItem)}
        />
      )}

      {/* Standalone Source Switch Modal for Shelf Book */}
      {switchingItem && (
        <SourceSwitchModal
          bookName={switchingItem.name}
          author={switchingItem.author}
          currentSourceId={switchingItem.sourceId}
          currentBookUrl={switchingItem.bookUrl}
          currentChapterIndex={switchingItem.chapterIndex}
          knownAlternateSources={switchingItem.alternateSources}
          sources={sources}
          onSwitch={handleSwitchShelfSource}
          onClose={() => setSwitchingItem(null)}
        />
      )}
      {showTocRules && (
        <TocRulesModal
          value={txtTocRule}
          onChange={onTxtTocRuleChange}
          onClose={() => setShowTocRules(false)}
          onImport={() => {
            // 导书这条动作就着这一屏做完：关掉弹窗、直接开文件选择，不再让人回去找那颗按钮
            setShowTocRules(false)
            fileInputRef.current?.click()
          }}
        />
      )}
    </main>
  )
}

