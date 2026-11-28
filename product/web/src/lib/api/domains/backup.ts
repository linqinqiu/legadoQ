/** 备份包导入与 kept 条目相关 API。 */
import { request, requestText, requestBlob } from '../client'
import type {
  BackupImportSummary,
  BackupImportPreview,
  BackupLibraryPolicy,
  BackupSectionId,
  BackupRestoreScheduled,
  BackupSnapshotInfo,
  KeptBackupEntry,
  BackupWebDavRequest,
  BackupWebDavEntry,
  BackupWebDavUpload,
  SourceVersionList,
  SourceVersionRequest,
  SourceVersionPreview,
  SourceVersionResult,
} from '../types'

/** 备份。 */
export const backup = {
  sourceVersions: (config: { archive: string; offset?: number; query?: string }) =>
    request<SourceVersionList>('/api/backup/source-versions/list', {
      method: 'POST', body: JSON.stringify(config),
    }),
  sourceVersionPreview: (config: SourceVersionRequest) =>
    request<SourceVersionPreview>('/api/backup/source-versions/preview', {
      method: 'POST', body: JSON.stringify(config),
    }),
  activateSourceVersion: (config: SourceVersionRequest) =>
    request<SourceVersionResult>('/api/backup/source-versions/activate', {
      method: 'POST', body: JSON.stringify(config),
    }),
  webDavList: (config: BackupWebDavRequest) => request<BackupWebDavEntry[]>('/api/backup/webdav/list', {
    method: 'POST', body: JSON.stringify(config),
  }),
  webDavUpload: (config: BackupWebDavRequest) => request<BackupWebDavUpload>('/api/backup/webdav/upload', {
    method: 'POST', body: JSON.stringify(config),
  }),
  webDavPull: (config: BackupWebDavRequest) => requestBlob('/api/backup/webdav/pull', {
    method: 'POST', body: JSON.stringify(config),
  }),
  /** 确认导入备份包，可明确选择模块；不传 sections 时保留旧客户端全量导入行为。 */
  importFile: (file: File, password?: string, sections?: BackupSectionId[], libraryPolicy?: BackupLibraryPolicy, previewToken?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (password) form.append('password', password)
    if (sections) form.append('sections', JSON.stringify(sections))
    if (libraryPolicy) form.append('libraryPolicy', JSON.stringify(libraryPolicy))
    if (previewToken) form.append('previewToken', previewToken)
    return request<BackupImportSummary>('/api/backup/import', {
      method: 'POST',
      body: form,
    })
  },
  previewFile: (file: File, password?: string, libraryPolicy?: BackupLibraryPolicy) => {
    const form = new FormData()
    form.append('file', file)
    if (password) form.append('password', password)
    if (libraryPolicy) form.append('libraryPolicy', JSON.stringify(libraryPolicy))
    return request<BackupImportPreview>('/api/backup/import?preview=true', { method: 'POST', body: form })
  },
  /** 列出备份包里没有原生归宿、但已原样收进服务器数据目录的个性化条目。 */
  listKeptEntries: () => request<KeptBackupEntry[]>('/api/backup/kept'),
  /** 取 kept 条目 URL。 */
  keptEntryUrl: (name: string) => `/api/backup/kept/${encodeURIComponent(name)}`,
  /** 取 kept 条目原文。 */
  keptEntry: async (name: string) => {
    try {
      return await requestText(`/api/backup/kept/${encodeURIComponent(name)}`)
    } catch {
      // kept 目录里没有这一条是一个可预期结果，界面要一句能看懂的话，不是底层 statusText。
      throw new Error('服务器上没有这个条目')
    }
  },
  /** 数据库快照清单（备份目录里已有的快照 + 校验状态）。 */
  listSnapshots: () => request<BackupSnapshotInfo[]>('/api/backup/snapshots'),
  /** 排定一次恢复：只写 .pending-restore 标记，下次启动开库前才真正生效。 */
  restoreSnapshot: (name: string) =>
    request<BackupRestoreScheduled>('/api/backup/snapshots/restore', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
}
