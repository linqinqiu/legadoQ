import { useEffect, useState } from 'react'
import { useEscapeClose } from '../lib/useEscapeClose'
import { zh } from '../i18n/zh'
import { clearAccessToken, setAccessToken, UNAUTHORIZED_EVENT } from '../lib/accessToken'

/**
 * 服务端设了 LEGADO_ACCESS_TOKEN 且当前是非回环访问时，缺/错 token 的请求会回 401，
 * client.ts 派发 `legado:unauthorized` 事件，这里弹输入框让用户填一次并记住。
 *
 * 单机用户永远看不到这一层（服务端不鉴权、不会回 401）。保存后 reload 而非原地重试：
 * 启动时那一批请求（书源清单等）都是并行发的，逐个重试不如整页重来一遍干净，
 * 而且 reload 会重新跑 healthz 探测与所有初始化，状态一致。
 */
export function AccessTokenPrompt() {
  const [visible, setVisible] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onUnauthorized = () => {
      setValue('')
      setError('')
      setVisible(true)
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  // Esc 只关掉这一层，不保存；下次请求 401 会再弹。
  // 组件常驻（不可见时返回 null），Esc 监听始终在，但 setVisible(false) 在隐藏时是空操作。
  useEscapeClose(() => setVisible(false))

  if (!visible) return null

  const submit = () => {
    const token = value.trim()
    if (!token) {
      setError('请输入访问令牌')
      return
    }
    setAccessToken(token)
    // 重新加载：让所有请求（含 SSE/WS）都带上刚存的 token。
    window.location.reload()
  }

  return (
    <div className="overlay-backdrop" role="presentation">
      <div className="dialog-shell size-s" role="dialog" aria-modal="true" aria-labelledby="access-token-title">
        <header className="dialog-head">
          <h2 id="access-token-title">需要访问令牌</h2>
          <button type="button" className="overlay-close" onClick={() => setVisible(false)} aria-label={zh.common.close}>×</button>
        </header>
        <div className="server-port-body">
          <p>这台 legadoQ 从非本机地址访问时需要访问令牌。请向部署方索取服务端设置的 <code>LEGADO_ACCESS_TOKEN</code>。</p>
          <label className="customize-field">
            <span>访问令牌</span>
            <input
              autoFocus
              type="password"
              value={value}
              placeholder="访问令牌"
              onChange={event => { setValue(event.target.value); setError('') }}
              onKeyDown={event => { if (event.key === 'Enter') submit() }}
            />
          </label>
          {error && <p className="customize-error" role="alert">{error}</p>}
          <div className="customize-actions">
            <button type="button" onClick={() => { clearAccessToken(); setVisible(false) }}>取消</button>
            <button type="button" className="primary-button" onClick={submit}>保存并重新加载</button>
          </div>
        </div>
      </div>
    </div>
  )
}
