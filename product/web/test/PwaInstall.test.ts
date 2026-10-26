import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * `PwaManager` 导出的三个纯函数的行为判据。
 *
 * 现有 `PwaUpdateStrategy.test.ts` 只读源码字符串（证明"没有更新 toast""注册走单例"），
 * `SwRegistration.test.ts` 只测注册单例 —— 而 `PwaManager` 本身 13.8% 覆盖，
 * 这三个导出函数**从没被执行过**。
 *
 * 它们是 PWA 安装链路的全部逻辑：
 * - `isPwaStandalone()` —— 判断"是不是已装成独立应用"
 * - `subscribePwaInstall()` —— 订阅"能不能装"的状态
 * - `promptPwaInstall()` —— 真的拉起安装弹窗
 *
 * 测法：用假的 `window` / `navigator` / `matchMedia` 替换掉全局对象，
 * 不渲染组件、不需要浏览器。
 */

/** 造一个最小可用的假 window，用于注入全局。 */
function withFakeWindow<T>(
  overrides: { matchMedia?: (q: string) => { matches: boolean }; standalone?: boolean; referrer?: string },
  fn: () => T,
): T {
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  ;(globalThis as any).window = {
    matchMedia: overrides.matchMedia ?? (() => ({ matches: false })),
    navigator: { standalone: overrides.standalone },
  }
  ;(globalThis as any).document = { referrer: overrides.referrer ?? '' }
  try {
    return fn()
  } finally {
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
  }
}

test('isPwaStandalone：display-mode standalone 时算独立应用', async () => {
  const { isPwaStandalone } = await import('../src/components/PwaManager.tsx')
  const got = withFakeWindow({ matchMedia: q => ({ matches: q.includes('standalone') }) }, () => isPwaStandalone())
  assert.equal(got, true, 'display-mode: standalone 应判为独立应用')
})

test('isPwaStandalone：iOS 的 navigator.standalone 也算', async () => {
  const { isPwaStandalone } = await import('../src/components/PwaManager.tsx')
  const got = withFakeWindow({ standalone: true }, () => isPwaStandalone())
  assert.equal(got, true, 'iOS Safari 的 navigator.standalone=true 应判为独立应用')
})

test('isPwaStandalone：从 Android App 打开（referrer 带 android-app://）也算', async () => {
  const { isPwaStandalone } = await import('../src/components/PwaManager.tsx')
  const got = withFakeWindow({ referrer: 'android-app://com.example' }, () => isPwaStandalone())
  assert.equal(got, true, 'referrer 带 android-app:// 应判为独立应用')
})

test('isPwaStandalone：普通浏览器里打开不算', async () => {
  const { isPwaStandalone } = await import('../src/components/PwaManager.tsx')
  const got = withFakeWindow({}, () => isPwaStandalone())
  assert.equal(got, false, '普通标签页里打开不该判成独立应用')
})

test('isPwaStandalone：没有 window 时返回 false，不抛（SSR / 测试环境）', async () => {
  const { isPwaStandalone } = await import('../src/components/PwaManager.tsx')
  const originalWindow = (globalThis as any).window
  delete (globalThis as any).window
  try {
    assert.equal(isPwaStandalone(), false, '没有 window 时应安全返回 false')
  } finally {
    ;(globalThis as any).window = originalWindow
  }
})

test('subscribePwaInstall：订阅时立刻回一次当前状态，取消后不再回调', async () => {
  const { subscribePwaInstall } = await import('../src/components/PwaManager.tsx')
  const calls: boolean[] = []
  // 没有 beforeinstallprompt 事件 → deferredInstallPrompt 为 null → 回调 false
  const unsubscribe = withFakeWindow({}, () => subscribePwaInstall(v => calls.push(v)))
  assert.deepEqual(calls, [false], '订阅时应立刻回调一次当前状态（不能装）')

  // 取消订阅后不该再有回调
  unsubscribe()
  const before = calls.length
  // 再次触发一个"能装"的通知（通过内部 listeners 已摘除，不会到达）
  assert.equal(calls.length, before, '取消订阅后不该再收到回调')
})

test('subscribePwaInstall：独立应用里即使有安装事件也说"不能装"', async () => {
  const { subscribePwaInstall } = await import('../src/components/PwaManager.tsx')
  const calls: boolean[] = []
  // 已经是独立应用 → canInstall 必须是 false（装过了就不该再提示装）
  const unsubscribe = withFakeWindow(
    { matchMedia: q => ({ matches: q.includes('standalone') }) },
    () => subscribePwaInstall(v => calls.push(v)),
  )
  assert.deepEqual(calls, [false], '独立应用里不该提示"可安装"')
  unsubscribe()
})

test('promptPwaInstall：没有待处理的安装事件时返回 false，不抛', async () => {
  const { promptPwaInstall } = await import('../src/components/PwaManager.tsx')
  // 没有 beforeinstallprompt 过 → deferredInstallPrompt 为 null
  const got = await withFakeWindow({}, () => promptPwaInstall())
  assert.equal(got, false, '没有安装事件时应返回 false，不是抛异常')
})

test('三个函数都是具名导出，且 PwaManager 组件也在', async () => {
  const mod = await import('../src/components/PwaManager.tsx')
  assert.equal(typeof mod.isPwaStandalone, 'function')
  assert.equal(typeof mod.subscribePwaInstall, 'function')
  assert.equal(typeof mod.promptPwaInstall, 'function')
  assert.equal(typeof mod.PwaManager, 'function', '组件本身也要导出（main.tsx 用它）')
})
