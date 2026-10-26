#!/usr/bin/env node
/**
 * 把 `tools/verify/` 下所有 `*-check.mjs` **串行**跑一遍，出一张总表。
 *
 * 为什么需要这个：CI 里用通配符 `tools/verify/*-check.mjs` 扫（full job），
 * 但**本地从来没人跑过全部**。47 个脚本里只要有一个因为环境假设过期而长期红，
 * 它就会在 CI 里一直红着，然后所有人开始忽略 CI 的红 —— 那比没有门禁更糟。
 *
 * 三条纪律（与 docs/gates-guide.md 一致）：
 * 1. **一律串行**：多个门禁会抢同一个 Chrome profile 与同一个实例的探针数据；
 * 2. **失败继续跑**：一个红了不能掩盖后面 46 个的结果，最后一起汇总；
 * 3. **区分"产品坏了"与"探针坏了"**：输出里带每条失败的原始信息，供人工判。
 *
 * 用法：
 *   node scripts/run-all-gates.mjs              # 跑全部
 *   node scripts/run-all-gates.mjs --filter=ui  # 只跑名字含 ui 的
 *   node scripts/run-all-gates.mjs --list       # 只列清单
 *
 * 产物：`tools/verify/out/gates-<时间戳>.json` + 终端总表
 */

import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERIFY = path.join(ROOT, 'tools', 'verify')
const OUT = process.env.LEGADO_VERIFY_OUT || path.join(VERIFY, 'out')

const args = process.argv.slice(2)
const onlyList = args.includes('--list')
const filter = args.find(a => a.startsWith('--filter='))?.split('=')[1]

const all = fs.readdirSync(VERIFY)
  .filter(n => n.endsWith('-check.mjs'))
  .sort()
const targets = filter ? all.filter(n => n.includes(filter)) : all

if (onlyList) {
  console.log(`${targets.length} 个门禁：`)
  for (const t of targets) console.log(`  ${t}`)
  process.exit(0)
}

/**
 * 单个门禁的超时上限。
 *
 * 原来写 300 秒，实测**不够**：`source-picker-check` 单独跑要 373 秒
 * （它要起真浏览器、开书架、点右键菜单、验归组，步骤多），
 * 于是被误判成"失败"——其实它 32/32 全过，只是被我掐断了。
 *
 * 300 秒 → 600 秒。这个上限的意义是"防止某个门禁卡死不返回"，
 * 不是"给门禁定一个合理的运行时长"；定太紧只会制造假红。
 * 实测最慢的几个：source-picker 373s / subscription 275s / source-editor 140s。
 */
const GATE_TIMEOUT_MS = 600_000

/** 跑一个脚本，返回 { name, ok, ms, tail }。 */
function runOne(name) {
  const started = Date.now()
  try {
    // 与 coverage-report 同一套平台处理：Windows 上 .cmd/.bat 必须经 shell。
    const out = process.platform === 'win32'
      ? execSync(`node "tools/verify/${name}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: GATE_TIMEOUT_MS })
      : execFileSync('node', [`tools/verify/${name}`], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: GATE_TIMEOUT_MS })
    return { name, ok: true, ms: Date.now() - started, tail: lastLines(out, 3) }
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '')
    return { name, ok: false, ms: Date.now() - started, tail: lastLines(out, 12) }
  }
}

function lastLines(text, n) {
  return text.trim().split('\n').slice(-n).join('\n').trim()
}

console.log(`串行跑 ${targets.length} 个门禁（每个最多 5 分钟）…\n`)
const results = []
for (const [i, name] of targets.entries()) {
  process.stdout.write(`[${String(i + 1).padStart(2)}/${targets.length}] ${name.padEnd(38)}`)
  const r = runOne(name)
  results.push(r)
  console.log(r.ok ? `✓ ${(r.ms / 1000).toFixed(1)}s` : `✗ ${(r.ms / 1000).toFixed(1)}s`)
  if (!r.ok) {
    for (const line of r.tail.split('\n')) console.log(`        ${line}`)
  }
}

const pass = results.filter(r => r.ok)
const fail = results.filter(r => !r.ok)

console.log('\n' + '═'.repeat(72))
console.log(`  门禁总表：${pass.length}/${results.length} 通过`)
console.log('═'.repeat(72))
if (fail.length) {
  console.log('\n未通过：')
  for (const r of fail) console.log(`  ✗ ${r.name}`)
}
console.log(`\n耗时合计 ${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0)} 秒`)

// 落盘，便于事后分析
fs.mkdirSync(OUT, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const file = path.join(OUT, `gates-${stamp}.json`)
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pass: pass.length, total: results.length, results }, null, 2))
console.log(`详情 ${path.relative(ROOT, file)}`)

process.exit(fail.length ? 1 : 0)
