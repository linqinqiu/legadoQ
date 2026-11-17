import React, { useEffect, useState } from 'react'
import { api, type AgentPrompt, type AgentPromptInput, type AgentTaskModel } from '../../lib/api'
import { AiPanel } from './AiPanel'

/**
 * 「AI 提示词」浮层：管"怎么说话"的要求（语气、字数、格式），可开关可排序。
 *
 * 与技能的分工（这一句必须留在界面上，否则两者会被当成两个一样的输入框）：
 * 提示词默认**每次对话都生效**、按顺序注入；技能只在命中关键词时进来、一次最多 3 条。
 *
 * 2026-11-07：预设可以只挂到某个任务上（对话 / 摘要 / 某条技能），于是"摘要用这套语气、
 * 书源排错用那套"成立。不勾任务 = 全局，与老条目完全一样，不需要迁移。
 *
 * 一份清单一次最多注入 6000 字：装不下的**整条不注入**，也**不回报成"已注入"** ——
 * 界面说"用了 4 条"而模型只看到 3 条，人会对着那 3 条查半天。
 */
export function AiPromptsModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="AI 提示词" icon="edit" onClose={onClose}>
      <PromptsPanel />
    </AiPanel>
  )
}

/** 把一条预设原样折成保存请求（同 id 覆盖）；停用与排序都只改其中一个字段。 */
function toPromptInput(preset: AgentPrompt): AgentPromptInput {
  return {
    id: preset.id,
    name: preset.name,
    instruction: preset.instruction,
    enabled: preset.enabled,
    order: preset.order,
    // 停用 / 上移下移都走这条：不带上 tasks 就会把"只给某个任务"洗成全局。
    tasks: preset.tasks,
  }
}

/** 生效范围的显示名：任务 id 换成界面上的中文名，认不出的原样显示。 */
function scopeLabel(tasks: string[], options: AgentTaskModel[]): string {
  if (tasks.length === 0) return '全局'
  return tasks.map(task => options.find(o => o.task === task)?.label ?? task).join(' · ')
}

function PromptsPanel() {
  const [prompts, setPrompts] = useState<AgentPrompt[]>([])
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState('')
  const [editing, setEditing] = useState<AgentPrompt | null>(null)
  const [creating, setCreating] = useState(false)
  /** 任务清单（对话 / 摘要 / 每条技能）—— 与「按任务选模型」共用同一份定义，不在这儿另起一套。 */
  const [taskOptions, setTaskOptions] = useState<AgentTaskModel[]>([])

  const refresh = () => {
    api.listAgentPrompts()
      .then(result => { setPrompts(result.prompts); setLoadError('') })
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取提示词失败'))
  }
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    api.listAgentTaskModels().then(result => setTaskOptions(result.tasks)).catch(() => setTaskOptions([]))
  }, [])

  const remove = async (preset: AgentPrompt) => {
    if (!window.confirm(`删除提示词「${preset.name}」？删除前会先备份整份清单，可以找回。`)) return
    try {
      await api.deleteAgentPrompt(preset.id)
      if (editing?.id === preset.id) setEditing(null)
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '删除失败')
    }
  }

  /** 停用/启用：只改 enabled，其余字段原样回存（同 id 覆盖）。 */
  const toggle = async (preset: AgentPrompt) => {
    try {
      await api.saveAgentPrompt({ ...toPromptInput(preset), enabled: !preset.enabled })
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '切换失败')
    }
  }

  /**
   * 上移/下移：与相邻那条交换 order。
   * 交换而不是重算全部序号：预设最多 30 条，一次只改两条最省请求。
   * 两条 order 相同（列表靠名称决胜）时，给被移动的那条让出一个空位（上移减一、下移加一），
   * 否则换了也看不出来。
   *
   * **必须一条一条发**：服务端这份文件是「读 → 改 → 写」，两条并发请求会各自读到
   * 旧快照再整份写回，后落盘的那条把先落盘的顶掉（实测点一次上移，两条 order 变成同一个数）。
   * 服务端已加写锁兜底，这里仍按顺序发 —— 少一处竞态就少一处要解释的行为。
   */
  const move = async (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= prompts.length) return
    const a = prompts[index]
    const b = prompts[target]
    const orderForA = a.order === b.order ? b.order + delta : b.order
    try {
      await api.saveAgentPrompt({ ...toPromptInput(a), order: orderForA })
      await api.saveAgentPrompt({ ...toPromptInput(b), order: a.order })
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '调整顺序失败')
      refresh()
    }
  }

  return (
    <section className="ai-section">
      <h3>AI 提示词</h3>
      <p className="ai-section-hint">
        提示词管「怎么说话」：语气、字数、格式这类要求，启用的默认每次对话都带上，越靠前越先生效。
        也可以只给某个任务（摘要、某条技能），互不干扰。技能不一样 —— 技能是「这类任务怎么做」，只在命中关键词时才进来。
        单条最长 2000 字，一次对话总共最长 6000 字，装不下的整条不带。
      </p>
      {loadError ? (
        <p className="customize-error" role="alert">{loadError}</p>
      ) : (
        <ul className="ai-skill-list">
          {prompts.map((preset, index) => (
            <li key={preset.id} className={`ai-skill-item${expanded === preset.id ? ' expanded' : ''}`}>
              <div className="ai-skill-main">
                <button
                  type="button"
                  className="ai-skill-name"
                  onClick={() => setExpanded(current => (current === preset.id ? '' : preset.id))}
                  title="展开/收起提示词正文"
                >
                  {preset.name}
                </button>
                {!preset.enabled && <span className="ai-tag ai-tag-warn ai-skill-badge">已停用</span>}
                {preset.tasks.length > 0 && <span className="ai-tag ai-skill-badge">{scopeLabel(preset.tasks, taskOptions)}</span>}
                <span className="ai-skill-desc">{preset.instruction}</span>
              </div>
              <div className="ai-skill-actions">
                <button type="button" className="link-button" onClick={() => void toggle(preset)}>
                  {preset.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="link-button" onClick={() => void move(index, -1)} disabled={index === 0}>
                  上移
                </button>
                <button type="button" className="link-button" onClick={() => void move(index, 1)} disabled={index === prompts.length - 1}>
                  下移
                </button>
                <button type="button" className="link-button" onClick={() => { setEditing(preset); setCreating(false) }}>编辑</button>
                <button type="button" className="link-button ai-conn-del" onClick={() => void remove(preset)}>删除</button>
              </div>
              {expanded === preset.id && <pre className="ai-skill-content">{preset.instruction}</pre>}
            </li>
          ))}
        </ul>
      )}
      {(creating || editing) ? (
        <PromptForm
          key={editing?.id ?? 'new'}
          preset={editing}
          taskOptions={taskOptions}
          onCancel={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); refresh() }}
        />
      ) : (
        <div className="customize-actions">
          <button type="button" className="ghost-button" onClick={() => { setEditing(null); setCreating(true) }}>新建提示词</button>
        </div>
      )}
    </section>
  )
}

function PromptForm({ preset, taskOptions, onCancel, onSaved }: {
  preset: AgentPrompt | null
  taskOptions: AgentTaskModel[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(preset?.name ?? '')
  const [instruction, setInstruction] = useState(preset?.instruction ?? '')
  const [enabled, setEnabled] = useState(preset?.enabled ?? true)
  /** 空数组 = 全局。勾哪个就只对哪个任务生效。 */
  const [tasks, setTasks] = useState<string[]>(preset?.tasks ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !instruction.trim()) { setError('名称与正文都要填'); return }
    setBusy(true)
    setError('')
    const req: AgentPromptInput = {
      // 改已有条目时带上 id 覆盖；新建时不带，由服务端按名称生成。
      id: preset?.id,
      name: name.trim(),
      instruction: instruction.trim(),
      enabled,
      // order 只在改已有条目时回传，新建交给服务端排到末尾。
      ...(preset ? { order: preset.order } : {}),
      tasks,
    }
    try {
      await api.saveAgentPrompt(req)
      onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-skill-form">
      <h4>{preset ? `编辑提示词：${preset.name}` : '新建提示词'}</h4>
      <label className="customize-field">
        <span>名称</span>
        <input value={name} onChange={e => setName(e.target.value.slice(0, 60))} placeholder="如 结论先行" />
      </label>
      <label className="customize-field">
        <span>正文（注入给模型看，最多 2000 字）</span>
        <textarea
          rows={5}
          value={instruction}
          onChange={e => setInstruction(e.target.value.slice(0, 2000))}
          placeholder="例：先给结论，再给理由；不超过 100 字；不要用列表。"
        />
      </label>
      <fieldset className="ai-task-scope">
        <legend>生效范围</legend>
        <p className="ai-section-hint">不勾 = 所有任务都注入（全局语气）；勾了就只在选中的任务里注入。</p>
        <div className="ai-task-scope-list">
          {taskOptions.map(option => (
            <label key={option.task} className="ai-check">
              <input
                type="checkbox"
                checked={tasks.includes(option.task)}
                onChange={() => setTasks(current => (
                  current.includes(option.task)
                    ? current.filter(task => task !== option.task)
                    : [...current, option.task]
                ))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="ai-check">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>启用（停用的留在列表里，但不注入）</span>
      </label>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>取消</button>
      </div>
    </div>
  )
}
