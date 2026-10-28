import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, launchOptions } from './env.mjs'
/**
 * 首次打开的「用户协议与免责声明」门禁（用户 2026-10-10，参照 legado-with-MD3 的首启免责声明）：
 *  1. 没同意过 → 打开就是全屏协议层，按钮禁用且带 5 秒倒计时；
 *  2. 倒计时走完 → 按钮变「同意并进入」；
 *  3. 点掉 → 层消失、localStorage 记住；
 *  4. 刷新 → 不再出现。
 * 跑完把 localStorage 的标记清掉 —— 门禁用的是常驻调试 profile，不清会把用户自己的"首启"吃掉。
 */
const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

const browser = await puppeteer.launch(launchOptions())
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 归零：清掉同意标记，模拟"第一次打开"。
  await page.evaluate(async () => {
    localStorage.removeItem('legadoq-agreement-v1')
    const registrations = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
    return Promise.all(registrations.map(entry => entry.unregister()))
  })
  await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.overlay-backdrop.is-agreement', { timeout: 15000 })
  check('第一次打开：全屏协议层出现', true)

  const first = await page.evaluate(() => {
    const button = document.querySelector('.agreement-actions .primary-button')
    return { text: button?.textContent?.trim() ?? '', disabled: button?.disabled ?? true }
  })
  check('倒计时中按钮禁用且带秒数', first.disabled && /请阅读（\d+ 秒）/.test(first.text), first.text)
  const startSeconds = Number(/（(\d+) 秒）/.exec(first.text)?.[1] ?? -1)
  check('倒计时从 5 秒起', startSeconds === 5, `起始 ${startSeconds} 秒`)

  // 等倒计时走完（5 秒 + 余量）。
  await page.waitForFunction(() => {
    const button = document.querySelector('.agreement-actions .primary-button')
    return Boolean(button && !button.disabled)
  }, { timeout: 12000 })
  const ready = await page.evaluate(() => document.querySelector('.agreement-actions .primary-button')?.textContent?.trim() ?? '')
  check('倒计时结束按钮变「同意并进入」', ready === '同意并进入', ready)

  await page.click('.agreement-actions .primary-button')
  await page.waitForFunction(() => !document.querySelector('.overlay-backdrop.is-agreement'), { timeout: 5000 })
  const stored = await page.evaluate(() => localStorage.getItem('legadoq-agreement-v1'))
  check('点同意：层消失、localStorage 记住', Boolean(stored), stored ? `标记 ${String(stored).slice(0, 19)}` : '没写标记')

  await page.goto(`${BASE}/?t=${Date.now() + 1}`, { waitUntil: 'domcontentloaded' })
  await new Promise(resolve => setTimeout(resolve, 800))
  const again = await page.evaluate(() => document.querySelector('.overlay-backdrop.is-agreement') !== null)
  check('刷新之后不再显示', !again, again ? '又弹了' : '不再弹')
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  try {
    const pages = await browser.pages()
    if (pages[0]) await pages[0].evaluate(() => localStorage.removeItem('legadoq-agreement-v1')).catch(() => undefined)
  } catch { /* profile 清理失败不掩盖判据 */ }
  await browser.close()
}

const failed = results.filter(item => !item.ok)
console.log(`\nagreement-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
if (failed.length) process.exitCode = 1
