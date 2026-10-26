import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 默认扫全部会分发的 markdown，而不是写死一份：旧 README 里有两处表格被断句撑坏
 * （一行中文落在表格中间、环境变量表少一列），这份门禁当时只看着 `docs/实现说明.md`，
 * 所以那两份破损一直绿着（2026-10-03 重写 README 时才发现）。
 * 给一个路径参数就只查那一份。
 *
 * 2026-10-22：上面这句「默认扫全部」原来**没做到** —— 代码里是写死的 6 个文件名，
 * 于是 `docs/README.md`、`docs/ARCHITECTURE.md`、`docs/gates-guide.md` 这些
 * 真正会改出表格错误的文档全在覆盖之外，门禁绿着但没看它们。改成真的递归扫。
 */
const targets = process.argv[2]
  ? [process.argv[2]]
  : listDistributedMarkdown()

/** 递归列出仓库里会分发的 .md（跳过依赖/产物目录）。 */
function listDistributedMarkdown() {
  const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'tmp', '.gradle', '.data', 'coverage', 'out'])
  const found = []
  const walk = rel => {
    const abs = path.join(ROOT, rel)
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const childRel = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(childRel)
      else if (e.name.endsWith('.md')) found.push(childRel)
    }
  }
  walk('')
  return found.sort()
}

const count = row => (row.match(/(?<!\\)\|/g) ?? []).length

const checkFile = target => {
  const file = path.join(ROOT, target)
  if (!fs.existsSync(file)) return [`缺失：${target}（门禁列了它，文件却不在）`]
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  let header = null
  let headerCells = 0
  const bad = []
  lines.forEach((line, index) => {
    const text = line.trim()
    const isRow = text.startsWith('|') && text.endsWith('|') && text.length > 1
    if (!isRow) {
      header = null
      return
    }
    if (header === null) {
      header = index + 1
      headerCells = count(text)
    } else if (count(text) !== headerCells) {
      bad.push(`${target} line ${index + 1}: expected ${headerCells} pipes, got ${count(text)} — ${text.slice(0, 60)}`)
    }
  })
  return bad
}

let failed = 0
for (const target of targets) {
  const bad = checkFile(target)
  failed += bad.length
  for (const row of bad) console.log(row)
  if (bad.length === 0) console.log(`OK ${target}: 所有表格行列数一致`)
}
process.exit(failed === 0 ? 0 : 1)
