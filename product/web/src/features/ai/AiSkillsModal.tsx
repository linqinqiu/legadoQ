import React, { useEffect, useState } from 'react'
import { api, type AgentPrompt, type AgentSkill, type AgentSkillInput } from '../../lib/api'
import { AiPanel } from './AiPanel'

/**
 * 「AI 技能」浮层：一段段按需注入的方法说明。
 *
 * 与提示词的分工（两处各说各的，别混成"两个输入框"）：
 * 技能管**这类任务怎么做**，只在用户的话命中关键词时进来，一次最多 3 条；
 * 提示词管**怎么说话**，默认对所有对话生效。
 *
 * 2026-11-07：技能这一侧可以直接给某条技能挂「专用提示词」—— 展开技能就能勾。
 * 底层写的是预设自己的 `tasks`（`skill:<id>`），与「AI 提示词」里那个「生效范围」
 * 是同一份数据，不另存一套关系，所以两边永远不会各说一套。
 *
 * 自带技能可以「另存为我的版本」：改完就是你在用的那一份，改坏了也能恢复。
 * 列表默认一行、正文点开才展开，与书源列表同一套紧凑习惯。
 */
export function AiSkillsModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="AI 技能" icon="book" onClose={onClose}>
      <SkillsPanel />
    </AiPanel>
  )
}

function SkillsPanel() {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  /** 全部预设：技能这边只读它们的 tasks，改的时候仍然走预设自己的保存接口。 */
  const [prompts, setPrompts] = useState<AgentPrompt[]>([])
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState('')
  const [editing, setEditing] = useState<AgentSkill | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    api.listAgentSkills()
      .then(result => { setSkills(result.skills); setLoadError('') })
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取技能失败'))
    api.listAgentPrompts()
      .then(result => setPrompts(result.prompts))
      .catch(() => setPrompts([]))
  }
  useEffect(() => { refresh() }, [])

  const remove = async (skill: AgentSkill) => {
    if (!window.confirm(`删除技能「${skill.name}」？会移到回收站，可以找回。`)) return
    try {
      await api.deleteAgentSkill(skill.id)
      if (editing?.id === skill.id) setEditing(null)
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '删除失败')
    }
  }

  const openEditor = (skill: AgentSkill | null) => {
    setEditing(skill)
    setCreating(skill === null)
  }

  return (
    <section className="ai-section">
      <h3>AI 技能</h3>
      <p className="ai-section-hint">
        技能是一段按需注入的方法说明：你的话命中关键词才进来，一次最多 3 条。
        自带的那几条可以另存为自己的版本改。
      </p>
      {loadError ? (
        <p className="customize-error" role="alert">{loadError}</p>
      ) : (
        <ul className="ai-skill-list">
          {skills.map(skill => (
            <li key={skill.id} className={`ai-skill-item${expanded === skill.id ? ' expanded' : ''}`}>
              <div className="ai-skill-main">
                <button
                  type="button"
                  className="ai-skill-name"
                  onClick={() => setExpanded(current => (current === skill.id ? '' : skill.id))}
                  title="展开/收起技能正文"
                >
                  {skill.name}
                </button>
                {skill.builtin && <span className="ai-tag ai-skill-badge">自带</span>}
                {!skill.enabled && <span className="ai-tag ai-tag-warn ai-skill-badge">已停用</span>}
                <span className="ai-skill-desc">{skill.description || '—'}</span>
                {skill.keywords.length > 0 && (
                  <span className="ai-skill-keywords">{skill.keywords.slice(0, 4).join(' / ')}</span>
                )}
              </div>
              <div className="ai-skill-actions">
                <button type="button" className="link-button" onClick={() => openEditor(skill)}>
                  {skill.builtin ? '另存为我的' : '编辑'}
                </button>
                {!skill.builtin && (
                  <button type="button" className="link-button ai-conn-del" onClick={() => void remove(skill)}>删除</button>
                )}
              </div>
              {expanded === skill.id && (
                <>
                  <pre className="ai-skill-content">{skill.content}</pre>
                  <SkillPrompts skill={skill} prompts={prompts} onChanged={next => setPrompts(next)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {(creating || editing) ? (
        <SkillForm
          key={editing?.id ?? 'new'}
          skill={editing}
          onCancel={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); refresh() }}
        />
      ) : (
        <div className="customize-actions">
          <button type="button" className="ghost-button" onClick={() => openEditor(null)}>新建技能</button>
        </div>
      )}
    </section>
  )
}

function SkillForm({ skill, onCancel, onSaved }: { skill: AgentSkill | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [keywords, setKeywords] = useState((skill?.keywords ?? []).join(','))
  const [content, setContent] = useState(skill?.content ?? '')
  const [enabled, setEnabled] = useState(skill?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !content.trim()) { setError('名称与正文都要填'); return }
    setBusy(true)
    setError('')
    const req: AgentSkillInput = {
      // 改已有条目带上同 id 覆盖；新建时不带，由服务端按名称生成。
      id: skill?.id,
      name: name.trim(),
      description: description.trim(),
      keywords: keywords.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
      content: content.trim(),
      enabled,
    }
    try {
      await api.saveAgentSkill(req)
      onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-skill-form">
      <h4>{skill ? (skill.builtin ? `另存为我的技能：${skill.name}` : `编辑技能：${skill.name}`) : '新建技能'}</h4>
      <div className="ai-field-grid">
        <label className="customize-field">
          <span>名称</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如 书源排错" />
        </label>
        <label className="customize-field">
          <span>关键词（逗号分隔，命中才注入）</span>
          <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="书源,搜不到,目录为空" />
        </label>
      </div>
      <label className="customize-field">
        <span>说明（一句话）</span>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="按「结构 → 搜索 → 目录 → 正文」定位问题" />
      </label>
      <label className="customize-field">
        <span>正文（注入给模型看，最多 4000 字）</span>
        <textarea
          rows={6}
          value={content}
          onChange={e => setContent(e.target.value.slice(0, 4000))}
          placeholder="写清先查什么、给什么格式、哪些动作必须先问。"
        />
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>启用（停用后不会被关键词命中）</span>
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

/**
 * 某条技能的「专用提示词」。
 *
 * 勾选 = 把 `skill:<id>` 加进那条预设的生效范围；取消 = 摘掉。写的是预设自己的
 * `tasks`，所以「AI 提示词」那边看到的范围会同步变 —— 一份数据，两个入口。
 *
 * 全局预设（tasks 为空）本来就对所有任务生效，这里显示成"已生效"且不可勾：
 * 让它在技能页被"勾上"会把全局改成只给这一条技能，那是另一件事，不该藏在一个勾里。
 */
function SkillPrompts({ skill, prompts, onChanged }: {
  skill: AgentSkill
  prompts: AgentPrompt[]
  onChanged: (next: AgentPrompt[]) => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const taskId = `skill:${skill.id}`

  const toggle = async (preset: AgentPrompt, on: boolean) => {
    const nextTasks = on
      ? [...preset.tasks, taskId]
      : preset.tasks.filter(task => task !== taskId)
    // 摘掉最后一个任务 = 这条预设变成"全局"，会在所有任务里注入。
    // 这不是勾选框该悄悄做的事，先问一句。
    if (!on && nextTasks.length === 0
      && !window.confirm(`「${preset.name}」不再挂任何任务，会变成全局提示词（所有任务都注入）。继续？`)) return
    setBusy(preset.id)
    setError('')
    try {
      const saved = await api.saveAgentPrompt({
        id: preset.id,
        name: preset.name,
        instruction: preset.instruction,
        enabled: preset.enabled,
        order: preset.order,
        tasks: nextTasks,
      })
      onChanged(prompts.map(item => (item.id === saved.id ? saved : item)))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  if (prompts.length === 0) {
    return (
      <div className="ai-skill-prompts">
        <p className="ai-section-hint">还没有提示词预设。到「AI 提示词」里新建一条，再回来勾。</p>
      </div>
    )
  }

  return (
    <div className="ai-skill-prompts">
      <div className="ai-skill-prompts-head">
        <strong>专用提示词</strong>
        <span className="ai-section-hint">只在命中本技能时额外注入；全局预设本来就生效。</span>
      </div>
      <div className="ai-skill-prompts-list">
        {prompts.map(preset => {
          const global = preset.tasks.length === 0
          const mine = preset.tasks.includes(taskId)
          const elsewhere = !global && !mine
          return (
            <label key={preset.id} className="ai-check">
              <input
                type="checkbox"
                checked={global || mine}
                disabled={global || busy === preset.id}
                onChange={event => void toggle(preset, event.target.checked)}
              />
              <span>
                {preset.name}
                {global && '（全局）'}
                {elsewhere && '（其他任务专用）'}
                {!preset.enabled && '（已停用）'}
              </span>
            </label>
          )
        })}
      </div>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
    </div>
  )
}
