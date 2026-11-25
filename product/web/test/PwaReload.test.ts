import test from 'node:test'
import assert from 'node:assert/strict'
import { createReloadWhenIdle } from '../src/components/pwaReload.ts'
import { isAppBusy, READER_BUSY_SOURCE, registerAppBusy } from '../src/lib/appBusy.ts'

function fakeTimers() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()
  return {
    setTimer(callback: () => void, delayMs: number): number {
      assert.equal(delayMs, 1500)
      const id = nextId++
      callbacks.set(id, callback)
      return id
    },
    clearTimer(id: number): void {
      callbacks.delete(id)
    },
    get size(): number {
      return callbacks.size
    },
    runNext(): void {
      const next = callbacks.entries().next()
      if (next.done) return
      callbacks.delete(next.value[0])
      next.value[1]()
    },
  }
}

test('reader busy 时保留待刷新动作，重复触发不叠 timer，空闲后只刷新一次', () => {
  const timers = fakeTimers()
  let reloads = 0
  const reloadWhenIdle = createReloadWhenIdle({
    isBusy: () => isAppBusy(),
    reload: () => { reloads += 1 },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  const releaseReader = registerAppBusy(READER_BUSY_SOURCE)
  try {
    reloadWhenIdle.request()
    reloadWhenIdle.request()
    reloadWhenIdle.request()
    assert.equal(timers.size, 1, '忙碌时只能有一个等待 timer')
    assert.equal(reloads, 0)

    timers.runNext()
    assert.equal(timers.size, 1, '仍忙碌时要继续等待，但不能叠加')
    assert.equal(reloads, 0)

    releaseReader()
    timers.runNext()
    assert.equal(reloads, 1)
    assert.equal(timers.size, 0)

    reloadWhenIdle.request()
    assert.equal(reloads, 1, '同一次更新只能刷新一次')
    assert.equal(timers.size, 0)
  } finally {
    releaseReader()
    reloadWhenIdle.dispose()
  }
})

test('卸载清理等待 timer，已排队回调与后续通知都不能再刷新', () => {
  let busy = true
  let queued: (() => void) | null = null
  const cleared: number[] = []
  let reloads = 0
  const reloadWhenIdle = createReloadWhenIdle({
    isBusy: () => busy,
    reload: () => { reloads += 1 },
    setTimer: callback => {
      queued = callback
      return 7
    },
    clearTimer: timer => { cleared.push(timer) },
  })

  reloadWhenIdle.request()
  assert.deepEqual(cleared, [])
  reloadWhenIdle.dispose()
  assert.deepEqual(cleared, [7])

  busy = false
  const queuedCallback = queued as (() => void) | null
  assert.ok(queuedCallback, 'request 应排下一颗 idle timer')
  queuedCallback()
  reloadWhenIdle.request()
  assert.equal(reloads, 0)
})
