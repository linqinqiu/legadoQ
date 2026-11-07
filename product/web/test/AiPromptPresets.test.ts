import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 提示词预设（借自 legado-with-MD3 的 `AiPromptPreset`）的前端判据。
 *
 * 与 `AiAssistEnhancements.test.ts` 同一风格：只读源码做结构断言，不起浏览器。
 * 盯三件最容易悄悄坏掉的事：
 * ① 三条接口方法有没有真的接到 `/api/agent/prompts`；
 * ② 界面把「预设」与「技能」说成同一件事（两者语义一混，用户就不知道往哪填）；
 * ③ 后端回报的 promptsUsed / trimmed 有没有一路传到气泡 —— 没有这两项，
 *    用户根本看不出自己刚写的预设到底生效了没有。
 *
 * 2026-11-03：「AI 接入」那一档浮层拆成六档（对话 / 模型连接 / 工具 / 技能 / 提示词 /
 * 书源校验），提示词的界面从 `AiConnectionsModal.tsx` 搬进 `AiPromptsModal.tsx`，
 * 对话搬进 `AiChatModal.tsx`。判据跟着换文件，断言的东西一条没减。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('api 层有提示词预设的三个方法，路径与后端三条路由一致', () => {
  // 0.2.14：按域拆分后三条实现住在 lib/api/domains/agent.ts，类型在 lib/api/types.ts
  const api = read('../src/lib/api/domains/agent.ts')
  assert.match(api, /list:\s*\(\)\s*=>\s*request<\{ prompts: AgentPrompt\[\] \}>\('\/api\/agent\/prompts'\)/,
    '列表要读 {prompts:[…]}，不是裸数组')
  assert.match(api, /save:[\s\S]{0,160}'\/api\/agent\/prompts',\s*\{\s*method:\s*'POST'/, '保存走 POST')
  assert.match(api, /delete:[\s\S]{0,240}`\/api\/agent\/prompts\/\$\{encodeURIComponent\(id\)\}`[\s\S]{0,80}method:\s*'DELETE'/,
    '删除要 encodeURIComponent(id)，预设名可能含中文')
  const types = read('../src/lib/api/types.ts')
  assert.match(types, /export type AgentPrompt = \{[\s\S]*?order:\s*number/, '类型带 order（界面靠它排序）')
  assert.match(types, /export type AgentPromptInput = \{[\s\S]*?id\?:\s*string/, '新建时 id 可缺省，由服务端按名称生成')
})

test('提示词有自己那一档浮层，且说清与技能的分工', () => {
  const modal = read('../src/features/ai/AiPromptsModal.tsx')
  assert.match(modal, /<PromptsPanel \/>/, '内容要真的挂进浮层')
  assert.match(modal, /function PromptsPanel/, '面板实现')
  assert.match(modal, /function PromptForm/, '新建/编辑表单')
  assert.match(modal, /api\.listAgentPrompts\(\)/, '列表从这里取')
  assert.match(modal, /api\.saveAgentPrompt\(/, '保存从这里发')
  assert.match(modal, /api\.deleteAgentPrompt\(/, '删除从这里发')
  // 独立一档也必须还是那一套外壳（遮罩 + dialog-shell + 关闭键），不许长出一个裸表单
  assert.match(modal, /<AiPanel title="AI 提示词"/, '走共用的浮层外壳')

  // 分工：预设管"怎么说话"、对所有对话生效；技能管"这类任务怎么做"、按关键词命中。
  assert.match(modal, /怎么说话/, '要写清预设是"怎么说话"')
  assert.match(modal, /这类任务怎么做/, '要与技能的"这类任务怎么做"区分开')

  // 行内动作：开关与排序是这个功能的核心，少了任何一个都等于只能删了重建。
  assert.match(modal, /preset\.enabled \? '停用' : '启用'/, '每行能停用/启用')
  assert.match(modal, /上移\n/, '能上移')
  assert.match(modal, /下移\n/, '能下移')
  assert.match(modal, /新建提示词/, '能新建')

  // 删除是不可逆动作（虽然服务端会备份），必须二次确认并说清能找回。
  assert.match(modal, /window\.confirm\(`删除提示词/, '删除要确认')
  assert.match(modal, /删除前会先备份整份清单/, '确认文案要说清备份能找回')

  // 正文限长要在输入侧就挡住，而不是保存后被服务端截断。
  assert.match(modal, /setInstruction\(e\.target\.value\.slice\(0,\s*2000\)\)/, '输入框就限 2000 字')
})

test('排序的两条保存要顺序发，不能并发', () => {
  // 服务端那份清单是整份「读 → 改 → 写」：两条并发保存会各自读到旧快照，
  // 后落盘的把先落盘的顶掉（实测点一次上移，两条 order 变成同一个数）。
  const modal = read('../src/features/ai/AiPromptsModal.tsx')
  const move = modal.slice(modal.indexOf('const move = async'), modal.indexOf('return (\n    <section className="ai-section">\n      <h3>AI 提示词</h3>'))
  assert.ok(move.length > 0, '要能找到 move 的实现')
  assert.doesNotMatch(move, /Promise\.all/, '排序不能用 Promise.all 并发发两条保存')
  const saves = move.match(/await api\.saveAgentPrompt\(/g) ?? []
  assert.equal(saves.length, 2, `应顺序 await 两次保存，实际 ${saves.length} 次`)
})

test('注入顺序：先定"怎么说话"的预设，再定"怎么做"的技能', () => {
  // 拆成两档浮层之后，界面上已经没有"谁在谁之前"这回事了；真正的不变量在服务端注入时：
  // `Agent.injectContext` 必须先把预设拼进 system，再拼技能（越具体越靠后）。
  const agent = read('../../app/src/main/kotlin/io/legado/ai/Agent.kt')
  const inject = agent.slice(agent.indexOf('private fun injectContext'))
  // 2026-11-07：预设转 system 消息抽进 `presetMessages`（对话与摘要共用同一套格式），
  // 判据跟着改成"调 presetMessages 必须在拼技能之前"，盯的还是同一个不变量。
  const promptsAt = inject.indexOf('presetMessages(prompts)')
  const skillsAt = inject.indexOf('for (skill in skills)')
  assert.ok(promptsAt > 0 && skillsAt > 0, '两段注入都要找得到')
  assert.ok(promptsAt < skillsAt, '提示词要先注入，技能在后（与界面那句分工一致）')
})

test('流式累积器收下 prompts 与 trimmed，快照不共用数组', () => {
  const stream = read('../src/features/ai/agentStream.ts')
  assert.match(stream, /prompts:\s*string\[\]/, 'draft 里有 prompts')
  assert.match(stream, /trimmed:\s*number/, 'draft 里有 trimmed')
  assert.match(stream, /if \(event\.prompts\) draft\.prompts = event\.prompts/, 'start/end 帧都要收下')
  assert.match(stream, /if \(event\.trimmed\) draft\.trimmed = event\.trimmed/, '没裁时不覆盖成 0')
  assert.match(stream, /prompts: \[\.\.\.draft\.prompts\]/, '快照要拷贝，不能与 draft 共用引用')
})

test('两处气泡都回报"这轮带上了什么"', () => {
  for (const file of ['../src/features/ai/AiChatModal.tsx', '../src/features/ai/AiFloatingBall.tsx']) {
    const source = read(file)
    assert.match(source, /提示词 \{m\.promptsUsed\.length\} 条/, `${file}：要显示注入了几条预设`)
    assert.match(source, /已裁历史 \{m\.trimmed\} 条/, `${file}：裁过历史要如实说出来`)
  }
  const store = read('../src/lib/aiChatStore.ts')
  assert.match(store, /promptsUsed\?: string\[\]/, '会话消息类型装得下 promptsUsed')
  assert.match(store, /trimmed\?: number/, '会话消息类型装得下 trimmed')
})

test('裁历史不是静默改用户的输入：只丢整轮，最后一条用户消息保留', () => {
  // 这条判据在后端（AgentPromptContextTest）也有一份；这里守的是"界面不许假装没事"：
  // trimmed 一定要出现在元信息里，而不是被吞掉。
  const modal = read('../src/features/ai/AiChatModal.tsx')
  assert.match(modal, /trimmed:\s*result\.trimmed > 0 \? result\.trimmed : undefined/,
    '没裁时不写字段，裁了才显示 —— 显示 "0 条" 会让人以为历史被动过')
})

test('预设可以只挂到某个任务上：范围走任务清单，空 = 全局', () => {
  const types = read('../src/lib/api/types.ts')
  assert.match(types, /export type AgentPrompt = \{[\s\S]*?tasks: string\[\]/, '预设要带生效范围')
  assert.match(types, /export type AgentPromptInput = \{[\s\S]*?tasks\?: string\[\]/, '保存时可选')

  const modal = read('../src/features/ai/AiPromptsModal.tsx')
  assert.match(modal, /api\.listAgentTaskModels\(\)/, '任务清单与「按任务选模型」共用一份，不另起一套')
  assert.match(modal, /<fieldset className="ai-task-scope">/, '生效范围要有自己的分组')
  assert.match(modal, /不勾 = 所有任务都注入/, '空选择 = 全局，这句话要写在界面上')
  assert.match(modal, /^\s*tasks,$/m, '保存请求要带上 tasks')
  // 停用 / 上移下移都走 toPromptInput：不带上 tasks 会把"只给某个任务"洗成全局。

  // 停用 / 上移下移都走 toPromptInput：不带上 tasks 会把"只给某个任务"洗成全局。
  assert.match(modal, /tasks: preset\.tasks,/, 'toPromptInput 必须原样带上生效范围')
  assert.match(modal, /function scopeLabel\(tasks: string\[\], options: AgentTaskModel\[\]\): string/)
  assert.match(modal, /\{preset\.tasks\.length > 0 && <span className="ai-tag ai-skill-badge">/, '列表里要标出范围')
})
