import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { api } from '../../lib/api'
import { createProgressSaver, type ProgressSnapshot } from './content/progressSaver'

type Options = {
  sourceId: string
  bookUrl: string
  readSnapshot: () => ProgressSnapshot | null
}

export function useReaderProgress({ sourceId, bookUrl, readSnapshot }: Options) {
  const saver = useMemo(() => createProgressSaver(snapshot => api.saveProgress(
    sourceId,
    bookUrl,
    snapshot.chapterUrl,
    snapshot.chapterIndex,
    snapshot.scrollPosition,
    snapshot.position,
  )), [sourceId, bookUrl])
  const state = useSyncExternalStore(saver.subscribe, saver.getState, saver.getState)

  const schedule = useCallback(() => {
    saver.schedule(readSnapshot)
  }, [readSnapshot, saver])

  const persist = useCallback(() => {
    const snapshot = readSnapshot()
    if (snapshot) saver.persist(snapshot)
    else saver.flush()
  }, [readSnapshot, saver])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('online', persist)
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('online', persist)
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      saver.flush()
    }
  }, [persist, saver])

  return { schedule, persist, state }
}
