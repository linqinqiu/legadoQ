import test from 'node:test'
import assert from 'node:assert/strict'
import { toast, ToastItem } from '../src/components/Toast.tsx'

test('toast store - full method suite and timeout dismiss', async () => {
  // Clear any pre-existing toasts from earlier test suites
  const initial = (toast as any).toasts as ToastItem[]
  initial.slice().forEach(t => toast.dismiss(t.id))

  const captured: ToastItem[][] = []
  const unsubscribe = toast.subscribe(items => {
    captured.push(items)
  })

  try {
    const id1 = toast.success('成功提示', 50)
    assert.ok(id1)
    const id2 = toast.info('普通消息', 50)
    assert.ok(id2)
    const id3 = toast.error('错误警告', 50)
    assert.ok(id3)
    const id4 = toast.warning('注意警告', 50)
    assert.ok(id4)

    // Manual dismiss id1
    toast.dismiss(id1)

    // Wait for timeout auto-dismiss of id2, id3, id4 (50ms)
    await new Promise(resolve => setTimeout(resolve, 100))

    const latest = captured.at(-1) || []
    assert.equal(latest.length, 0)
  } finally {
    unsubscribe()
  }
})

test('toast store - 什么都没移除时不再通知一轮（手动关与定时器会撞在一起）', () => {
  let notifies = 0
  const unsubscribe = toast.subscribe(() => { notifies += 1 })
  try {
    const id = toast.show('会被手动关掉', 'info', 5000)
    const afterShow = notifies
    assert.ok(afterShow >= 2, 'show 至少要通知一轮，否则这条判据在演空戏')
    toast.dismiss(id)
    const afterManual = notifies
    assert.equal(afterManual, afterShow + 1, '手动关闭该通知一轮')
    toast.dismiss(id) // 它那条 setTimeout(dismiss) 稍后会原样再来一次
    assert.equal(notifies, afterManual, '移除不了任何东西就不该再让整棵树重渲染一次')
  } finally {
    unsubscribe()
  }
})
