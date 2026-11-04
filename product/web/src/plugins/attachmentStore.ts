/**
 * Attachment Store：Slot ↔ Extension 映射的全局 store。
 *
 * 页面通过 `attach(slot, extId)` 把 Extension 挂到 Slot，
 * `<ExtensionSlot name="slot">` 订阅该 Slot 下的 attachment 列表并渲染。
 * 运行时 attach/detach，无需重新编译页面。
 *
 * 实现用 React 内置的 `useSyncExternalStore`，不引入第三方状态库：
 * 这份映射只是「一个数组 + 四个纯操作」，外部订阅即可，没有中间件需求。
 */

import { useSyncExternalStore } from 'react'

export type Attachment = {
  slot: string
  extensionId: string
  /** 挂载顺序（数字越小越靠前）。 */
  order: number
}

type AttachmentState = {
  attachments: Attachment[]
}

let state: AttachmentState = { attachments: [] }

const listeners = new Set<() => void>()

function emit(next: AttachmentState) {
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return state
}

/** 挂载一个 Extension 到 Slot（同一 slot+extension 重复调用是幂等的）。 */
export function attach(slot: string, extensionId: string, order = 0) {
  if (state.attachments.some((a) => a.slot === slot && a.extensionId === extensionId)) {
    return
  }
  emit({
    attachments: [...state.attachments, { slot, extensionId, order }].sort(
      (a, b) => a.order - b.order,
    ),
  })
}

/** 撤销一个 Extension 与 Slot 的绑定。 */
export function detach(slot: string, extensionId: string) {
  emit({
    attachments: state.attachments.filter(
      (a) => !(a.slot === slot && a.extensionId === extensionId),
    ),
  })
}

/** 撤销某个 Slot 的所有绑定。 */
export function detachSlot(slot: string) {
  emit({ attachments: state.attachments.filter((a) => a.slot !== slot) })
}

/** 撤销某个 Extension 的所有绑定。 */
export function detachExtension(extensionId: string) {
  emit({ attachments: state.attachments.filter((a) => a.extensionId !== extensionId) })
}

/** 查询某个 Slot 下的 attachments（按 order 排序）。 */
export function attachmentsForSlot(slot: string): Attachment[] {
  return state.attachments.filter((a) => a.slot === slot).sort((a, b) => a.order - b.order)
}

/**
 * 订阅整个 attachment 表。
 *
 * 保持与旧 Zustand 版一致的调用形状：`const { attach, attachments } = useAttachmentStore()`。
 * 返回对象每次渲染重新组装，字段值来自同一份快照，不会引起无谓重渲染（列表本身按引用比较）。
 */
export function useAttachmentStore() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    attachments: snapshot.attachments,
    attach,
    detach,
    detachSlot,
    detachExtension,
    attachmentsForSlot,
  }
}