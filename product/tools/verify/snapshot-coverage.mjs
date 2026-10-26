import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const tracked = execSync('git ls-files', { maxBuffer: 1 << 26, cwd: import.meta.dirname + '/../..' }).toString().split('\n').filter(Boolean)
const snap = process.argv[2]
const have = new Set()
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else have.add(path.relative(snap, full).split(path.sep).join('/'))
  }
}
walk(snap)
// 快照把源码树放在 src/ 下面，比对时要把这层前缀剥掉，否则 404 个文件全部"未覆盖"是假警报
const normalize = p => p.startsWith('src/') ? p.slice(4) : p
const haveNorm = new Set([...have].map(normalize))
const missing = tracked.filter(f => !haveNorm.has(f))
console.log(`版本库跟踪文件 ${tracked.length} · 快照内文件 ${have.size} · 未覆盖 ${missing.length}`)
const by = {}
for (const f of missing) {
  const key = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '(根) ' + f
  by[key] = (by[key] || 0) + 1
}
console.log('--- 未覆盖的分布 ---')
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 24)) console.log(String(v).padStart(4), k)
console.log('--- 根级未覆盖文件（最容易漏的那批）---')
console.log(missing.filter(f => !f.includes('/')).join('\n') || '(无)')
