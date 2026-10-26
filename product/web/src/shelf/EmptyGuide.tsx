import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons'

/**
 * 空态引导：说清这张列表装的是什么、东西从哪来，并把去处做成按钮。
 *
 * 之前这里是一句「还没有书源订阅。」加一段"去某某页导入"的文字指引 ——
 * 用户读完不知道下一步点哪里，所以去处一律可点。
 */
export function EmptyGuide({ icon, title, body, actions }: {
  icon: IconName
  title: string
  body: ReactNode
  actions: { label: string; onClick: () => void; primary?: boolean; icon?: IconName }[]
}) {
  return (
    <div className="panel-empty">
      <span className="panel-empty-icon"><Icon name={icon} /></span>
      <h3>{title}</h3>
      <div className="panel-empty-body">{body}</div>
      <div className="panel-empty-actions">
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? 'primary-button' : 'subtle-button'}
            onClick={action.onClick}
          >
            {action.icon && <Icon name={action.icon} />}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}
