import { useEffect, useState } from 'react'
import { api, type TocRuleList } from '../lib/api'
import { Icon } from '../icons'
import { Select } from './Select'
import { toast } from './Toast'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 本地书分章规则（用户 2026-10-03：「『自定义』弹窗成了杂物间」）。
 *
 * 它原来住在「自定义」里，和皮肤挤在同一个弹窗：可这两件事毫无关系 ——
 * 皮肤是"长什么样"，分章规则是"下一本 TXT 怎么切目录"。
 * 现在它长在**导入动作旁边**（书架「导入本地」那颗按钮边上），
 * 因为人只会在准备导一本书时想起它。
 *
 * 一屏说清三件事：下一本按哪条切（默认）、哪几条参与"自动"打分（开关）、
 * 已经在读的那本用的是哪条（在它的阅读设置里换，这里改不动它）。
 *
 * 只接 `value`/`onChange` 这一条设置，不接整个 ReaderSettings：这个弹窗管不到字号与主题，
 * 接一堆用不到的字段只会让它被阅读设置的改动顺手带坏。
 */
export function TocRulesModal({
  value,
  onChange,
  onClose,
  onImport,
}: {
  value: string
  onChange: (next: string) => void
  onClose: () => void
  onImport: () => void
}) {
  useEscapeClose(onClose)
  const [rules, setRules] = useState<TocRuleList | null>(null)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    let cancelled = false
    void api.tocRules().then(list => { if (!cancelled) setRules(list) })
      .catch(error => { if (!cancelled) setFailed(error instanceof Error ? error.message : '规则表读取失败') })
    return () => { cancelled = true }
  }, [])

  /**
   * 「能不能手动选」和「要不要参与自动打分」是两件事，界面上就得分成两处：
   * 上面那颗选择器列全部（只要本机编得出正则），下面那些勾只管自动候选。
   * 混成一个开关的结果是 26 条里有 12 条在界面上根本不存在（用户 2026-10-03 报的那条）。
   */
  const options = rules?.options ?? []
  const pickable = options.filter(option => !option.broken)
  const rows = options.filter(option => !option.builtIn && option.key !== 'auto')
  const toggle = (key: string, enable: boolean) => {
    void api.toggleTocRule(key, enable)
      .then(() => api.tocRules())
      .then(setRules)
      .catch(error => toast.error(error instanceof Error ? error.message : '这条规则没开关成功'))
  }

  /**
   * 新建 / 编辑（用户 2026-10-03：「txt目录规则可新建可编辑」）。
   * `key === null` 是新建；就地展开在这一行下面，不再套一层弹窗 ——
   * 规则表本身已经在一个弹窗里了，弹窗上叠弹窗会让人不知道自己在改哪一条。
   */
  const [draft, setDraft] = useState<{ key: string | null; name: string; rule: string; example: string; enable: boolean } | null>(null)
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  const saveDraft = () => {
    if (!draft) return
    if (!draft.name.trim() || !draft.rule.trim()) {
      setFormError('名字与正则都得填：只有名字的那条规则切不出章。')
      return
    }
    setBusy(true)
    setFormError('')
    void api.saveTocRule({
      key: draft.key ?? undefined,
      name: draft.name.trim(),
      rule: draft.rule.trim(),
      example: draft.example.trim() || undefined,
      enable: draft.enable,
    })
      .then(async () => {
        setRules(await api.tocRules())
        setDraft(null)
        toast.success(draft.key ? '这条规则改好了' : '新建的规则已经能选')
      })
      .catch(error => setFormError(error instanceof Error ? error.message : '这条规则没存进去'))
      .finally(() => setBusy(false))
  }

  const removeRule = (key: string, label: string) => {
    if (!window.confirm(`删掉自己建的这条「${label}」？随包那 26 条不受影响。`)) return
    setBusy(true)
    void api.deleteTocRule(key)
      .then(async result => {
        if (!result.removed) throw new Error('这条不是本机自建的规则，删不掉')
        setRules(await api.tocRules())
        toast.success(`已删掉「${label}」`)
      })
      .catch(error => toast.error(error instanceof Error ? error.message : '这条没删掉'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m toc-rules-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="本地书分章规则">
        <header className="dialog-head toc-rules-head">
          <h2><Icon name="list" /> 本地书分章规则</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="toc-rules-body">
          {!!failed && <p className="toc-rules-failed">{failed}</p>}
          {!rules && !failed && <p className="toc-rules-loading">正在读取规则表…</p>}

          {rules && (
            <>
              <div className="customize-field">
                <span>导入下一本 TXT 时按哪条切目录</span>
                <Select
                  ariaLabel="TXT 目录规则（默认）"
                  value={value}
                  options={pickable.map(option => ({
                    value: option.key,
                    label: option.enable || option.builtIn || option.key === 'auto' ? option.label : `${option.label}（不参与自动）`,
                    hint: option.example || undefined,
                  }))}
                  onChange={onChange}
                />
              </div>
              <div className="customize-actions">
                <button type="button" className="primary-button" onClick={onImport}>
                  按这条导入本地书
                </button>
              </div>

              <p className="customize-note">
                上面那颗列全部 {pickable.length} 条 —— 手动选一条不需要先"启用"它。
                下面这些勾只管一件事：<strong>「自动」打分时允许考虑哪几条</strong>
                （当前 {rules.enabled} / {rules.total} 条参与）。
                已经在读的那本用它当初切好的规则，在那本书的「阅读设置 → 本地书目录」里单独换。
                手机上改过启用勾选的话，到「备份包」把包导进来，在「包里收下的条目」里对 TXT 分章规则点「套用」。
              </p>

              <div className="toc-rules-head-row">
                <span>下面这些勾只管「自动」打分；名字与正则都能改</span>
                <button
                  type="button"
                  className="subtle-button"
                  disabled={busy || draft !== null}
                  onClick={() => { setFormError(''); setDraft({ key: null, name: '', rule: '', example: '', enable: true }) }}
                >
                  新建一条
                </button>
              </div>

              <div className="toc-rules-list">
                {rows.map(rule => (
                  <div key={rule.key} className={`toc-rule${rule.broken ? ' is-broken' : ''}${draft?.key === rule.key ? ' is-editing' : ''}`}>
                    <label className="toc-rule-switch">
                      <input
                        type="checkbox"
                        checked={rule.enable !== false}
                        disabled={rule.broken}
                        aria-label={`${rule.label} 参与自动选择`}
                        onChange={event => toggle(rule.key, event.target.checked)}
                      />
                      <span>自动</span>
                    </label>
                    <div className="toc-rule-main">
                      <strong>{rule.label}</strong>
                      <code title={rule.rule}>{rule.rule || '内置逐行匹配'}</code>
                      {rule.example && <small>例：{rule.example}</small>}
                      {rule.broken && <small className="toc-rule-broken">正则在本机编译不出来，选了也切不出章</small>}
                    </div>
                    <div className="toc-rule-actions">
                      <button
                        type="button"
                        className="toc-rule-btn"
                        aria-label={`编辑 ${rule.label}`}
                        title="改这条规则（改的是本机这一份，「恢复随包那份」能整张还原）"
                        disabled={busy}
                        onClick={() => {
                          setFormError('')
                          setDraft(current => (current?.key === rule.key
                            ? null
                            : { key: rule.key, name: rule.label, rule: rule.rule ?? '', example: rule.example ?? '', enable: rule.enable !== false }))
                        }}
                      >
                        <Icon name="edit" />
                      </button>
                      {!!rule.removable && (
                        <button
                          type="button"
                          className="toc-rule-btn is-danger"
                          aria-label={`删除 ${rule.label}`}
                          title="这条是自己建的，可以删"
                          disabled={busy}
                          onClick={() => removeRule(rule.key, rule.label)}
                        >
                          <Icon name="trash" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {draft && (
                  <div className="toc-rule-editor">
                    <label className="customize-field">
                      <span>名字</span>
                      <input
                        type="text"
                        value={draft.name}
                        maxLength={40}
                        placeholder="例如：第N节（自己写的）"
                        onChange={event => setDraft({ ...draft, name: event.target.value })}
                      />
                    </label>
                    <label className="customize-field">
                      <span>正则（Java 语法，按整行找章节标题）</span>
                      <textarea
                        className="customize-css"
                        rows={2}
                        spellCheck={false}
                        value={draft.rule}
                        onChange={event => setDraft({ ...draft, rule: event.target.value })}
                      />
                    </label>
                    <label className="customize-field">
                      <span>示例（可空，只是列表里给你看一眼）</span>
                      <input
                        type="text"
                        value={draft.example}
                        maxLength={60}
                        placeholder="第一节 起风了"
                        onChange={event => setDraft({ ...draft, example: event.target.value })}
                      />
                    </label>
                    <label className="toc-rule-editor-enable">
                      <input
                        type="checkbox"
                        checked={draft.enable}
                        onChange={event => setDraft({ ...draft, enable: event.target.checked })}
                      />
                      <span>参与「自动」打分</span>
                    </label>
                    {!!formError && <p className="customize-error" role="alert">{formError}</p>}
                    <div className="customize-actions">
                      <button type="button" className="primary-button" disabled={busy} onClick={saveDraft}>
                        {busy ? '正在存…' : draft.key ? '保存这一条' : '存为新的规则'}
                      </button>
                      <button type="button" className="subtle-button" disabled={busy} onClick={() => { setDraft(null); setFormError('') }}>
                        取消
                      </button>
                      <small className="customize-note">正则在本机编不出来时，服务端直接退回原因，不会存进表里。</small>
                    </div>
                  </div>
                )}
              </div>

              {rules.overridden && (
                <div className="customize-actions">
                  <button
                    type="button"
                    className="subtle-button"
                    onClick={() => {
                      // 套用是一次显式动作，就得能显式反悔：这条清掉本机那份覆盖，回到随包那 26 条
                      void api.resetTocRules()
                        .then(() => api.tocRules())
                        .then(setRules)
                        .catch(error => toast.error(error instanceof Error ? error.message : '没恢复成随包那份'))
                    }}
                  >
                    恢复成随包那份规则表
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
