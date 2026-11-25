interface ReloadWhenIdleDependencies {
  isBusy: () => boolean
  reload: () => void
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (timer: number) => void
}

/** 合并重复更新通知：忙碌时只保留一个等待 timer，空闲后只刷新一次。 */
export function createReloadWhenIdle(deps: ReloadWhenIdleDependencies) {
  let pending = false
  let refreshing = false
  let disposed = false
  let timer: number | null = null

  const check = (): void => {
    if (disposed || refreshing || !pending || timer !== null) return
    if (deps.isBusy()) {
      timer = deps.setTimer(() => {
        timer = null
        check()
      }, 1500)
      return
    }
    pending = false
    refreshing = true
    deps.reload()
  }

  return {
    request(): void {
      if (disposed || refreshing) return
      pending = true
      check()
    },
    dispose(): void {
      disposed = true
      pending = false
      if (timer !== null) deps.clearTimer(timer)
      timer = null
    },
  }
}
