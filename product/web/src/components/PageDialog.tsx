import React from 'react'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 整页内容改悬浮层共用的壳（0.6.27：规则 / 备份 / 更新日志 / 关于 不再占整页路由）。
 * 不在导航栏的目的地一律开在这里，盖在当前页面上 —— 用户不失语境，顶栏也不用为它们留位置。
 */
export function PageDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-l page-dialog"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="overlay-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="page-dialog-body">{children}</div>
      </div>
    </div>
  )
}
