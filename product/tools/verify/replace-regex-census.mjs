// ruleContent.replaceRegex 形态普查：上游只认 `##正则##替换` 这一种写法（SourceRule 按 ## 切分），
// 所以要按形状分桶统计，才能判断「整条不生效」到底影响多少源、以及该按哪种形状实现。
// 用法：node tools/verify/replace-regex-census.mjs
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB } from './env.mjs'

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('select id, name, payload from source').all()
db.close()

const buckets = new Map()
const samples = new Map()
let total = 0

const note = (key, value) => {
  buckets.set(key, (buckets.get(key) ?? 0) + 1)
  if (!samples.has(key)) samples.set(key, [])
  if (samples.get(key).length < 3) samples.get(key).push(value)
}

for (const row of rows) {
  let source
  try { source = JSON.parse(row.payload) } catch { continue }
  const rule = source.ruleContent
  const raw = rule && typeof rule === 'object' ? rule.replaceRegex : null
  if (typeof raw !== 'string' || !raw.trim()) continue
  total++
  // 上游 splitSourceRule 先按 && 拆条，再对每条 split('##')
  const entries = raw.split(/[\r\n]+|&&/).map(s => s.trim()).filter(Boolean)
  const shapes = entries.map(entry => {
    const parts = entry.split('##')
    if (parts.length === 1) return '无 ## 段（上游等于不替换）'
    if (parts.length === 2) return '##正则（替换为空）'
    if (parts.length === 3) return '##正则##替换'
    return '##正则##替换###（只替换首个匹配）'
  })
  const leadingEmpty = entries.every(e => e.startsWith('##'))
  note(`${[...new Set(shapes)].join(' + ')}${leadingEmpty ? '' : ' ｜ 首段非空(要先跑取值规则)'}`, entry_preview(entries[0] ?? ''))
}

function entry_preview(text) {
  return text.length > 90 ? text.slice(0, 90) + '…' : text
}

const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1])
console.log(`配了 ruleContent.replaceRegex 的书源：${total} 个\n`)
for (const [key, count] of sorted) {
  console.log(`${String(count).padStart(5)}  ${key}`)
  for (const sample of samples.get(key)) console.log(`         · ${sample}`)
}
