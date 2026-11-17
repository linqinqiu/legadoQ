import React, { useEffect, useState } from 'react'
import { api, type AgentMcpServer } from '../../lib/api'
import { AiPanel } from './AiPanel'

/**
 * 「外部工具（MCP）」浮层：接上别的程序暴露的工具，让 AI 能调。
 *
 * 为什么单独一档：MCP 服务是**用户自己起的进程**（文件系统、git、数据库、内部系统…），
 * 与"连哪个模型"完全无关 —— 混在模型连接里，改一个地址会让人以为换了模型。
 *
 * 三条与后端一致的约定，界面上必须说清，否则用户会以为坏了：
 * - **保存即连接**：点保存就握手一次，成功显示「N 个工具」，失败直接把原因摆出来；
 * - **默认关**：工具挂进 `mcp` 组，但不下发给模型，模型得先用工具搜索找到再用。
 *   想让它直接看见，去「AI 工具」里把这一组打开；
 * - **地址只放行本机与公网**：私网段（192.168./10./172.16.）会被服务端拒绝，
 *   与"AI 连接不许打内网"同一条口径，这里不另开一道门。
 *
 * 请求头的值不回传（服务端只给名字）：那里面通常就是 token，界面不该再显示一遍。
 */
export function AiMcpModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="外部工具（MCP）" icon="globe" onClose={onClose}>
      <McpPanel />
    </AiPanel>
  )
}

export function McpPanel() {
  const [servers, setServers] = useState<AgentMcpServer[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  /** 可选鉴权头：值只在提交时用一次，不回填、不展示。 */
  const [headerName, setHeaderName] = useState('Authorization')
  const [headerValue, setHeaderValue] = useState('')
  /** 正在改哪一台；`null` = 新建。改的时候不回填请求头（服务端也不回传值）。 */
  const [editingId, setEditingId] = useState<string | null>(null)

  const adopt = (list: AgentMcpServer[]) => setServers(list)

  const refresh = () => {
    setLoading(true)
    api.listAgentMcp()
      .then(res => adopt(res.servers ?? []))
      .catch(err => setError(err instanceof Error ? err.message : '读取 MCP 服务失败'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { refresh() }, [])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setUrl('')
    setHeaderValue('')
  }

  const startEdit = (server: AgentMcpServer) => {
    setEditingId(server.id)
    setName(server.name)
    setUrl(server.url)
    setHeaderValue('')
    setError('')
  }

  const submit = async () => {
    if (!name.trim() || !url.trim()) {
      setError('服务名与地址都要填')
      return
    }
    setBusy('save')
    setError('')
    try {
      const headers: Record<string, string> = {}
      if (headerName.trim() && headerValue.trim()) headers[headerName.trim()] = headerValue.trim()
      const saved = await api.saveAgentMcp({
        ...(editingId ? { id: editingId } : {}),
        name: name.trim(),
        url: url.trim(),
        // 没填就**整个字段都不发**：服务端把"不传 headers"当作"沿用原值"。
        // 传一个空对象等于"清空鉴权头"，用户只是改个名字就会把 token 弄丢。
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      })
      adopt([...servers.filter(item => item.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id)))
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const toggle = async (server: AgentMcpServer) => {
    setBusy(server.id)
    setError('')
    try {
      const saved = await api.saveAgentMcp({
        id: server.id,
        name: server.name,
        url: server.url,
        enabled: !server.enabled,
      })
      adopt(servers.map(item => (item.id === saved.id ? saved : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换失败')
    } finally {
      setBusy('')
    }
  }

  const remove = async (server: AgentMcpServer) => {
    setBusy(server.id)
    setError('')
    try {
      await api.deleteAgentMcp(server.id)
      adopt(servers.filter(item => item.id !== server.id))
      // 删掉的正是正在编辑的那台：表单要退回"新建"，否则下一次保存会带着一个不存在的 id。
      if (editingId === server.id) resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy('')
    }
  }

  const refreshAll = async () => {
    setBusy('refresh')
    setError('')
    try {
      const res = await api.refreshAgentMcp()
      adopt(res.servers ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <section className="ai-section">
        <h3>MCP 服务</h3>
        <p className="ai-section-hint">
          接上你本机跑着的 MCP 服务，它暴露的工具就会成为 AI 的能力。
          工具挂在「AI 工具」的「外部工具」一档里，默认关着 —— 模型要先用工具搜索找到再用。
          只接受 http(s) 地址，私网段会被拒绝。
        </p>
        {error && <p className="customize-error" role="alert">{error}</p>}
        <div className="settings-row">
          <div className="settings-row-main">
            <strong>全部重连</strong>
            <small>服务重启过、或上次保存时它还没起来，点这里重新握手并拉一遍工具清单。</small>
          </div>
          <button
            type="button"
            className="subtle-button"
            disabled={busy === 'refresh' || servers.length === 0}
            onClick={() => void refreshAll()}
          >
            {busy === 'refresh' ? '重连中…' : '刷新'}
          </button>
        </div>

        {loading && <p className="ai-muted">正在读取…</p>}
        {!loading && servers.length === 0 && (
          <p className="ai-muted">还没有接任何服务。下面填一个地址就能试。</p>
        )}
        {servers.length > 0 && (
          <ul className="ai-task-list">
            {servers.map(server => (
              <li key={server.id} className="ai-task-item">
                <div className="ai-task-head">
                  <strong>{server.name}</strong>
                  {server.enabled
                    ? (server.ok
                      ? <span className="ai-tag ai-tag-ok">已连接 · {server.toolCount} 个工具</span>
                      : <span className="ai-tag ai-tag-warn">未连接</span>)
                    : <span className="ai-tag">已停用</span>}
                </div>
                <div className="ai-mcp-meta">
                  <code>{server.url}</code>
                  <small>
                    id {server.id}
                    {server.headerNames.length > 0 ? ` · 请求头 ${server.headerNames.join('、')}` : ''}
                  </small>
                </div>
                {server.enabled && !server.ok && server.error && (
                  <p className="ai-mcp-error" role="status">{server.error}</p>
                )}
                <div className="ai-task-fields">
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy === server.id}
                    onClick={() => startEdit(server)}
                  >编辑</button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy === server.id}
                    onClick={() => void toggle(server)}
                  >{server.enabled ? '停用' : '启用'}</button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy === server.id}
                    onClick={() => void remove(server)}
                  >删除</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ai-section">
        <h3>{editingId ? '改这一台' : '接一个新的'}</h3>
        <p className="ai-section-hint">
          地址就是那个服务的 MCP 端点，通常长这样：<code>http://127.0.0.1:3001/mcp</code>。
          {editingId ? '请求头留空 = 保持原来的，不会被清掉。' : ''}
        </p>
        <div className="ai-task-fields">
          <input
            aria-label="服务名"
            placeholder="服务名，如 本地文件"
            value={name}
            onChange={event => setName(event.target.value)}
          />
          <input
            aria-label="服务地址"
            placeholder="http://127.0.0.1:3001/mcp"
            value={url}
            onChange={event => setUrl(event.target.value)}
          />
        </div>
        <div className="ai-task-fields">
          <input
            aria-label="请求头名称"
            placeholder="Authorization（可留空）"
            value={headerName}
            onChange={event => setHeaderName(event.target.value)}
          />
          <input
            aria-label="请求头内容"
            type="password"
            placeholder="Bearer …（可留空，保存后不再显示）"
            value={headerValue}
            onChange={event => setHeaderValue(event.target.value)}
          />
        </div>
        <div className="ai-task-fields">
          <button
            type="button"
            className="primary-button"
            disabled={busy === 'save'}
            onClick={() => void submit()}
          >{busy === 'save' ? '连接中…' : (editingId ? '保存并重连' : '保存并连接')}</button>
          {editingId && (
            <button type="button" className="link-button" onClick={resetForm}>取消</button>
          )}
        </div>
      </section>
    </>
  )
}
