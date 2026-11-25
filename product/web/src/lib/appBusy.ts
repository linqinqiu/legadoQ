/** 命名忙碌源的引用计数：同一来源可并发注册，全部注销后才算空闲。 */
const sourceCounts = new Map<string, number>()
const listeners = new Set<(busy: boolean) => void>()

export const READER_BUSY_SOURCE = 'reader'

function notify(busy: boolean): void {
  for (const listener of [...listeners]) listener(busy)
}

/** 注册一个忙碌源；返回的注销函数可重复调用，且只释放本次注册。 */
export function registerAppBusy(source: string): () => void {
  const wasBusy = isAppBusy()
  sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
  if (!wasBusy) notify(true)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = sourceCounts.get(source) ?? 0
    if (count <= 1) sourceCounts.delete(source)
    else sourceCounts.set(source, count - 1)
    if (!isAppBusy()) notify(false)
  }
}

export function getAppBusySourceCount(source: string): number {
  return sourceCounts.get(source) ?? 0
}

export function isAppBusy(): boolean {
  return sourceCounts.size > 0
}

/** 订阅整体忙碌状态；先同步当前值，之后只在 false/true 切换时回调。 */
export function subscribeAppBusy(listener: (busy: boolean) => void): () => void {
  listeners.add(listener)
  listener(isAppBusy())
  return () => { listeners.delete(listener) }
}
