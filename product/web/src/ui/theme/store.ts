/**
 * 动态主题状态（`ui/theme` 的单一真相）。
 *
 * 形状照 `lib/brandStore.ts`：external store + `useSyncExternalStore`，不引状态库。
 * 为什么需要它而不是塞进 `ReaderSettings`：皮肤是**用户选的**，动态主题是**由封面算出来的**——
 * 它随"现在看哪本书"变，随打开/关闭阅读器变，不该被当成一件用户偏好写进设置里。
 * 设置里只有一个开关（`ReaderSettings.coverTheme`），其余状态都住这里。
 *
 * 三个约定：
 * 1. `active=false` 是唯一表示"没有动态主题"的状态；不留 `null` 与它并存。
 * 2. 同一份 seed 重复写入**不通知**（阅读器重渲染很频繁，否则每帧都重算一遍配色）。
 * 3. 持久化只做"刷新后不闪一下"用：写入失败（隐私模式/无 localStorage）不算错误。
 */
import type { DynamicThemeState } from './types'

export type { DynamicThemeState }

const STORAGE_KEY = 'legado-dynamic-theme-v1'

export const EMPTY_DYNAMIC_THEME: DynamicThemeState = {
  active: false,
  seed: '',
  label: '',
  origin: 'none',
  bookId: null,
}

function readStorage(): DynamicThemeState {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_DYNAMIC_THEME
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_DYNAMIC_THEME
    const parsed = JSON.parse(raw) as Partial<DynamicThemeState> | null
    if (!parsed || typeof parsed !== 'object') return EMPTY_DYNAMIC_THEME
    // 只有"有 seed 且自述 active"才恢复：半截状态宁可回到默认，也不要一个没有颜色的覆盖层。
    if (parsed.active !== true || typeof parsed.seed !== 'string' || !/^#[0-9a-f]{6}$/i.test(parsed.seed)) {
      return EMPTY_DYNAMIC_THEME
    }
    const origin = parsed.origin === 'cover' || parsed.origin === 'wallpaper' || parsed.origin === 'brand' || parsed.origin === 'manual'
      ? parsed.origin
      : 'manual'
    return {
      active: true,
      seed: parsed.seed.toLowerCase(),
      label: typeof parsed.label === 'string' ? parsed.label.slice(0, 80) : '',
      origin,
      bookId: typeof parsed.bookId === 'string' ? parsed.bookId : null,
    }
  } catch {
    return EMPTY_DYNAMIC_THEME
  }
}

function writeStorage(state: DynamicThemeState): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (!state.active) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存不下就只是刷新后少一次复原，界面不受影响。
  }
}

let snapshot: DynamicThemeState = readStorage()
const listeners = new Set<() => void>()

function sameTheme(a: DynamicThemeState, b: DynamicThemeState): boolean {
  return a.active === b.active && a.seed === b.seed && a.label === b.label
    && a.origin === b.origin && a.bookId === b.bookId
}

function commit(next: DynamicThemeState): void {
  if (sameTheme(snapshot, next)) return
  snapshot = next
  writeStorage(next)
  listeners.forEach(listener => listener())
}

export function getDynamicTheme(): DynamicThemeState {
  return snapshot
}

export function subscribeDynamicTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 打开一本书时按封面颜色覆盖当前配色。非法 seed 直接忽略，不把界面弄成黑屏。 */
export function setDynamicTheme(input: {
  seed: string
  label?: string
  origin?: DynamicThemeState['origin']
  bookId?: string | null
}): void {
  const seed = String(input.seed || '').trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(seed)) return
  commit({
    active: true,
    seed,
    label: (input.label ?? '').slice(0, 80),
    origin: input.origin ?? 'cover',
    bookId: input.bookId ?? null,
  })
}

/** 回到用户选的皮肤。关阅读器、关掉开关、封面算不出种子时都走这一条。 */
export function clearDynamicTheme(): void {
  commit(EMPTY_DYNAMIC_THEME)
}

/** 判据用：把模块状态拨回初始值（不碰监听者）。 */
export function resetDynamicThemeForTest(): void {
  snapshot = EMPTY_DYNAMIC_THEME
  writeStorage(snapshot)
}
