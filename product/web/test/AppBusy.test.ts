import test from 'node:test'
import assert from 'node:assert/strict'
import { getAppBusySourceCount, isAppBusy, READER_BUSY_SOURCE, registerAppBusy, subscribeAppBusy } from '../src/lib/appBusy.ts'

test('reader 打开即视为 busy，卸载后恢复空闲', () => {
  const release = registerAppBusy(READER_BUSY_SOURCE)
  try {
    assert.equal(isAppBusy(), true)
  } finally {
    release()
  }
  assert.equal(isAppBusy(), false)
})

test('并发忙碌源按引用计数，一个结束不误判空闲', () => {
  const releaseFirst = registerAppBusy('api-mutation')
  const releaseSecond = registerAppBusy('api-mutation')
  try {
    assert.equal(getAppBusySourceCount('api-mutation'), 2)
    releaseFirst()
    releaseFirst()
    assert.equal(getAppBusySourceCount('api-mutation'), 1)
    assert.equal(isAppBusy(), true)
  } finally {
    releaseFirst()
    releaseSecond()
  }
  assert.equal(getAppBusySourceCount('api-mutation'), 0)
  assert.equal(isAppBusy(), false)
})

test('订阅只在整体忙碌状态变化时通知，注销后不再接收', () => {
  const states: boolean[] = []
  const unsubscribe = subscribeAppBusy(busy => states.push(busy))
  const releaseReader = registerAppBusy(READER_BUSY_SOURCE)
  const releaseMutation = registerAppBusy('api-mutation')
  try {
    assert.deepEqual(states, [false, true])
    releaseReader()
    assert.deepEqual(states, [false, true], '仍有其他忙碌源时不能通知空闲')
    releaseMutation()
    assert.deepEqual(states, [false, true, false])
  } finally {
    releaseReader()
    releaseMutation()
    unsubscribe()
  }

  registerAppBusy(READER_BUSY_SOURCE)()
  assert.deepEqual(states, [false, true, false])
})
