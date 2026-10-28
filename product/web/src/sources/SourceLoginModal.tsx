import React, { useState, useEffect, useCallback, useRef } from 'react'
import { api, ExternalLoginStatus, SourceBrowserCookies, SourceLoginUiResponse } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

interface SourceLoginModalProps {
  sourceId: string
  sourceName: string
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
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
  /** 当前选择的登录方式；null 表示还没按书源能力自动选过。 */
  const [method, setMethod] = useState<'external' | 'cookie' | null>(null)
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

  // 切到「真浏览器」时先问一次状态：服务重启后窗口可能还开着（服务端靠 profile 里的调试端口
  // 附着回来），界面不该一上来就说「还没打开」，更不该因此把「抓取并入库」禁用掉。
  useEffect(() => {
    if (method === 'external') void refreshExternal()
  }, [method, refreshExternal])

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
      // 抓取的同时重判一次登录态：有 loginCheckJs 的源会当场从「未验证」变成「已验证」；
      // 没有校验规则的源（番茄就是）仍然如实显示"有凭据、未验证"，不假装。
      const [nextJar, check] = await Promise.all([
        api.sourceBrowserCookies(sourceId),
        api.checkSourceLogin(sourceId).catch(() => null),
      ])
      setJar(nextJar)
      if (check) setStatus(check)
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
      // 用户没手动切过分段时，按书源能力自动选推荐方式：
      // 有登录入口（URL / 脚本 / jsLib 里的 startBrowserAwait）就开真浏览器，
      // 否则只剩粘贴 Cookie 一条路。
      if (!userPickedRef.current) {
        setMethod((res.loginUrl || res.loginCanOpenBrowser) ? 'external' : 'cookie')
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

  // Esc 一次只关一层：登录头编辑 → 凭据菜单 → 登录浮层本身。
  // 全站其它浮层都吃 Esc，这个浮层以前不吃，键盘用户只能点 ✕。
  useEscapeClose(() => {
    if (headerEditOpen) { setHeaderEditOpen(false); return }
    if (menuOpen) { setMenuOpen(false); return }
    onClose()
  })

  /**
   * 顶栏「保存并登录」的唯一路径。
   *
   * 书源的登录方式分三类：
   * ① loginUrl 是整段 JS（大多数聚合源）：保存表单后执行 `login(true)`，脚本自己决定
   *    是拿表单去请求，还是 java.startBrowserAwait 打开登录页；
   * ② loginUrl 只是一个网址（番茄 v3.4.2 就是）：这种源没有 `login()` 可执行。
   *    以前硬投 `login(true)` 只会得到 "login is not defined"，用户看到「书源脚本执行失败」
   *    而实际什么都没发生 —— 现在保存后直接打开真浏览器登录页；
   * ③ 两者都没有：只保存输入，不再假装能登录。
   */
  const handleSaveAndLogin = async () => {
    if (executing || loading) return
    try {
      setExecuting(true)
      await api.saveSourceLoginInfo(sourceId, formData)
      if (uiResponse?.loginIsScript) {
        const res = await api.executeSourceLoginAction(sourceId, 'login(true)', formData, false)
        if (res.error) {
          onToast(`书源脚本执行失败：${res.error}`, 'error')
        } else if (res.toastMessages && res.toastMessages.length > 0) {
          res.toastMessages.forEach(msg => onToast(msg, res.success ? 'success' : 'info'))
        } else {
          onToast('登录信息已保存并尝试登录', 'success')
        }
        if (res.openUrl) {
          // 登录脚本用 java.startBrowserAwait 要一个浏览器：只有真浏览器能读回带
          // HttpOnly 的 Cookie，所以直接交给它，并切到对应页签让用户看到后续步骤。
          userPickedRef.current = true
          setMethod('external')
          setExternalBusy(true)
          try {
            const started = await api.externalLoginStart(sourceId, res.openUrl)
            setExternal(started)
            setExternalStored([])
            onToast(
              started.opened ? '已在真浏览器中打开登录页，登录完成后点「抓取并入库」' : '浏览器没能打开',
              started.opened ? 'success' : 'error',
            )
          } finally {
            setExternalBusy(false)
          }
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
        return
      }
      if (uiResponse?.loginCanOpenBrowser || uiResponse?.loginUrl) {
        // 没有登录脚本时「登录」只能发生在网站自己的页面上，交给真浏览器；
        // 内置浏览器的 opaque origin 沙箱跑不了这类站点的风控脚本。
        // 只把绝对的 http(s) 地址交给服务端；相对路径 / jsLib 里的 startBrowserAwait
        // 由服务端自己解析 —— 界面上不该重复一套解析逻辑。
        const explicit = uiResponse?.loginUrl?.trim()
        const startUrl = explicit && /^https?:\/\//i.test(explicit) ? explicit : undefined
        userPickedRef.current = true
        setMethod('external')
        setExternalBusy(true)
        try {
          const res = await api.externalLoginStart(sourceId, startUrl)
          setExternal(res)
          setExternalStored([])
          onToast(
            res.opened
              ? '登录信息已保存。请在打开的浏览器里登录，完成后点「抓取并入库」'
              : '登录信息已保存，但浏览器没能打开',
            res.opened ? 'success' : 'error',
          )
        } finally {
          setExternalBusy(false)
        }
        return
      }
      onToast('登录信息已保存（这本书源没有登录流程）', 'success')
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
              className="source-login-action-btn primary"
              title={uiResponse?.loginIsScript ? '保存并登录' : (uiResponse?.loginCanOpenBrowser || uiResponse?.loginUrl) ? '保存并打开登录页' : '保存登录信息'}
              aria-label={uiResponse?.loginIsScript ? '保存并登录' : (uiResponse?.loginCanOpenBrowser || uiResponse?.loginUrl) ? '保存并打开登录页' : '保存登录信息'}
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
            // 登录入口不再只看"是不是一个 http 地址"：相对路径、登录脚本、jsLib 里的
            // startBrowserAwait，服务端都能解析成真正的登录页。
            const hasLoginUrl = !!(uiResponse?.loginCanOpenBrowser || uiResponse?.loginUrl)
            const hasCredential = (jar?.count ?? 0) > 0 || !!uiResponse?.loginHeader
            const recommended = hasLoginUrl ? 'external' : 'cookie'
            const active = method ?? recommended
            const tab = (key: 'external' | 'cookie', label: string) => (
              <button
                key={key}
                type="button"
                className={`source-login-method-tab${active === key ? ' is-active' : ''}`}
                onClick={() => { userPickedRef.current = true; setMethod(key) }}
              >
                {label}
                {recommended === key && <span className="source-login-method-recommend">推荐</span>}
              </button>
            )
            return (
              <>
                <div className="source-login-method-tabs" role="tablist">
                  {tab('external', '真浏览器')}
                  {tab('cookie', '粘贴 Cookie')}
                </div>

                {/* 状态行只给结论；"为什么不能验证"放进 title，不再占一整行正文 */}
                <div
                  className={`source-login-status ${status?.verified ? 'is-verified' : hasCredential ? 'is-credential' : 'is-empty'}`}
                  title={status?.verified
                    ? '书源的 loginCheckJs 判定通过'
                    : hasCredential
                      ? '这本书源没有 loginCheckJs，无法自动判定有效性；实际搜索或阅读一次即可确认'
                      : undefined}
                >
                  {status?.verified
                    ? '登录态已验证'
                    : hasCredential
                      ? '已存凭据 · 未自动验证'
                      : '还没有任何凭据'}
                </div>

                {!hasCredential && (
                  <p className="source-login-hint small">
                    凭据按注册域全局共享，同一域的所有书源共用一份；删除会影响它们。
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

                {active === 'external' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      用本机 Chrome / Edge 打开登录页，扫码、账号密码、站点风控都照常。登录后点「抓取并入库」，
                      含 HttpOnly 的 Cookie 会自动读回并按域入库；登录时经 passport / OAuth 中转写下的凭据
                      （书源配置里没提到的域）也会一并识别。
                    </p>
                    {!hasLoginUrl && (
                      <p className="source-login-hint small">
                        这本书源没有配置 loginUrl，会直接打开书源首页；在窗口里登录后同样可以抓取凭据。
                      </p>
                    )}
                    <div className={`source-login-status ${external?.opened ? 'is-credential' : 'is-empty'}`}>
                      {external?.opened
                        // 附着到早先拉起的窗口时服务端拿不到 pid（为 0），这时不摆一个「进程 0」
                        ? `已打开 ${external.browser || '浏览器'}${external.pid > 0 ? `（进程 ${external.pid}）` : ''}，等你在窗口里登录`
                        : '还没打开浏览器'}
                      {(external?.seen.length ?? 0) > 0 && ` · 已见到凭据：${external!.seen.join('、')}`}
                      {externalStored.length > 0 && ` · 本轮入库：${externalStored.join('、')}`}
                    </div>
                    <div className="source-login-external-actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={externalBusy}
                        title="使用独立且持久的登录档，不会动你日常浏览器的资料"
                        onClick={() => void handleExternalStart()}
                      >
                        {externalBusy ? '处理中…' : '打开真浏览器登录'}
                      </button>
                      <button type="button" className="subtle-button" disabled={externalBusy || !external?.opened} onClick={() => void handleExternalCapture()}>
                        抓取并入库
                      </button>
                      <button type="button" className="subtle-button" disabled={!external?.opened} onClick={() => void handleExternalStop()}>
                        关闭浏览器
                      </button>
                    </div>
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
      </div>
    </div>
  )
}
