/**
 * RSS 源存活普查（任务 #58「订阅功能深度研究一下，不行删除」的证据）。
 *
 * 判"留还是删"不能靠感觉，要数得出来：这 176 条是从手机备份灌进来的，
 * 里面有多少到今天还能读出文章？有多少连栏目都列不出来？
 * 逐条走界面用的同一条链路：`/api/rss/tabs` → 第一个栏目 → `/api/rss/articles`。
 *
 * 只读：不改启用位、不写任何数据。默认并发 8、单条 12 秒上限。
 * 跑法：node tools/verify/rss-census.mjs [--limit=N] [--group=关键词]
 */
import { BASE } from './env.mjs'

const args = Object.fromEntries(process.argv.slice(2)
  .map(arg => arg.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? '1']))
const LIMIT = Number(args.limit ?? 0)
const GROUP_FILTER = String(args.group ?? '')
const CONCURRENCY = Number(args.concurrency ?? 8)
const PER_SOURCE_MS = Number(args.timeout ?? 12000)

const headers = { 'content-type': 'application/json', origin: BASE, host: new URL(BASE).host }
async function call(method, url, body, budgetMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs ?? 20000)
  try {
    const response = await fetch(BASE + url, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    try { return { status: response.status, json: JSON.parse(text), text } } catch { return { status: response.status, json: null, text } }
  } catch (error) {
    return { status: 0, json: null, text: error instanceof Error ? error.name : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const all = (await call('GET', '/api/rss/sources')).json ?? []
const targets = all.filter(source => !GROUP_FILTER || (source.group ?? '').includes(GROUP_FILTER))
  .slice(0, LIMIT > 0 ? LIMIT : undefined)
console.log(`RSS 源共 ${all.length} 条，本轮普查 ${targets.length} 条（并发 ${CONCURRENCY}，单条 ${PER_SOURCE_MS}ms 上限）`)

const rows = []
let cursor = 0
async function worker() {
  while (cursor < targets.length) {
    const source = targets[cursor++]
    const started = Date.now()
    const tabsResponse = await call('GET', `/api/rss/tabs?sourceUrl=${encodeURIComponent(source.sourceUrl)}`, undefined, PER_SOURCE_MS)
    const tabs = Array.isArray(tabsResponse.json) ? tabsResponse.json : []
    if (tabs.length === 0) {
      rows.push({ name: source.name, url: source.sourceUrl, enabled: source.enabled, verdict: tabsResponse.status === 0 ? 'timeout' : 'no_tabs', articles: 0, ms: Date.now() - started, note: (tabsResponse.text ?? '').slice(0, 90) })
      continue
    }
    const first = tabs[0]
    const articlesResponse = await call('POST', '/api/rss/articles', { sourceUrl: source.sourceUrl, url: first.url, page: 1 }, PER_SOURCE_MS)
    const articles = Array.isArray(articlesResponse.json) ? articlesResponse.json.length : 0
    rows.push({
      name: source.name,
      url: source.sourceUrl,
      enabled: source.enabled,
      tabs: tabs.length,
      firstTab: first.title,
      verdict: articlesResponse.status === 0 ? 'timeout' : articles > 0 ? 'ok' : articlesResponse.status >= 400 ? 'error' : 'empty',
      articles,
      ms: Date.now() - started,
      note: articles > 0 ? '' : (articlesResponse.text ?? '').slice(0, 110),
    })
    const done = rows.length
    if (done % 20 === 0) process.stdout.write(`  已普查 ${done}/${targets.length}\n`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const tally = {}
for (const row of rows) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1
const enabledAlive = rows.filter(row => row.verdict === 'ok' && row.enabled).length
const alive = rows.filter(row => row.verdict === 'ok').length

/**
 * 失败原因归一。这一步才决定"留还是删"：
 * 「没有配置 ruleArticles」与「String must not be empty」是**我们这边解析不了**，
 * 不是源死了 —— 把它们和"上游 404 / 连不上"混成一类去删功能，等于用我们的能力缺口
 * 判了 176 条源的死刑。
 */
const REASONS = [
  [/没有配置 ruleArticles/, '我们解析不了：源里没有 ruleArticles'],
  [/String must not be empty/, '我们解析不了：栏目地址为空'],
  [/header parser received no bytes|Connection reset|Broken pipe/, '上游无响应'],
  [/上游返回 HTTP/, '上游报错状态码'],
  [/timed out|AbortError|timeout/, '超时'],
  [/Unable to resolve|UnknownHost|无法解析/, '域名解析不了'],
  [/拒绝访问内网|仅允许 HTTP/, '被本机 SSRF 守卫挡下'],
]
const reasonOf = row => {
  if (row.verdict === 'ok') return '正常出文章'
  if (row.verdict === 'no_tabs') return '列不出栏目'
  if (row.verdict === 'empty') return '栏目能开但 0 篇'
  for (const [pattern, label] of REASONS) if (pattern.test(row.note)) return label
  return `其他：${row.note.slice(0, 40) || '(没有错误文案)'}`
}
const reasons = {}
for (const row of rows) {
  const reason = reasonOf(row)
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

console.log('\n── 结论 ────────────────────────────────────────────')
console.log(`能读出文章：${alive} / ${rows.length}（其中启用中的 ${enabledAlive} 条）`)
for (const [verdict, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${verdict.padEnd(10)} ${count}`)
console.log('\n── 按原因归类（决定留/删的关键一张表）───────────────')
const ours = Object.entries(reasons).filter(([reason]) => reason.startsWith('我们解析不了')).reduce((sum, [, count]) => sum + count, 0)
for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${reason}`)
console.log(`\n  其中"是我们解析能力不够、不是源死了"：${ours} 条`)
console.log(`平均单条耗时：${Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / Math.max(1, rows.length))}ms`)

const sorted = [...rows].sort((a, b) => (a.verdict === b.verdict ? a.name.localeCompare(b.name, 'zh-CN') : a.verdict === 'ok' ? -1 : 1))
console.log('\n── 明细（前 40 条）─────────────────────────────────')
for (const row of sorted.slice(0, 40)) {
  console.log(`  ${row.verdict.padEnd(9)} ${row.enabled ? '启用' : '停用'}  ${row.name.slice(0, 22).padEnd(24)} ${row.articles} 篇${row.tabs ? ` / ${row.tabs} 栏` : ''}  ${row.note}`)
}
