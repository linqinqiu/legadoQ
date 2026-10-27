import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { toast } from '../components/Toast'
import { useEscapeClose } from '../lib/useEscapeClose'
import {
  cookieApi,
  type GlobalCookieEntry,
  type GlobalCookieList,
} from '../lib/cookieApi'

/**
 * 设置页的「Cookie」分区：全局登录凭据（按注册域归桶）的列表、搜索、多选批量删除与编辑。
 *
 * 为什么需要这一页：凭据按注册域共享，删书源**不会**连带清桶（这是有意的 —— 同域其他源还要用），
 * 于是没有全局视图时它们就成了「看不见又删不掉」。列表接口刻意只回键名不回值，
 * 值要单独点「显示」才按域拉一条（`GET /api/cookies/detail`），避免一次列表把全部明文摊开。
 *
 * 控件全部复用设置页与登录弹层已有的类名（`.settings-rows` / `.settings-row` / `.dialog-shell` /
 * `.source-login-*`），所以这个分区不新增任何样式。
 */

/** 一批域删除之后汇总给用户的结果。 */
type DeleteSummary = { ok: number; failed: string[] }

function summarizeDelete(targets: string[], results: PromiseSettledResult<unknown>[]): DeleteSummary {
  const failed: string[] = []
  let ok = 0
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') ok += 1
    else failed.push(targets[index])
  })
  return { ok, failed }
}

/** 值还没展开时显示的占位：键名保留，值一律打码。 */
const maskKeys = (keys: string[]) => keys.map(key => `${key}=***`).join('；')

export function CookieSection() {
  const [list, setList] = useState<GlobalCookieList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** 点过「显示」的域 → 该域的凭据原文。 */
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  /** 二次确认：批量删还是删单行（删除不可逆，点一下不能就删）。 */
  const [confirming, setConfirming] = useState<{ kind: 'batch' } | { kind: 'one'; domain: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await cookieApi.list()
      setList(next)
      // 刷新后把已经不存在的域从选中集合里剔掉，否则「删除选中」会带着幽灵项
      setSelected(previous => {
        const alive = new Set(next.cookies.map(entry => entry.domain))
        return new Set([...previous].filter(domain => alive.has(domain)))
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取 Cookie 列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const entries = list?.cookies ?? []
  const needle = query.trim().toLowerCase()
  const shown = needle === ''
    ? entries
    : entries.filter(entry =>
      entry.domain.toLowerCase().includes(needle) ||
      entry.keys.some(key => key.toLowerCase().includes(needle)))
  const totalKeys = entries.reduce((sum, entry) => sum + entry.keys.length, 0)

  const toggleSelected = (domain: string) => {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  const allShownSelected = shown.length > 0 && shown.every(entry => selected.has(entry.domain))
  const toggleAllShown = () => {
    setSelected(previous => {
      const next = new Set(previous)
      if (allShownSelected) shown.forEach(entry => next.delete(entry.domain))
      else shown.forEach(entry => next.add(entry.domain))
      return next
    })
  }

  const toggleReveal = async (entry: GlobalCookieEntry) => {
    const domain = entry.domain
    if (revealed[domain] !== undefined) {
      // 收起时把明文从内存里丢掉（再点「显示」会重新拉一次），不让值常驻在页面上
      setRevealed(previous => {
        const next = { ...previous }
        delete next[domain]
        return next
      })
      return
    }
    setRevealing(previous => new Set(previous).add(domain))
    try {
      const detail = await cookieApi.detail(domain)
      setRevealed(previous => ({ ...previous, [domain]: detail.cookie }))
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : `读取 ${domain} 的凭据失败`)
    } finally {
      setRevealing(previous => {
        const next = new Set(previous)
        next.delete(domain)
        return next
      })
    }
  }

  const removeDomains = async (targets: string[]) => {
    setDeleting(true)
    try {
      const results = await Promise.allSettled(targets.map(domain => cookieApi.remove(domain)))
      const summary = summarizeDelete(targets, results)
      setConfirming(null)
      setSelected(previous => {
        const next = new Set(previous)
        targets.forEach(domain => next.delete(domain))
        return next
      })
      // 删掉的域连同已展开的值一起清掉，避免留下点不开的残留
      setRevealed(previous => {
        const next = { ...previous }
        targets.forEach(domain => delete next[domain])
        return next
      })
      await load()
      if (summary.failed.length === 0) {
        toast.success(targets.length === 1 ? `已删除 ${targets[0]} 的凭据` : `已删除 ${summary.ok} 个域的凭据`)
      } else {
        toast.error(`有 ${summary.failed.length} 个域没删掉：${summary.failed.join('、')}`)
      }
    } finally {
      setDeleting(false)
    }
  }

  /** 批量确认框要删的那批域：以「当前列表 ∩ 已选中」为准，搜索收窄后不会误删看不见的域。 */
  const confirmTargets = confirming?.kind === 'batch'
    ? shown.filter(entry => selected.has(entry.domain)).map(entry => entry.domain)
    : []

  return (
    <>
      <div className="settings-search-row">
        <input
          type="search"
          className="settings-search"
          placeholder="搜域名或 Cookie 键名"
          aria-label="搜域名或 Cookie 键名"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <small>{`共 ${entries.length} 个域 · ${totalKeys} 个键`}</small>
        <button type="button" className="subtle-button" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" />
          {loading ? '读取中…' : '刷新'}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={selected.size === 0 || deleting}
          onClick={() => setConfirming({ kind: 'batch' })}
        >
          <Icon name="trash" />
          {`删除选中${selected.size > 0 ? `（${selected.size}）` : ''}`}
        </button>
      </div>

      {error && (
        <p className="form-error">
          {`读取失败：${error}`}
          <button type="button" className="link-button" onClick={() => void load()}>重试</button>
        </p>
      )}

      {!error && loading && list === null && <p className="empty-notice">正在读取这台机器上的凭据…</p>}

      {!error && list !== null && entries.length === 0 && (
        <p className="empty-notice">还没有任何 Cookie 记录。在书源登录里粘贴或抓取过之后，这里会按域名列出来。</p>
      )}

      {!error && list !== null && entries.length > 0 && shown.length === 0 && (
        <p className="empty-notice">{`没有匹配「${query.trim()}」的域名或键名。`}</p>
      )}

      {shown.length > 0 && (
        <div className="settings-rows">
          <div className="settings-row">
            <label className="rule-checkbox-label">
              <input
                type="checkbox"
                checked={allShownSelected}
                onChange={toggleAllShown}
                aria-label={allShownSelected ? '取消全选当前列表' : '全选当前列表'}
              />
            </label>
            <div className="settings-row-main">
              <strong>{allShownSelected ? '取消全选' : '全选当前列表'}</strong>
              <small>{`列表里 ${shown.length} 个域，已选中 ${selected.size} 个。删除会清掉该域的全部 Cookie，对所有用到它的书源同时生效。`}</small>
            </div>
          </div>

          {confirming?.kind === 'batch' && (
            <div className="settings-row">
              <div className="settings-row-main">
                <strong>{`确认删除选中的 ${confirmTargets.length} 个域？`}</strong>
                <small>删除不可撤销；该域上的全部 Cookie 会被清掉，用到它的书源会立刻失去登录态。</small>
              </div>
              <button type="button" className="link-button" disabled={deleting} onClick={() => setConfirming(null)}>取消</button>
              <button type="button" className="danger-button" disabled={deleting || confirmTargets.length === 0} onClick={() => void removeDomains(confirmTargets)}>
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          )}

          {shown.map(entry => {
            const domain = entry.domain
            const value = revealed[domain]
            const isRevealing = revealing.has(domain)
            const isConfirming = confirming?.kind === 'one' && confirming.domain === domain
            return (
              <div key={domain} className="settings-row">
                <label className="rule-checkbox-label">
                  <input
                    type="checkbox"
                    checked={selected.has(domain)}
                    onChange={() => toggleSelected(domain)}
                    aria-label={`选择 ${domain}`}
                  />
                </label>
                <div className="settings-row-main">
                  <strong>{domain}</strong>
                  {value === undefined ? (
                    <small>{`${entry.keys.length} 个键：${maskKeys(entry.keys)} · 被 ${entry.mentionedBy} 个书源提到`}</small>
                  ) : (
                    <div className="source-login-url-line">{value}</div>
                  )}
                </div>
                {isConfirming ? (
                  <>
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>取消</button>
                    <button type="button" className="danger-button" disabled={deleting} onClick={() => void removeDomains([domain])}>
                      {deleting ? '删除中…' : '确认删除'}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="link-button" disabled={isRevealing} onClick={() => void toggleReveal(entry)}>
                      {isRevealing ? '读取中…' : value === undefined ? '显示' : '收起'}
                    </button>
                    <button type="button" className="subtle-button" onClick={() => setEditing(domain)}>
                      <Icon name="edit" />
                      编辑
                    </button>
                    <button type="button" className="danger-button" onClick={() => setConfirming({ kind: 'one', domain })}>
                      删除
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <CookieEditModal
          domain={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}

/**
 * 编辑某个域的 Cookie 串。打开时先拉这一域的原文回填（列表接口不回值）；
 * 保存走 `POST /api/cookies`，服务端按键合并 —— 同名覆盖、其余保留。
 */
function CookieEditModal({ domain, onClose, onSaved }: {
  domain: string
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeClose(onClose)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const detail = await cookieApi.detail(domain)
        if (!cancelled) setDraft(detail.cookie)
      } catch (reason) {
        // 没有凭据（404）也允许直接写一份新的，只是回填为空
        if (!cancelled) setError(reason instanceof Error ? reason.message : '读取现有凭据失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [domain])

  const save = async () => {
    const cookie = draft.trim()
    if (cookie === '') {
      setError('Cookie 不能为空；要清掉整桶请用行上的「删除」。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await cookieApi.save(`https://${domain}/`, cookie)
      toast.success(`已保存 ${result.domain} 的 Cookie（合并后 ${result.count} 个键）`)
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell" role="dialog" aria-modal="true" aria-label={`编辑 ${domain} 的 Cookie`} onClick={event => event.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>编辑 Cookie</h2>
            <small>{domain}</small>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="source-login-body" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <p className="source-login-hint">
            按 <code>k=v; k2=v2</code> 写（也接受 Cookie-Editor 导出的 JSON）。
            保存是<b>同名覆盖、其余保留</b>：这里没写到的键不会被删掉；要清掉整桶请关掉这一层用行上的「删除」。
          </p>
          {loading ? (
            <p className="empty-notice">正在读取现有凭据…</p>
          ) : (
            <textarea
              className="source-login-textarea"
              rows={6}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder={'sessionid=…; token=…'}
              aria-label="Cookie 字符串"
            />
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="source-login-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="subtle-button" onClick={onClose} disabled={saving}>取消</button>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={saving || loading}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
