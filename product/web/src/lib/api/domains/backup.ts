/** 备份包导入与 kept 条目相关 API。 */
import { request } from '../client'
import type {
  BackupImportSummary,
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
  keptEntry: (name: string) =>
    fetch(`/api/backup/kept/${encodeURIComponent(name)}`).then((response) =>
      response.ok ? response.text() : Promise.reject(new Error('服务器上没有这个条目')),
    ),
}
