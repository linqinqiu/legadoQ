import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import {
  aiToolGroupHint,
  aiToolGroupTitle,
  loadAiToolGroups,
  rememberToolIndex,
  saveAiToolGroups,
} from '../lib/aiToolGroups'

type ToolInfo = { id: string; group?: string; description?: string }

/**
 * 「AI 接入」里的工具组开关：决定 AI 能用哪些能力。
 *
 * 为什么要有：服务端默认按对话关键词选相关组，但"我这台机器想不想让它碰书架/规则/朗读"
 * 是用户的决定，不该由关键词猜。选择存在本机 localStorage。
 *
 * 说明必须说人话：清单里只有 `bookshelf` / `replace-rules` 这种 id，直接摆给用户等于让他猜。
 * 所以每组给中文名 + 一句"开了能做什么" + 工具条数，还能展开看这一组每个工具的描述。
 *
 * `program` 组（程序目录、tool.search/tool.call）始终可用 —— 关掉它等于把"按需发现"也关掉，
 * 所以不提供开关，只在说明里讲清。
 */
export function AiToolsSection() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [enabled, setEnabled] = useState<string[] | null>(loadAiToolGroups)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 展开看细节的那一组；同时只开一组，避免整页变成长清单。 */
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.agentManifest()
      .then(manifest => {
        if (!alive) return
        const list = (manifest.tools ?? []).map(tool => ({
          id: tool.id,
          group: tool.group,
          description: tool.description,
        }))
        setTools(list)
        rememberToolIndex(list)
      })
      .catch(() => { if (alive) setError('读不到工具清单；确认 AI 网关已启动') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  /** 组 → 该组工具条数（按组名排序，保证每次打开顺序一致）。 */
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tool of tools) {
      if (!tool.group) continue
      counts.set(tool.group, (counts.get(tool.group) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [tools])

  /** 当前选中的组：`null` = 全部启用。 */
  const selected = useMemo(() => new Set(enabled ?? groups.map(([group]) => group)), [enabled, groups])

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
          <small>
            勾掉哪一组，模型就看不到那组工具 —— 不会被告知，也无法调用。
            程序目录与工具搜索始终开着，否则它连「有哪些工具」都查不到。
          </small>
        </div>
        <button type="button" className="subtle-button" onClick={enableAll} disabled={enabled === null}>
          {enabled === null ? '全部启用' : '恢复全部'}
        </button>
      </div>
      {loading && <div className="settings-row"><div className="settings-row-main"><small>正在读取工具清单…</small></div></div>}
      {error && <div className="settings-row"><div className="settings-row-main"><small className="form-error">{error}</small></div></div>}
      {!loading && !error && groups.map(([group, count]) => {
        const open = openGroup === group
        const locked = group === 'program'
        return (
          <div className="settings-row" key={group}>
            <div className="settings-row-main">
              <strong>{aiToolGroupTitle(group)}</strong>
              <small>
                {aiToolGroupHint(group)}
                {` · ${count} 个工具`}
                {locked ? ' · 始终启用' : ''}
              </small>
              <button
                type="button"
                className="link-button ai-tool-more"
                aria-expanded={open}
                onClick={() => setOpenGroup(open ? null : group)}
              >
                {open ? '收起工具' : '看这一组有哪些工具'}
              </button>
              {open && (
                <ul className="ai-tool-detail">
                  {tools.filter(tool => tool.group === group).map(tool => (
                    <li key={tool.id}>
                      <code>{tool.id}</code>
                      {tool.description && <small>{tool.description}</small>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="subtle-button"
              aria-pressed={selected.has(group)}
              disabled={locked}
              onClick={() => toggle(group)}
            >
              {selected.has(group) ? '已启用' : '已关闭'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
