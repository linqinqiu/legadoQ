import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createProgressSaver, type ProgressSnapshot } from '../src/features/reader/content/progressSaver'

const snapshot = (position: number, chapterIndex = 0): ProgressSnapshot => ({
  chapterUrl: `chapter-${chapterIndex}`,
  chapterIndex,
  scrollPosition: position,
  position: { charOffset: Math.round(position * 1000), paragraphAnchor: '正文', positionChecksum: 'checksum' },
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('进度保存：连续位置共用一个定时器，保存最后的完整快照', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => { saved.push(value) })
  saver.schedule(() => snapshot(0.1))
  t.mock.timers.tick(600)
  saver.schedule(() => snapshot(0.8, 1))
  t.mock.timers.tick(599)
  assert.equal(saved.length, 0)
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(saved, [snapshot(0.8, 1)])
  assert.deepEqual(saver.getState(), { saving: false, failed: false })
})

test('进度保存：前次请求完成前不并发，只补存最新位置', async () => {
  const first = deferred()
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => {
    saved.push(value)
    if (saved.length === 1) await first.promise
  })
  saver.persist(snapshot(0.1))
  saver.persist(snapshot(0.4))
  saver.persist(snapshot(0.9, 1))
  assert.deepEqual(saved, [snapshot(0.1)])
  assert.equal(saver.getState().saving, true)
  first.resolve()
  await nextTurn()
  assert.deepEqual(saved, [snapshot(0.1), snapshot(0.9, 1)])
  assert.deepEqual(saver.getState(), { saving: false, failed: false })
})

test('进度保存：失败不空转重试，保留位置并通知，显式重试成功才清除失败', async () => {
  const retry = deferred()
  const saved: ProgressSnapshot[] = []
  let notifications = 0
  const saver = createProgressSaver(async value => {
    saved.push(value)
    if (saved.length === 1) throw new Error('网络中断')
    await retry.promise
  })
  const unsubscribe = saver.subscribe(() => { notifications++ })
  saver.persist(snapshot(0.6))
  await nextTurn()
  assert.equal(saved.length, 1)
  assert.deepEqual(saver.getState(), { saving: false, failed: true })
  saver.flush()
  assert.deepEqual(saver.getState(), { saving: true, failed: true })
  assert.deepEqual(saved, [snapshot(0.6), snapshot(0.6)])
  retry.resolve()
  await nextTurn()
  assert.deepEqual(saver.getState(), { saving: false, failed: false })
  assert.equal(notifications, 4)
  unsubscribe()
  saver.persist(snapshot(0.7))
  await nextTurn()
  assert.equal(notifications, 4)
})

test('进度保存：旧请求失败不能覆盖已经排队的新章节', async () => {
  const first = deferred()
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => {
    saved.push(value)
    if (saved.length === 1) await first.promise
  })
  saver.persist(snapshot(0.9, 0))
  saver.persist(snapshot(0.2, 1))
  first.reject(new Error('旧请求失败'))
  await nextTurn()
  assert.deepEqual(saved, [snapshot(0.9, 0), snapshot(0.2, 1)])
  assert.deepEqual(saver.getState(), { saving: false, failed: false })
})

test('进度保存：前后请求均失败时，重试保留最新而非旧位置', async () => {
  const first = deferred()
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => {
    saved.push(value)
    if (saved.length === 1) await first.promise
    if (saved.length === 2) throw new Error('仍未恢复')
  })
  saver.persist(snapshot(0.9, 0))
  saver.persist(snapshot(0.2, 1))
  first.reject(new Error('断线'))
  await nextTurn()
  assert.deepEqual(saver.getState(), { saving: false, failed: true })
  saver.flush()
  await nextTurn()
  assert.deepEqual(saved, [snapshot(0.9, 0), snapshot(0.2, 1), snapshot(0.2, 1)])
})

test('进度保存：清除定时器后还能重新安排，退出立即补存且不会再重复触发', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => { saved.push(value) })
  saver.schedule(() => snapshot(0.2))
  saver.flush()
  await nextTurn()
  saver.schedule(() => snapshot(0.7))
  t.mock.timers.tick(1200)
  await nextTurn()
  assert.deepEqual(saved, [snapshot(0.2), snapshot(0.7)])
  saver.flush()
  t.mock.timers.tick(1200)
  assert.equal(saved.length, 2)
})

test('进度保存：不同书籍的队列互不覆盖', async () => {
  const first = deferred()
  const savedA: ProgressSnapshot[] = []
  const savedB: ProgressSnapshot[] = []
  const a = createProgressSaver(async value => { savedA.push(value); await first.promise })
  const b = createProgressSaver(async value => { savedB.push(value) })
  a.persist(snapshot(0.1))
  a.persist(snapshot(0.4))
  b.persist(snapshot(0.8))
  await nextTurn()
  assert.deepEqual(savedA, [snapshot(0.1)])
  assert.deepEqual(savedB, [snapshot(0.8)])
  first.resolve()
  await nextTurn()
  assert.deepEqual(savedA, [snapshot(0.1), snapshot(0.4)])
  assert.deepEqual(savedB, [snapshot(0.8)])
})

test('进度保存：空队列不发请求，状态快照在没有变化时保持同一引用', () => {
  const saver = createProgressSaver(async () => { assert.fail('空队列不能发送') })
  const state = saver.getState()
  saver.flush()
  assert.equal(saver.getState(), state)
})

test('进度保存：连续滚动不逐帧测量位置，失败重试使用已捕获的完整快照', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  let position = 0.1
  const saved: ProgressSnapshot[] = []
  const saver = createProgressSaver(async value => {
    saved.push(value)
    if (saved.length === 1) throw new Error('暂时不可用')
  })
  const read = () => { reads++; return snapshot(position) }
  for (let i = 0; i < 100; i++) saver.schedule(read)
  assert.equal(reads, 0)
  position = 0.8
  t.mock.timers.tick(1200)
  await nextTurn()
  assert.equal(reads, 1)
  position = 0.9
  saver.flush()
  await nextTurn()
  assert.equal(reads, 1)
  assert.deepEqual(saved, [snapshot(0.8), snapshot(0.8)])
})

test('进度保存：尚未载入正文时不发送空位置', () => {
  const saver = createProgressSaver(async () => { assert.fail('不能发送空位置') })
  saver.schedule(() => null)
  saver.flush()
  assert.deepEqual(saver.getState(), { saving: false, failed: false })
})
