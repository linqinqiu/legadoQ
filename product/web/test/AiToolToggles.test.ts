import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * AI 工具「逐项停用」（借自 refgd 的 `aiEnabledToolNames`）的前端判据。
 *
 * 存储读写是真跑的（装一个内存 localStorage 再 import 模块），因为最容易坏掉的恰好是
 * 迁移与"别顺手清掉另一项"这两条 —— 只看源码字符串看不出 `saveAiToolGroups` 有没有把
 * disabledTools 丢掉，而那正是用户会遇到的"我明明只关了个组，怎么逐项选择全没了"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const KEY = 'legado-ai-tool-groups'

/** 装一个够用的 localStorage 垫片，返回读写句柄。 */
function withLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const previous = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
  }
  return {
    peek: (key: string) => store.get(key) ?? null,
    restore: () => {
      if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
      else (globalThis as { localStorage?: unknown }).localStorage = previous
    },
  }
}

test('v1 的组选择在升级到逐项停用后仍然读得出来', async () => {
  const env = withLocalStorage({ [KEY]: JSON.stringify(['tts', 'bookshelf']) })
  try {
    const { loadAiToolPrefs } = await import('../src/lib/aiToolGroups')
    const prefs = loadAiToolPrefs()
    assert.deepEqual(prefs.groups, ['tts', 'bookshelf'], '旧格式（纯数组）要读成组限制')
    assert.deepEqual(prefs.disabledTools, [], '旧格式没有逐项停用，应为空而不是 undefined')
  } finally { env.restore() }
})

test('关组不会顺手清空逐项停用，反之也一样', async () => {
  const env = withLocalStorage({
    [KEY]: JSON.stringify({ groups: ['tts'], disabledTools: ['tts.speak'] }),
  })
  try {
    const { loadAiToolPrefs, saveAiToolGroups, saveAiToolPrefs } = await import('../src/lib/aiToolGroups')

    // 只动组：逐项停用必须原样留着。
    saveAiToolGroups(['tts', 'notes'])
    let stored = JSON.parse(env.peek(KEY) ?? '{}') as { groups?: string[]; disabledTools?: string[] }
    assert.deepEqual(stored.groups, ['tts', 'notes'])
    assert.deepEqual(stored.disabledTools, ['tts.speak'], '关组时把逐项停用清空就是丢用户的选择')

    // 只动逐项停用：组限制必须原样留着。
    saveAiToolPrefs({ groups: loadAiToolPrefs().groups, disabledTools: [] })
    stored = JSON.parse(env.peek(KEY) ?? '{}') as { groups?: string[]; disabledTools?: string[] }
    assert.deepEqual(stored.groups, ['tts', 'notes'], '反过来也一样，两个开关互不覆盖')
    assert.deepEqual(stored.disabledTools, [])
  } finally { env.restore() }
})

test('两个对话入口都把 disabledTools 发出去', () => {
  for (const file of ['../src/features/ai/AiConnectionsModal.tsx', '../src/features/ai/AiFloatingBall.tsx']) {
    const source = read(file)
    assert.match(source, /disabledTools:\s*prefs\.disabledTools/, `${file}：发送时要带上逐项停用清单`)
  }
  const api = read('../src/lib/api.ts')
  assert.match(api, /\.\.\.\(disabledTools && disabledTools\.length > 0 \? \{ disabledTools \} : \{\}\)/,
    '非流式 chat 带上 disabledTools（空数组不进请求体）')
  assert.match(api, /\.\.\.\(opts\.disabledTools && opts\.disabledTools\.length > 0 \? \{ disabledTools: opts\.disabledTools \} : \{\}\)/,
    '流式 chat 同样带上 —— 两条路径的过滤必须一致')
  const stream = read('../src/features/ai/agentStream.ts')
  assert.match(stream, /disabledTools:\s*opts\.disabledTools/, '流式累积器要透传')
})

test('工具区块给出逐项复选框，并解释 program 组为什么不能停', () => {
  const section = read('../src/settings/AiToolsSection.tsx')
  assert.match(section, /loadAiToolPrefs/, '状态读的是完整偏好')
  assert.match(section, /toggleTool/, '有逐项开关的处理')
  assert.match(section, /aria-label=\{`启用 \$\{tool\.id\}`\}/, '每个工具一条可勾选项，且有可读标签')
  assert.match(section, /已停用 \$\{offCount\} 个/, '组行上要看得见这一组停了几条')
  assert.match(section, /始终可用/, 'program 组那几条要说明为什么没有复选框')
  assert.match(section, /展开一组还能逐个停用/, '顶部说明要讲清有这一层')
})

test('凭据界面说清会话层与超长丢下的键', () => {
  const api = read('../src/lib/cookieApi.ts')
  assert.match(api, /sessionKeys\?: string\[\]/, '列表类型装得下会话键')
  assert.match(api, /droppedKeys\?: string\[\]/, '也装得下因超长没发出去的键')
  const section = read('../src/settings/CookieSection.tsx')
  assert.match(section, /仅本次会话（重启失效）/, '要说清会话凭据的寿命，不能只说"有几个键"')
  assert.match(section, /不会发出/, '被 4096 上限丢下的键要指名道姓')
  assert.match(section, /单条就超过 4096 字符/, '只剩一条仍然超限是另一回事，要分开说')
})
