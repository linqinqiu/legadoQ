import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 选区共享 —— 「在对应地点研究」的落地判据。
 *
 * 用户原话：「ai 功能太差……不能在对应地点研究」。
 * 之前 AI 只知道"你在第 N 章"，不知道"你正盯着哪一段"：
 * 阅读器里选中文字弹出的 `NoteToolbar` 那份选区只活在 ReaderScreen 的局部 state 里，
 * 而 AI 悬浮球挂在根节点上，两棵互不相通的树。
 *
 * 这里钉三件事：
 * 1. 选区存放在**组件之外**（模块级 store），两边对同一份状态说话；
 * 2. 上下文里**带得出**选中的原文（且知道它在哪一章）；
 * 3. 选区**有上限** —— 整章那么长的选中不能直接塞进一次请求。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('选区存在组件之外：阅读器写入、AI 面板读取同一份', () => {
  const store = read('../src/lib/selectionStore.ts')
  // 模块级可变状态 + 订阅：组件卸载不影响它（和 aiChatStore 同一套做法）
  assert.match(store, /let current: TextSelection \| null/, '选区状态要在模块级，不能是组件 useState')
  assert.match(store, /export function getSelection/, '要能读当前选区')
  assert.match(store, /export function subscribeSelection/, '要能订阅变化')
  assert.match(store, /export function setSelectionFromDraft/, '阅读器要有写入入口')

  // 阅读器真的调用了它
  const reader = read('../src/reader/ReaderScreen.tsx')
  assert.match(reader, /setSelectionFromDraft\(/, '阅读器选中文字时要写入选区')
  assert.match(reader, /setSelection\(null\)/, '选区取消/保存后要清掉 —— 不然助手一直盯着旧的一段')
})

test('主壳把选区接进 uiContext', () => {
  const main = read('../src/main.tsx')
  assert.match(main, /useSyncExternalStore\(subscribeSelection, getSelection/, '主壳要订阅选区')
  assert.match(main, /selection: currentSelection/, 'uiContext 里要带上选区')
  assert.match(main, /import .*selectionStore/, '要引入选区 store')
})

test('上下文带得出选中的原文，并说明它在哪一章', () => {
  const ctx = read('../src/lib/uiContext.ts')
  assert.match(ctx, /selection: \{[\s\S]*?text: string/, 'UiContext 里要有选区字段')
  assert.match(ctx, /用户此刻选中了/, '要把选区写进给模型看的那段话')
  assert.match(ctx, /lines\.push\(s\.text\)/, '选中的原文要真的发出去 —— 只说"有一段被选中"等于没说')
  assert.match(ctx, /第 \$\{s\.chapterIndex \+ 1\} 章/, '要说明这段话在哪一章')
})

test('选区有上限：整章那么长的选中不能直接塞进请求', () => {
  const store = read('../src/lib/selectionStore.ts')
  assert.match(store, /export const MAX_SELECTION = \d+/, '要有一个明确的上限')
  assert.match(store, /clipSelection/, '要有裁剪函数')
  assert.match(store, /fullLength/, '要记住裁剪前的真实长度 —— 模型得知道"这是截断过的"')

  const ctx = read('../src/lib/uiContext.ts')
  assert.match(ctx, /fullLength > s\.text\.length/, '截断过要在上下文里说明')
  assert.match(ctx, /原文 \$\{s\.fullLength\} 字/, '要告诉模型原文多长')
})

test('选区取消后 AI 面板不再显示"选中的 N 字"', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /ctx\.selection/, '面板要读选区')
  assert.match(fab, /选中的 \$\{ctx\.selection\.text\.length\} 字/, '要让用户看见助手知道什么')
})
