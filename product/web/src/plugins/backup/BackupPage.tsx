import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, type BackupImportPreview, type BackupLibraryPolicy, type BackupSectionId, type BackupImportSummary, type BackupSnapshotInfo, type KeptBackupEntry } from '../../lib/api'
import { requestBlob } from '../../lib/api/client'
import { toast } from '../../components/Toast'
import { Icon } from '../../icons'
import { loadReaderSettings, saveReaderSettings } from '../../features/reader/settingsPanel/readerSettings'
import { applyPreferencePatch, mapReadStyle, mapTtsEngine } from '../../features/reader/settingsPanel/backupPreferences'
import { fetchImportUrl, fileNameFromUrl } from '../../lib/importFromUrl'
import { BackupWebDavPanel } from './BackupWebDavPanel'
import { BackupSourceVersionsPanel, isSourceVersionArchive } from './BackupSourceVersionsPanel'

/**
 * 「备份」页：预览 Legado（或 MD3 / Max / Ink / Night-Reader 等兄弟项目）导出的备份，勾选模块后恢复，
 * 本地导入或手动 WebDAV 拉取均先预览。认 zip 备份包，也认分享出来的**裸 JSON**
 * （单个/多个书源、`{bookSource:[…],bookshelf:[…]}` 这类合并导出）。
 *
 * 这条路径以前是"先把 zip 放进 WebDAV 存储区，再点导入"，而那个服务只绑回环时手机根本推不上来 ——
 * 等于没有。现在浏览器直接上传，服务端写临时文件、读完即删，包不落盘。
 *
 * 措辞口径（用户 2026-09-30：「手机恢复这个名词解释有些难听，咱们这是电脑啊」）：
 * 主语是**备份包**，不是手机。这台服务跑在电脑上，"读得懂安卓端导出的包"只是它的输入格式。
 */

/** 服务端承接的内容；界面要提前说清楚，而不是导入完让人猜。 */
/** 上一次导出的记录（时间 + 大小），只在这台机器的这个浏览器里 —— 用户点完能回头确认「确实下下来了」。 */
const LAST_EXPORT_KEY = 'legadoq-last-export'

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const RESTORED_SECTIONS: [string, string][] = [
  ['书源', '同名书源按 ID 覆盖规则内容；**已存在的书源保留你本机的启用/停用选择**'],
  ['替换净化规则', '按规则标识覆盖'],
  ['书架与阅读进度', '默认保留本机书架信息，只采用时间明确且更新的进度；预览时可更改策略；**你从书架删过的书不会被备份复活**'],
  ['RSS 订阅源', '「订阅」页那一栏，按 sourceUrl 合并'],
  ['分组', '包里的组号会换成本机组号（同名只留一个）'],
  ['书源订阅', '「订阅」页的书源订阅地址，按地址合并；原包也照样留档'],
]

/** 没有原生界面、但会原样收进数据目录的条目，以及它们各自的下落（导入后下面会列出这次实际收下的文件）。 */
const KEPT_SECTIONS: [string, string][] = [
  ['阅读样式', '可套用到本机阅读设置'],
  ['朗读引擎', '可套用到本机朗读设置'],
  ['TXT 分章规则', '可套用到本机规则表：按规则字面匹配采纳你在手机上勾的启用/停用，包里自己加的规则作为新规则收下'],
  ['字典规则', '这台服务没有取词功能，先原样存着，可下载'],
  ['其余条目', '搜索历史、书籍笔记、RSS 收藏、阅读记录 —— 原样存着，可下载'],
]

export function reportImportSummary(summary: BackupImportSummary) {
  const total = (a?: number, b?: number) => (a ?? 0) + (b ?? 0)
  const skipped = summary.skippedSections ?? []
  const kept = summary.keptSections ?? []
  const books = total(summary.books, summary.booksUpdated)
  const rss = total(summary.rssSources, summary.rssSourcesUpdated)
  if (
    total(summary.sources, summary.sourcesUpdated) + total(summary.rules, summary.rulesUpdated) +
    books + rss + summary.progress + (summary.libraryDiff?.booksKept ?? 0) + (summary.booksSkippedDeleted ?? 0) +
    (summary.subscriptions ?? 0) + (summary.bookGroups ?? 0) + (summary.cookies ?? 0) + kept.length === 0
  ) {
    toast.warning(skipped.length ? `备份包里没有可导入的内容，已跳过：${skipped.join('、')}` : '备份包里没有可导入的内容')
  } else toast.success(
    `导入完成：书源 ${total(summary.sources, summary.sourcesUpdated)}（已存在的保留本机启用状态），` +
    `替换规则 ${total(summary.rules, summary.rulesUpdated)}，书籍 ${books}，阅读进度 ${summary.progress}` +
    `${rss ? `，RSS 订阅源 ${rss}` : ''}${summary.bookGroups ? `，分组 ${summary.bookGroups}` : ''}` +
    `${summary.subscriptions ? `，书源订阅 ${summary.subscriptions}` : ''}` +
    `${summary.cookies ? `，登录凭据 ${summary.cookies} 条` : ''}`,
  )
  // 备份里当然还留着删之前的书：跳过多少本必须说出来，否则用户以为导入把删除决定盖掉了
  if (summary.booksSkippedDeleted) {
    toast.info(`备份里另有 ${summary.booksSkippedDeleted} 本你已从书架删除，按删除保留、没有恢复`)
  }
  if (summary.libraryDiff) {
    const diff = summary.libraryDiff
    toast.info(`按策略保留书架信息 ${diff.booksKept} 本、跳过备份进度 ${diff.progressKept} 条；包内缺少有效进度时间 ${diff.progressUnknownTime} 条，重复书籍 ${diff.duplicates} 条（取最后一条）`)
  }
  // 凭据只是"这一节没做成"，不是导入失败：单独一句，别和"不承接"混在一起
  if (summary.cookiesNote) toast.warning(summary.cookiesNote)
  if (kept.length) toast.info(`另外原样收下 ${kept.length} 类条目：${kept.map(item => item.label).join('、')}`)
  if (skipped.length) toast.warning(`这些条目连收下的地方都还没有：${skipped.join('、')}`)
  // 单条读坏了以前只停在服务端的 ImportResponse 里，界面上完全看不见 —— 静默丢东西比报错了更难查
  const errors = summary.errors ?? []
  if (errors.length) toast.warning(`${errors.length} 条没读进去：${errors.slice(0, 2).join('；')}${errors.length > 2 ? '…' : ''}`)
}

/**
 * 导入成功后的收尾：播报结果 + 请求宿主刷新书源共享目录。
 *
 * 抽成纯函数是为了能脱离 DOM 测（`handleImport` 挂在 `<input>` 的 onChange 上，SSR 触发不了）。
 * 书源走 `sourceCatalog` 那份共享缓存：`load()` 在 status=ready 时直接返回旧数组，导入写了库却不
 * invalidate，关掉这个浮层后书源页 / 选源下拉看到的还是导入前那份，用户读到的是"导了没用"。
 * 书架与 RSS 每次挂载都重新 fetch、不依赖缓存，所以这里只需刷新书源这一处。
 */
export function afterBackupImported(summary: BackupImportSummary, onImported?: () => void) {
  reportImportSummary(summary)
  onImported?.()
}

/** 凭据始终需要用户显式选择；不把包里缺失的域送回服务端。 */
export const defaultBackupSections = (preview: BackupImportPreview): BackupSectionId[] =>
  preview.sections.filter(section => section.id !== 'cookies').map(section => section.id)

export function BackupPreviewPanel({ preview, selected, busy, onToggle, onConfirm, onCancel, onRefresh, policy, stale = false, onPolicyChange }: {
  preview: BackupImportPreview
  selected: BackupSectionId[]
  busy: boolean
  onToggle: (id: BackupSectionId) => void
  onConfirm: () => void
  onCancel: () => void
  onRefresh: () => void
  policy?: BackupLibraryPolicy
  stale?: boolean
  onPolicyChange?: (policy: BackupLibraryPolicy) => void
}) {
  return <div className="backup-preview" aria-label="备份导入预览">
    <h3>选择要导入的内容</h3>
    <p className="backup-hint">预览尚未写入数据。取消会放弃本次选择。</p>
    {preview.warnings.map((warning, index) => <p className="backup-hint" key={index}>{warning}</p>)}
    {preview.sections.map(section => <div key={section.id}>
      <label><input type="checkbox" checked={selected.includes(section.id)} disabled={busy}
        onChange={() => onToggle(section.id)} /> {section.label}（{section.items}）</label>
      <p className="backup-hint">{section.policy}</p>
    </div>)}
    {preview.sections.some(section => section.id === 'shelf') && policy && onPolicyChange && <fieldset disabled={busy}>
      <legend>书架与进度冲突策略</legend>
      <label>已有书架信息 <select value={policy.metadata} onChange={event => onPolicyChange({ ...policy, metadata: event.target.value as BackupLibraryPolicy['metadata'] })}>
        <option value="keep_local">保留本机信息</option><option value="overwrite">采用备份信息</option>
      </select></label>
      <label>阅读进度 <select value={policy.progress} onChange={event => onPolicyChange({ ...policy, progress: event.target.value as BackupLibraryPolicy['progress'] })}>
        <option value="newer">只采用明确较新的进度</option><option value="keep_local">不恢复进度</option><option value="overwrite">采用备份进度（可回退）</option>
      </select></label>
      <p className="backup-hint">相同时间保留本机进度；缺少时间默认跳过。强制采用时，无时间记录按本次导入时间保存。</p>
    </fieldset>}
    {stale ? <p role="alert">策略、密码或本机数据已变化，请重新预览后确认。</p> : selected.includes('shelf') && preview.libraryDiff && <p role="status">
      预计：新增 {preview.libraryDiff.booksAdded} 本，更新信息 {preview.libraryDiff.booksUpdated} 本，保留信息 {preview.libraryDiff.booksKept} 本，
      按删除跳过 {preview.libraryDiff.skippedDeleted} 本；采用进度 {preview.libraryDiff.progressApplied} 条，保留/跳过进度 {preview.libraryDiff.progressKept} 条，
      缺少有效进度时间 {preview.libraryDiff.progressUnknownTime} 条；重复 {preview.libraryDiff.duplicates} 条（取最后一条）。
    </p>}
    {!preview.sections.length && <p role="status">包内没有可选择的内容，请检查备份或填写凭据解密密码后重新预览。</p>}
    <div className="backup-actions">
      <button type="button" className="primary-button" disabled={busy || stale || !selected.length} onClick={onConfirm}>确认导入所选内容</button>
      <button type="button" className="subtle-button" disabled={busy} onClick={onRefresh}>重新预览</button>
      <button type="button" className="subtle-button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </div>
}

export function BackupPage({ onImported }: { onImported?: () => void } = {}) {
  const [backupPassword, setBackupPassword] = useState('')
  /** 「从地址导入」的地址输入；与「选择备份包导入」并存。 */
  const [importUrl, setImportUrl] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [importBusy, setBusy] = useState(false)
  const [webDavBusy, setWebDavBusy] = useState(false)
  const [versionsBusy, setVersionsBusy] = useState(false)
  const [versionArchive, setVersionArchive] = useState<string | null>(null)
  const busy = importBusy || webDavBusy || versionsBusy
  const [pending, setPending] = useState<{ file: File; password: string; preview: BackupImportPreview } | null>(null)
  const [selected, setSelected] = useState<BackupSectionId[]>([])
  const [libraryPolicy, setLibraryPolicy] = useState<BackupLibraryPolicy>({ metadata: 'keep_local', progress: 'newer' })
  const [previewStale, setPreviewStale] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<{ at: number; bytes: number } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_EXPORT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { at?: number; bytes?: number }
      if (typeof parsed.at === 'number' && typeof parsed.bytes === 'number') setLastExport({ at: parsed.at, bytes: parsed.bytes })
    } catch { /* 读不出来就当没有，不影响导出 */ }
  }, [])
  const [kept, setKept] = useState<KeptBackupEntry[]>([])
  // 取失败与"确实没导过包"要分开：以前 catch 成空数组，整块面板直接消失，
  // 用户读到的是"这个服务没收下任何东西"，而真实情况可能是那一次请求没成。
  const [keptFailed, setKeptFailed] = useState(false)
  const backupInputRef = useRef<HTMLInputElement>(null)

  const loadKept = useCallback(async () => {
    try { setKept(await api.keptBackupEntries()); setKeptFailed(false) } catch { setKeptFailed(true) }
  }, [])
  useEffect(() => { void loadKept() }, [loadKept])

  // 启动库快照：可回滚的历史副本。取失败与"确实一份都没有"分开，别把没取到说成"没有备份"。
  const [snapshots, setSnapshots] = useState<BackupSnapshotInfo[]>([])
  const [snapshotsFailed, setSnapshotsFailed] = useState(false)
  const loadSnapshots = useCallback(async () => {
    try { setSnapshots(await api.backupSnapshots()); setSnapshotsFailed(false) } catch { setSnapshotsFailed(true) }
  }, [])
  useEffect(() => { void loadSnapshots() }, [loadSnapshots])

  const scheduleRestore = async (snap: BackupSnapshotInfo) => {
    const when = new Date(snap.createdAt).toLocaleString('zh-CN', { hour12: false })
    const go = window.confirm(
      `用「${when}」这份启动快照恢复数据库？\n` +
      '这不会立刻生效：系统会在你下一次重启 legadoQ、打开数据库之前才落库，' +
      '并把当前库先留成一份"恢复前副本"，万一恢复的不是想要的还能再退回。' +
      '确认后排定成功，请随后重启一次。',
    )
    if (!go) return
    setBusy(true)
    try {
      const result = await api.restoreBackupSnapshot(snap.name)
      toast.success(result.restartRequired ? '已排定：下次重启 legadoQ 时恢复（当前库会先留一份副本）' : '已排定恢复')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '排定恢复失败')
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (file: File) => {
    setPending(null)
    setSelected([])
    setBusy(true)
    try {
      const password = backupPassword.trim()
      const preview = await api.previewBackupFile(file, password, libraryPolicy)
      setPending({ file, password, preview })
      setPreviewStale(false)
      setSelected(defaultBackupSections(preview))
      if (preview.warnings.some(warning => warning.includes('cookies.json'))) setPasswordOpen(true)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份预览失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  const confirmImport = async () => {
    if (!pending || !selected.length || busy || previewStale || pending.password !== backupPassword.trim()) return
    setBusy(true)
    try {
      const summary = await api.importBackupFile(pending.file, pending.password, selected, pending.preview.libraryPolicy ?? libraryPolicy, pending.preview.previewToken ?? undefined)
      setPending(null)
      setSelected([])
      afterBackupImported(summary, onImported)
      // 只有包内确实有加密凭据、又没填密码时，才提示可以补密码重试 ——
      // 它不是导入的前置条件，以前摆在主操作行上，看着像必填。
      if (summary.cookiesNote && !summary.cookies) setPasswordOpen(true)
      await loadKept()
    } catch (error) {
      setPreviewStale(true)
      toast.error(error instanceof Error ? error.message : '备份导入失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 从地址导入：经同源代理把 zip 取回来，再转成 File 交给上面同一条 handleImport
   * （预览、选域、密码、结果播报都复用，不另写一套恢复逻辑）。
   */
  const importFromUrl = async () => {
    setBusy(true)
    try {
      const { blob } = await fetchImportUrl(importUrl)
      const file = new File([blob], fileNameFromUrl(importUrl), { type: blob.type || 'application/zip' })
      await handleImport(file)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份导入失败')
    } finally {
      setBusy(false)
    }
  }

  const applyKept = async (entry: KeptBackupEntry) => {
    // TXT 分章规则不在前端设置里，它是服务端切目录时读的那张表 —— 所以这一条走服务端接口。
    if (entry.name.toLowerCase().startsWith('txttocrule')) {
      setBusy(true)
      try {
        const result = await api.applyTocRulesFromBackup()
        const parts = [`采纳 ${result.matched} 条的启用选择（改动 ${result.flipped} 条）`, `收下新规则 ${result.added} 条`]
        if (result.unusable) parts.push(`${result.unusable} 条正则在本机编不出来，已跳过`)
        toast.success(`目录规则已套用：${parts.join('，')} · 现在共 ${result.total} 条`)
        void loadKept()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '套用失败')
      } finally {
        setBusy(false)
      }
      return
    }
    let raw = ''
    try { raw = await api.keptBackupEntry(entry.name) }
    catch (error) { toast.error(error instanceof Error ? error.message : '读不出来'); return }
    const current = loadReaderSettings()
    const result = entry.name.toLowerCase().startsWith('httptts')
      ? mapTtsEngine(raw)
      : mapReadStyle(raw, current)
    if (!result.applied.length) {
      toast.warning(result.notes.join('；') || '这条里没有能映射到本机设置的字段')
      return
    }
    saveReaderSettings(applyPreferencePatch(current, result.patch))
    toast.success(`已套用：${result.applied.join('、')}${result.notes.length ? `（${result.notes.join('；')}）` : ''}`)
  }

  /**
   * 导出六个原生域；迁移包另带已收下的文件，恢复时仍需预览确认。
   *
   * 用 fetch 取 Blob 而不是 `<a href download>`：这样失败（服务 500、磁盘满）能给出具体原因，
   * 而不是点下去什么都不发生。文件名由服务端 Content-Disposition 给，这里本地再造一份只为兜底。
   */
  const handleExport = useCallback(async (recovery = false) => {
    if (exporting) return
    setExporting(true)
    try {
      const blob = await requestBlob(recovery ? '/api/backup/export?domain=recovery' : '/api/backup/export')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      link.href = url
      link.download = `legadoq-${recovery ? 'migration' : 'backup'}-${stamp}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      // 立刻 revoke 会让部分浏览器下不到文件，留一拍再释放
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      const record = { at: Date.now(), bytes: blob.size }
      setLastExport(record)
      try { localStorage.setItem(LAST_EXPORT_KEY, JSON.stringify(record)) } catch { /* 存不下不影响导出 */ }
      toast.success(`备份已导出：${formatSize(blob.size)}`)
    } catch (error) {
      toast.error(error instanceof Error ? `导出失败：${error.message}` : '导出失败')
    } finally {
      setExporting(false)
    }
  }, [exporting])

  return (
    <section className="backup-page">
      {/* 标题由悬浮层头给（0.6.27）。正文不再写"全程在本机/不经过网盘"这类讲实现的句子 ——
          "包不落盘"那句（下面主操作面板里）才是用户真正要的那句。 */}
      <p className="page-lead">
        两个方向都在这一页：选择备份包后先预览并勾选内容，再确认导入；点「导出备份包」把本机的东西打包带走。
        导入认 Legado 的 zip，也认 MD3 / Max / Night-Reader 等兄弟项目的包，以及分享出来的书源 JSON。
      </p>

      <section className="backup-panel">
        <h2>导出备份</h2>
        <p className="backup-hint">
          一个包带走六类：书源、替换净化规则、分组、RSS 订阅源、书源订阅、书架与阅读进度。
          普通备份包<strong>不含独立登录凭据</strong>（登录态不随包走），也不含笔记、书签、封面与本地书文件 ——
          这几样导入侧还没有对应入口，放了就是「恢复了但看不见」。
        </p>
        {exporting && (
          <p className="backup-hint" role="status">
            正在打包…书源或留档多时可能需要一些时间，请等待下载完成。
          </p>
        )}
        {!exporting && lastExport && (
          <p className="backup-hint" role="status">
            上次导出：{new Date(lastExport.at).toLocaleString('zh-CN', { hour12: false })} · {formatSize(lastExport.bytes)}
            （这次下载到哪了，看浏览器的「下载」列表）
          </p>
        )}
        <div className="backup-actions">
          <button type="button" className="primary-button" onClick={() => void handleExport()} disabled={exporting || busy}>
            <span>{exporting ? '导出中…' : '导出备份包'}</span>
          </button>
          <button type="button" className="subtle-button" onClick={() => void handleExport(true)} disabled={exporting || busy}>
            导出含留档的迁移包
          </button>
        </div>
        <p className="backup-hint">迁移包另含已收下的个性化文件、冲突书源版本与原始书架引用；导入时仍先预览、按模块确认，不自动激活书源版本或套用设置。留档可能含私密配置，请妥善保管。两种包均不含封面、本地书文件或完整数据库状态。</p>
        <p className="backup-hint">这里的导出下载到浏览器；上传远端请使用下方 WebDAV 区。</p>
      </section>

      <BackupWebDavPanel disabled={importBusy || versionsBusy || exporting} onFile={handleImport} onBusyChange={setWebDavBusy} />

      <section className="backup-panel">
        <div className="backup-actions">
          <input
            ref={backupInputRef}
            type="file"
            accept=".zip,.json,.txt,application/zip,application/json"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void handleImport(file)
            }}
          />
          <button type="button" className="primary-button" onClick={() => backupInputRef.current?.click()} disabled={busy}>
            <Icon name="importFile" />
            <span>{busy ? '处理中…' : '选择备份包导入'}</span>
          </button>
          <input
            className="backup-url"
            type="url"
            value={importUrl}
            onChange={event => setImportUrl(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void importFromUrl() } }}
            placeholder="或粘贴备份包地址（http/https）"
            aria-label="备份包地址"
            autoComplete="off"
            disabled={busy}
          />
          <button type="button" className="subtle-button" onClick={() => void importFromUrl()} disabled={busy}>
            从地址导入
          </button>
          <button type="button" className="link-button" onClick={() => setPasswordOpen(open => !open)}>
            {passwordOpen ? '收起凭据解密密码' : '需要解开包里的登录凭据？'}
          </button>
        </div>
        {passwordOpen && (
          <div className="backup-password-row">
            <input
              className="backup-password"
              type="password"
              value={backupPassword}
              disabled={busy}
              onChange={event => setBackupPassword(event.target.value)}
              placeholder="凭据解密密码（只用于解开 cookies.json）"
              autoComplete="off"
              aria-label="凭据解密密码"
            />
            <p className="backup-hint">
              只有 <code>cookies.json</code> 需要它。
              不填也照样导入其余所选内容。填写或修改密码后点「重新预览」，再单独勾选登录凭据；密码不写日志。
            </p>
          </div>
        )}
        <p className="backup-hint">备份包只临时用一下，不会留在电脑上。</p>
        {pending && <>
          <p className="backup-hint">待导入：{pending.file.name}</p>
          <BackupPreviewPanel preview={pending.preview} selected={selected} busy={busy}
            policy={libraryPolicy} stale={previewStale || pending.password !== backupPassword.trim()}
            onPolicyChange={policy => { setLibraryPolicy(policy); setPreviewStale(true) }}
            onToggle={id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])}
            onConfirm={() => void confirmImport()}
            onRefresh={() => void handleImport(pending.file)}
            onCancel={() => { setPending(null); setSelected([]) }} />
        </>}
      </section>

      <section className="backup-panel">
        <h2>会恢复到应用里</h2>
        <dl className="backup-scope">
          {RESTORED_SECTIONS.map(([name, detail]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{detail.replace(/\*\*(.+?)\*\*/g, '$1')}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="backup-panel">
        <h2>原样收下的条目</h2>
        <dl className="backup-scope">
          {KEPT_SECTIONS.map(([name, detail]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
        {keptFailed && kept.length === 0 && (
          <p className="backup-hint" role="status">
            本次实际收下的文件没取到。
            <button type="button" className="subtle-button" onClick={() => void loadKept()}>再取一次</button>
          </p>
        )}
        {kept.length > 0 && (
          <>
            <h3 className="backup-kept-subhead">本次导入实际收下的文件</h3>
            <ul className="backup-kept-list">
              {kept.map(entry => (
                <li key={entry.name}>
                  <span className="backup-kept-label">{entry.label}</span>
                  <span className="backup-kept-meta">
                    {entry.items > 0 ? `${entry.items} 条 · ` : ''}{Math.max(1, Math.round(entry.bytes / 1024))} KB
                  </span>
                  {entry.appliable && (
                    <button type="button" className="subtle-button" disabled={busy || exporting} onClick={() => void applyKept(entry)}>套用</button>
                  )}
                  {isSourceVersionArchive(entry.name) && (
                    <button type="button" className="subtle-button" disabled={busy || exporting} onClick={() => setVersionArchive(entry.name)}>查看版本</button>
                  )}
                  <a className="subtle-button backup-kept-download" href={api.keptBackupEntryUrl(entry.name)} download={entry.name}>下载</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {versionArchive && <BackupSourceVersionsPanel key={versionArchive} archive={versionArchive}
        disabled={importBusy || webDavBusy || exporting} onClose={() => setVersionArchive(null)} onBusyChange={setVersionsBusy}
        onActivated={async () => { onImported?.(); await Promise.all([loadKept(), loadSnapshots()]) }} />}
      <section className="backup-panel">
        <h2>启动快照（回滚点）</h2>
        <p className="backup-hint">
          每次启动会在服务器数据目录里留一份数据库的完整快照，只保留最近几份。
          误删书源、装坏规则之后，可以从这里挑一份"排定恢复"——恢复在你下次重启时生效，当前库会先留一份副本。
        </p>
        {snapshotsFailed && snapshots.length === 0 && (
          <p className="backup-hint" role="status">
            快照清单没取到。
            <button type="button" className="subtle-button" onClick={() => void loadSnapshots()}>再取一次</button>
          </p>
        )}
        {!snapshotsFailed && snapshots.length === 0 && (
          <p className="backup-hint">这台服务还没留下过快照（首次启动后就会有）。</p>
        )}
        {snapshots.length > 0 && (
          <ul className="backup-kept-list">
            {snapshots.map(snap => (
              <li key={snap.name}>
                <span className="backup-kept-label">{new Date(snap.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                <span className="backup-kept-meta">
                  {snap.verified ? '完整' : '校验未通过'} · {Math.max(1, Math.round(snap.bytes / 1024))} KB
                </span>
                {snap.verified && (
                  <button type="button" className="subtle-button" disabled={busy} onClick={() => void scheduleRestore(snap)}>排定恢复</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
