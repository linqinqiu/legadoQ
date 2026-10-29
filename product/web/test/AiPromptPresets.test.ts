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
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('api 层有提示词预设的三个方法，路径与后端三条路由一致', () => {
  const api = read('../src/lib/api.ts')
  assert.match(api, /listAgentPrompts:\s*\(\)\s*=>\s*request<\{ prompts: AgentPrompt\[\] \}>\('\/api\/agent\/prompts'\)/,
    '列表要读 {prompts:[…]}，不是裸数组')
  assert.match(api, /saveAgentPrompt[\s\S]{0,160}'\/api\/agent\/prompts',\s*\{\s*method:\s*'POST'/, '保存走 POST')
  assert.match(api, /deleteAgentPrompt[\s\S]{0,200}`\/api\/agent\/prompts\/\$\{encodeURIComponent\(id\)\}`, \{ method: 'DELETE' \}/,
    '删除要 encodeURIComponent(id)，预设名可能含中文')
  assert.match(api, /export type AgentPrompt = \{[\s\S]*?order:\s*number/, '类型带 order（界面靠它排序）')
  assert.match(api, /export type AgentPromptInput = \{[\s\S]*?id\?:\s*string/, '新建时 id 可缺省，由服务端按名称生成')
})

test('AI 接入面板有独立的提示词区块，且说清与技能的分工', () => {
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  assert.match(modal, /<PromptsSection \/>/, '区块要真的挂进面板')
  assert.match(modal, /function PromptsSection/, '区块实现')
  assert.match(modal, /function PromptForm/, '新建/编辑表单')
  assert.match(modal, /api\.listAgentPrompts\(\)/, '列表从这里取')
  assert.match(modal, /api\.saveAgentPrompt\(/, '保存从这里发')
  assert.match(modal, /api\.deleteAgentPrompt\(/, '删除从这里发')

  // 分工：预设管"怎么说话"、对所有对话生效；技能管"这类任务怎么做"、按关键词命中。
  assert.match(modal, /怎么说话/, '要写清预设是"怎么说话"')
  assert.match(modal, /这类任务怎么做/, '要与技能的"这类任务怎么做"区分开')

  // 行内动作：开关与排序是这个功能的核心，少了任何一个都等于只能删了重建。
  assert.match(modal, /preset\.enabled \? '停用' : '启用'/, '每行能停用/启用')
  assert.match(modal, /上移\n/, '能上移')
  assert.match(modal, /下移\n/, '能下移')
  assert.match(modal, /新建提示词/, '能新建')

  // 删除是不可逆动作（虽然服务端会备份），必须二次确认并说清备份位置。
  assert.match(modal, /window\.confirm\(`删除提示词/, '删除要确认')
  assert.match(modal, /agent-prompts\.json 备份到 \.trash/, '确认文案要说清备份能找回')

  // 正文限长要在输入侧就挡住，而不是保存后被服务端截断。
  assert.match(modal, /setInstruction\(e\.target\.value\.slice\(0,\s*2000\)\)/, '输入框就限 2000 字')
})

test('排序的两条保存要顺序发，不能并发', () => {
  // 服务端 agent-prompts.json 是整份「读 → 改 → 写」：两条并发保存会各自读到旧快照，
  // 后落盘的把先落盘的顶掉（实测点一次上移，两条 order 变成同一个数）。
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  const move = modal.slice(modal.indexOf('const move = async'), modal.indexOf('return (\n    <section className="ai-section">\n      <h3>提示词</h3>'))
  assert.ok(move.length > 0, '要能找到 move 的实现')
  assert.doesNotMatch(move, /Promise\.all/, '排序不能用 Promise.all 并发发两条保存')
  const saves = move.match(/await api\.saveAgentPrompt\(/g) ?? []
  assert.equal(saves.length, 2, `应顺序 await 两次保存，实际 ${saves.length} 次`)
})

test('提示词排在技能之前（先定"怎么说话"，再定"怎么做"）', () => {
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  const promptsIndex = modal.indexOf('<PromptsSection />')
  const skillsIndex = modal.indexOf('<SkillsSection />')
  assert.ok(promptsIndex > 0 && skillsIndex > 0, '两个区块都要挂上')
  assert.ok(promptsIndex < skillsIndex, '面板里提示词区块要在技能之前')
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
  for (const file of ['../src/features/ai/AiConnectionsModal.tsx', '../src/features/ai/AiFloatingBall.tsx']) {
    const source = read(file)
    assert.match(source, /提示词 \{m\.promptsUsed\.length\} 条/, `${file}：要显示注入了几条预设`)
    assert.match(source, /已裁历史 \{m\.trimmed\} 条/, `${file}：裁过历史要如实说出来`)
  }
  const store = read('../src/features/ai/aiChatStore.ts')
  assert.match(store, /promptsUsed\?: string\[\]/, '会话消息类型装得下 promptsUsed')
  assert.match(store, /trimmed\?: number/, '会话消息类型装得下 trimmed')
})

test('裁历史不是静默改用户的输入：只丢整轮，最后一条用户消息保留', () => {
  // 这条判据在后端（AgentPromptContextTest）也有一份；这里守的是"界面不许假装没事"：
  // trimmed 一定要出现在元信息里，而不是被吞掉。
  const modal = read('../src/features/ai/AiConnectionsModal.tsx')
  assert.match(modal, /trimmed:\s*result\.trimmed > 0 \? result\.trimmed : undefined/,
    '没裁时不写字段，裁了才显示 —— 显示 "0 条" 会让人以为历史被动过')
})
