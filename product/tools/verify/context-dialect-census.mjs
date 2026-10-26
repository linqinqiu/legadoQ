// #28 三项方言缺口的普查：@put 多键、searchUrl/tocUrl 缺 bookUrl/chapterUrl、规则里引用 book./chapter. 上下文。
// 用法：node tools/verify/context-dialect-census.mjs
import { DatabaseSync } from 'node:sqlite'
import { DB } from './env.mjs'

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('select id, payload from source').all()
db.close()

const put = { total: 0, multi: 0, samples: [] }
const noBookUrl = []
const noChapterUrl = []
const ctx = new Map()
let ctxSources = 0

const CONTEXT_KEYS = /^(book|chapter)\.[A-Za-z]\w*/

for (const row of rows) {
  let s
  try { s = JSON.parse(row.payload) } catch { continue }
  const blob = row.payload
  let touchedContext = false

  // ① @put:{...}：数一下大括号里有几个键
  for (const match of blob.matchAll(/@put:\s*\{([^{}]*)\}/g)) {
    put.total++
    const body = match[1]
    const keys = body.split(',').filter(part => part.includes(':')).map(part => part.split(':')[0].trim().replace(/["']/g, ''))
    const distinct = [...new Set(keys.filter(Boolean))]
    if (distinct.length > 1) {
      put.multi++
      if (put.samples.length < 6) put.samples.push(`${s.bookSourceName} :: @put:{${body.slice(0, 90)}} → 键 ${distinct.join(',')}`)
    }
  }

  // ② 搜索规则里没有 bookUrl / 目录规则里没有 chapterUrl：上游回落到元素自身的 href
  const rs = s.ruleSearch
  if (rs && typeof rs === 'object' && rs.bookList && !rs.bookUrl) {
    if (noBookUrl.length < 6) noBookUrl.push(`${s.bookSourceName} :: bookList=${String(rs.bookList).slice(0, 40)}`)
    noBookUrl.count = (noBookUrl.count ?? 0) + 1
  }
  const rt = s.ruleToc
  if (rt && typeof rt === 'object' && rt.chapterList && !rt.chapterUrl) {
    if (noChapterUrl.length < 6) noChapterUrl.push(`${s.bookSourceName} :: chapterList=${String(rt.chapterList).slice(0, 40)}`)
    noChapterUrl.count = (noChapterUrl.count ?? 0) + 1
  }

  // ③ 规则里引用 book.xxx / chapter.xxx 上下文喂值
  for (const [, value] of Object.entries(s)) {
    const text = typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : ''
    for (const match of text.matchAll(/(?:^|[^.\w])(book|chapter)\.([A-Za-z]\w*)/g)) {
      const key = `${match[1]}.${match[2]}`
      if (!CONTEXT_KEYS.test(key)) continue
      ctx.set(key, (ctx.get(key) ?? 0) + 1)
      touchedContext = true
    }
  }
  if (touchedContext) ctxSources++
}

console.log(`库内 ${rows.length} 个书源\n`)
console.log(`① @put 出现 ${put.total} 次，其中**多键** ${put.multi} 次（以前只有第一个键生效）`)
for (const sample of put.samples) console.log(`     · ${sample}`)
console.log(`\n② 有 bookList 但没写 ruleSearch.bookUrl 的源：${noBookUrl.count ?? 0}`)
for (const line of noBookUrl) console.log(`     · ${line}`)
console.log(`   有 chapterList 但没写 ruleToc.chapterUrl 的源：${noChapterUrl.count ?? 0}`)
for (const line of noChapterUrl) console.log(`     · ${line}`)
console.log(`\n③ 引用 book./chapter. 上下文喂值的源：${ctxSources} 个，键分布 top 12：`)
for (const [key, count] of [...ctx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(count).padStart(6)}  ${key}`)
