import React from 'react'
import { zh } from '../../i18n/zh'
import { Icon, type IconName } from '../../icons'
import { useEscapeClose } from '../../lib/useEscapeClose'

/**
 * AI 相关浮层的共用外壳。
 *
 * AI 的能力面拆成了几个入口（对话助手 / 模型连接 / 工具 / 技能 / 提示词 / 书源校验），
 * 每一档的遮罩、外壳、标题行、关闭键、Esc 关闭都必须一模一样 —— 复制六遍迟早有一遍
 * 少了关闭键或不走令牌（`UiContract` 判据盯的正是这几个类名与 `--backdrop` 令牌）。
 *
 * 只画外壳，不管内容怎么滚动：内容仍然放在 `.page-dialog-body` 里，与既有浮层同一套版式。
 */
export function AiPanel({
  title,
  icon = 'sliders',
  onClose,
  children,
}: {
  title: string
  icon?: IconName
  onClose: () => void
  children: React.ReactNode
}) {
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
          <h2><Icon name={icon} /> {title}</h2>
          <button type="button" className="overlay-close" aria-label={zh.common.close} onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="page-dialog-body">{children}</div>
      </div>
    </div>
  )
}
