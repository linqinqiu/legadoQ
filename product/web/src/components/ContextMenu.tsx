import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../icons'
import { useClampOverlay } from '../lib/overlayGeometry'

export type ContextMenuItem = {
  label: string
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

type OpenMenu = { x: number; y: number; items: ContextMenuItem[] }

let publish: (menu: OpenMenu | null) => void = () => {}

/** 在 onContextMenu 里调用：拦下浏览器原生菜单，换成应用内动作菜单。 */
export function showContextMenu(event: { preventDefault: () => void; clientX: number; clientY: number }, items: ContextMenuItem[]) {
  const usable = items.filter(item => !item.disabled)
  if (!usable.length) return
  event.preventDefault()
  publish({ x: event.clientX, y: event.clientY, items: usable })
}

export function ContextMenuLayer() {
  const [menu, setMenu] = useState<OpenMenu | null>(null)

  useEffect(() => {
    publish = setMenu
    return () => { publish = () => {} }
  }, [])

  if (!menu) return null
  return <ContextMenuPopup menu={menu} onClose={() => setMenu(null)} />
}

/**
 * 菜单的宽高由样式表决定（`min-width: 196`、行 32 + 间隙 2），位置由**挂载后量出来的真实矩形**
 * 夹进视口 —— 这里以前写着 `width = 210 / 行 = 34`，与样式表那两份数值互相矛盾，
 * 谁也不报错，菜单贴到视口下沿时就是被裁掉的那一个。
 */
function ContextMenuPopup({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useClampOverlay<HTMLDivElement>({ x: menu.x, y: menu.y })

  useEffect(() => {
    const node = ref.current
    const onPointerDown = (event: PointerEvent) => {
      // 捕获阶段拦下这一次的 pointerdown，避免「右键→菜单刚出现就被自己关掉」
      if (node?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('pointerdown', onPointerDown, true)
    addEventListener('blur', onClose)
    addEventListener('resize', onClose)
    addEventListener('scroll', onClose, true)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onPointerDown, true)
      removeEventListener('blur', onClose)
      removeEventListener('resize', onClose)
      removeEventListener('scroll', onClose, true)
      removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={event => event.preventDefault()}
    >
      {menu.items.map(item => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'context-menu-danger' : ''}
          onClick={() => { onClose(); item.onSelect() }}
        >
          {item.icon && <Icon name={item.icon} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
