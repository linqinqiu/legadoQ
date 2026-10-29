import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import {
  aiToolGroupHint,
  aiToolGroupTitle,
  loadAiToolPrefs,
  rememberToolIndex,
  saveAiToolPrefs,
  type AiToolPrefs,
} from '../lib/aiToolGroups'

type ToolInfo = { id: string; group?: string; description?: string }

/**
 * 「AI 接入」里的工具开关：决定 AI 能用哪些能力，两级 —— 组开关 + 组内逐项停用。
 *
 * 为什么要有：服务端默认按对话关键词选相关组，但"我这台机器想不想让它碰书架/规则/朗读"
 * 是用户的决定，不该由关键词猜。选择存在本机 localStorage。
 *
 * 逐项停用是组开关之上的一层（借自 refgd 的 `aiEnabledToolNames`）：一组里常常只有一两条
 * 是不想放的，比如"朗读整组我要，但不想让它自己建会话"。只有组级开关时用户只能整组关掉，
 * 于是把想要的也一起牺牲掉。
 *
 * 说明必须说人话：清单里只有 `bookshelf` / `replace-rules` 这种 id，直接摆给用户等于让他猜。
 * 所以每组给中文名 + 一句"开了能做什么" + 工具条数，还能展开看这一组每个工具的描述。
 *
 * `program` 组（程序目录、tool.search/tool.call）始终可用 —— 关掉它等于把"按需发现"也关掉，
 * 所以不提供组开关，也不给逐项复选框。
 */
export function AiToolsSection() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [prefs, setPrefs] = useState<AiToolPrefs>(loadAiToolPrefs)
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

  const enabled = prefs.groups
  const disabled = useMemo(() => new Set(prefs.disabledTools), [prefs.disabledTools])
  /** 当前选中的组：`null` = 全部启用。 */
  const selected = useMemo(() => new Set(enabled ?? groups.map(([group]) => group)), [enabled, groups])

  /** 写偏好并落盘（两个开关共用这一条出口，避免哪边忘了保存）。 */
  const commit = (next: AiToolPrefs) => {
    setPrefs(next)
    saveAiToolPrefs(next)
  }

  const toggle = (group: string) => {
    const next = new Set(selected)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    // 全选等于"不限制"，存 null，避免以后新增组被旧列表挡住。
    const value = next.size >= groups.length ? null : [...next]
    // 只改组这一项：逐项停用是另一个决定，不能顺手清掉。
    commit({ groups: value, disabledTools: prefs.disabledTools })
  }

  const toggleTool = (toolId: string) => {
    const next = new Set(disabled)
    if (next.has(toolId)) next.delete(toolId)
    else next.add(toolId)
    commit({ groups: prefs.groups, disabledTools: [...next] })
  }

  const enableAll = () => { commit({ groups: null, disabledTools: [] }) }

  return (
    <div className="settings-rows">
      <div className="settings-row">
        <div className="settings-row-main">
          <strong>AI 工具组</strong>
          <small>
            勾掉哪一组，模型就看不到那组工具 —— 不会被告知，也无法调用。
            展开一组还能逐个停用：只想去掉其中一两条时，不必把整组关掉。
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
        const groupOn = selected.has(group)
        const groupTools = tools.filter(tool => tool.group === group)
        const offCount = groupTools.filter(tool => disabled.has(tool.id)).length
        return (
          <div className="settings-row" key={group}>
            <div className="settings-row-main">
              <strong>{aiToolGroupTitle(group)}</strong>
              <small>
                {aiToolGroupHint(group)}
                {` · ${count} 个工具`}
                {locked ? ' · 始终启用' : ''}
                {!locked && offCount > 0 ? ` · 已停用 ${offCount} 个` : ''}
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
                  {groupTools.map(tool => (
                    <li key={tool.id}>
                      {locked ? (
                        // program 组豁免：停用它等于把"我能做什么"这张地图撤走，
                        // 后果不是少一个能力而是整条按需发现失效，所以这里不放复选框。
                        <small>始终可用</small>
                      ) : (
                        <label className="rule-checkbox-label">
                          <input
                            type="checkbox"
                            checked={!disabled.has(tool.id)}
                            disabled={!groupOn}
                            onChange={() => toggleTool(tool.id)}
                            aria-label={`启用 ${tool.id}`}
                          />
                        </label>
                      )}
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
              aria-pressed={groupOn}
              disabled={locked}
              onClick={() => toggle(group)}
            >
              {groupOn ? '已启用' : '已关闭'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
