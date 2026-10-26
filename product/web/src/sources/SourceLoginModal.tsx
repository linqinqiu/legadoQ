import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api, ExternalLoginStatus, SourceBrowserCookies, SourceLoginUiItem, SourceLoginUiResponse } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { Select } from '../components/Select'
import { SourceWebViewModal } from './SourceWebViewModal'

interface SourceLoginModalProps {
  sourceId: string
  sourceName: string
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/** 「填写表单」值不值得推荐：loginUi 里得有真的可填控件，只有一个「打开登录网页」按钮时不该推荐。 */
function hasFillableControl(items: SourceLoginUiItem[]): boolean {
  return items.some(item => !['button', 'label', 'textlabel'].includes((item.type || 'text').toLowerCase()))
}

/** 输入框里可能填 `https://x.com/path` 也可能只填 `x.com`，取主机部分去和罐子里的键对。 */
function hostOfInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/^[a-z]+:\/\//i, '').split('/')[0].split('?')[0].toLowerCase()
}

/** 说清楚"保存会发生什么"：同名键覆盖、其它键保留（上游 `CookieStore.replaceCookie` 就是这个语义）。 */
function cookieHint(hosts: string[], chosen: string, jar: SourceBrowserCookies | null): string {
  const preview = hosts.slice(0, 6).join(' 、 ') || '（未从书源配置中识别到主机）'
  if (!chosen) return `这本书源实际会访问：${preview}`
  const host = hostOfInput(chosen)
  // 罐子按**注册域**归桶（`probe-c-login.example` 而不是 `reader.probe-c-login.example`），
  // 所以不能拿完整主机名去精确取键 —— 那样永远查不到，界面就会对着已有凭据的域说"还没有 Cookie"。
  const bucketKey = Object.keys(jar?.cookies ?? {}).find(d => host === d || host.endsWith(`.${d}`))
  const existing = (bucketKey ? jar?.cookies[bucketKey] ?? '' : '').split(';').map(item => item.trim()).filter(Boolean).length
  if (existing) return `${bucketKey === host ? host : `${host}（归在 ${bucketKey} 桶）`} 已存 ${existing} 项：保存是按键合并，同名键被新值覆盖、其它键保留`
  return `${host} 还没有 Cookie，保存后新建一条。这本书源实际会访问：${preview}`
}

export const SourceLoginModal: React.FC<SourceLoginModalProps> = ({
  sourceId,
  sourceName,
  onClose,
  onToast,
}) => {
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [uiResponse, setUiResponse] = useState<SourceLoginUiResponse | null>(null)
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [headerEditOpen, setHeaderEditOpen] = useState(false)
  const [headerEditText, setHeaderEditText] = useState('')
  const [cookieInputText, setCookieInputText] = useState('')
  /** 粘贴的 Cookie 要落到哪个域名/地址：默认取书源自己的登录域，而不是书源主域。 */
  const [cookieDomain, setCookieDomain] = useState('')
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({})
  const [webViewOpen, setWebViewOpen] = useState(false)
  const [webViewStartUrl, setWebViewStartUrl] = useState<string | undefined>(undefined)
  /** 触发内置浏览器的登录动作，登录完成后需要带 Cookie 重跑一次 */
  const pendingBrowserActionRef = useRef<string | null>(null)
  /** 当前选择的登录方式；null 表示还没按书源能力自动选过。 */
  const [method, setMethod] = useState<'form' | 'browser' | 'external' | 'cookie' | 'bookmark' | null>(null)
  /** 真浏览器登录：服务端拉起的本机 Chromium 状态。 */
  const [external, setExternal] = useState<ExternalLoginStatus | null>(null)
  /**
   * 本轮抓取真正入库了哪些域，单独存一份。
   * 状态轮询（每 2.5 秒）回包里并没有 stored 字段，若把它并进 external，
   * 抓取结果会在两秒内被冲成空 —— 用户刚点完「抓取并入库」，界面却说没入库。
   */
  const [externalStored, setExternalStored] = useState<string[]>([])
  const [externalBusy, setExternalBusy] = useState(false)
  const [status, setStatus] = useState<{ loggedIn: boolean; hasCredential?: boolean; verified?: boolean; message?: string } | null>(null)
  /** 库里到底存了什么 Cookie：按域名分组，登录是否"留下了东西"必须能核对，不能只看一句结论 */
  const [jar, setJar] = useState<SourceBrowserCookies | null>(null)
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null)
  const userPickedRef = useRef(false)

  const refreshExternal = useCallback(async () => {
    try {
      setExternal(await api.externalLoginStatus(sourceId))
    } catch {
      /* 读不到状态就维持原样：这里不报错，避免把「浏览器已关」渲染成一次失败 */
    }
  }, [sourceId])

  // 浏览器活着的时候每 2.5 秒问一次：用户在窗口里登录完，这边要能看到「这个域已经有 Cookie 了」。
  useEffect(() => {
    if (!external?.opened) return
    const timer = window.setInterval(() => void refreshExternal(), 2500)
    return () => window.clearInterval(timer)
  }, [external?.opened, refreshExternal])

  const handleExternalStart = useCallback(async () => {
    setExternalBusy(true)
    try {
      const res = await api.externalLoginStart(sourceId, uiResponse?.loginUrl)
      setExternal(res)
      setExternalStored([])
      onToast(res.opened ? `已用 ${res.browser || '本机浏览器'} 打开登录页，请在弹出的窗口里登录` : '没能打开浏览器', res.opened ? 'success' : 'error')
    } catch (error) {
      onToast(`启动真浏览器失败：${(error as Error).message}`, 'error')
    } finally {
      setExternalBusy(false)
    }
  }, [onToast, sourceId, uiResponse?.loginUrl])

  const handleExternalCapture = useCallback(async () => {
    setExternalBusy(true)
    try {
      const res = await api.externalLoginCapture(sourceId)
      setExternal(res)
      setExternalStored(res.stored)
      setJar(await api.sourceBrowserCookies(sourceId))
      onToast(
        res.stored.length > 0 ? `已自动入库 ${res.stored.length} 个域的凭据：${res.stored.join('、')}` : '目标域上还没有 Cookie —— 通常是还没在弹出的窗口里登录',
        res.stored.length > 0 ? 'success' : 'info',
      )
    } catch (error) {
      onToast(`抓取失败：${(error as Error).message}`, 'error')
    } finally {
      setExternalBusy(false)
    }
  }, [onToast, sourceId])

  const handleExternalStop = useCallback(async () => {
    setExternalBusy(true)
    try {
      await api.externalLoginStop(sourceId)
      setExternalStored([])
      setExternal(await api.externalLoginStatus(sourceId))
    } catch {
      /* 关不掉就交给下一轮 status 说话 */
    } finally {
      setExternalBusy(false)
    }
  }, [sourceId])

  const loadLoginUi = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api.getSourceLoginUi(sourceId)
      setUiResponse(res)
      setHeaderEditText(res.loginHeader || '')
      const initialData: Record<string, string> = { ...(res.loginInfo || {}) }
      res.loginUi.forEach(item => {
        const key = item.key || item.name
        if (key && initialData[key] === undefined && item.default) {
          initialData[key] = item.default
        }
      })
      setFormData(initialData)
      // 拉一次登录判定 + 库里实际存了什么，让头部状态与凭据明细一致
      const [check, cookies] = await Promise.all([
        api.checkSourceLogin(sourceId).catch(() => null),
        api.sourceBrowserCookies(sourceId).catch(() => null),
      ])
      setStatus(check)
      setJar(cookies)
      setCookieDomain(current => current || (res.cookieDomains ?? [])[0] || '')
      // 用户没手动切过分段时，按书源能力自动选推荐方式。
      // 「表单」只有真的有待填字段才值得推荐：不少源的 loginUi 就一个「打开登录网页」按钮，
      // 推荐它等于把用户领到一个没有输入框的页面。
      if (!userPickedRef.current) {
        setMethod(hasFillableControl(res.loginUi) ? 'form' : res.loginUrl ? 'browser' : 'cookie')
      }
    } catch (err: any) {
      onToast(err.message || '获取登录界面失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [sourceId, onToast])

  useEffect(() => {
    loadLoginUi()
  }, [loadLoginUi])

  // Esc 一次只关一层：登录头编辑 → 内置浏览器 → 凭据菜单 → 登录浮层本身。
  // 全站其它浮层都吃 Esc，这个浮层以前不吃，键盘用户只能点 ✕。
  useEscapeClose(() => {
    if (headerEditOpen) { setHeaderEditOpen(false); return }
    if (webViewOpen) { setWebViewOpen(false); return }
    if (menuOpen) { setMenuOpen(false); return }
    onClose()
  })

  /** 用户手动打开内置浏览器（不带触发动作），入口地址交给书源配置决定 */
  const openBuiltInBrowser = useCallback(() => {
    pendingBrowserActionRef.current = null
    setWebViewStartUrl(undefined)
    setWebViewOpen(true)
  }, [])

  const bookmarkletCode = useMemo(() => {
    const serverOrigin = window.location.origin
    const targetSourceId = encodeURIComponent(sourceId)
    return `javascript:(function(){var c=document.cookie;var u=location.href;if(!c){alert('当前页面没有可读到的 Cookie');return;}fetch('${serverOrigin}/api/sources/${targetSourceId}/login-cookie',{method:'POST',mode:'cors',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:c,url:u})}).then(function(r){return r.text().then(function(t){return{ok:r.ok,status:r.status,body:t}})}).then(function(x){if(!x.ok){var m='';try{var j=JSON.parse(x.body);m=j.message||j.error||''}catch(e){}alert('同步失败：'+(m||('HTTP '+x.status)));return}alert('已把当前站点的 Cookie 同步进 legadoQ')}).catch(function(e){alert('同步失败：'+e)});})();`
  }, [sourceId])

  const handleInputChange = (key: string, val: string) => {
    setFormData(prev => ({ ...prev, [key]: val }))
  }

  const handleAction = async (actionCode?: string, isLongClick = false, allowBuiltInBrowser = true, browserCompleted = false) => {
    if (!actionCode && actionCode !== '') return
    try {
      setExecuting(true)
      const trimmed = actionCode.trim()
      if (!browserCompleted && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
        window.open(trimmed, '_blank', 'noopener,noreferrer')
        return
      }

      const res = await api.executeSourceLoginAction(sourceId, actionCode, formData, isLongClick, browserCompleted)
      if (res.error) {
        // 书源脚本失败时必须显式告知，否则按钮会「看起来成功但毫无反应」
        onToast(`书源脚本执行失败：${res.error}`, 'error')
      } else if (res.toastMessages && res.toastMessages.length > 0) {
        res.toastMessages.forEach(msg => onToast(msg, res.success ? 'success' : 'info'))
      } else if (res.success) {
        onToast('操作执行成功', 'success')
      }

      if (res.openUrl) {
        // 书源 JS 通过 java.startBrowserAwait(url) 请求打开网页：在本应用内置浏览器中打开，
        // 而不是弹到外部标签页，这样登录产生的 Cookie 能直接落到书源 Credential 里。
        if (allowBuiltInBrowser) {
          pendingBrowserActionRef.current = actionCode
          setWebViewStartUrl(res.openUrl)
          setWebViewOpen(true)
        } else {
          window.open(res.openUrl, '_blank', 'noopener,noreferrer')
        }
      }
      if (res.copyText) {
        await navigator.clipboard.writeText(res.copyText)
        onToast(`已复制到剪贴板: ${res.copyText}`, 'info')
      }
      if (res.updatedLoginInfo) {
        setFormData(prev => ({ ...prev, ...res.updatedLoginInfo }))
      }
      if (res.reRenderUi) {
        await loadLoginUi()
      }
    } catch (err: any) {
      onToast(err.message || '执行操作失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleSaveAndLogin = async () => {
    try {
      setExecuting(true)
      await api.saveSourceLoginInfo(sourceId, formData)
      const res = await api.executeSourceLoginAction(sourceId, 'login(true)', formData, false)
      if (res.error) {
        onToast(`书源脚本执行失败：${res.error}`, 'error')
      } else if (res.toastMessages && res.toastMessages.length > 0) {
        res.toastMessages.forEach(msg => onToast(msg, res.success ? 'success' : 'info'))
      } else {
        onToast('登录信息已保存并尝试登录', 'success')
      }
      if (res.openUrl) {
        pendingBrowserActionRef.current = 'login(true)'
        setWebViewStartUrl(res.openUrl)
        setWebViewOpen(true)
      }
      if (res.copyText) {
        await navigator.clipboard.writeText(res.copyText)
      }
      if (res.updatedLoginInfo) {
        setFormData(prev => ({ ...prev, ...res.updatedLoginInfo }))
      }
      if (res.reRenderUi) {
        await loadLoginUi()
      }
    } catch (err: any) {
      onToast(err.message || '保存或登录失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleCopyLoginHeader = async () => {
    const header = uiResponse?.loginHeader
    if (!header) {
      onToast('当前书源无登录头', 'info')
      return
    }
    await navigator.clipboard.writeText(header)
    onToast('登录头已复制到剪贴板', 'success')
    setMenuOpen(false)
  }

  const handleSaveHeader = async () => {
    try {
      setExecuting(true)
      await api.saveSourceLoginHeader(sourceId, headerEditText.trim())
      onToast('登录头已成功更新并保存', 'success')
      setHeaderEditOpen(false)
      await loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '保存登录头失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleSaveCookie = async () => {
    if (!cookieInputText.trim()) {
      onToast('请输入 Cookie 内容', 'error')
      return
    }
    try {
      setExecuting(true)
      await api.saveSourceCookie(sourceId, cookieInputText.trim(), cookieDomain.trim() || undefined)
      onToast('Cookie 已成功保存并关联到书源', 'success')
      setCookieInputText('')
      await loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '保存 Cookie 失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const copyJarDomain = async (domain: string, cookie: string) => {
    await navigator.clipboard.writeText(cookie)
    onToast(`${domain} 的 Cookie 已复制到剪贴板`, 'success')
  }

  const handleRemoveDomain = async (domain: string) => {
    if (!confirm(`确定删除 ${domain} 下保存的 Cookie 吗？这本书源对该站点的登录态会失效。`)) return
    try {
      setExecuting(true)
      await api.removeSourceCookie(sourceId, domain)
      if (expandedDomain === domain) setExpandedDomain(null)
      onToast(`${domain} 的 Cookie 已删除`, 'success')
      await loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '删除 Cookie 失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleDeleteLoginHeader = async () => {
    if (!confirm('确定删除此书源保存的登录头吗？')) return
    try {
      await api.clearSourceLoginHeader(sourceId)
      onToast('登录头已删除', 'success')
      setMenuOpen(false)
      loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '删除登录头失败', 'error')
    }
  }

  const handleClearLoginInfo = async () => {
    if (!confirm('确定清空此书源的所有登录输入信息吗？')) return
    try {
      await api.clearSourceLoginInfo(sourceId)
      setFormData({})
      onToast('登录信息已清空', 'success')
      setMenuOpen(false)
    } catch (err: any) {
      onToast(err.message || '清空登录信息失败', 'error')
    }
  }

  const copyBookmarklet = async () => {
    await navigator.clipboard.writeText(bookmarkletCode)
    onToast('一键抓取书签代码已复制到剪贴板', 'success')
  }

  const renderControl = (item: SourceLoginUiItem, index: number) => {
    const key = item.key || item.name
    const label = item.viewName || item.name
    const type = (item.type || 'text').toLowerCase()
    const value = formData[key] ?? ''

    const basisPercent = item.style?.layout_flexBasisPercent ?? -1
    let flexStyle: React.CSSProperties = {}
    if (basisPercent > 0) {
      if (basisPercent >= 0.9) {
        flexStyle = { flex: '1 1 100%', width: '100%' }
      } else if (basisPercent >= 0.4 && basisPercent <= 0.6) {
        flexStyle = { flex: '1 1 calc(50% - 8px)', minWidth: '180px' }
      } else {
        flexStyle = { flex: `1 1 ${Math.round(basisPercent * 100)}%` }
      }
    } else {
      flexStyle = { flex: item.style?.layout_flexGrow ? `${item.style.layout_flexGrow} 1 auto` : '1 1 100%', width: '100%' }
    }

    if (item.style?.layout_wrapBefore) {
      flexStyle.breakBefore = 'always'
    }

    if (type === 'button') {
      return (
        <div key={`${key}-${index}`} style={flexStyle}>
          <button
            type="button"
            className="source-login-btn primary-subtle"
            disabled={executing}
            onClick={() => handleAction(item.action, false)}
            onContextMenu={e => {
              e.preventDefault()
              handleAction(item.action, true)
            }}
          >
            {label}
          </button>
        </div>
      )
    }

    if (type === 'toggle' || type === 'switch' || type === 'checkbox') {
      const isChecked = value === 'true' || value === '1'
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-toggle-container">
          <label className="login-ui-toggle-label">
            <span>{label}</span>
            <input
              type="checkbox"
              checked={isChecked}
              onChange={e => handleInputChange(key, e.target.checked ? 'true' : 'false')}
            />
          </label>
        </div>
      )
    }

    if (type === 'select' || type === 'dropdown') {
      const options = item.options || (item.chars ? item.chars.filter((c): c is string => c !== null) : [])
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-field">
          <label className="login-ui-field-label">{label}</label>
          <Select
            className="login-ui-select"
            value={value}
            onChange={v => handleInputChange(key, v)}
            ariaLabel={label || '选择'}
            options={options.map(opt => ({ value: opt, label: opt }))}
          />
        </div>
      )
    }

    if (type === 'label' || type === 'textlabel') {
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-info">
          <div className="login-ui-info-text">{item.hint || item.default || label}</div>
        </div>
      )
    }

    const isPassword = type === 'password'
    const isShowing = showPasswords[key]
    return (
      <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-field">
        <label className="login-ui-field-label">{label}</label>
        <div className="login-ui-input-wrapper">
          <input
            type={isPassword && !isShowing ? 'password' : 'text'}
            className="login-ui-input"
            value={value}
            placeholder={item.hint || item.default || `请输入${label}`}
            onChange={e => handleInputChange(key, e.target.value)}
          />
          {isPassword && (
            <button
              type="button"
              className="login-ui-eye-btn"
              onClick={() => setShowPasswords(prev => ({ ...prev, [key]: !prev[key] }))}
              title={isShowing ? '隐藏密码' : '显示密码'}
            >
              <Icon name={isShowing ? 'eyeOff' : 'eye'} />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-s source-login-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="书源登录">
        <div className="dialog-head">
          <div className="source-login-title-group">
            <h3 className="source-login-title">登录 {sourceName}</h3>
            {uiResponse?.sourceVariable && (
              <span className="source-login-subtitle" title={uiResponse.sourceVariable}>
                已关联变量
              </span>
            )}
          </div>
          <div className="source-login-actions">
            <button
              type="button"
              className="source-login-action-btn"
              title="用内置浏览器登录"
              aria-label="用内置浏览器登录"
              onClick={openBuiltInBrowser}
            >
              <Icon name="globe" />
            </button>
            <button
              type="button"
              className="source-login-action-btn primary"
              title="保存并登录"
              aria-label="保存并登录"
              disabled={executing || loading}
              onClick={handleSaveAndLogin}
            >
              <Icon name="check" />
            </button>
            <div className="source-login-menu-container">
              <button
                type="button"
                className="source-login-action-btn"
                title="凭据管理"
                aria-label="凭据管理"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(prev => !prev)}
              >
                <Icon name="more" />
              </button>
              {menuOpen && (
                <div className="source-login-dropdown-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setHeaderEditText(uiResponse?.loginHeader || '')
                      setHeaderEditOpen(true)
                      setMenuOpen(false)
                    }}
                  >
                    <Icon name="edit" /> 填入 / 查看登录头
                  </button>
                  {uiResponse?.loginHeader && (
                    <button type="button" onClick={handleCopyLoginHeader}>
                      <Icon name="copy" /> 复制登录头
                    </button>
                  )}
                  <button type="button" className="danger-text" onClick={handleDeleteLoginHeader}>
                    <Icon name="trash" /> 删除登录头
                  </button>
                  <button type="button" className="danger-text" onClick={handleClearLoginInfo}>
                    <Icon name="trash" /> 清空登录信息
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="overlay-close"
              title="关闭"
              aria-label="关闭"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="source-login-body">
          {loading ? (
            <div className="login-ui-loading">正在加载登录界面…</div>
          ) : (() => {
            const hasForm = (uiResponse?.loginUi?.length ?? 0) > 0
            const hasInput = hasFillableControl(uiResponse?.loginUi ?? [])
            const hasLoginUrl = !!uiResponse?.loginUrl
            const recommended = hasInput ? 'form' : hasLoginUrl ? 'browser' : 'cookie'
            const active = method ?? recommended
            const tab = (key: 'form' | 'browser' | 'external' | 'cookie' | 'bookmark', label: string, enabled = true) => (
              <button
                key={key}
                type="button"
                className={`source-login-method-tab${active === key ? ' is-active' : ''}`}
                disabled={!enabled}
                onClick={() => { userPickedRef.current = true; setMethod(key) }}
              >
                {label}
                {recommended === key && <span className="source-login-method-recommend">推荐</span>}
              </button>
            )
            return (
              <>
                <div className="source-login-method-tabs" role="tablist">
                  {tab('form', '填写表单', hasForm)}
                  {tab('browser', '内置浏览器')}
                  {tab('external', '真浏览器')}
                  {tab('cookie', '粘贴 Cookie')}
                  {tab('bookmark', '书签同步')}
                </div>

                <div className={`source-login-status ${status?.verified ? 'is-verified' : jar?.count || uiResponse?.loginHeader ? 'is-credential' : 'is-empty'}`}>
                  {status?.verified
                    ? '登录态已验证（书源自带的校验判定通过）'
                    : jar?.count || uiResponse?.loginHeader
                      ? '已存凭据，未自动验证（这个源没写校验规则，只能靠实际读一次确认）'
                      : '还没有任何凭据'}
                </div>

                {(jar?.count ?? 0) === 0 && (
                  <p className="source-login-hint small">
                    下面列的是<b>这本书源会带出去</b>的凭据：真浏览器、内置浏览器与粘贴来的 Cookie 都按<b>注册域</b>存进同一张全局表，
                    所以同一个域（例如 fanqienovel.com）是所有访问它的书源共用一份，删掉也会影响那些书源。
                  </p>
                )}

                {/* 凭据明细：光给一句「已捕获」不可核对（实测番茄那条其实是 hm.baidu.com 的统计 Cookie）。
                    按域名摊开、能看能单域删除，才谈得上"我到底登没登上"。 */}
                {(jar?.count ?? 0) > 0 && (
                  <div className="source-login-jar">
                    {jar!.domains.map(domain => {
                      const pairs = (jar!.cookies[domain] || '').split(';').map(x => x.trim()).filter(Boolean)
                      const open = expandedDomain === domain
                      return (
                        <div key={domain} className="source-login-jar-row">
                          <button
                            type="button"
                            className="source-login-jar-toggle"
                            aria-expanded={open}
                            title={open ? '收起这条 Cookie' : '展开看这条 Cookie 的键值'}
                            onClick={() => setExpandedDomain(open ? null : domain)}
                          >
                            <span className="source-login-jar-domain">{domain}</span>
                            <span className="source-login-jar-count">{pairs.length} 项</span>
                            <Icon name="chevronDown" />
                          </button>
                          <button
                            type="button"
                            className="subtle-button source-login-jar-copy"
                            title="复制该域名下的完整 Cookie"
                            aria-label={`复制 ${domain} 的 Cookie`}
                            onClick={() => void copyJarDomain(domain, jar!.cookies[domain] || '')}
                          >
                            <Icon name="copy" />
                          </button>
                          <button
                            type="button"
                            className="subtle-button source-login-jar-del"
                            title={`删除 ${domain} 下保存的 Cookie`}
                            aria-label={`删除 ${domain} 的 Cookie`}
                            onClick={() => void handleRemoveDomain(domain)}
                          >
                            <Icon name="trash" />
                          </button>
                          {open && (
                            <div className="source-login-jar-detail">
                              {pairs.map(pair => {
                                const split = pair.indexOf('=')
                                const name = split > 0 ? pair.slice(0, split) : pair
                                const value = split > 0 ? pair.slice(split + 1) : ''
                                return <code key={pair}>{name}={value.length > 12 ? `${value.slice(0, 12)}…` : value}</code>
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {active === 'form' && (hasForm ? (
                  <form
                    className="source-login-flex-form"
                    onSubmit={e => { e.preventDefault(); handleSaveAndLogin() }}
                  >
                    {uiResponse!.loginUi.map((item, idx) => renderControl(item, idx))}
                    {/* 上游只在真有表单时才给「确定」：只有一个「打开登录网页」按钮时，
                        摆一个全宽的"保存并登录"等于骗用户点一个什么都不做的按钮 */}
                    {hasInput && (
                      <div style={{ flex: '1 1 100%', width: '100%', marginTop: 6 }}>
                        <button type="submit" className="primary-button" style={{ width: '100%' }} disabled={executing}>
                          {executing ? '登录中…' : '保存并登录'}
                        </button>
                      </div>
                    )}
                  </form>
                ) : (
                  <p className="source-login-hint">此书源未提供可视化登录表单，请改用「内置浏览器」或「粘贴 Cookie」方式。</p>
                ))}

                {active === 'browser' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      {uiResponse?.loginIsScript
                        ? '这本书源的登录地址由它自己的脚本决定（loginUrl 是整段登录 JS）。点下面的按钮会执行脚本，由它请求打开真正的登录页；登录完成后站点写回的 Cookie 会按域名收进书源凭据罐。'
                        : '在内置浏览器中打开该书源登录页完成登录，站点的 Set-Cookie 会被服务端自动收进书源 Cookie 罐。对纯前端渲染 / 风控站点（番茄、起点等）常无效，此时请改用「粘贴 Cookie」。'}
                    </p>
                    {uiResponse?.loginUrl && !uiResponse.loginIsScript && (
                      <div className="source-login-url-line">{uiResponse.loginUrl}</div>
                    )}
                    <button type="button" className="primary-button" disabled={!hasLoginUrl} onClick={openBuiltInBrowser} style={{ alignSelf: 'flex-start' }}>
                      打开内置浏览器登录
                    </button>
                    {!hasLoginUrl && <p className="source-login-hint small">此书源未配置 loginUrl，无法用内置浏览器登录。</p>}
                  </div>
                )}

                {/* 真浏览器：内嵌浏览器把页面关在 opaque origin 沙箱里，番茄这类站点自己的风控脚本
                    跑不起来（实测 forms:0 fields:0）；这里交给本机真 Chromium 窗口，登录完由服务端
                    经 CDP 自动回读该域 Cookie —— 含 HttpOnly，书签方式取不到那种。 */}
                {active === 'external' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      由服务端在你这台机器上打开一个<b>真正的浏览器窗口</b>（Chrome / Edge），用它自己的引擎跑该书源的登录页 ——
                      扫码、账号密码、站点风控脚本都照常。你在窗口里登录完成后点「抓取并入库」，服务端会读回那个域
                      的 Cookie（<b>含 HttpOnly</b>，所以不需要你手工复制粘贴），按域名分别存进凭据罐。
                    </p>
                    <p className="source-login-hint small">
                      这个窗口用的是独立且持久的登录档，<b>不会</b>动你日常浏览器的资料；第一次要在里面登一遍，之后登录档会留着。
                      另外它也无法直接读你已经开着的那个浏览器 —— 没带调试端口启动的实例，任何本地程序都贴不上去，这是浏览器自身的边界。
                    </p>
                    <div className={`source-login-status ${external?.opened ? 'is-credential' : 'is-empty'}`}>
                      {external?.opened
                        ? `已打开 ${external.browser || '浏览器'}（进程 ${external.pid}），等你在窗口里登录`
                        : '还没打开浏览器'}
                      {(external?.seen.length ?? 0) > 0 && ` · 已见到凭据：${external!.seen.join('、')}`}
                      {externalStored.length > 0 && ` · 本轮入库：${externalStored.join('、')}`}
                    </div>
                    <div className="source-login-external-actions">
                      <button type="button" className="primary-button" disabled={externalBusy} onClick={() => void handleExternalStart()}>
                        {externalBusy ? '处理中…' : '打开真浏览器登录'}
                      </button>
                      <button type="button" className="subtle-button" disabled={externalBusy || !external?.opened} onClick={() => void handleExternalCapture()}>
                        抓取并入库
                      </button>
                      <button type="button" className="subtle-button" disabled={!external?.opened} onClick={() => void handleExternalStop()}>
                        关闭浏览器
                      </button>
                    </div>
                    <p className="source-login-hint small">
                      要打开的地址：{uiResponse?.loginUrl && !uiResponse.loginIsScript ? uiResponse.loginUrl : uiResponse?.loginUrl ? '由该书源脚本决定（loginUrl 是整段 JS），将退到它的主页' : '此书源没配 loginUrl，将打开它的主页'}
                    </p>
                  </div>
                )}

                {active === 'cookie' && (
                  <div className="source-login-panel">
                    <div className="direct-cookie-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>粘贴 Cookie / Token（支持 JSON / 键值对）</label>
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>支持 Cookie-Editor 导出的 JSON</span>
                      </div>
                      {/* 凭据必须落在"请求真正打到的那个域名"上。番茄官方接口直连源就是典型：
                          书源主域是代理站，而需要登录的书架接口在 fanqienovel.com。 */}
                      <label className="login-ui-field-label" htmlFor="cookie-domain">这份 Cookie 属于哪个站点</label>
                      <input
                        id="cookie-domain"
                        className="login-ui-input"
                        list="cookie-domain-options"
                        value={cookieDomain}
                        onChange={e => setCookieDomain(e.target.value)}
                        placeholder="https://fanqienovel.com/ 或 fanqienovel.com"
                      />
                      <datalist id="cookie-domain-options">
                        {(uiResponse?.cookieDomains ?? []).map(domain => <option key={domain} value={domain} />)}
                      </datalist>
                      <div className="source-login-hint small">
                        {cookieHint(uiResponse?.cookieDomains ?? [], cookieDomain.trim(), jar)}
                      </div>
                      <textarea
                        className="source-login-textarea"
                        rows={5}
                        value={cookieInputText}
                        placeholder={'直接粘贴 Cookie 字符串（k1=v1; k2=v2）或 Cookie-Editor 导出的 JSON 数组：\n[{"name":"sessionid","value":"…"},{"name":"token","value":"…"}]'}
                        onChange={e => setCookieInputText(e.target.value)}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        {uiResponse?.loginHeader && (
                          <button type="button" className="subtle-button danger-text" onClick={handleDeleteLoginHeader}>删除登录头</button>
                        )}
                        <button type="button" className="primary-button" disabled={executing || !cookieInputText.trim()} onClick={handleSaveCookie}>
                          {executing ? '保存中…' : '保存 Cookie'}
                        </button>
                      </div>
                    </div>
                    {uiResponse?.loginHeader && (
                      <div className="source-login-header-preview">
                        <div className="source-login-header-preview-title">当前书源已持久化登录头</div>
                        <div className="source-login-header-preview-body">{uiResponse.loginHeader}</div>
                      </div>
                    )}
                  </div>
                )}

                {active === 'bookmark' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      在新标签页打开目标网站并登录后，在书签栏点一下此书签，即可把当前站点 Cookie 秒级回传到 legadoQ。
                    </p>
                    <ol className="source-login-bookmark-steps">
                      <li>复制下方代码（或点「复制书签代码」）；</li>
                      <li>浏览器书签栏新建书签，网址处粘贴该代码；</li>
                      <li>在网站登录完成后，点击该书签即可回传。</li>
                    </ol>
                    <textarea className="source-login-textarea" rows={4} readOnly value={bookmarkletCode} style={{ fontSize: '11px', fontFamily: 'monospace' }} onFocus={e => e.currentTarget.select()} />
                    <button type="button" className="primary-button" onClick={copyBookmarklet} style={{ alignSelf: 'flex-start' }}>复制书签代码</button>
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {headerEditOpen && (
          <div className="overlay-backdrop is-topped" onClick={() => setHeaderEditOpen(false)}>
            <div className="dialog-shell size-s source-login-dialog" role="dialog" aria-modal="true" aria-label="编辑登录请求头" onClick={e => e.stopPropagation()}>
              <div className="dialog-head">
                <h3>编辑 / 填入登录头 (Login Header)</h3>
                <button type="button" className="overlay-close" onClick={() => setHeaderEditOpen(false)} aria-label="关闭"><Icon name="close" /></button>
              </div>
              <div className="source-login-body" style={{ padding: '16px' }}>
                <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--muted)' }}>
                  支持 JSON 格式（如 <code>{`{"Authorization": "Bearer ...", "Cookie": "..."}`}</code>）或直接文本。
                </p>
                <textarea
                  className="source-login-textarea"
                  rows={6}
                  value={headerEditText}
                  placeholder='{"Authorization": "Bearer ...", "Cookie": "..."}'
                  onChange={e => setHeaderEditText(e.target.value)}
                />
              </div>
              <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="subtle-button" onClick={() => setHeaderEditOpen(false)}>取消</button>
                <button type="button" className="primary-button" disabled={executing} onClick={handleSaveHeader}>保存登录头</button>
              </div>
            </div>
          </div>
        )}
        {webViewOpen && (
          <SourceWebViewModal
            sourceId={sourceId}
            sourceName={sourceName}
            startUrl={webViewStartUrl}
            onClose={() => setWebViewOpen(false)}
            onToast={onToast}
            onNeedOtherMethod={() => {
              setWebViewOpen(false)
              userPickedRef.current = true
              setMethod('cookie')
            }}
            onLoggedIn={async () => {
              await loadLoginUi()
              // 内置浏览器登录完，带着已落库的 Cookie 重跑当初触发浏览器的动作。
              // browserCompleted=true 让服务端把 `startBrowserAwait` 的返回体填成它自己抓到的页面，
              // 否则脚本里 `r.body` 永远是空串，登录等于只做了一半。
              const pending = pendingBrowserActionRef.current
              if (pending) {
                pendingBrowserActionRef.current = null
                await handleAction(pending, false, false, true)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}
