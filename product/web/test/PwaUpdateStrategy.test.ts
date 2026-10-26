import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * PWA 更新策略的判据。
 *
 * 策略是「autoUpdate」：新 SW 自己 skipWaiting + clientsClaim，接管后页面在空闲时刷新。
 * 因此**不该**再有一套「发现新版本 → 等用户点立即更新」的提示 —— 那会与自动刷新打架：
 * 用户还没点，页面已经自己刷了；`registration.waiting` 也基本不存在。
 *
 * 同时只保留一个注册入口：VitePWA 默认会注入 `/registerSW.js`，而 PwaManager 也手动
 * `register('/sw.js')`。同一 scope 会去重，但两个入口会让"谁在管更新"说不清。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')
const CONFIG = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'vite.config.ts'), 'utf8')
const MANAGER = fs.readFileSync(path.join(SRC, 'components', 'PwaManager.tsx'), 'utf8')

test('autoUpdate 是唯一策略，且不再让插件注入第二个注册脚本', () => {
  assert.match(CONFIG, /registerType:\s*'autoUpdate'/, '策略必须是 autoUpdate')
  assert.match(CONFIG, /injectRegister:\s*null/, '注册只由 PwaManager 做，插件不要再注入 registerSW.js')
})

test('不再有等待用户确认的更新提示（与自动刷新冲突）', () => {
  assert.doesNotMatch(MANAGER, /pwa-update-toast/, '更新 toast 的 DOM 已删除')
  assert.doesNotMatch(MANAGER, /发现新版本/, '不再提示"发现新版本"')
  assert.doesNotMatch(MANAGER, /SKIP_WAITING/, 'SW 自己 skipWaiting，不需要页面发消息')
  assert.doesNotMatch(MANAGER, /needRefresh/, '没有 waiting 态，就不该再有 needRefresh 状态')
})

test('注册只有一个调用点，且走单例函数', () => {
  const calls = MANAGER.match(/navigator\.serviceWorker\.register\(/g) ?? []
  assert.equal(calls.length, 1, `register() 只该有一个调用点，现在有 ${calls.length} 个`)
  assert.match(MANAGER, /registerServiceWorkerOnce\(/, '注册走缓存函数，不直接调 register')
})

test('接管后按空闲刷新：controllerchange + 输入/搜索让路', () => {
  assert.match(MANAGER, /controllerchange/, '新 SW 接管后要触发刷新')
  assert.match(MANAGER, /reloadWhenIdle/, '刷新要等空闲，不能打断输入或搜索')
  assert.match(MANAGER, /停止搜索/, '搜索进行中是明确的"在飞"标志')
  assert.match(MANAGER, /reg\.update\(\)/, '仍要主动检查更新')
  assert.match(MANAGER, /setInterval\(checkForUpdate, 5 \* 60 \* 1000\)/, '长期打开的页面要定期检查')
})
