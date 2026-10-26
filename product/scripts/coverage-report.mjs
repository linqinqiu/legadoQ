#!/usr/bin/env node
/**
 * 前后端覆盖率汇总 —— 一条命令出总报告。
 *
 * 为什么要有这个：后端跑 JaCoCo（Java 生态）、前端跑 c8/Istanbul（Node 生态），
 * 两边产出的格式完全不同、报告也各在各的目录。想知道"这个项目整体覆盖多少"，
 * 得开两个目录对两份 HTML —— 那件事没人会天天做，于是覆盖率就变成了"配了但没人看"。
 *
 * 这个脚本做三件事：
 * 1. 跑两边的覆盖率任务（可选跳过，`--skip-run`）；
 * 2. 读两边的机器可读报告（后端 CSV、前端 json-summary）；
 * 3. 生成一份**合并的总报告**：HTML + 终端表格 + Markdown 摘要。
 *
 * 用法：
 *   node scripts/coverage-report.mjs            # 跑测试 + 出报告
 *   node scripts/coverage-report.mjs --skip-run # 只用现有数据出报告
 *   node scripts/coverage-report.mjs --json     # 额外输出机器可读摘要
 *
 * 产物：
 *   coverage-report/index.html     总报告（浏览器打开）
 *   coverage-report/summary.md     一句话摘要（可直接贴 PR / README）
 *   coverage-report/summary.json   机器可读
 *
 * 注意：**不做覆盖率门禁**（不设阈值失败）。理由写在 README 的"覆盖率"一节：
 * 先看清楚哪里没覆盖，再决定阈值；一上来就卡数字只会逼人写凑数测试。
 */

import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'coverage-report')

/**
 * 报告上那个版本号从 `app/build.gradle` 现读，不写死。
 * 从前这里硬编码过 `0.8.3`：版本升到 0.8.5 之后报告还在说 0.8.3，
 * 一份"看覆盖率"的报告自己就是过期的，谁还敢信它别的数字。
 * 版本号唯一书写处是 gradle（见 CHANGELOG 顶部与 tools/verify/version-check.mjs），这里只做读者。
 */
function appVersion() {
  try {
    const gradle = fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8')
    return /^\s*version\s*=\s*'([^']+)'/m.exec(gradle)?.[1] ?? '未知版本'
  } catch { return '未知版本' }
}

const args = process.argv.slice(2)
const skipRun = args.includes('--skip-run')
const wantJson = args.includes('--json')

const BACKEND_CSV = path.join(ROOT, 'app/build/reports/jacoco/testCoverage/jacocoTestReport.csv')
const BACKEND_HTML = path.join(ROOT, 'app/build/reports/jacoco/testCoverage/html/index.html')
const FRONTEND_SUMMARY = path.join(ROOT, 'web/coverage/coverage-summary.json')
const FRONTEND_HTML = path.join(ROOT, 'web/coverage/index.html')

/**
 * 跑一条命令，失败不中断（覆盖率是"看"，不是"卡"）。
 *
 * Windows 上的坑（实测踩过）：
 * - `gradlew.bat` 与 `npm.cmd` **必须**经 shell 才能启动，直接 spawn 报 EINVAL / ENOENT；
 * - 但 `shell: true` + 参数数组会触发 Node 的 DEP0190（参数只做字符串拼接）。
 *
 * 所以按平台分两条路：Windows 用 shell + 拼好的整串命令，其他平台直接 spawn。
 * 命令里没有用户输入，都是本脚本写死的，拼接没有注入面。
 */
function run(cmd, cmdArgs, cwd, label) {
  process.stdout.write(`\n▶ ${label}\n`)
  try {
    if (process.platform === 'win32') {
      // 路径里有空格（如 Program Files）时 cmd 需要引号；这里只涉及仓库内相对路径与 npm，
      // 但仍统一加引号更稳。
      const quote = s => (/[\s]/.test(s) ? `"${s}"` : s)
      const line = [cmd, ...cmdArgs].map(quote).join(' ')
      execSync(line, { cwd, stdio: 'inherit' })
    } else {
      execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
    }
    return true
  } catch (error) {
    console.warn(`  ⚠ ${label} 失败（继续，覆盖率仍会尽量出）：${error.message.split('\n')[0]}`)
    return false
  }
}

/** 后端：读 JaCoCo CSV，按包汇总行覆盖。 */
function readBackend() {
  if (!fs.existsSync(BACKEND_CSV)) return null
  const lines = fs.readFileSync(BACKEND_CSV, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const idx = name => header.indexOf(name)
  const iLineM = idx('LINE_MISSED')
  const iLineC = idx('LINE_COVERED')
  const iBranchM = idx('BRANCH_MISSED')
  const iBranchC = idx('BRANCH_COVERED')
  const iPkg = idx('PACKAGE')
  const iClass = idx('CLASS')

  const byPackage = new Map()
  const classes = []
  for (const line of lines.slice(1)) {
    // CSV 里的类名可能含逗号（匿名类），按「最后 N 个字段是数字」从右往左切
    const parts = line.split(',')
    const tail = parts.slice(-10).map(Number)
    if (tail.some(Number.isNaN)) continue
    const pkg = parts[iPkg]
    const cls = parts.slice(iClass, parts.length - 10).join(',')
    const row = {
      lineMissed: Number(parts[iLineM]),
      lineCovered: Number(parts[iLineC]),
      branchMissed: Number(parts[iBranchM]),
      branchCovered: Number(parts[iBranchC]),
    }
    const acc = byPackage.get(pkg) ?? { lineMissed: 0, lineCovered: 0, branchMissed: 0, branchCovered: 0 }
    acc.lineMissed += row.lineMissed
    acc.lineCovered += row.lineCovered
    acc.branchMissed += row.branchMissed
    acc.branchCovered += row.branchCovered
    byPackage.set(pkg, acc)
    classes.push({ pkg, cls, ...row })
  }

  const sum = [...byPackage.values()].reduce(
    (a, r) => ({
      lineMissed: a.lineMissed + r.lineMissed,
      lineCovered: a.lineCovered + r.lineCovered,
      branchMissed: a.branchMissed + r.branchMissed,
      branchCovered: a.branchCovered + r.branchCovered,
    }),
    { lineMissed: 0, lineCovered: 0, branchMissed: 0, branchCovered: 0 },
  )
  const pct = (c, m) => (c + m === 0 ? 0 : Math.round((100 * c) / (c + m) * 10) / 10)

  return {
    totals: {
      lines: { covered: sum.lineCovered, total: sum.lineCovered + sum.lineMissed, pct: pct(sum.lineCovered, sum.lineMissed) },
      branches: { covered: sum.branchCovered, total: sum.branchCovered + sum.branchMissed, pct: pct(sum.branchCovered, sum.branchMissed) },
    },
    byPackage: [...byPackage.entries()]
      .map(([name, r]) => ({
        name,
        lines: { covered: r.lineCovered, total: r.lineCovered + r.lineMissed, pct: pct(r.lineCovered, r.lineMissed) },
        branches: { covered: r.branchCovered, total: r.branchCovered + r.branchMissed, pct: pct(r.branchCovered, r.branchMissed) },
      }))
      .sort((a, b) => a.lines.pct - b.lines.pct),
    // 最该补的 15 个类：给"先补哪里"一个排序依据。
    //
    // 过滤规则（实测踩出来的）：
    // - 太小的类不算（<20 行）—— 一行的类没覆盖不代表问题；
    // - **排除编译器合成的 lambda 类**：JaCoCo 会把 Kotlin 的
    //   `new Function2() {...}` / `new WebSocket.Listener() {...}` 当成独立类列出来。
    //   它们没有独立的名字、也没法单独为它们写测试 —— 列在"最该补"里只会把真正
    //   该补的类挤下去（实测前 15 名里 11 个是这种）。它们的覆盖度应该跟着宿主类看。
    worstClasses: classes
      .filter(c => c.lineCovered + c.lineMissed >= 20)
      // Kotlin 的匿名类/监听器在 JaCoCo 里长这样：`...listener.new WebSocket.Listener() {...}`。
      // 它们没有独立名字、也没法单独写测试，列进"最该补"只会挤掉真正该补的类。
      .filter(c => !c.cls.includes('.new '))
      .filter(c => !c.cls.includes('$'))   // 其它合成类（lambda$$inlined 等）
      .map(c => ({
        name: `${c.pkg}.${c.cls}`,
        lines: { covered: c.lineCovered, total: c.lineCovered + c.lineMissed, pct: pct(c.lineCovered, c.lineMissed) },
      }))
      .sort((a, b) => a.lines.pct - b.lines.pct)
      .slice(0, 15),
    html: path.relative(ROOT, BACKEND_HTML),
  }
}

/** 前端：读 c8 的 json-summary，按目录汇总。 */
function readFrontend() {
  if (!fs.existsSync(FRONTEND_SUMMARY)) return null
  const raw = JSON.parse(fs.readFileSync(FRONTEND_SUMMARY, 'utf8'))
  const total = raw.total

  // 按 src/ 下一级目录汇总（reader / shelf / sources / features …）
  const byDir = new Map()
  for (const [file, data] of Object.entries(raw)) {
    if (file === 'total') continue
    const rel = path.relative(path.join(ROOT, 'web'), file).replaceAll('\\', '/')
    const m = rel.match(/^src\/([^/]+)\//)
    const dir = m ? `src/${m[1]}` : 'src（根）'
    const acc = byDir.get(dir) ?? { covered: 0, total: 0 }
    acc.covered += data.lines.covered
    acc.total += data.lines.total
    byDir.set(dir, acc)
  }
  const pct = (c, t) => (t === 0 ? 0 : Math.round((100 * c) / t * 10) / 10)

  return {
    totals: {
      lines: { covered: total.lines.covered, total: total.lines.total, pct: total.lines.pct },
      branches: { covered: total.branches.covered, total: total.branches.total, pct: total.branches.pct },
      functions: { covered: total.functions.covered, total: total.functions.total, pct: total.functions.pct },
    },
    byDir: [...byDir.entries()]
      .map(([name, r]) => ({ name, lines: { covered: r.covered, total: r.total, pct: pct(r.covered, r.total) } }))
      .sort((a, b) => a.lines.pct - b.lines.pct),
    html: path.relative(ROOT, FRONTEND_HTML),
  }
}

/** 合并：两边行数相加，算一个"整体行覆盖率"。 */
function combine(backend, frontend) {
  if (!backend || !frontend) return null
  const covered = backend.totals.lines.covered + frontend.totals.lines.covered
  const total = backend.totals.lines.total + frontend.totals.lines.total
  return {
    lines: { covered, total, pct: total === 0 ? 0 : Math.round((100 * covered) / total * 10) / 10 },
    backendShare: backend.totals.lines.total,
    frontendShare: frontend.totals.lines.total,
  }
}

const bar = pct => {
  const filled = Math.round(pct / 5)
  return '█'.repeat(filled) + '░'.repeat(20 - filled)
}

function printTable(backend, frontend, combined) {
  console.log('\n' + '═'.repeat(72))
  console.log('  覆盖率总览')
  console.log('═'.repeat(72))
  if (combined) {
    console.log(`  整体（前后端合计）  行 ${String(combined.lines.pct).padStart(5)}%  ${bar(combined.lines.pct)}  ${combined.lines.covered}/${combined.lines.total}`)
    console.log(`    ├─ 后端 ${combined.backendShare} 行`)
    console.log(`    └─ 前端 ${combined.frontendShare} 行`)
  }
  if (backend) {
    console.log(`\n  后端（JaCoCo）`)
    console.log(`    行 ${String(backend.totals.lines.pct).padStart(5)}%  ${bar(backend.totals.lines.pct)}  ${backend.totals.lines.covered}/${backend.totals.lines.total}`)
    console.log(`    分支 ${String(backend.totals.branches.pct).padStart(3)}%`)
    console.log('\n    最该补的包（行覆盖从低到高）：')
    for (const p of backend.byPackage.slice(0, 6)) {
      console.log(`      ${String(p.lines.pct).padStart(5)}%  ${p.name}  (${p.lines.covered}/${p.lines.total})`)
    }
  }
  if (frontend) {
    console.log(`\n  前端（c8 / Istanbul）`)
    console.log(`    行 ${String(frontend.totals.lines.pct).padStart(5)}%  ${bar(frontend.totals.lines.pct)}  ${frontend.totals.lines.covered}/${frontend.totals.lines.total}`)
    console.log(`    分支 ${String(frontend.totals.branches.pct).padStart(3)}%  函数 ${String(frontend.totals.functions.pct).padStart(3)}%`)
    console.log('\n    最该补的目录（行覆盖从低到高）：')
    for (const d of frontend.byDir.slice(0, 6)) {
      console.log(`      ${String(d.lines.pct).padStart(5)}%  ${d.name}  (${d.lines.covered}/${d.lines.total})`)
    }
  }
  console.log('\n' + '─'.repeat(72))
}

function writeHtml(backend, frontend, combined) {
  const row = (label, pct, detail) => {
    const cls = pct >= 80 ? 'good' : pct >= 60 ? 'mid' : 'bad'
    return `<tr><td>${label}</td><td class="num ${cls}">${pct}%</td><td class="detail">${detail}</td></tr>`
  }
  const table = (rows) => `<table>${rows.join('')}</table>`

  const backendRows = backend
    ? backend.byPackage.map(p => row(p.name, p.lines.pct, `${p.lines.covered}/${p.lines.total} 行`))
    : []
  const frontendRows = frontend
    ? frontend.byDir.map(d => row(d.name, d.lines.pct, `${d.lines.covered}/${d.lines.total} 行`))
    : []

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>legadoQ · 覆盖率总报告</title>
<style>
  :root { --fg:#1a1a1a; --dim:#666; --line:#e5e5e5; --good:#137333; --mid:#b06000; --bad:#c5221f; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color:var(--fg); max-width: 980px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .meta { color: var(--dim); font-size: 12px; margin-bottom: 24px; }
  .big { display: flex; gap: 32px; margin: 20px 0 8px; }
  .big div { flex: 1; }
  .big .n { font-size: 32px; font-weight: 600; line-height: 1.1; }
  .big .l { color: var(--dim); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 8px; border-bottom: 1px solid #f2f2f2; }
  td.num { text-align: right; width: 80px; font-variant-numeric: tabular-nums; font-weight: 600; }
  td.detail { color: var(--dim); text-align: right; width: 120px; font-size: 12px; }
  .good { color: var(--good); } .mid { color: var(--mid); } .bad { color: var(--bad); }
  a { color: #1a73e8; }
  .note { background:#f8f9fa; border-left: 3px solid #dadce0; padding: 10px 14px; margin: 20px 0; font-size: 13px; color:#444; }
</style></head><body>
<h1>legadoQ · 覆盖率总报告</h1>
<div class="meta">生成时间 ${new Date().toLocaleString('zh-CN')} · 版本 ${appVersion()}</div>

${combined ? `<div class="big">
  <div><div class="n">${combined.lines.pct}%</div><div class="l">整体行覆盖（前后端合计 ${combined.lines.total} 行）</div></div>
  ${backend ? `<div><div class="n">${backend.totals.lines.pct}%</div><div class="l">后端 ${backend.totals.lines.total} 行</div></div>` : ''}
  ${frontend ? `<div><div class="n">${frontend.totals.lines.pct}%</div><div class="l">前端 ${frontend.totals.lines.total} 行</div></div>` : ''}
</div>` : ''}

<div class="note">
  <strong>这不是门禁。</strong>没有设阈值、不会让 CI 失败。先看清楚哪里没覆盖，再决定要不要卡数字 ——
  一上来就卡百分比只会逼人写凑数测试。
</div>

${backend ? `<h2>后端 · 按包（${backend.totals.lines.pct}% 行 / ${backend.totals.branches.pct}% 分支）</h2>
<p class="meta">从低到高排 —— 最上面就是最该补的。<a href="${backend.html}">完整 JaCoCo 报告 →</a></p>
${table(backendRows)}` : '<h2>后端</h2><p class="meta">没有数据（先跑 <code>./gradlew :app:testCoverageReport</code>）</p>'}

${backend ? `<h2>后端 · 最该补的 15 个类</h2>
<p class="meta">只统计 ≥20 行的类 —— 一行的类没覆盖不代表问题。</p>
${table(backend.worstClasses.map(c => row(c.name, c.lines.pct, `${c.lines.covered}/${c.lines.total} 行`)))}` : ''}

${frontend ? `<h2>前端 · 按目录（${frontend.totals.lines.pct}% 行 / ${frontend.totals.branches.pct}% 分支 / ${frontend.totals.functions.pct}% 函数）</h2>
<p class="meta">从低到高排。<a href="${frontend.html}">完整 c8 报告 →</a></p>
${table(frontendRows)}` : '<h2>前端</h2><p class="meta">没有数据（先跑 <code>npm --prefix web run test:coverage</code>）</p>'}

</body></html>`
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html)
}

function writeSummary(backend, frontend, combined) {
  const lines = []
  lines.push('# 覆盖率摘要')
  lines.push('')
  lines.push(`> 生成时间 ${new Date().toLocaleString('zh-CN')} · 版本 ${appVersion()}`)
  lines.push('')
  if (combined) {
    lines.push(`**整体行覆盖 ${combined.lines.pct}%**（${combined.lines.covered}/${combined.lines.total} 行）`)
    lines.push('')
  }
  if (backend) {
    lines.push(`| 后端 | 行 | 分支 |`)
    lines.push(`|---|---:|---:|`)
    lines.push(`| 全部 | ${backend.totals.lines.pct}% | ${backend.totals.branches.pct}% |`)
    lines.push('')
    lines.push(`最该补的包：`)
    for (const p of backend.byPackage.slice(0, 5)) lines.push(`- \`${p.name}\` ${p.lines.pct}%`)
    lines.push('')
  }
  if (frontend) {
    lines.push(`| 前端 | 行 | 分支 | 函数 |`)
    lines.push(`|---|---:|---:|---:|`)
    lines.push(`| 全部 | ${frontend.totals.lines.pct}% | ${frontend.totals.branches.pct}% | ${frontend.totals.functions.pct}% |`)
    lines.push('')
    lines.push(`最该补的目录：`)
    for (const d of frontend.byDir.slice(0, 5)) lines.push(`- \`${d.name}\` ${d.lines.pct}%`)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('完整报告：`coverage-report/index.html`（浏览器打开）')
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), lines.join('\n'))
}

// ── 主流程 ───────────────────────────────────────────────────────────
if (!skipRun) {
  run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:testCoverageReport', '--console=plain', '-q'], ROOT, '后端测试 + JaCoCo 覆盖率')
  run('npm', ['--prefix', 'web', 'run', 'test:coverage'], ROOT, '前端测试 + c8 覆盖率')
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const backend = readBackend()
const frontend = readFrontend()
const combined = combine(backend, frontend)

if (!backend && !frontend) {
  console.error('\n两份数据都没有。先跑一次（不加 --skip-run），或检查报告路径。')
  console.error(`  后端期望：${path.relative(ROOT, BACKEND_CSV)}`)
  console.error(`  前端期望：${path.relative(ROOT, FRONTEND_SUMMARY)}`)
  process.exit(1)
}

printTable(backend, frontend, combined)
writeHtml(backend, frontend, combined)
writeSummary(backend, frontend, combined)

console.log(`\n✓ 总报告：${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))}`)
console.log(`✓ 摘要：  ${path.relative(ROOT, path.join(OUT_DIR, 'summary.md'))}`)

if (wantJson) {
  const json = { generatedAt: new Date().toISOString(), version: appVersion(), backend, frontend, combined }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(json, null, 2))
  console.log(`✓ JSON：  ${path.relative(ROOT, path.join(OUT_DIR, 'summary.json'))}`)
}
