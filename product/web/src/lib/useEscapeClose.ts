import { useEffect } from 'react'

/**
 * 浮层统一支持 Esc 关闭。
 *
 * `blockedBy` 是一个 CSS 选择器：命中时本次 Esc 让位给叠在其上的更高层浮层，
 * 例如「书籍管理」面板传 `blockedBy='.book-info-edit-modal'`，一次 Esc 只关最上面那层。
 */
export function useEscapeClose(onClose: () => void, blockedBy?: string) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (blockedBy && document.querySelector(blockedBy)) return
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, blockedBy])
}
