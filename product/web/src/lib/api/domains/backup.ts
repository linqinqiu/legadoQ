/** 备份包导入与 kept 条目相关 API。 */
import { request, requestText } from '../client'
import type {
  BackupImportSummary,
  BackupRestoreScheduled,
  BackupSnapshotInfo,
  KeptBackupEntry,
} from '../types'

/** 备份。 */
export const backup = {
  /** 浏览器直传手机备份包：选文件即导入，服务端读完临时文件就删。 */
  importFile: (file: File, password?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (password) form.append('password', password)
    return request<BackupImportSummary>('/api/backup/import', {
      method: 'POST',
      body: form,
    })
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
