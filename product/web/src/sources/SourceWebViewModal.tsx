import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'


interface SourceWebViewModalProps {
  sourceId: string
  sourceName: string
  /** 书源 JS 通过 java.startBrowserAwait(url) 指定的入口地址，优先于书源配置的 loginUrl */
  startUrl?: string
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
  onLoggedIn?: () => void
  /** 反代浏览器帮不上时（纯前端渲染/风控站点），请求切回其它登录方式。 */
  onNeedOtherMethod?: () => void
}

type NavState = { list: string[]; index: number }

/** 被代理页面回报的登录控件现场：谁挡住了点击、有没有落在视口外。 */
type LoginTarget = {
  text: string
  box: number[]
  inView: boolean
  blocked: boolean
  blocker: string
}

type WebviewDiagnostics = {
  forms: number
  fields: number
  scripts: number
  storage: string
  viewport: number[]
  targets: LoginTarget[]
  errors: string[]
}

/**
 * 内置登录浏览器（网页版 WebView）。
 *
 * 目标站点由服务端整站反向代理到本服务路径下，因此可以安全地放进 iframe：
 * - iframe 故意**不开启 allow-same-origin**，被代理页面的 JS 无法触碰本应用的 DOM；
 * - 代理端点用一次性令牌鉴权，不依赖管理会话 Cookie；
 * - 目标站点的 Set-Cookie 会被服务端吸收进书源 Cookie jar，登录成功即刻生效。
 */
export const SourceWebViewModal: React.FC<SourceWebViewModalProps> = ({
  sourceId,
  sourceName,
  startUrl: startUrlOverride,
  onClose,
  onToast,
  onLoggedIn,
  onNeedOtherMethod,
}) => {
  const [token, setToken] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [navTarget, setNavTarget] = useState('')
  const [inlineKey, setInlineKey] = useState('')
  const [navSeq, setNavSeq] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nav, setNav] = useState<NavState>({ list: [], index: -1 })
  const [cookieCount, setCookieCount] = useState<number | null>(null)
  /** 登录判定：unknown 未查 / none 无凭据 / credential 有凭据未验证 / verified 已验证通过。 */
  const [loginStatus, setLoginStatus] = useState<'unknown' | 'none' | 'credential' | 'verified'>('unknown')
  /** 「登录控件点不到」需连续多次诊断都命中才告警，去除同意弹层等瞬态误报。 */
  const blockedStreakRef = useRef(0)
  const diagSeqRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  /** 被代理页面自己回报的可用性：有没有表单、站方 JS 有没有因为沙箱报错。 */
  const [diagnostics, setDiagnostics] = useState<WebviewDiagnostics | null>(null)
  const tokenRef = useRef('')

  // 建立代理会话
  useEffect(() => {
    let cancelled = false
    const open = async () => {
      try {
        const session = await api.createSourceBrowserSession(sourceId, startUrlOverride)
        if (cancelled) return
        tokenRef.current = session.token
        setToken(session.token)
        setStartUrl(session.startUrl)
        if (session.inlineOnly) {
          // 书源脚本生成的自包含页面（教程 / 更新 / 设置中心）：由服务端解码托管，
          // 直接把上萬字符的数据地址塞进 iframe 会触发请求行 8192 上限。
          const { key } = await api.registerSourceBrowserInline(sourceId, session.token, (startUrlOverride ?? '').trim())
          if (cancelled) return
          setInlineKey(key)
          setAddressDraft('内置页面（由书源脚本生成）')
          setNav({ list: ['内置页面'], index: 0 })
        } else {
          setNavTarget(session.startUrl)
          setAddressDraft(session.startUrl)
          setNav({ list: [session.startUrl], index: 0 })
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '无法打开内置浏览器')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void open()
    return () => {
      cancelled = true
      if (tokenRef.current) void api.closeSourceBrowserSession(sourceId, tokenRef.current).catch(() => undefined)
    }
  }, [sourceId, startUrlOverride])

  // 监听被代理页面回报的地址变化，用于地址栏与前进/后退
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string
        type?: string
        url?: string
        forms?: number
        fields?: number
        scripts?: number
        storage?: string
        viewport?: number[]
        targets?: LoginTarget[]
        errors?: string[]
      } | null
      if (!data || data.source !== 'legado-webview') return
      if (data.type === 'diagnostics') {
        const next: WebviewDiagnostics = {
          forms: Number(data.forms ?? 0),
          fields: Number(data.fields ?? 0),
          scripts: Number(data.scripts ?? 0),
          storage: String(data.storage ?? ''),
          viewport: Array.isArray(data.viewport) ? data.viewport.map(Number) : [],
          targets: Array.isArray(data.targets) ? data.targets.slice(0, 8) : [],
          errors: Array.isArray(data.errors) ? data.errors.slice(0, 4) : [],
        }
        setDiagnostics(next)
        diagSeqRef.current += 1
        const unreachableNow = next.targets.some(t => t.blocked || !t.inView)
        blockedStreakRef.current = unreachableNow ? blockedStreakRef.current + 1 : 0
        return
      }
      if (data.type !== 'navigated') return
      const url = typeof data.url === 'string' ? data.url : ''
      if (!url) return
      setDiagnostics(null)
      blockedStreakRef.current = 0
      diagSeqRef.current = 0
      setNav(prev => {
        if (prev.list[prev.index] === url) return prev
        const list = prev.list.slice(0, prev.index + 1)
        list.push(url)
        return { list, index: list.length - 1 }
      })
      setAddressDraft(url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const refreshLoginStatus = useCallback(async () => {
    try {
      const status = await api.checkSourceLogin(sourceId)
      setLoginStatus(status.verified ? 'verified' : (status.hasCredential || status.loggedIn) ? 'credential' : 'none')
    } catch {
      /* 轮询失败保持上一次状态，不打断浏览 */
    }
  }, [sourceId])

  const refreshCookies = useCallback(async () => {
    try {
      const result = await api.sourceBrowserCookies(sourceId)
      setCookieCount(result.count)
      return result.count
    } catch {
      return null
    }
  }, [sourceId])

  // 只要会话在，就持续轮询 cookie 数与登录判定：SPA 登录常走 fetch/XHR（命中的是 /res 代理，
  // 后端已 harvest cookie），但不触发 iframe 导航，若只在导航时刷新一次，徽标就永远停在旧值。
  useEffect(() => {
    if (!token) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      await refreshCookies()
      await refreshLoginStatus()
    }
    void tick()
    const timer = setInterval(() => void tick(), 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [token, refreshCookies, refreshLoginStatus])

  const pageSrc = useMemo(() => {
    if (!token) return ''
    if (inlineKey) return api.sourceBrowserInlineUrl(sourceId, token, inlineKey)
    return navTarget ? api.sourceBrowserPageUrl(sourceId, token, navTarget) : ''
  }, [sourceId, token, navTarget, inlineKey])

  const navigate = useCallback(
    (url: string) => {
      if (!url) return
      setLoading(true)
      setInlineKey('')
      setNavTarget(url)
      setAddressDraft(url)
      setNavSeq(seq => seq + 1)
    },
    [],
  )

  const canGoBack = nav.index > 0
  const canGoForward = nav.index >= 0 && nav.index < nav.list.length - 1

  const handleCheckLogin = async () => {
    setBusy(true)
    try {
      const count = await refreshCookies()
      const status = await api.checkSourceLogin(sourceId)
      const state = status.verified ? 'verified' : (status.hasCredential || status.loggedIn) ? 'credential' : 'none'
      setLoginStatus(state)
      if (state === 'verified') {
        onToast('登录已验证通过', 'success')
        onLoggedIn?.()
        setTimeout(onClose, 600)
      } else if (state === 'credential') {
        // 抓到凭据 ≠ 登录成功：如实说明未验证，避免"看起来成功却搜不到"的误导，也不自动关窗。
        onToast(`已捕获 ${count ?? 0} 个域名的 Cookie，但未能自动验证登录态。若搜索仍无结果，请改用「填写登录表单」或「粘贴 Cookie / 书签同步」。`, 'info')
        onLoggedIn?.()
      } else {
        onToast('尚未检测到登录凭据，请在页面里完成登录后重试', 'info')
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : '检查登录状态失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const submitAddress = (event: React.FormEvent) => {
    event.preventDefault()
    const value = addressDraft.trim()
    if (!value) return
    navigate(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  }

  const unreachableTargets = (diagnostics?.targets ?? []).filter(t => t.blocked || !t.inView)
  // 「点不到」要连续多次诊断都命中才算真问题：同意弹层/遮罩常常一闪即过，单次快照会误报。
  const persistentBlocked = blockedStreakRef.current >= 2 && unreachableTargets.length > 0
  // 「没有表单」只有在已经反复探测过多份诊断之后仍什么都没有时才成立，避免 SPA 首屏未挂载就误判。
  const noFormAtAll = !!diagnostics && diagSeqRef.current >= 4 && diagnostics.forms === 0 && diagnostics.fields === 0
  const footnoteWarning = persistentBlocked || noFormAtAll

  const statusPill =
    loginStatus === 'verified'
      ? { cls: 'is-verified', text: '已登录（已验证）' }
      : loginStatus === 'credential'
        ? { cls: 'is-credential', text: `已捕获 ${cookieCount ?? 0} 域 · 待验证` }
        : loginStatus === 'none'
          ? { cls: 'is-none', text: '未检测到登录凭据' }
          : { cls: 'is-unknown', text: cookieCount !== null ? `已捕获 ${cookieCount} 域` : '检测中' }

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop is-flush" onClick={onClose}>
      <div className="dialog-shell is-fullscreen source-webview-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="内置浏览器">
        <div className="source-webview-toolbar">
          <div className="source-webview-nav-group">
            <button
              type="button"
              className="source-webview-icon-btn"
              title="后退"
              aria-label="后退"
              disabled={!canGoBack}
              onClick={() => canGoBack && navigate(nav.list[nav.index - 1])}
            >
              <Icon name="arrowLeft" />
            </button>
            <button
              type="button"
              className="source-webview-icon-btn"
              title="前进"
              aria-label="前进"
              disabled={!canGoForward}
              onClick={() => canGoForward && navigate(nav.list[nav.index + 1])}
            >
              <Icon name="arrowRight" />
            </button>
            <button
              type="button"
              className="source-webview-icon-btn"
              title="刷新"
              aria-label="刷新"
              disabled={!token}
              onClick={() => {
                setLoading(true)
                setNavSeq(seq => seq + 1)
              }}
            >
              <Icon name="refresh" />
            </button>
            <button
              type="button"
              className="source-webview-icon-btn"
              title="回到登录页"
              aria-label="回到登录页"
              disabled={!startUrl}
              onClick={() => navigate(startUrl)}
            >
              <Icon name="home" />
            </button>
          </div>

          <form className="source-webview-address-form" onSubmit={submitAddress}>
            <input
              className="source-webview-address"
              value={addressDraft}
              spellCheck={false}
              onChange={e => setAddressDraft(e.target.value)}
              placeholder="输入该书源站点内的网址"
            />
          </form>

          <div className="source-webview-actions">
            <span className={`source-webview-status-pill ${statusPill.cls}`} title={cookieCount !== null ? `已捕获 Cookie 域名数：${cookieCount}` : '正在检测登录状态'}>
              {statusPill.text}
            </span>
            <button
              type="button"
              className="source-webview-icon-btn"
              title="在新标签页打开"
              aria-label="在新标签页打开"
              disabled={!pageSrc}
              onClick={() => pageSrc && window.open(pageSrc, '_blank', 'noopener,noreferrer')}
            >
              <Icon name="external" />
            </button>
            <button
              type="button"
              className="primary-button source-webview-login-btn"
              disabled={busy || !token}
              onClick={handleCheckLogin}
            >
              {busy ? '检测中…' : '登录完成'}
            </button>
            <button type="button" className="source-webview-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="source-webview-body">
          {error ? (
            <div className="source-webview-placeholder">
              <div className="source-webview-placeholder-title">无法打开内置浏览器</div>
              <div className="source-webview-placeholder-text">{error}</div>
              <div className="source-webview-placeholder-text">
                可在书源中补全 <code>loginUrl</code> 后重试，或改用「快捷填入 Cookie」「同步书签」两种方式。
              </div>
            </div>
          ) : (
            <>
              {loading && <div className="source-webview-loading">正在打开 {sourceName} ...</div>}
              {pageSrc && (
                <iframe
                  key={navSeq}
                  className="source-webview-frame"
                  title={`${sourceName} 登录`}
                  src={pageSrc}
                  sandbox="allow-forms allow-scripts allow-popups allow-modals allow-downloads"
                  referrerPolicy="no-referrer"
                  onLoad={() => setLoading(false)}
                />
              )}
            </>
          )}
        </div>

        <div className={`source-webview-footnote${footnoteWarning ? ' is-warning' : ''}`}>
          <div className="source-webview-footnote-text">
            {persistentBlocked ? (
              <>
                <strong>登录控件疑似被遮挡。</strong>
                「{unreachableTargets.slice(0, 2).map(t => t.text).join('」「')}」
                {unreachableTargets[0]?.blocked ? `可能被 ${unreachableTargets[0].blocker || '一个覆盖层'} 挡住` : '在视口外'}。可滚动页面或换种方式登录。
              </>
            ) : noFormAtAll ? (
              <>
                <strong>这页可能靠前端框架渲染、或需先登录。</strong>
                内置浏览器对这类站点（番茄、起点等）常帮不上，建议换用「填写登录表单」或「粘贴 Cookie / 书签同步」。
              </>
            ) : (
              <>
                登录成功后 Cookie 会自动存入该书源，无需手动复制。
                {diagnostics ? `已识别 ${diagnostics.forms} 表单 / ${diagnostics.fields} 输入项${diagnostics.targets.length ? ` / ${diagnostics.targets.length} 个登录控件` : ''}。` : ''}
              </>
            )}
          </div>
          {onNeedOtherMethod && (
            <button type="button" className="subtle-button source-webview-switch-btn" onClick={onNeedOtherMethod}>
              换种方式登录
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
