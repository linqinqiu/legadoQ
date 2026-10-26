import React from 'react'
import { describeSyncError, looksLikeFailure } from '../lib/syncErrors'

/**
 * 面板里的一行反馈。
 *
 * 成功提示就一行；失败给「结论 + 怎么修」，原始堆栈式文案收进可展开的一栏，
 * 不再把 `UnknownHostException: xxx:80: Name or service not known` 直接糊在页面上。
 */
export function Notice({ text }: { text: string }) {
  const raw = text?.trim()
  if (!raw) return null
  if (!looksLikeFailure(raw)) return <p className="sidebar-notice">{raw}</p>
  const info = describeSyncError(raw)
  const sameLine = info.headline === raw
  return (
    <div className="notice-error" role="status">
      <p><strong>{info.headline}</strong>{info.hint && <span>{info.hint}</span>}</p>
      {!sameLine && (
        <details>
          <summary>查看原始报错</summary>
          <code>{raw}</code>
        </details>
      )}
    </div>
  )
}
