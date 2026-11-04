/**
 * Slot 声明与查询注册表。
 *
 * Slot 是 UI 中的“占位区域”，由宿主页面预留（如 `<ExtensionSlot name="reader.sidebar" />`），
 * Extension 通过 `attachmentStore` 动态挂载到 Slot 上。页面代码不需要知道谁挂了什么，
 * 实现“运行时注册，无需重新编译”。
 */

import type { ReactNode } from 'react'

export type SlotName = string

/** 已声明的 Slot 列表（文档化用途，运行时不强制必须预先声明）。 */
const declaredSlots = new Set<SlotName>()

/** 声明一个 Slot，供文档与自检使用。已存在的重复声明幂等。 */
export function declareSlot(name: SlotName) {
  declaredSlots.add(name)
}

/** 查询某个 Slot 是否已声明。 */
export function isSlotDeclared(name: SlotName): boolean {
  return declaredSlots.has(name)
}

/** 内置关键 Slot 名称（与页面中的 <ExtensionSlot> 保持一致）。 */
export const BUILTIN_SLOTS = {
  /** 书架卡片浮层（角标、进度环等）。 */
  bookshelfCardOverlay: 'bookshelf.card.overlay',
  /** 阅读器工具栏左侧。 */
  readerToolbarLeft: 'reader.toolbar.left',
  /** 阅读器工具栏右侧。 */
  readerToolbarRight: 'reader.toolbar.right',
  /** 阅读器侧边栏。 */
  readerSidebar: 'reader.sidebar',
  /** 设置页分区（第三方配置扩展）。 */
  settingsSection: 'settings.section',
} as const

// 在模块加载时声明内置 Slot
Object.values(BUILTIN_SLOTS).forEach(declareSlot)
