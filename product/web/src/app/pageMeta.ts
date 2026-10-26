import type { Page } from '../lib/nav'

/**
 * 一级页面的**元数据表** —— 路由的唯一来源。
 *
 * 从前这件事散在三处：`main.tsx` 的 `pageFromHash` 三元链、`shortcuts.ts` 的
 * `PRIMARY_PAGES`、`AppHeader.tsx` 的 `AppPage` union。加一页要改五处，漏一处就是
 * 「点了没反应」或「数字键按不到」。现在只在这里加一行。
 *
 * 这里**只放纯数据**，不放 React 组件 —— 快捷键表、顶栏、路由解析都读它，
 * 不该因为多一张表就把整棵页面树拖进测试。
 */
export type PageMeta = {
  /** 路由 key，对应 `#<key>`。 */
  key: Page
  /** 顶栏文字。 */
  nav: string
  /** 快捷键表里的全名（「切到「书库」这一页」）。 */
  label: string
  /** 是否进顶栏与数字键（1..N）。阅读器是整屏态，不进。 */
  primary: boolean
}

export const PAGES: PageMeta[] = [
  { key: 'library', nav: '书库', label: '书库', primary: true },
  { key: 'shelf', nav: '书架', label: '书架', primary: true },
  { key: 'sources', nav: '书源', label: '书源', primary: true },
  { key: 'explore', nav: '发现', label: '发现', primary: true },
  { key: 'subscriptions', nav: '订阅', label: '订阅', primary: true },
  { key: 'settings', nav: '设置', label: '设置', primary: true },
  { key: 'reader', nav: '阅读', label: '阅读', primary: false },
]

/** 顶栏与数字键用的一级页面（顺序 = 顶栏顺序 = 数字键顺序）。 */
export const PRIMARY_PAGES = PAGES
  .filter(item => item.primary)
  .map(({ key, nav, label }) => ({ page: key, nav, label }))

/** 从 hash 解析页面；不认识的一律回书库（深链写错不该白屏）。 */
export function pageFromHash(hash: string = location.hash): Page {
  return PAGES.find(item => hash === `#${item.key}`)?.key ?? 'library'
}
