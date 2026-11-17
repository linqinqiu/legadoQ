import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「AI 外部工具（MCP）」前端判据。
 *
 * 这一档最容易坏在三处，而三处都看不出报错：
 * ① 端点路径/方法写错 —— 保存按钮点了没反应，控制台只一条 404；
 * ② 忘了接进入口 —— 组件写好了，用户根本找不到（`ai-mcp` 不在 AppModal 里就是这种）；
 * ③ 把请求头的**值**显示出来 —— 那里面通常就是 token，回显一次就多一次被截图带走的机会。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('API 层的 MCP 四条端点与后端一致', () => {
  const api = read('../src/lib/api/domains/agent.ts')
  assert.match(api, /list: \(\) => request<\{ group: string; servers: AgentMcpServer\[\] \}>\('\/api\/agent\/mcp'\)/,
    '列表：GET /api/agent/mcp')
  assert.match(api, /request<AgentMcpServer>\('\/api\/agent\/mcp', \{\s*\n\s*method: 'POST'/,
    '保存：POST /api/agent/mcp（保存即连接）')
  assert.match(api, /request<\{ group: string; servers: AgentMcpServer\[\] \}>\('\/api\/agent\/mcp\/refresh', \{\s*\n\s*method: 'POST'/,
    '刷新：POST /api/agent/mcp/refresh')
  assert.match(api, /`\/api\/agent\/mcp\/\$\{encodeURIComponent\(id\)\}`/, '删除要编码 id')
  assert.match(api, /method: 'DELETE'/, '删除用 DELETE')
})

test('类型里有 MCP 服务，且只承诺回传请求头名字', () => {
  const types = read('../src/lib/api/types.ts')
  assert.match(types, /export type AgentMcpServer = \{/, '要有服务视图类型')
  assert.match(types, /headerNames: string\[\]/, '请求头只回名字')
  assert.match(types, /export type AgentMcpServerInput = \{/, '要有保存入参类型')
  assert.match(types, /enabled\?: boolean/, '入参要能只改启停')
})

test('入口接全：AppModal、设置页一行、浮层渲染', () => {
  const nav = read('../src/lib/nav.ts')
  assert.match(nav, /\| 'ai-mcp'/, 'AppModal 里要有 ai-mcp，否则 openModalDirect 打不开')
  const main = read('../src/main.tsx')
  assert.match(main, /openAiMcp: \(\) => openModalDirect\('ai-mcp'\)/, '设置页动作要指到 ai-mcp')
  assert.match(main, /openModal === 'ai-mcp' && <AiMcpModal/, '浮层要真的渲染出来')
  const sections = read('../src/features/settings/settingsSections.ts')
  assert.match(sections, /openAiMcp: \(\) => void/, '动作类型要有这一项')
  // 2026-11-12：AI 入口整体搬进独立的「AI」分区，标题去掉了重复的「AI 」前缀
  // （分区名已经是 AI，行名再带一次只是噪音）。这里跟着改，断言意图不变：设置页要有一行、用中文名。
  assert.match(sections, /外部工具（MCP）/, '设置页要有一行，且用中文名')
})

test('界面不显示请求头的值，密码输入框兜住', () => {
  const panel = read('../src/features/ai/AiMcpModal.tsx')
  assert.match(panel, /server\.headerNames/, '只渲染名字')
  assert.doesNotMatch(panel, /headerValues|headers\.map|Object\.entries\(server\.headers\)/, '不许把整份 headers 摊开渲染')
  assert.match(panel, /type="password"/, '填 token 的输入框要遮起来')
})

test('没填请求头时整个字段都不发（传空对象等于清空鉴权头）', () => {
  const panel = read('../src/features/ai/AiMcpModal.tsx')
  assert.match(
    panel,
    /Object\.keys\(headers\)\.length > 0 \? \{ headers \} : \{\}/,
    '空表也要发出去的话，用户改个名字就把 Authorization 抹了 —— 服务端把"不传"当作"沿用原值"',
  )
})

test('工具组有一档中文名，默认不下发的说法在界面上', () => {
  const groups = read('../src/lib/aiToolGroups.ts')
  assert.match(groups, /mcp: \{/, 'mcp 组要有中文名与说明')
  assert.match(groups, /外部工具（MCP）/, '显示名')
  assert.match(groups, /默认不下发/, '要说清它默认是关的，否则用户以为没接上')
  const panel = read('../src/features/ai/AiMcpModal.tsx')
  assert.match(panel, /默认关着/, '面板里也要讲一遍')
  assert.match(panel, /私网段会被拒绝/, '地址限制要提前说，不要等保存失败才说')
})
