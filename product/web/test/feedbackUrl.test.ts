import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_TEMPLATE,
  FEEDBACK_TITLE_MAX,
  buildFeedbackUrl,
  clampText,
} from '../src/lib/feedbackUrl.ts'

const base = {
  repository: 'linqinqiu/legadoQ',
  title: '希望目录能记住折叠状态',
  description: '每次打开长目录都要重新折叠一遍，希望记住上次的状态。',
  version: '0.2.14',
  build: '11',
}

test('生成的地址指向仓库的新建 Issue 页，并带上 markdown 模板', () => {
  const url = buildFeedbackUrl(base)
  assert.ok(url.startsWith('https://github.com/linqinqiu/legadoQ/issues/new?'), url)
  const params = new URL(url).searchParams
  assert.equal(params.get('template'), FEEDBACK_TEMPLATE)
  assert.equal(params.get('title'), base.title)
})

test('正文带描述、版本与构建号，且不含未编码的换行', () => {
  const url = buildFeedbackUrl(base)
  const body = new URL(url).searchParams.get('body') ?? ''
  assert.ok(body.includes(base.description))
  assert.ok(body.includes('版本：0.2.14'))
  assert.ok(body.includes('构建：#11'))
  assert.ok(body.includes('关于 → 提交建议'))
  // URL 里不能出现裸换行，否则部分客户端会在那里截断
  assert.ok(!url.includes('\n'))
})

test('构建号缺失或为 0 时不编一个假构建', () => {
  const body = new URL(buildFeedbackUrl({ ...base, build: '0' })).searchParams.get('body') ?? ''
  assert.ok(!body.includes('构建：'))
  const noBuild = new URL(buildFeedbackUrl({ ...base, build: null })).searchParams.get('body') ?? ''
  assert.ok(!noBuild.includes('构建：'))
})

test('标题与描述按上限截断，且按字符而不是码元截', () => {
  assert.equal(clampText('  前后有空格  ', 20), '前后有空格')
  assert.equal(clampText('一二三四五', 3), '一二三')
  // emoji 是代理对：按 UTF-16 码元截会留下半个字符
  assert.equal(clampText('😀😀😀', 2), '😀😀')

  const url = buildFeedbackUrl({
    ...base,
    title: '标'.repeat(FEEDBACK_TITLE_MAX + 20),
    description: '字'.repeat(FEEDBACK_BODY_MAX + 20),
  })
  const params = new URL(url).searchParams
  assert.equal(Array.from(params.get('title') ?? '').length, FEEDBACK_TITLE_MAX)
  // 正文里还有分隔线与版本行，所以只断言"描述被截到上限、第 601 个字没进去"
  const body = params.get('body') ?? ''
  assert.ok(body.startsWith('字'.repeat(FEEDBACK_BODY_MAX)))
  assert.ok(!body.includes('字'.repeat(FEEDBACK_BODY_MAX + 1)))
})

test('最大输入下整条地址仍短于 8 KB，不会被浏览器或 WebView 截断', () => {
  const url = buildFeedbackUrl({
    ...base,
    title: '标'.repeat(FEEDBACK_TITLE_MAX),
    description: '字'.repeat(FEEDBACK_BODY_MAX),
  })
  assert.ok(url.length < 8000, `地址长 ${url.length}，超过 8 KB 安全线`)
})

test('空标题、空描述、不可用的仓库地址都拒绝生成', () => {
  assert.throws(() => buildFeedbackUrl({ ...base, title: '   ' }), /标题/)
  assert.throws(() => buildFeedbackUrl({ ...base, description: '  ' }), /描述/)
  assert.throws(() => buildFeedbackUrl({ ...base, repository: '' }), /仓库/)
  assert.throws(() => buildFeedbackUrl({ ...base, repository: 'a/b/c' }), /仓库/)
  assert.throws(() => buildFeedbackUrl({ ...base, repository: 'owner repo' }), /仓库/)
})
