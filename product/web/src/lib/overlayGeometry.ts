import { useLayoutEffect, useRef } from 'react'

/**
 * 浮层定位的**唯一**一处算式。
 *
 * 改版前有四份：`Select` 自己夹一次、右键菜单自己夹一次、`ContextMenu.tsx` 里还写着
 * `width = 210 / 行 = 34`，而样式表写的是 `min-width: 196 / 行 32 + 2` —— 两份数值互相矛盾，
 * 谁也没报错，菜单高度算错就被视口裁掉。这里的原则是：**已经画出来的东西要用量的，不要用估的**。
 */
export const OVERLAY_EDGE = 8

export type OverlayBox = { left: number; top: number; width: number; height: number }

/** 纯算式：把这个盒子夹进视口，只保证四边留 `edge`，不改尺寸。 */
export function clampOverlay(box: OverlayBox, viewport: { width: number; height: number }, edge = OVERLAY_EDGE): { left: number; top: number } {
  // 用 clientWidth/clientHeight 而不是 innerWidth/innerHeight：后者把经典滚动条算进去，
  // 于是"留 8px"实际压在滚动条上。position: fixed 的包含块本来就是布局视口，要对齐的是同一个数。
  const { width: vw, height: vh } = viewport
  return {
    left: Math.min(Math.max(edge, box.left), Math.max(edge, vw - box.width - edge)),
    top: Math.min(Math.max(edge, box.top), Math.max(edge, vh - box.height - edge)),
  }
}

/**
 * 给"挂载即可见"的浮层（右键菜单这类）用：JSX 里先按请求点定位，
 * 本钩子在**绘制之前**按节点的真实尺寸夹一次，所以不会先闪到屏幕外再跳回来。
 */
export function useClampOverlay<T extends HTMLElement>(request: { x: number; y: number }) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const apply = () => {
      const root = document.documentElement
      const at = clampOverlay(
        { left: request.x, top: request.y, width: node.offsetWidth, height: node.offsetHeight },
        { width: root.clientWidth, height: root.clientHeight },
      )
      node.style.left = `${at.left}px`
      node.style.top = `${at.top}px`
    }
    apply()
    addEventListener('resize', apply)
    return () => { removeEventListener('resize', apply) }
  }, [request.x, request.y])
  return ref
}
