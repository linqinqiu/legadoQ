import { Icon } from '../icons'

/**
 * 阅读器里那一排方形图标键（返回 / 工具栏 / 抽屉动作…）。从 `ReaderScreen` 抽出来
 * （PROPOSAL-019 F）：纯呈现，只有 label / icon / onClick 那几样。
 */
export function IconButton({ label, icon, onClick, className = '', onDoubleClick, hint, disabled = false }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; className?: string; onDoubleClick?: () => void; hint?: string; disabled?: boolean }) {
  return <button className={`reader-icon-button ${className}`} title={hint ? `${label} · ${hint}` : label} aria-label={label} onClick={onClick} onDoubleClick={onDoubleClick} disabled={disabled}><Icon name={icon} /></button>
}
