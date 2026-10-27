import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { loadAiToolGroups, saveAiToolGroups } from '../lib/aiToolGroups'

/**
 * 设置页「AI 工具」分区：决定 AI 能用哪些工具组。
 *
 * 为什么要有：服务端默认按对话关键词选相关组，但"我这台机器想不想让它碰书架/规则/朗读"
 * 是用户的决定，不该由关键词猜。这里按组开关，选择存在本机 localStorage。
 *
 * `program` 组（程序目录、tool.search/tool.call）始终可用 —— 关掉它等于把"按需发现"也关掉，
 * 所以不提供开关，只在说明里讲清。
 */
export function AiToolsSection() {
  const [groups, setGroups] = useState<string[]>([])
  const [enabled, setEnabled] = useState<string[] | null>(loadAiToolGroups)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api.agentManifest()
      .then(manifest => {
        if (!alive) return
        const names = [...new Set(manifest.tools.map(tool => tool.group).filter(Boolean))].sort()
        setGroups(names)
      })
      .catch(() => { if (alive) setError('读不到工具清单；确认 AI 网关已启动') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  /** 当前选中的组：`null` = 全部启用。 */
  const selected = useMemo(() => new Set(enabled ?? groups), [enabled, groups])

  const toggle = (group: string) => {
    const next = new Set(selected)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    // 全选等于"不限制"，存 null，避免以后新增组被旧列表挡住。
    const value = next.size >= groups.length ? null : [...next]
    setEnabled(value)
    saveAiToolGroups(value)
  }

  const enableAll = () => { setEnabled(null); saveAiToolGroups(null) }

  return (
    <div className="settings-rows">
      <div className="settings-row">
        <div className="settings-row-main">
          <strong>AI 工具组</strong>
          <small>只勾选你想让 AI 使用的能力；不勾的组不会发给模型。程序目录与工具搜索始终可用。</small>
        </div>
        <button type="button" className="subtle-button" onClick={enableAll} disabled={enabled === null}>
          {enabled === null ? '全部启用' : '恢复全部'}
        </button>
      </div>
      {loading && <div className="settings-row"><div className="settings-row-main"><small>正在读取工具清单…</small></div></div>}
      {error && <div className="settings-row"><div className="settings-row-main"><small className="form-error">{error}</small></div></div>}
      {!loading && !error && groups.map(group => (
        <div className="settings-row" key={group}>
          <div className="settings-row-main">
            <strong>{group}</strong>
            <small>{group === 'program' ? '程序目录与工具搜索（始终启用）' : `这一组下的工具才会下发给 AI`}</small>
          </div>
          <button
            type="button"
            className="subtle-button"
            aria-pressed={selected.has(group)}
            disabled={group === 'program'}
            onClick={() => toggle(group)}
          >
            {selected.has(group) ? '已启用' : '已关闭'}
          </button>
        </div>
      ))}
    </div>
  )
}
