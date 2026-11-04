/**
 * Extension 注册表。
 *
 * Extension 是可复用的 React 组件，由 id + 组件 + 元数据组成。
 * 页面不直接 import Extension，而是通过 `attachmentStore` 把 Extension 挂到 Slot，
 * 再由 `<ExtensionSlot name="...">` 渲染。
 */

import type { ComponentType } from 'react'

export type ExtensionId = string

export interface ExtensionRegistration {
  id: ExtensionId
  /** 组件：接收 `props`（由挂载方透传，暂定空对象，未来可按需扩展）。 */
  component: ComponentType<{ [key: string]: unknown }>
  /** 可读名称，用于调试与管理界面。 */
  label: string
  /** 所属 Slot 名称（建议值，实际挂载以 attachmentStore 为准）。 */
  defaultSlot?: string
  /** 是否内置（false = 用户/第三方注册）。 */
  builtin: boolean
}

const extensions = new Map<ExtensionId, ExtensionRegistration>()

/** 注册一个 Extension。id 已存在时返回 false（不覆盖），除非 replace 为 true。 */
export function registerExtension(reg: ExtensionRegistration, replace = false): boolean {
  if (!replace && extensions.has(reg.id)) return false
  extensions.set(reg.id, reg)
  return true
}

/** 注销一个 Extension。返回是否真的删除了。 */
export function unregisterExtension(id: ExtensionId): boolean {
  return extensions.delete(id)
}

/** 按 id 取 Extension；没有返回 null。 */
export function getExtension(id: ExtensionId): ExtensionRegistration | null {
  return extensions.get(id) ?? null
}

/** 所有已注册 Extension。 */
export function allExtensions(): ExtensionRegistration[] {
  return Array.from(extensions.values())
}

/** 判断某个 id 是否已注册。 */
export function hasExtension(id: ExtensionId): boolean {
  return extensions.has(id)
}
