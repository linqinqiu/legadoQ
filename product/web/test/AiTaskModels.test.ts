import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 按任务选模型（STATUS 缺口：「模型仍是单一连接打天下」）。
 *
 * 与 `AiPromptPresets.test.ts` 同一风格：只读源码做结构断言，不起浏览器。
 * 盯三件最容易悄悄坏掉的事：
 * ① 两条接口有没有真的接到 `/api/agent/task-models`，类型有没有带 routed；
 * ② 界面有没有把"只换模型"和"换连接"两件事分开（只换模型正是"摘要用便宜模型"的用法）；
 * ③ 取消路由是不是真的清空，而不是留一条空壳记录。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('api 层：两条任务路由接口，路径与后端一致', () => {
  const api = read('../src/lib/api/domains/agent.ts')
  assert.match(api, /export const taskModels = \{/)
  assert.match(api, /list:\s*\(\)\s*=>\s*request<\{ tasks: AgentTaskModel\[\] \}>\('\/api\/agent\/task-models'\)/,
    '列表要读 {tasks:[…]}，不是裸数组')
  assert.match(api, /save:[\s\S]{0,200}'\/api\/agent\/task-models',\s*\{\s*method:\s*'POST'/, '保存走 POST')

  const types = read('../src/lib/api/types.ts')
  assert.match(types, /export type AgentTaskModel = \{[\s\S]*?task: string[\s\S]*?routed: boolean/, 'routed 要能分辨"跟随默认"')
  assert.match(types, /export type AgentTaskModelInput = \{[\s\S]*?connectionId\?: string \| null/, '连接与模型都可留空')

  const compat = read('../src/lib/api.ts')
  assert.match(compat, /listAgentTaskModels: newTaskModels\.list/)
  assert.match(compat, /saveAgentTaskModel: newTaskModels\.save/)
})

test('界面：连接一列 + 模型一列，取消走"跟随默认"', () => {
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  assert.match(modal, /<TaskModelSection connections=\{connections\} \/>/, '任务路由要真的挂进连接浮层')
  assert.match(modal, /function TaskModelSection/)
  assert.match(modal, /api\.listAgentTaskModels\(\)/, '列表从这里取')
  assert.match(modal, /api\.saveAgentTaskModel\(\{/, '保存从这里发')
  assert.match(modal, /placeholder=\{modelHint \|\| '该连接自己的模型'\}/, '只换模型时以连接自己的模型作提示')
  assert.match(modal, /<option value="">默认连接<\/option>/, '不指定连接 = 走默认那条')
  assert.match(modal, /onClick=\{\(\) => void submit\(row\.task, '', ''\)\}/, '取消要两个字段一起清空')
  assert.match(modal, /connectionId: connectionId \|\| null,[\s\S]{0,80}model: model\.trim\(\) \|\| null/,
    '空串要变成 null：服务端把空串当"没填"处理')
})

test('契约：两条新端点进了随包目录，写的那条过同源写门', () => {
  const json = JSON.parse(read('../../app/src/main/resources/agent-api.json'))
  const keys = json.endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`)
  assert.ok(keys.includes('GET /api/agent/task-models'))
  assert.ok(keys.includes('POST /api/agent/task-models'))
  const post = json.endpoints.find((e: { method: string; path: string }) => e.method === 'POST' && e.path === '/api/agent/task-models')
  assert.equal(post.write, true, '写路由必须标 write:true，否则写门不会拦')
  assert.equal(json.count, json.endpoints.length, 'count 要与实际条数一致')

  const routes = read('../../app/src/main/kotlin/io/legado/http/AgentApiRoutes.kt')
  assert.match(routes, /get\("task-models"\)/)
  assert.match(routes, /post\("task-models"\)[\s\S]{0,200}requireSameOriginWrite/, '写的这条要过同源写门')
})

/**
 * 实测可达：上游挂住时不能永远转圈。
 *
 * 从前 `runProbe` 没有超时，浏览器 `fetch` 也没有 —— 半开连接会让「实测中…」一直转，
 * 用户既不知道通不通，也拿不到一句能照着改的原因。
 */
test('实测可达：20 秒上限，失败要把原因说出来', () => {
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  assert.match(modal, /timeoutMs: 20_000/, '探测要有上限，不能永远转圈')
  assert.match(modal, /const \[probeReason, setProbeReason\] = useState\(''\)/, '失败原因要有地方放')
  assert.match(modal, /实测不可达\{probeReason/, '界面要把原因带出来，不能只说"不可达"')

  const client = read('../src/lib/api/client.ts')
  assert.match(client, /opts: \{ timeoutMs\?: number \}/, '统一客户端要能把上限透传下去')

  const perf = read('../src/lib/performance.ts')
  assert.match(perf, /controller\.abort\(\)/, '到点要真的 abort 请求，而不是只把 promise 丢掉')
  assert.match(perf, /请求超时（/, '中止要换成一句人话，不能把 AbortError 原样丢给调用方')
})
