import { useEffect, useState } from 'react'
import { useEscapeClose } from '../lib/useEscapeClose'
import { DISCLAIMER_TEXT, PRODUCT_INTRO, TERMS_TEXT } from '../lib/agreement'

/**
 * 首次打开的「用户协议与免责声明」全屏层（用户 2026-10-10，参照 legado-with-MD3 的首启免责声明）：
 * 倒计时 5 秒内「同意并进入」是禁用的，到点可点；同意后写 localStorage，之后**永不再显示**。
 *
 * 外壳走统一的那一套（`.overlay-backdrop` + `.dialog-shell` + `useEscapeClose`，W2 并档的规矩），
 * 不自造第二套几何。Esc 只是关掉这一层、**不写同意标记**——没同意的人下次打开还会看到；
 * 「之后不再显示」只承诺给点了同意的人。文案与「关于」页共用 `agreement.ts` 那一份
 * （抄两份迟早漂移）。key 带版本号：将来协议大改时升 v2，老用户会再看一次。
 */
const STORAGE_KEY = 'qingyue-agreement-v1'
const READ_SECONDS = 5

export function FirstRunAgreement() {
  const [visible, setVisible] = useState(() => {
    try { return !window.localStorage.getItem(STORAGE_KEY) } catch { return true }
  })
  const [seconds, setSeconds] = useState(READ_SECONDS)
  useEscapeClose(() => setVisible(false))

  useEffect(() => {
    if (!visible || seconds <= 0) return
    const timer = window.setTimeout(() => setSeconds(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [visible, seconds])

  if (!visible) return null
  const agree = () => {
    try { window.localStorage.setItem(STORAGE_KEY, new Date().toISOString()) } catch { /* 存不进就每次都看一遍 */ }
    setVisible(false)
  }

  return (
    <div className="overlay-backdrop is-agreement" role="dialog" aria-modal="true" aria-label="用户协议与免责声明">
      <div className="dialog-shell agreement-card">
        <h1>用户协议与免责声明</h1>
        <p className="agreement-intro">{PRODUCT_INTRO}</p>
        <div className="agreement-body">
          <h2>用户协议</h2>
          <p>{TERMS_TEXT}</p>
          <h2>免责声明</h2>
          <p>{DISCLAIMER_TEXT}</p>
        </div>
        <div className="agreement-actions">
          <button type="button" className="primary-button" disabled={seconds > 0} onClick={agree}>
            {seconds > 0 ? `请阅读（${seconds} 秒）` : '同意并进入'}
          </button>
        </div>
      </div>
    </div>
  )
}
