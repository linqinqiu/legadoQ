import type { LogicalPosition } from './logicalPosition'

export type ProgressSnapshot = {
  chapterUrl: string
  chapterIndex: number
  scrollPosition: number
  position?: LogicalPosition
}

export type ProgressSaveState = {
  saving: boolean
  failed: boolean
}

export function createProgressSaver(save: (snapshot: ProgressSnapshot) => Promise<unknown>) {
  let pending: ProgressSnapshot | (() => ProgressSnapshot | null) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: ProgressSaveState = { saving: false, failed: false }
  const listeners = new Set<() => void>()

  const updateState = (next: ProgressSaveState) => {
    if (state.saving === next.saving && state.failed === next.failed) return
    state = next
    listeners.forEach(listener => listener())
  }

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const drain = async () => {
    updateState({ saving: true, failed: state.failed })
    while (pending !== null) {
      cancelTimer()
      const snapshot = typeof pending === 'function' ? pending() : pending
      pending = null
      if (snapshot === null) continue
      try {
        await save(snapshot)
      } catch {
        if (pending !== null) {
          updateState({ saving: true, failed: true })
          continue
        }
        pending = snapshot
        updateState({ saving: false, failed: true })
        return
      }
    }
    updateState({ saving: false, failed: false })
  }

  const flush = () => {
    cancelTimer()
    if (!state.saving && pending !== null) void drain()
  }

  return {
    schedule(readSnapshot: () => ProgressSnapshot | null) {
      pending = readSnapshot
      if (timer === null) timer = setTimeout(flush, 1200)
    },
    persist(snapshot: ProgressSnapshot) {
      pending = snapshot
      flush()
    },
    flush,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
