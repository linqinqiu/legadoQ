import type { Page } from './nav'

/**
 * 一级页面的**元数据表** —— 路由的唯一来源。
 *
 * 从前这件事散在三处：`main.tsx` 的 `pageFromHash` 三元链、`shortcuts.ts` 的
 * `PRIMARY_PAGES`、`AppHeader.tsx` 的 `AppPage` union。加一页要改五处，漏一处就是
 * 「点了没反应」或「数字键按不到」。现在只在这里加一行。
 *
 * 这里**只放纯数据**，不放 React 组件 —— 快捷键表、顶栏、路由解析都读它，
 * 不该因为多一张表就把整棵页面树拖进测试。
 *
 * ★ 为什么住 `lib/`（shared）而不是 `app/`（shell）：顶栏（`components/`）与快捷键表
 * （`features/reader/`）都要读它，而这两者都**不允许依赖 shell** —— 放在 `app/` 里会让
 * 「组合根」变成共享数据的存放地，于是 shared 与 features 各自反向依赖 shell 一次
 * （实测正是 2 条：`app/AppHeader.tsx`、`features/reader/interaction/shortcuts.ts`）。
 * 它是纯数据、零 React 依赖，本来就属于 shared。判据见
 * `web/test/ArchitectureBoundary.test.ts`「shell 只能被组合根 import」。
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
