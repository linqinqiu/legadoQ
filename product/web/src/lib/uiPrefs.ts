/**
 * 界面偏好的服务端镜像：**换端口不丢设置**的桥。
 *
 * 背景（用户 2026-11-12 报的）：改端口后壁纸恢复默认、免责声明又弹一次。
 * 根因不是代码写错，是 localStorage 按 origin 隔离 —— 端口变了就是另一个站点。
 * 这里做两件事：
 * 1. `hydrateUiPrefs()`：启动时先从服务端把缺的这几项补回 localStorage（**在 React 渲染前**，
 *    否则会出现"先按默认渲染一帧，再跳成用户设置"的闪动，免责声明也会先弹一下）；
 * 2. `pushUiPref()`：本地改了之后去抖上行，让下一台/下一个端口能赎回。
 *
 * 刻意不做的事：
 * - 不做双向实时同步（多开两个端口的同一份服务互相覆盖，比丢失更糟）；
 * - 不上传壁纸二进制（体积大，且 `lib/wallpaper.ts` 与 IndexedDB 的分工是既有设计），
 *   只上传**设置**：上传过的图在新 origin 下需要重新上传一次，界面会明说"图不在"。
 * - 失败一律静默：偏好同步失败不能让启动或阅读卡住。
 */
import { uiPrefs } from './api/domains/prefs'

/** 需要跨 origin 赎回的键。新增一项就在这里加一条，并让对应模块在保存时调 `pushUiPref`。 */
export type UiPrefKey = 'agreement' | 'wallpaper' | 'reader-settings'

/**
 * 键 → 该模块自己的 localStorage key。
 *
 * 这些字符串**必须**与各模块里的那份逐字相同。它们是故意各自定义的：
 * 让 `wallpaper.ts` 反过来 import 本文件会形成环（它要调 `pushUiPref`）。
 * 判据 `UiPrefs.test.ts` 会读三个源文件核对这张表没漂。
 */
export const UI_PREF_STORAGE: Record<UiPrefKey, string> = {
  agreement: 'legadoq-agreement-v1',
  wallpaper: 'legado-wallpaper-v1',
  'reader-settings': 'legado-reader-settings-v2',
}

/** localStorage 里是字符串；服务端存的是 JSON 值。这两个函数把两端对齐，且可单测。 */
export function storageTextToJson(raw: string | null): unknown {
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function jsonToStorageText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** 启动时的补写：服务端有、本地没有的键才写（本地是更新的一份，不覆盖）。 */
export function mergePrefsIntoStorage(prefs: Record<string, unknown>): UiPrefKey[] {
  const restored: UiPrefKey[] = []
  if (typeof localStorage === 'undefined') return restored
  for (const key of Object.keys(UI_PREF_STORAGE) as UiPrefKey[]) {
    const text = jsonToStorageText(prefs[key])
    if (text === null) continue
    const storageKey = UI_PREF_STORAGE[key]
    try {
      if (localStorage.getItem(storageKey) !== null) continue
      localStorage.setItem(storageKey, text)
      restored.push(key)
    } catch {
      // 隐私模式 / 配额满：放弃这一项，不影响其它项与启动
    }
  }
  return restored
}

/** `hydrateUiPrefs` 的结果，判据与日志都读它（不读全局变量）。 */
export type HydrateResult = { ok: boolean; restored: UiPrefKey[] }

let hydrateOnce: Promise<HydrateResult> | null = null

/**
 * 启动前调用一次（`main.tsx` 的 async bootstrap）。
 * 服务端没起来/超时都只是 `ok:false`，**绝不 reject** —— 否则整页白屏。
 */
export function hydrateUiPrefs(timeoutMs = 900): Promise<HydrateResult> {
  if (hydrateOnce) return hydrateOnce
  const failed: HydrateResult = { ok: false, restored: [] }
  if (typeof window === 'undefined') {
    hydrateOnce = Promise.resolve(failed)
    return hydrateOnce
  }
  hydrateOnce = Promise.race([
    uiPrefs.all().then(
      result => ({ ok: true, restored: mergePrefsIntoStorage(result?.prefs ?? {}) }),
      () => failed,
    ),
    new Promise<HydrateResult>(resolve => setTimeout(() => resolve(failed), timeoutMs)),
  ]).catch(() => failed)
  return hydrateOnce
}

const timers = new Map<UiPrefKey, ReturnType<typeof setTimeout>>()

/** 本地保存后调它：去抖 600ms 上行一次（拖滑杆会连写几十次）。 */
export function pushUiPref(key: UiPrefKey, delayMs = 600): void {
  if (typeof window === 'undefined') return
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    const text = (() => {
      try { return localStorage.getItem(UI_PREF_STORAGE[key]) } catch { return null }
    })()
    const value = storageTextToJson(text)
    if (value === undefined) return
    void uiPrefs.set(key, value).catch(() => undefined)
  }, delayMs))
}

/** 判据用：把去抖计时器清掉，避免测试进程被挂着的定时器拖住。 */
export function flushUiPrefTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

/** 判据用：允许重复 hydrate（模块级 once 会让第二条用例拿到上一条的结果）。 */
export function resetHydrateForTest(): void {
  hydrateOnce = null
}
