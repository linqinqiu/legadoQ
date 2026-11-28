import React, { useState } from 'react'
import { backup } from '../../lib/api/domains/backup'
import type { BackupWebDavEntry, BackupWebDavRequest } from '../../lib/api/types'
import { toast } from '../../components/Toast'

/** Request-scoped credentials: deliberately no localStorage, server config or auto-sync. */
export function BackupWebDavPanel({ disabled, onFile, onBusyChange }: {
  disabled: boolean
  onFile: (file: File) => Promise<boolean>
  onBusyChange: (busy: boolean) => void
}) {
  const [config, setConfig] = useState<BackupWebDavRequest>({ url: '', username: '', password: '' })
  const [entries, setEntries] = useState<BackupWebDavEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const update = (key: 'url' | 'username' | 'password', value: string) => {
    setConfig(previous => ({ ...previous, [key]: value }))
    setEntries([]); setLoaded(false); setMessage('')
  }
  const run = async (action: 'list' | 'upload' | 'pull', name?: string) => {
    if (working || disabled || !config.url.trim()) return
    setWorking(true); onBusyChange(true); setMessage('')
    try {
      if (action === 'list') {
        setEntries(await backup.webDavList(config)); setLoaded(true)
        setMessage('目录已刷新；只显示本产品生成的迁移包。')
      } else if (action === 'upload') {
        const result = await backup.webDavUpload(config)
        if (!result.verified) throw new Error('远端尚未通过回读校验，请刷新列表核对')
        setEntries([]); setLoaded(false)
        setMessage(`上传完成并通过远端回读校验：${result.name}；请刷新远端列表查看。`)
        toast.success('迁移包已上传，远端字节校验通过')
      } else if (name) {
        const blob = await backup.webDavPull({ ...config, name })
        if (!await onFile(new File([blob], name, { type: 'application/zip' }))) {
          throw new Error('迁移包已拉取，但预览失败；请查看导入区提示，尚未恢复数据。')
        }
        setMessage('已拉取并提交预览；请在导入区核对结果，勾选模块后再确认。')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'WebDAV 操作失败')
      if (action === 'list') { setEntries([]); setLoaded(false) }
    } finally { setWorking(false); onBusyChange(false) }
  }
  const blocked = disabled || working
  return <section className="backup-panel backup-webdav" aria-label="手动 WebDAV 迁移">
    <h2>手动 WebDAV 迁移</h2>
    <p className="backup-hint">手动上传含留档的迁移包，或从远端拉取后预览。当前支持公网 HTTPS WebDAV，暂不支持本机或 NAS 私网直连；不会自动同步或自动恢复。</p>
    <fieldset disabled={blocked}>
      <label>WebDAV 目录地址<input type="url" autoComplete="off" placeholder="https://dav.example.com/legadoq/" value={config.url} onChange={event => update('url', event.target.value)} /></label>
      <label>WebDAV 用户名<input autoComplete="off" value={config.username} onChange={event => update('username', event.target.value)} /></label>
      <label>WebDAV 密码<input type="password" autoComplete="new-password" value={config.password} onChange={event => update('password', event.target.value)} /></label>
      <div className="backup-actions">
        <button className="subtle-button" type="button" disabled={!config.url.trim()} onClick={() => void run('list')}>刷新远端列表</button>
        <button className="primary-button" type="button" disabled={!config.url.trim()} onClick={() => void run('upload')}>上传迁移包并校验</button>
        <button className="subtle-button" type="button" onClick={() => { setConfig({ url: '', username: '', password: '' }); setEntries([]); setLoaded(false); setMessage('') }}>清空连接信息</button>
      </div>
    </fieldset>
    <p className="backup-hint">请先创建远端目录。账号密码仅用于当次请求，不在应用中保存；关闭页面后需重新填写。上传含留档文件，可能包含私密配置；最多 64 MiB。失败时远端可能留有文件，请刷新列表核对。哈希用于发现损坏，不能认证备份来源。</p>
    {working && <p role="status" className="backup-hint">正在传输或校验，请等待完成…</p>}
    {message && <p role="status" className="backup-hint">{message}</p>}
    {loaded && entries.length === 0 && <p className="backup-hint">该目录没有可列出的迁移包。</p>}
    {entries.length > 0 && <ul className="backup-kept-list">{entries.map(entry => <li key={entry.name}>
      <span className="backup-webdav-name">{entry.name}</span>
      <span className="backup-kept-meta">{entry.bytes == null ? '大小未知' : `${Math.ceil(entry.bytes / 1024)} KB`}</span>
      <button type="button" className="subtle-button" disabled={blocked} onClick={() => void run('pull', entry.name)}>拉取并预览</button>
    </li>)}</ul>}
  </section>
}
