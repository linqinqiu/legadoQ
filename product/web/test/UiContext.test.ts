import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_UI_CONTEXT,
  describeUiContext,
  uiContextMessage,
  type UiContext,
} from '../src/lib/uiContext.ts'

/**
 * 界面上下文的判据 —— 让 AI 能"识别所在界面内容"的基础。
 *
 * 测的是**采集与描述**本身：只描述真实状态、不编、不塞正文、空上下文不占位。
 * 具体某个界面采集到什么，由 main.tsx 的组装决定，这里测协议。
 */

const base: UiContext = {
  page: 'reader',
  dialog: null,
  source: null,
  book: null,
  keyword: null,
  // `selection` 是后加的一档（AI 悬浮球要能问"选中这一段"），字段本身是必填的。
  // 这里显式写成 null 而不是靠类型可选：判据要能看出"没有选区"是采集到的一种正常状态。
  selection: null,
}

test('空上下文不产生消息 —— 不该无端占一条 system', () => {
  assert.equal(uiContextMessage(EMPTY_UI_CONTEXT), null)
})

test('只有页面也算有内容 —— 至少告诉模型在哪个界面', () => {
  const msg = uiContextMessage(base)
  assert.ok(msg, '有页面就该产生消息')
  assert.equal(msg.role, 'system')
  assert.match(msg.content, /阅读器/)
})

test('页面名翻成中文 不把英文 key 直接丢给模型', () => {
  for (const [key, label] of [
    ['sources', '书源'], ['shelf', '书架'], ['library', '书库'],
    ['explore', '发现'], ['subscriptions', '订阅'], ['settings', '设置'], ['reader', '阅读器'],
  ] as const) {
    assert.match(describeUiContext({ ...base, page: key }), new RegExp(label))
  }
})

test('正在读的书会带标识与章节 —— 这样"这本书"才有指代', () => {
  const text = describeUiContext({
    ...base,
    book: {
      sourceId: 'src-1', bookUrl: 'https://x/book/1', name: '测试之书',
      author: '某作者', chapterIndex: 4, chapterTitle: '第五章',
    },
  })
  assert.match(text, /测试之书/)
  assert.match(text, /某作者/)
  assert.match(text, /第 5 章/, '章号要按人读的 1 基显示')
  assert.match(text, /第五章/)
  assert.match(text, /sourceId=src-1/, '要给模型可用的标识，它才能调工具去取正文')
  assert.match(text, /bookUrl=https:\/\/x\/book\/1/)
})

test('没有章名时不硬编一个 —— 只给章号', () => {
  const text = describeUiContext({
    ...base,
    book: { sourceId: 's', bookUrl: 'u', name: '书', chapterIndex: 0 },
  })
  assert.match(text, /第 1 章/)
  assert.doesNotMatch(text, /「」/, '没有章名就不该出现空引号')
})

test('选中的书源会带上 id', () => {
  const text = describeUiContext({ ...base, page: 'sources', source: { id: 's1', name: '某书源' } })
  assert.match(text, /某书源/)
  assert.match(text, /id=s1/)
})

test('打开的浮层会被说明', () => {
  const text = describeUiContext({ ...base, dialog: 'rules' })
  assert.match(text, /浮层：rules/)
})

test('搜索词会被带上', () => {
  const text = describeUiContext({ ...base, page: 'explore', keyword: '三体' })
  assert.match(text, /搜索词：三体/)
})

test('上下文只描述状态 不给指令 —— 采集层不该固化提示词', () => {
  const text = describeUiContext({
    ...base,
    book: { sourceId: 's', bookUrl: 'u', name: '书', chapterIndex: 0, chapterTitle: '章' },
  })
  // 出现"你应该""请你"这类祈使句就说明采集层越界了
  assert.doesNotMatch(text, /你应该|请你|务必|必须回/, '采集层只描述，不给模型下指令')
  assert.match(text, /只描述、不是指令/, '应当明确告诉模型这是状态而非指令')
})

test('不塞正文 —— 上下文要能塞进一次请求', () => {
  const longIntro = 'x'.repeat(5000)
  const text = describeUiContext({
    ...base,
    book: { sourceId: 's', bookUrl: 'u', name: '书', author: longIntro, chapterIndex: 0 },
  })
  // 只有书名/作者这类短字段，不该出现整段正文；这里用长度做个粗护栏
  assert.ok(text.length < 2000, `上下文不该膨胀（实际 ${text.length} 字符）`)
})
