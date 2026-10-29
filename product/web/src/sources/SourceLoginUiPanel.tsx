import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  api,
  SourceLoginActionResult,
  SourceLoginUiActionResponse,
  SourceLoginUiItem,
} from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

export type SourceLoginUiPanelHandle = {
  /** 顶栏「保存并登录」（v1）：保存字段后执行 login(true)。 */
  submitLogin: () => Promise<void>
  /** 本地页面浮层是否开着：外层登录浮层的 Esc 要先让给它。 */
  hasInlinePage: () => boolean
}

interface SourceLoginUiPanelProps {
  sourceId: string
  /** 1 = loginUi 静态 JSON 数组；2 = 脚本渲染的 {"version":2}。 */
  version: number
  rows: SourceLoginUiItem[]
  /** v2 首屏渲染失败的原因。 */
  uiError?: string
  storedLoginInfo: Record<string, string>
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
  /** 重新拉一次 /login-ui（v1 的 java.upLoginData 会要求重绘）。 */
  onRefresh: () => Promise<void> | void
  onClose: () => void
  /** 动作返回了 openUrl：交给真浏览器打开登录页。 */
  onOpenExternal: (url: string) => Promise<void> | void
  onLoginInfoChanged?: (info: Record<string, string>) => void
}

interface InlinePage {
  html: string
  title: string
  action: string
  version: number
}

const INPUT_TYPES = new Set(['text', 'password', 'select', 'toggle'])

const isInput = (row: SourceLoginUiItem) => INPUT_TYPES.has(row.type)

const rowKey = (row: SourceLoginUiItem, version: number) =>
  version === 2 ? (row.key || row.name) : row.name

/**
 * 书源给出的 `data:text/html` 页面在 iframe 里跑。iframe 是 opaque origin（不加
 * allow-same-origin），父页面读不到它的 DOM，只能靠 postMessage 让页面自己把
 * `documentElement.outerHTML` 交回来 —— 这也正是脚本 `startBrowserAwait(...).body()`
 * 期望拿到的东西。
 */
const BRIDGE_SCRIPT = `<script>(function(){
  function send(payload){ try { parent.postMessage(payload, '*') } catch (e) {} }
  window.addEventListener('message', function(event){
    if (!event.data || event.data.__legadoInlineRequest !== true) return
    var html = ''
    try { html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML } catch (e) {}
    send({ __legadoInline: true, html: html })
  })
  if (document.readyState === 'complete') { send({ __legadoInline: true, ready: true }) }
  else { window.addEventListener('load', function(){ send({ __legadoInline: true, ready: true }) }) }
})();</script>`

function withInlineBridge(html: string): string {
  const index = html.toLowerCase().lastIndexOf('</body>')
  return index >= 0 ? `${html.slice(0, index)}${BRIDGE_SCRIPT}${html.slice(index)}` : `${html}${BRIDGE_SCRIPT}`
}

/**
 * 本地登录界面（对应 Legado APK 的 loginUi 渲染）。
 *
 * v1：loginUi 是一组静态字段/按钮，按钮 action 是原样执行的 JS；每次动作前把可见字段
 * 合并进 loginInfo 落库（脚本里的 `source.getLoginInfo()` 依赖它）。
 * v2：`loginUi(state)` 渲染 rows，`loginAction(action,state,form)` 返回命令
 * （state / error / login / close）。
 *
 * 两种协议都可能用 `java.startBrowserAwait('data:text/html…')` 打开设置页；这里用
 * 带 postMessage 桥的 sandbox iframe 展示，用户点「完成并回传」后把整页 HTML 作为
 * browserBody 重跑同一个动作，脚本就能像真 WebView 关闭后那样继续往下走。
 */
export const SourceLoginUiPanel = forwardRef<SourceLoginUiPanelHandle, SourceLoginUiPanelProps>(
  function SourceLoginUiPanel(
    {
      sourceId,
      version,
      rows,
      uiError,
      storedLoginInfo,
      onToast,
      onRefresh,
      onClose,
      onOpenExternal,
      onLoginInfoChanged,
    },
    ref,
  ) {
    const [values, setValues] = useState<Record<string, string>>({})
    const valuesRef = useRef<Record<string, string>>({})
    const storedRef = useRef(storedLoginInfo)
    const sessionRef = useRef<Record<string, string>>({})
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false)
    const [countdowns, setCountdowns] = useState<Record<string, number>>({})
    const [inline, setInline] = useState<InlinePage | null>(null)
    const inlineOpenRef = useRef(false)
    inlineOpenRef.current = Boolean(inline)
    const [inlineReady, setInlineReady] = useState(false)
    const [capturing, setCapturing] = useState(false)
    const captureTimerRef = useRef<number | null>(null)
    const inlineFrameRef = useRef<HTMLIFrameElement | null>(null)
    const [localRows, setLocalRows] = useState(rows)
    const [, setLoginStateState] = useState('{}')
    const loginStateRef = useRef('{}')

    const setLoginState = (next: string) => {
      loginStateRef.current = next
      setLoginStateState(next)
    }

    const updateStored = useCallback(
      (next: Record<string, string>) => {
        storedRef.current = next
        onLoginInfoChanged?.(next)
      },
      [onLoginInfoChanged],
    )

    useEffect(() => {
      storedRef.current = storedLoginInfo
    }, [storedLoginInfo])

    // 新一屏 / 新字段：render 值 > 本会话输入 > 已存 loginInfo > row.default
    useEffect(() => {
      const next: Record<string, string> = {}
      rows.forEach(row => {
        if (!isInput(row)) return
        const key = rowKey(row, version)
        if (!key) return
        const fallback = row.type === 'toggle' ? 'false' : ''
        next[key] = row.value ?? sessionRef.current[key] ?? storedRef.current[key] ?? row.default ?? fallback
      })
      valuesRef.current = { ...next }
      setValues(next)
    }, [rows, version])

    useEffect(() => {
      const timer = window.setInterval(() => {
        setCountdowns(prev => {
          const keys = Object.keys(prev)
          if (keys.length === 0) return prev
          const next: Record<string, number> = {}
          keys.forEach(key => {
            const left = prev[key] - 1
            if (left > 0) next[key] = left
          })
          return next
        })
      }, 1000)
      return () => window.clearInterval(timer)
    }, [])

    const setField = (key: string, value: string) => {
      const next = { ...valuesRef.current, [key]: value }
      valuesRef.current = next
      sessionRef.current[key] = value
      setValues(next)
      setErrors(prev => {
        if (!(key in prev)) return prev
        const copy = { ...prev }
        delete copy[key]
        return copy
      })
    }

    const startCountdown = (action: string, seconds: number) => {
      setCountdowns(prev => ({ ...prev, [action]: seconds }))
    }

    const showToasts = (messages: string[], success: boolean) => {
      messages.forEach(message => onToast(message, success ? 'success' : 'info'))
    }

    const setRows = (nextRows: SourceLoginUiItem[], state: string) => {
      setLocalRows(nextRows)
      setLoginState(state)
      setErrors({})
      const nextValues: Record<string, string> = {}
      nextRows.forEach(row => {
        if (!isInput(row)) return
        const key = rowKey(row, version)
        if (!key) return
        const fallback = row.type === 'toggle' ? 'false' : ''
        nextValues[key] = row.value ?? sessionRef.current[key] ?? storedRef.current[key] ?? row.default ?? fallback
      })
      valuesRef.current = { ...nextValues }
      setValues(nextValues)
    }

    const handleV1Result = async (
      res: SourceLoginActionResult,
      action: string,
      countdown: number | null,
    ) => {
      if (res.error) {
        onToast(`书源脚本执行失败：${res.error}`, 'error')
        return
      }
      showToasts(res.toastMessages || [], res.success)
      if (res.updatedLoginInfo) {
        updateStored({ ...storedRef.current, ...res.updatedLoginInfo })
      }
      if (res.copyText) {
        await navigator.clipboard.writeText(res.copyText).catch(() => undefined)
      }
      if (res.openUrl) await onOpenExternal(res.openUrl)
      if (res.inlineHtml) {
        setInlineReady(false)
        setInline({
          html: res.inlineHtml,
          title: res.inlineTitle || '书源页面',
          action,
          version: 1,
        })
      }
      if (res.reRenderUi) await onRefresh()
      if (res.success && countdown && countdown > 0) startCountdown(action, countdown)
    }

    const handleV2Result = async (
      res: SourceLoginUiActionResponse,
      action: string,
      countdown: number | null,
    ) => {
      if (!res.ok) {
        onToast(res.message || '书源脚本执行失败', 'error')
        return
      }
      showToasts(res.toastMessages || [], true)
      if (res.updatedLoginInfo) {
        updateStored({ ...storedRef.current, ...res.updatedLoginInfo })
      }
      if (Object.keys(res.error || {}).length > 0) setErrors(res.error)
      if (res.inlineHtml) {
        setInlineReady(false)
        setInline({
          html: res.inlineHtml,
          title: res.inlineTitle || '书源页面',
          action,
          version: 2,
        })
      }
      if (res.openUrl) await onOpenExternal(res.openUrl)
      if (res.close) {
        onClose()
        return
      }
      if (res.state) {
        const rendered = await api.renderSourceLoginUi(sourceId, res.state)
        if (rendered.error) {
          onToast(`登录界面重绘失败：${rendered.error}`, 'error')
        } else {
          updateStored(rendered.loginInfo)
          // 直接换掉本组件的 rows：服务端 GET /login-ui 给的是首屏，不能拿它覆盖当前屏。
          setRows(rendered.rows, rendered.state)
        }
      }
      if (countdown && countdown > 0) startCountdown(action, countdown)
    }

    useEffect(() => {
      setLocalRows(rows)
      setLoginState('{}')
      setErrors({})
    }, [rows])

    async function deliverAction(
      action: string,
      countdown: number | null,
      actionVersion: number,
      options?: { browserCompleted?: boolean; browserBody?: string },
    ) {
      if (!action || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setErrors({})
      try {
        if (actionVersion === 1) {
          // v1 脚本读 `source.getLoginInfo()`，动作前必须先把可见字段写进库
          const merged = { ...storedRef.current, ...valuesRef.current }
          await api.saveSourceLoginInfo(sourceId, merged)
          updateStored(merged)
          const res = await api.executeSourceLoginAction(
            sourceId,
            action,
            merged,
            false,
            options?.browserCompleted ?? false,
            options?.browserBody,
          )
          await handleV1Result(res, action, countdown)
        } else {
          const res = await api.executeSourceLoginUiAction(
            sourceId,
            action,
            loginStateRef.current,
            valuesRef.current,
            options?.browserCompleted ?? false,
            options?.browserBody,
          )
          await handleV2Result(res, action, countdown)
        }
      } catch (error) {
        onToast(`执行失败：${(error as Error).message}`, 'error')
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    }

    /** 始终指向最新一次渲染的 deliverAction，避免 iframe 回调拿到旧的 loginState。 */
    const deliverRef = useRef(deliverAction)
    deliverRef.current = deliverAction

    const continueInline = useCallback((page: InlinePage, html: string) => {
      void deliverRef.current(page.action, null, page.version, {
        browserCompleted: true,
        browserBody: html,
      })
    }, [])

    const runAction = (action: string, countdown: number | null) =>
      deliverAction(action, countdown, version)

    useImperativeHandle(ref, () => ({
      submitLogin: async () => {
        if (version === 2) {
          onToast('请用书源界面里的按钮完成登录', 'info')
          return
        }
        await deliverRef.current('login(true)', null, 1)
      },
      hasInlinePage: () => inlineOpenRef.current,
    }))

    // 本地页面自己也是一层浮层：Esc 先关它，别把整个登录框一起关掉。
    useEscapeClose(() => {
      if (inlineOpenRef.current) setInline(null)
    })

    const inlineDocument = useMemo(
      () => (inline ? withInlineBridge(inline.html) : ''),
      [inline],
    )

    useEffect(() => {
      if (!inline) return
      const handler = (event: MessageEvent) => {
        const data = event.data
        if (!data || data.__legadoInline !== true) return
        if (data.ready) {
          setInlineReady(true)
          return
        }
        if (typeof data.html !== 'string') return
        if (captureTimerRef.current !== null) {
          window.clearTimeout(captureTimerRef.current)
          captureTimerRef.current = null
        }
        setCapturing(false)
        setInline(null)
        setInlineReady(false)
        void continueInline(inline, data.html)
      }
      window.addEventListener('message', handler)
      return () => window.removeEventListener('message', handler)
    }, [inline, continueInline])

    useEffect(
      () => () => {
        if (captureTimerRef.current !== null) window.clearTimeout(captureTimerRef.current)
      },
      [],
    )

    const requestCapture = () => {
      const win = inlineFrameRef.current?.contentWindow
      if (!win) return
      setCapturing(true)
      win.postMessage({ __legadoInlineRequest: true }, '*')
      if (captureTimerRef.current !== null) window.clearTimeout(captureTimerRef.current)
      captureTimerRef.current = window.setTimeout(() => {
        captureTimerRef.current = null
        setCapturing(false)
        onToast('页面没有把内容交回来，可能脚本被沙箱拦住了', 'error')
      }, 3000)
    }

    const renderRow = (row: SourceLoginUiItem, index: number) => {
      const key = rowKey(row, version)
      const width = row.style?.layout_flexBasisPercent
        ? `${Math.max(10, Math.min(100, Math.round(row.style.layout_flexBasisPercent * 100)))}%`
        : undefined
      const style = width ? { flexBasis: width, maxWidth: width } : undefined
      const error = key ? errors[key] : undefined

      if (row.type === 'label') {
        return (
          <p key={`label-${index}`} className="source-login-form-label" style={style}>
            {row.name}
          </p>
        )
      }

      if (row.type === 'button') {
        if (!row.action) {
          // 示例书源用没有 action 的按钮当分隔标题
          return (
            <div key={`divider-${index}`} className="source-login-form-divider">
              {row.name}
            </div>
          )
        }
        const left = countdowns[row.action] ?? 0
        return (
          <button
            key={`button-${index}-${row.action}`}
            type="button"
            className="source-login-form-button"
            style={style}
            disabled={busy || left > 0}
            onClick={() => void runAction(row.action!, row.countdown ?? null)}
          >
            {row.name}
            {left > 0 ? ` (${left}s)` : ''}
          </button>
        )
      }

      if (!key) return null

      if (row.type === 'toggle') {
        return (
          <label key={`toggle-${key}`} className="source-login-form-toggle" style={style}>
            <input
              type="checkbox"
              checked={values[key] === 'true'}
              disabled={busy}
              onChange={event => {
                const next = event.target.checked ? 'true' : 'false'
                setField(key, next)
                if (row.action) void deliverAction(row.action, row.countdown ?? null, version)
              }}
            />
            <span>{row.name}</span>
          </label>
        )
      }

      if (row.type === 'select') {
        const options = row.options || []
        const current = options.includes(values[key]) ? values[key] : options[0] ?? ''
        return (
          <label key={`select-${key}`} className="source-login-form-field" style={style}>
            <span className="source-login-form-field-name">{row.name}</span>
            <select
              className="login-ui-input"
              value={current}
              disabled={busy}
              onChange={event => setField(key, event.target.value)}
            >
              {options.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            {error && <span className="source-login-form-error-text">{error}</span>}
          </label>
        )
      }

      return (
        <label key={`field-${key}`} className="source-login-form-field" style={style}>
          <span className="source-login-form-field-name">{row.name}</span>
          <input
            className={`login-ui-input${error ? ' has-error' : ''}`}
            type={row.type === 'password' ? 'password' : 'text'}
            value={values[key] ?? ''}
            placeholder={row.hint}
            disabled={busy}
            onChange={event => setField(key, event.target.value)}
          />
          {error && <span className="source-login-form-error-text">{error}</span>}
        </label>
      )
    }

    return (
      <>
        <div className="source-login-panel source-login-local">
          {uiError && (
            <div className="source-login-form-banner error">
              <span>登录界面渲染失败：{uiError}</span>
              <button type="button" className="subtle-button" onClick={() => void onRefresh()}>重试</button>
            </div>
          )}
          {localRows.length === 0 && !uiError && (
            <p className="source-login-hint small">这本书源的登录界面没有可显示的字段。</p>
          )}
          {localRows.length > 0 && (
            <div className="source-login-form-scroll">
              <div className="source-login-form-grid">{localRows.map(renderRow)}</div>
            </div>
          )}
          <p className="source-login-hint small">
            界面由书源自己的 loginUi 渲染，按钮动作在该书源的沙箱里执行；设置页会以本地页面打开，改完点「完成并回传」。
          </p>
        </div>

        {inline && (
          <div className="overlay-backdrop is-topped" onClick={() => setInline(null)}>
            <div
              className="dialog-shell size-m source-login-inline-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={inline.title}
              onClick={event => event.stopPropagation()}
            >
              <div className="dialog-head">
                <h3>{inline.title}</h3>
                <button
                  type="button"
                  className="overlay-close"
                  aria-label="关闭"
                  onClick={() => setInline(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="source-login-inline-body">
                <p className="source-login-hint small">
                  这是书源脚本生成的本地页面，和你点按钮时书源自己打开的设置页一致。
                  页面里的联网检测可能被沙箱拦住，但选择与开关会保留；改完点「完成并回传」。
                </p>
                <iframe
                  ref={inlineFrameRef}
                  className="source-login-inline-frame"
                  title={inline.title}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                  srcDoc={inlineDocument}
                  onLoad={() => setInlineReady(true)}
                />
              </div>
              <div className="source-login-inline-actions">
                <button type="button" className="subtle-button" onClick={() => setInline(null)}>取消</button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!inlineReady || capturing || busy}
                  onClick={requestCapture}
                >
                  {busy ? '回传中…' : capturing ? '读取页面…' : '完成并回传'}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  },
)
