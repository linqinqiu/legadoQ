/**
 * 后台更新提示（2026-11-25）。
 *
 * 为什么单独做：此前"检查更新"只有「关于」页那颗手动按钮 —— 用户不主动点就永远不知道有新版。
 * 但自动检查不能打扰启动：这台服务冷启动几十秒，探活一过就该进界面；GitHub 未认证 API
 * 每小时只有 60 次配额，页面一刷新就查一次很快耗尽。所以：
 *  - 拿到 /healthz 版本号后才后台查一次（fire-and-forget，不挡渲染）；
 *  - 节流窗口 6 小时，先记账再发请求，失败也不反复打 GitHub；
 *  - 只提供"有新版本"这一个事实，不弹窗、不打断、失败静默。
 *
 * 存储用 localStorage（按 origin 隔离）：换端口后会重新查一次，可接受；隐私模式禁止存储时
 * 节流退化成"每次都查"，但也只是多打一次 API，不影响功能。
 */
import type { UpdateCheckResult } from './api/types'

const LAST_CHECK_KEY = 'legado-update-hint-checked-v1'
/** GitHub 未认证 API 限额 60 次/小时；6 小时一次远低于该上限。 */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdateHint = { latest: string | null; url: string | null }

type Listener = () => void
const listeners = new Set<Listener>()
let snapshot: UpdateHint = { latest: null, url: null }

export function getUpdateHint(): UpdateHint {
  return snapshot
}

export function subscribeUpdateHint(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 发布一个新提示快照；供后台检查与测试直接调用。 */
export function setUpdateHint(latest: string | null, url: string | null = null): void {
  if (snapshot.latest === latest && snapshot.url === url) return
  snapshot = { latest, url }
  listeners.forEach(listener => listener())
}

/** 纯函数：距上次检查是否超过节流窗口。时间注入，判据无需真的等 6 小时。 */
export function shouldAutoCheck(lastCheckedAt: number, now = Date.now(), intervalMs = AUTO_CHECK_INTERVAL_MS): boolean {
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true
  return now - lastCheckedAt >= intervalMs
}

type HintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function readLast(storage: HintStorage): number {
  try {
    const raw = storage.getItem(LAST_CHECK_KEY)
    const value = raw == null ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * 启动后调用一次。节流通过才发请求；先写时间戳再发，避免失败时每次刷新都重试。
 * 只有明确报 `available` 且有版本号时才发布提示 —— 其它状态一律静默。
 */
export async function autoCheckUpdate(
  currentVersion: string,
  check: () => Promise<UpdateCheckResult>,
  storage: HintStorage = window.localStorage,
  now = Date.now(),
): Promise<void> {
  if (!shouldAutoCheck(readLast(storage), now)) return
  try { storage.setItem(LAST_CHECK_KEY, String(now)) } catch { /* 隐私模式禁止存储，照常查一次 */ }
  if (!currentVersion) return
  try {
    const result = await check()
    if (result.status === 'available' && result.latest) {
      setUpdateHint(result.latest, result.url ?? null)
    }
  } catch {
    // 更新提示是锦上添花：断网、上游 500、SSRF 闸门拒绝，都不该冒到用户面前。
  }
}

/** 测试用：清掉内存快照与节流时间戳。 */
export function resetUpdateHint(storage?: HintStorage): void {
  snapshot = { latest: null, url: null }
  listeners.forEach(listener => listener())
  if (storage) {
    try { storage.removeItem(LAST_CHECK_KEY) } catch { /* ignore */ }
  }
}
