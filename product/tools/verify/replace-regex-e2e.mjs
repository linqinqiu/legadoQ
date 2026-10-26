// 真源端到端取证：从库里挑配了 `##` 形状 ruleContent.replaceRegex 的书源，
// 用它**自己的规则**跑一遍 搜索 → 详情 → 目录 → 正文，然后拿它自己的正则去匹配**返回的正文**。
// 匹配得到 = 清洗没生效。旧实现（整条连 ## 一起当正则）应当大量命中，修好后应当归零。
// 用法：node tools/verify/replace-regex-e2e.mjs [尝试源数]
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BASE, DB } from './env.mjs'

const MAX_ATTEMPTS = Number(process.argv[2] || 24)
const TARGET_SUCCESSES = 8

const session = await (await fetch(`${BASE}/healthz`)).json()
const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken || '' }
const post = async (url, body, ms = 30000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await (await fetch(`${BASE}${url}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: controller.signal })).json()
  } finally {
    clearTimeout(timer)
  }
}

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('select id, name, payload from source order by name collate nocase').all()
db.close()

// 只取「##正则」两/三段、且正则在 JS 里能编译的形状：这样匹配判定才有意义
const collected = []
for (const row of rows) {
  let source
  try { source = JSON.parse(row.payload) } catch { continue }
  const rule = source.ruleContent
  const raw = rule && typeof rule === 'object' ? rule.replaceRegex : null
  if (typeof raw !== 'string' || !raw.trim().startsWith('##')) continue
  const entry = raw.split(/[\r\n]+|&&/).map(s => s.trim()).find(s => s.startsWith('##'))
  if (!entry) continue
  const parts = entry.split('##')
  const pattern = parts[1]
  if (!pattern || !pattern.trim()) continue
  let regex
  try { regex = new RegExp(pattern, 'g') } catch { continue }
  collected.push({ id: row.id, name: row.name, entry, pattern, regex, keyword: source.ruleSearch?.checkKeyWord || '都市' })
}
console.log(`库里共 ${rows.length} 源，其中 ${collected.length} 个配了可解析的 ## 形状 replaceRegex`)

// 按名字排序取前 N 个全是死源，改成定步长抽样，覆盖面才够
const candidates = []
const stride = Math.max(1, Math.floor(collected.length / MAX_ATTEMPTS))
for (let i = 0; i < collected.length && candidates.length < MAX_ATTEMPTS; i += stride) candidates.push(collected[i])
console.log(`抽样 ${candidates.length} 个做真源取证`)

let successes = 0
const dirty = []
const clean = []
const skipped = []

for (const source of candidates) {
  if (successes >= TARGET_SUCCESSES) break
  try {
    const results = await post('/api/search', { keyword: source.keyword, sourceIds: [source.id] }, 25000)
    if (!Array.isArray(results) || !results.length) { skipped.push(`${source.name}（搜索无结果）`); continue }
    const hit = results[0]
    const details = await post('/api/books/details', { sourceId: source.id, bookUrl: hit.bookUrl }, 25000)
    const chapters = await post('/api/books/chapters', { sourceId: source.id, bookUrl: details.tocUrl || hit.bookUrl }, 25000)
    if (!Array.isArray(chapters) || !chapters.length) { skipped.push(`${source.name}（目录为空）`); continue }
    const chapter = chapters[Math.min(1, chapters.length - 1)]
    const content = await post('/api/books/content', { sourceId: source.id, chapterUrl: chapter.url, bookUrl: hit.bookUrl }, 30000)
    const text = content?.content ?? ''
    if (text.length < 120) { skipped.push(`${source.name}（正文 ${text.length} 字，太短）`); continue }
    successes++
    // 正文里是否还能匹配到该书源自己的清洗正则
    const match = new RegExp(source.pattern, 'g').exec(text)
    if (match) {
      dirty.push({ name: source.name, entry: source.entry.slice(0, 70), hit: match[0].slice(0, 60), length: text.length })
    } else {
      clean.push({ name: source.name, entry: source.entry.slice(0, 70), length: text.length })
    }
  } catch (error) {
    skipped.push(`${source.name}（${String(error.message || error).slice(0, 40)}）`)
  }
}

console.log(`\n成功跑通 ${successes} 个真源章节：`)
for (const item of dirty) console.log(`  ✘ 广告仍在  ${item.name} :: ${JSON.stringify(item.entry)} → 命中 ${JSON.stringify(item.hit)}（正文 ${item.length} 字）`)
for (const item of clean) console.log(`  ✔ 已清干净  ${item.name} :: ${JSON.stringify(item.entry)}（正文 ${item.length} 字）`)
if (skipped.length) console.log(`  · 跳过 ${skipped.length} 个：${skipped.slice(0, 6).join('；')}`)

console.log(`\n合计 ${successes} 个真源样本：残留 ${dirty.length}，干净 ${clean.length}`)
// 零样本时绝不能报成功：否则「0 个残留」这种空断言会把没测到当成测过了
if (!successes) { console.log('✘ 一个都没跑通，无法取证'); process.exit(1) }
if (dirty.length) { console.log('✘ 仍有广告残留'); process.exit(1) }
console.log(`✔ ${successes} 个真源章节里，没有一个还能被自己的 replaceRegex 匹配到`)
