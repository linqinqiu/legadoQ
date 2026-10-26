/**
 * 一次性普查：全局 `button { min-height: 34px }` 会把"声明成方的"图标键拉成长条。
 * 逐个界面量一遍：只要一个键里只有一个 svg（没有文字），它就该是方的。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { BASE, ROOT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const SWEEP = () => {
  const bad = []
  for (const el of document.querySelectorAll('button')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || !el.getBoundingClientRect().width) continue
    const text = (el.textContent ?? '').trim()
    const svgs = el.querySelectorAll('svg')
    if (text || svgs.length !== 1) continue // 只看"纯图标"键
    const r = el.getBoundingClientRect()
    if (Math.abs(r.width - r.height) > 1.5) {
      const declared = cs.height
      bad.push({
        cls: (el.className || '').toString().split(' ').slice(0, 2).join('.'),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        declared,
        minH: cs.minHeight,
        aria: el.getAttribute('aria-label') ?? el.title ?? '',
      })
    }
  }
  const uniq = new Map()
  for (const b of bad) uniq.set(`${b.cls}|${b.box}`, b)
  return [...uniq.values()]
}

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function visit(name, hash, openText) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  if (openText) {
    await page.evaluate(t => {
      const btn = [...document.querySelectorAll('button')].find(n => (n.textContent ?? '').includes(t))
      btn?.click()
    }, openText)
    await sleep(900)
  }
  const rows = await page.evaluate(SWEEP)
  console.log(`\n── ${name}${openText ? ` · ${openText}` : ''}  → ${rows.length ? '' : '没有走形的图标键'}`)
  for (const r of rows) console.log(`   ${r.cls} 实measure=${r.box} computed高=${r.declared} minH=${r.minH} ${r.aria ? `(${r.aria})` : ''}`)
}

await visit('书库', 'library')
await visit('书架', 'shelf')
await visit('书源', 'sources')
await visit('书源 · 体检弹窗', 'sources', '体检')
await visit('书源 · 批量', 'sources', '批量管理')
await visit('发现', 'explore')
await visit('订阅', 'subscriptions')
await visit('规则', 'rules')
await visit('备份', 'backup')
await visit('设置', 'settings')
await visit('关于', 'about')
await visit('更新日志', 'changelog')
await visit('我的菜单', 'library', '我的')
await browser.close()
