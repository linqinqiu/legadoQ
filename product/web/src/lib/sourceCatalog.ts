import { sources } from './api/domains/sources'
import type { SourceSummary } from './api/types'

export type SourceCatalogStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type SourceCatalogSnapshot = {
  status: SourceCatalogStatus
  items: SourceSummary[]
  error: string | null
  updatedAt: number | null
}

export type SourceCatalog = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SourceCatalogSnapshot
  load: () => Promise<SourceSummary[]>
  invalidate: () => Promise<SourceSummary[]>
  replace: (items: SourceSummary[]) => void
}

const EMPTY_ITEMS: SourceSummary[] = []

export function createSourceCatalog(
  loadSources: () => Promise<SourceSummary[]> = () => sources.list(),
): SourceCatalog {
  let snapshot: SourceCatalogSnapshot = {
    status: 'idle',
    items: EMPTY_ITEMS,
    error: null,
    updatedAt: null,
  }
  const listeners = new Set<() => void>()
  let inFlight: Promise<SourceSummary[]> | null = null
  let refreshInFlight: Promise<SourceSummary[]> | null = null
  let generation = 0

  const publish = (patch: Partial<SourceCatalogSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }

  const request = (): Promise<SourceSummary[]> => {
    const requestGeneration = ++generation
    publish({ status: 'loading', error: null })
    let pending: Promise<SourceSummary[]>
    try {
      pending = loadSources()
    } catch (error) {
      pending = Promise.reject(error)
    }
    const loaded = pending.then(
      items => {
        if (requestGeneration === generation) {
          publish({ status: 'ready', items, error: null, updatedAt: Date.now() })
        }
        return items
      },
      (error: unknown) => {
        if (requestGeneration === generation) {
          publish({
            status: 'failed',
            error: error instanceof Error ? error.message : '无法载入书源',
          })
        }
        throw error
      },
    )
    const tracked = loaded.finally(() => {
      if (inFlight === tracked) inFlight = null
    })
    inFlight = tracked
    return tracked
  }

  const load = (): Promise<SourceSummary[]> => {
    if (inFlight) return inFlight
    if (snapshot.status === 'ready') return Promise.resolve(snapshot.items)
    return request()
  }

  const invalidate = (): Promise<SourceSummary[]> => {
    if (refreshInFlight) return refreshInFlight
    const tracked = request()
    const refresh = tracked.finally(() => {
      if (refreshInFlight === refresh) refreshInFlight = null
    })
    refreshInFlight = refresh
    return refresh
  }

  const replace = (items: SourceSummary[]) => {
    generation += 1
    inFlight = null
    refreshInFlight = null
    publish({ status: 'ready', items, error: null, updatedAt: Date.now() })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    load,
    invalidate,
    replace,
  }
}

export const sourceCatalog = createSourceCatalog()
