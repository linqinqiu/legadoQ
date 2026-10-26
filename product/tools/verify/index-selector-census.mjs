// 索引型选择器普查：`!N`、`[N]`、负索引、区间这些 Legado 变体到底有多少源在用、都长什么样。
// 先量形状再动手，避免照猜实现。用法：node tools/verify/index-selector-census.mjs
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB } from './env.mjs'

const FIELDS = [
  ['ruleSearch.bookList', '搜索列表'],
  ['ruleToc.chapterList', '目录列表'],
  ['ruleContent.content', '正文'],
  ['ruleBookInfo.name', '详情书名'],
  ['ruleExplore.bookList', '发现列表'],
]

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('select id, name, payload from source').all()
db.close()

const shapes = new Map()
const perField = new Map()
const examples = new Map()
let affected = 0

const note = (key, name, rule) => {
  shapes.set(key, (shapes.get(key) ?? 0) + 1)
  if (!examples.has(key)) examples.set(key, [])
  if (examples.get(key).length < 4) examples.get(key).push(rule.slice(0, 78))
}

for (const row of rows) {
  let source
  try { source = JSON.parse(row.payload) } catch { continue }
  let touched = false
  for (const [pathExpr, label] of FIELDS) {
    const [objKey, field] = pathExpr.split('.')
    const value = source[objKey]?.[field]
    if (typeof value !== 'string' || !value.trim()) continue
    // 规则按 @ 分层，逐段看选择器部分
    for (const segment of value.split('@')) {
      const seg = segment.trim()
      if (!seg) continue
      const bracket = /\[[^\]]*\]/.exec(seg)
      const exclam = /[!][\d,:\-]*/.exec(seg)
      if (exclam) {
        touched = true
        note(`排除式 !${exclam[0].replace(/\d+/g, 'N')}`, label, seg)
      }
      if (bracket) {
        const inner = bracket[0].slice(1, -1)
        const kind = /^\d+$/.test(inner) ? '定值 [N]'
          : /^-\d+$/.test(inner) ? '负索引 [-N]'
            : /^\d*:\d*(:\d+)?$/.test(inner) ? '区间 [a:b]'
              : /^\d+,\d+/.test(inner) || /,/.test(inner) ? '多值 [a,b]'
                : '属性式 [attr=val]'
        if (kind !== '属性式 [attr=val]') touched = true
        note(`${kind}`, label, seg)
      }
      // class.x.2 / tag.2 这种点号索引
      if (/(^|\.)\d+$/.test(seg) && !bracket && !exclam) {
        touched = true
        note('点号索引 .N', label, seg)
      }
    }
  }
  if (touched) affected++
}

console.log(`受影响的源：${affected} / ${rows.length}\n`)
for (const [key, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(6)}  ${key}`)
  for (const example of examples.get(key)) console.log(`          · ${example}`)
}
