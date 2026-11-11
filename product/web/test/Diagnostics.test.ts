import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 运行诊断（`GET /api/diagnostics` 的 stages）。
 *
 * 与其它前端判据同一风格：只读源码做结构断言，不起浏览器。
 * 盯三件事：
 * ① 接口类型是真的诊断形状，不是随手借来的 `SourceHealthCheckResponse`（借来的形状没有 stages）；
 * ② 诊断条挂在运行日志页上、默认收起、只发一次请求；
 * ③ 契约里写了 stages，否则外部客户端不知道有这一层。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('api 层：诊断有自己的类型，不再是借来的健康检查形状', () => {
  const types = read('../src/lib/api/types.ts')
  assert.match(types, /export type DiagnosticsSnapshot = \{[\s\S]*?stages: StageMetric\[\]/, '要有 stages')
  assert.match(types, /export type StageMetric = \{[\s\S]*?avgLatencyMs: number[\s\S]*?maxLatencyMs: number/)

  const system = read('../src/lib/api/domains/system.ts')
  assert.match(system, /diagnostics: \(\) => request<DiagnosticsSnapshot>\('\/api\/diagnostics'\)/)

  const compat = read('../src/lib/api/index.ts')
  assert.match(compat, /diagnostics: system\.diagnostics/, '旧 api 对象也要能拿到')
})

test('界面：运行日志页顶上有一条诊断，默认收起、只取一次', () => {
  const modal = read('../src/components/LogsModal.tsx')
  assert.match(modal, /<DiagnosticsStrip \/>/, '要真的挂进日志页')
  assert.match(modal, /import \{ DiagnosticsStrip \} from '\.\/DiagnosticsStrip'/)

  const strip = read('../src/components/DiagnosticsStrip.tsx')
  assert.match(strip, /api\.diagnostics\(\)/, '读同一个端点')
  assert.match(strip, /const \[open, setOpen\] = useState\(false\)/, '默认收起：它是第二眼信息')
  assert.match(strip, /useEffect\([\s\S]{0,200}api\.diagnostics\(\)/, '只在挂载时取一次')
  assert.match(strip, /if \(!snapshot\) return null/, '取不到就整块不出现，不留空白')
  assert.match(strip, /content: '正文'/, '阶段 id 要有中文名')
  assert.match(strip, /item\.failures > 0 \? item\.failures : '—'/, '0 失败显示破折号，别堆一列 0')
})

test('契约：diagnostics 的 response 里写了 stages', () => {
  const json = JSON.parse(read('../../app/src/main/resources/agent-api.json'))
  const endpoint = json.endpoints.find((e: { path: string }) => e.path === '/api/diagnostics')
  assert.ok(endpoint, '端点要在目录里')
  assert.match(endpoint.response, /stages:\[\{stage,calls,failures,avgLatencyMs,lastLatencyMs,maxLatencyMs\}\]/)
  assert.match(endpoint.purpose, /search \/ explore \/ details \/ toc \/ content \/ js \/ http/, '阶段名要写在契约里')
})
