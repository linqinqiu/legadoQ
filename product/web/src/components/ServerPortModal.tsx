import React, { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「服务端口」（用户 2026-10-09：「用户可以自定义端口……重启生效」）。
 *
 * 改的是安装根下的 `port.txt`（启动器下次从它读）—— **重启青阅之后才生效**：
 * 正在跑的这个进程没法把自己挪到另一个端口上，所以这里只写文件、如实说"重启后生效"。
 */
export function ServerPortModal({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  const [current, setCurrent] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.serverInfo()
      .then(info => { setCurrent(info.port); setValue(String(info.port)) })
      .catch(() => setError('没取到当前端口'))
  }, [])

  const save = async () => {
    const port = Number(value.trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口要填 1–65535 之间的整数')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.setServerPort(port)
      setSaved(result.port)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '没保存成功')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-s" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="服务端口">
        <header className="dialog-head">
          <h2><Icon name="sliders" /> 服务端口</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="server-port-body">
          <p className="server-port-current">当前跑在 <b>{current === null ? '…' : current}</b></p>
          <label className="customize-field">
            <span>改成（1–65535）</span>
            <input
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={value}
              onChange={event => setValue(event.target.value)}
            />
          </label>
          {!!error && <p className="customize-error" role="alert">{error}</p>}
          {saved !== null && (
            <p className="customize-note">
              已记下 <b>{saved}</b>：重启青阅后生效，之后用 <code>http://127.0.0.1:{saved}/</code> 打开。
            </p>
          )}
          <div className="customize-actions">
            <button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}
