// 从运行实例的 GET /api/catalog 重新生成 docs/API-REFERENCE.md（文档头声明的生成方式就是它）。
import fs from 'node:fs'
const BASE = process.env.LEGADO_BASE ?? 'http://127.0.0.1:1234'
const catalog = await (await fetch(`${BASE}/api/catalog`)).json()
const esc = s => String(s ?? '').replace(/\|/g, '\\|')
const ORDER = catalog.endpoints.map(e => e.group).filter((v, i, a) => a.indexOf(v) === i)
const counts = Object.fromEntries(ORDER.map(g => [g, catalog.endpoints.filter(e => e.group === g).length]))
const lines = []
lines.push(`# 青阅 API 参考`, ``)
lines.push(`> 版本：${catalog.version} · 端点数：${catalog.endpoints.length} · 生成时间：${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}`)
lines.push(`> 本文由运行中的 \`GET /api/catalog\` 实时生成（\`node scripts/gen-api-reference.mjs\`）；以此为准，不再手写端点清单。`, ``)
lines.push(`## 连接`, ``)
const hc = catalog.howToConnect ?? {}
lines.push(`- Base URL：\`${hc.baseUrl}\``)
lines.push(`- 认证：${hc.auth}`)
lines.push(`- Content-Type：\`${hc.contentType ?? 'application/json; charset=utf-8'}\``)
lines.push(`- 错误：${hc.errors}`, ``)
lines.push(`## 端点分组`, ``, `| 分组 | 条数 |`, `|---|---:|`)
for (const g of ORDER) lines.push(`| ${esc(g)} | ${counts[g]} |`)
lines.push(`| **合计** | **${catalog.endpoints.length}** |`, ``)
for (const g of ORDER) {
  lines.push(`## ${esc(g)}（${counts[g]}）`, ``, `| 方法 | 路径 | 写门 | 说明 |`, `|---|---|---|---|`)
  for (const e of catalog.endpoints.filter(x => x.group === g))
    lines.push(`| ${e.method} | \`${esc(e.path)}\` | ${e.write ? '是' : '否'} | ${esc(e.purpose)} |`)
  lines.push('')
}
fs.writeFileSync('E:/legado/docs/API-REFERENCE.md', lines.join('\n'), 'utf8')
console.log(`生成完成：${catalog.endpoints.length} 条 / ${ORDER.length} 组 / 版本 ${catalog.version}`)
