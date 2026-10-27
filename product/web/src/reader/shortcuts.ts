/**
 * 快捷键表（用户 2026-10-02：「加入一些快捷键快捷方式」）。
 *
 * 这张表是**唯一的来源**：按键处理按它查动作，「快捷键」那张表也渲染它。
 * 分成两份手写清单的下场一定是其中一份说谎 —— 界面上写着 `T` 换主题而处理器里早就改了名字，
 * 这种错没有任何运行时会报出来（判据见 web/test/Shortcuts.test.ts）。
 *
 * `keys` 是 `normalizeKey` 之后的形状（小写、` ` 记成 `space`、`Escape` 记成 `esc`），
 * `display` 是给人看的那一列 —— 两者分开是因为键盘上印的是「←」而代码里是 `arrowleft`。
 */
import { PRIMARY_PAGES } from '../app/pageMeta'

export { PRIMARY_PAGES }

export type ShortcutScope = 'reader' | 'global'

export type Shortcut = {
  action: string
  label: string
  display: string
  keys: string[]
  group: string
  /** 只有"切到第 N 页"那几条用：按了要去的页面（动作名都是 navigate，靠这个字段分流）。 */
  page?: string
}

/** 只认主修饰键：Ctrl / ⌘ / Alt 一律不当成快捷键（那些是浏览器与操作系统的）；Shift 允许，`?` 与 `+` 本来就要按。 */
export function normalizeKey(event: { key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): string {
  if (event.ctrlKey || event.metaKey || event.altKey) return ''
  const key = event.key ?? ''
  if (key === ' ') return 'space'
  if (key === 'Escape') return 'esc'
  return key.toLowerCase()
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [role="textbox"]'

/**
 * 这个按键是不是"正在输入"。
 *
 * 输入框里的一切都不该被抢走；但**按钮只让空格与回车归它自己** ——
 * 原来把整个 `button` 都当输入区，于是点过一次目录里的章节之后焦点留在按钮上，
 * `T` `D` `S` 这些快捷键全都不响了，直到用户在别处点一下。
 */
export function isTypingTarget(target: unknown, key: string): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  if (!element || typeof element.closest !== 'function') return false
  if (element.closest(EDITABLE)) return true
  if (key === 'space' || key === 'enter') return !!element.closest('button, a, [role="option"]')
  return false
}

export function shortcutFor(table: Shortcut[], key: string): Shortcut | null {
  if (!key) return null
  return table.find(entry => entry.keys.includes(key)) ?? null
}

export const READER_SHORTCUTS: Shortcut[] = [
  { action: 'page-up', keys: ['pageup'], display: 'Page Up', label: '向上翻一屏（已经在开头就退回上一章末）', group: '翻阅' },
  { action: 'page-down', keys: ['pagedown', 'space'], display: 'Page Down / 空格', label: '向下翻一屏（已经在末尾就进下一章）', group: '翻阅' },
  { action: 'chapter-prev', keys: ['arrowleft'], display: '←', label: '上一章（翻页模式下是上一页）', group: '翻阅' },
  { action: 'chapter-next', keys: ['arrowright'], display: '→', label: '下一章（翻页模式下是下一页）', group: '翻阅' },
  { action: 'chapter-start', keys: ['home'], display: 'Home', label: '回到这一章的开头', group: '翻阅' },
  { action: 'chapter-end', keys: ['end'], display: 'End', label: '跳到这一章的末尾', group: '翻阅' },
  { action: 'font-increase', keys: ['+', '='], display: '+', label: '字号加大一档', group: '排版' },
  { action: 'font-decrease', keys: ['-', '_'], display: '-', label: '字号减小一档', group: '排版' },
  { action: 'theme-next', keys: ['t'], display: 'T', label: '换下一套主题', group: '排版' },
  { action: 'toc', keys: ['d'], display: 'D', label: '打开 / 收起目录', group: '面板' },
  { action: 'settings', keys: ['s'], display: 'S', label: '打开 / 收起阅读设置', group: '面板' },
  { action: 'tts', keys: ['m'], display: 'M', label: '朗读：播放 / 暂停', group: '面板' },
  { action: 'fullscreen', keys: ['f'], display: 'F', label: '全屏 / 退出全屏', group: '面板' },
  { action: 'close', keys: ['esc'], display: 'Esc', label: '关掉当前这张抽屉', group: '面板' },
  { action: 'font-wheel', keys: [], display: 'Ctrl / ⌘ + 滚轮', label: '直接调字号（不用先开设置）', group: '排版' },
]

/**
 * 一级页面**只在这里列一次**：顶栏从左到右的按钮、数字键 1–6、`Alt + ← / →` 的循环顺序，
 * 三处都从这一张表取。
 *
 * 原来它是三份：顶栏在 `AppHeader.tsx` 里手写五个、`main.tsx` 里 `NAV` 一份七个
 * （而且 发现 与 书源 的顺序和顶栏相反）、这张表又一份 —— 三份各自漏过不同的页面。
 * AGENTS §5「按键表与处理器必须同源」同一个病。
 *
 * 归属判据（用户 2026-10-08 定的框架，对齐 Legado-with-MD3 的 IA；2026-10-09 用户要求
 * 把「书源」放回顶栏，故书源管理重新是一级入口）。**顶栏只放"有独立页面、会停下来管理"的目的地**。
 * 规则 / 备份 / 更新日志 / 关于 0.6.27 起改为悬浮层（PageDialog），不再占路由。
 *
 * `nav` 是顶栏上那两个字，`label` 是这张表里说全的名字。
 */
/**
 * 一级入口表已搬到 `app/pageMeta.ts` —— 顶栏、数字键、路由解析共用同一张表。
 * 这里 re-export，既有调用点与判据不用改 import 路径。
 */

/** 数字键切页：键 = 表里的位置，标签 = 说全的那个名字。 */
const PAGE_KEYS: [string, string, string][] = PRIMARY_PAGES.map((item, index) =>
  [String(index + 1), item.page, item.label])

export const GLOBAL_SHORTCUTS: Shortcut[] = [
  { action: 'search', keys: ['/'], display: '/', label: '聚焦当前这一页的搜索 / 筛选框', group: '全局' },
  { action: 'search', keys: [], display: 'Ctrl / ⌘ + F', label: '同上（这一档不占浏览器的页内查找）', group: '全局' },
  { action: 'nav-cycle', keys: [], display: 'Alt + ← / →', label: '在一级页面之间循环切换', group: '全局' },
  { action: 'help', keys: ['?'], display: '?', label: '打开 / 关掉这张快捷键表', group: '全局' },
  { action: 'close-help', keys: ['esc'], display: 'Esc', label: '关掉这张表', group: '全局' },
  { action: 'logs', keys: ['l'], display: 'L', label: '打开运行日志', group: '全局' },
  ...PAGE_KEYS.map(([key, page, label]) => ({
    action: 'navigate',
    keys: [key],
    display: key,
    label: `切到「${label}」这一页`,
    group: '全局',
    page,
  })),
]

export const SHORTCUT_TABLES: { scope: ShortcutScope; title: string; items: Shortcut[] }[] = [
  { scope: 'reader', title: '阅读器', items: READER_SHORTCUTS },
  { scope: 'global', title: '全局', items: GLOBAL_SHORTCUTS },
]
