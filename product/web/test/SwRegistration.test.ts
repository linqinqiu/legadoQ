import test from 'node:test'
import assert from 'node:assert/strict'
import { registerServiceWorkerOnce, resetServiceWorkerRegistration } from '../src/lib/swRegistration.ts'

/**
 * 单次注册的回归判据。
 *
 * PwaManager 在「加载页」和「主壳」各挂一次，effect 会跑两遍；如果没有缓存，
 * `register('/sw.js')` 会被调两次（浏览器会去重 registration，但调用本身是两次）。
 * 这里直接测单例函数：并发、成功后重复调用、失败后重试，三种路径都要对。
 */

const fakeReg = { scope: '/' } as unknown as ServiceWorkerRegistration

test('并发/重复调用只打一次底层 register，参数固定为 /sw.js + scope /', async () => {
  resetServiceWorkerRegistration()
  let calls = 0
  const register = async (url: string, options?: RegistrationOptions) => {
    calls += 1
    assert.equal(url, '/sw.js')
    assert.deepEqual(options, { scope: '/' })
    return fakeReg
  }

  const [a, b] = await Promise.all([registerServiceWorkerOnce(register), registerServiceWorkerOnce(register)])
  assert.equal(calls, 1, '同一次挂载里的并发调用只该打一次底层')
  assert.equal(a, fakeReg)
  assert.equal(b, fakeReg)

  await registerServiceWorkerOnce(register)
  assert.equal(calls, 1, '成功后的后续调用不该再打底层')
})

test('失败不缓存：并发失败只打一次，之后还能重试', async () => {
  resetServiceWorkerRegistration()
  let calls = 0
  const failing = async () => {
    calls += 1
    throw new Error('boom')
  }

  const results = await Promise.allSettled([registerServiceWorkerOnce(failing), registerServiceWorkerOnce(failing)])
  assert.deepEqual(results.map(item => item.status), ['rejected', 'rejected'])
  assert.equal(calls, 1, '同一次失败只该有一次底层调用')

  // 关键：失败后 pending 被清空，下一次调用才会重新打 register（calls 从 1 变 2）。
  // 如果缓存没清，这里会一直复用 rejected promise，calls 仍是 1 —— 页面就再也没机会恢复。
  await assert.rejects(registerServiceWorkerOnce(failing))
  assert.equal(calls, 2, '失败后缓存应清空，下一次挂载能重试')
})

test('成功结果被复用：组件重挂不会重新注册', async () => {
  resetServiceWorkerRegistration()
  let calls = 0
  const register = async () => {
    calls += 1
    return fakeReg
  }

  await registerServiceWorkerOnce(register)
  await registerServiceWorkerOnce(register)
  await registerServiceWorkerOnce(register)
  assert.equal(calls, 1, '加载页 → 主壳换挂时不该再注册一次')
})
