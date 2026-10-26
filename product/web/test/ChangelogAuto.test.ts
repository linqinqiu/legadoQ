import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SECTION_ORDER,
  classify,
  mergeEntries,
  overLong,
  parseCommitHeader,
  renderEntry,
  summarize,
} from '../../scripts/changelog-lib.mjs'

/**
 * 「当更新修改内容自动更新更新日志」（用户 2026-10-24）。
 *
 * 这里测的是 `scripts/changelog-lib.mjs` 那层纯逻辑：喂提交标题进去，看它归到哪一节、
 * 写成什么样、以及往 CHANGELOG 文本里合并时会不会破坏结构。
 * git 与落盘在 `scripts/changelog.mjs`，那层不起测试（起合成仓库要跑 `git commit`，
 * 在本机环境上不稳），所以所有判断都收在这层可测的纯函数里。
 */

test('约定式标题解析：类型 / scope / 破坏性标记', () => {
  assert.deepEqual(parseCommitHeader('feat(AI): 加悬浮球'), { type: 'feat', scope: 'AI', breaking: false, subject: '加悬浮球' })
  assert.equal(parseCommitHeader('fix!: 接口换了')?.breaking, true)
  assert.equal(parseCommitHeader('chore(deps): 升 gradle')?.type, 'chore')
  // 不是约定式的：合并提交、WIP、随手写的一串 —— 一律 null（不猜类型）
  assert.equal(parseCommitHeader('Merge branch "main"'), null)
  assert.equal(parseCommitHeader('wip'), null)
  assert.equal(parseCommitHeader(''), null)
})

test('该记的进对应小节，工程内部变化不记', () => {
  assert.equal(classify('feat(书架): 批量加书架').section, '新增')
  assert.equal(classify('fix: 云朵误显示').section, '修复')
  assert.equal(classify('perf: 首屏快了').section, '变更')
  assert.equal(classify('revert: 退回上一版').section, '修复')
  // 工程内部动作对读者不是"变化"，混进来会把"这版对我有什么变化"淹掉
  for (const header of ['test(web): 加判据', 'chore: 清文件', 'build: 改打包', 'ci: 加流水线', 'style: 排版', 'refactor: 拆文件', 'docs: 补文档']) {
    const verdict = classify(header)
    assert.equal(verdict.include, false, `${header} 不该进日志`)
    assert.ok(String(verdict.reason ?? '').length > 0, '跳过要给得出理由，不能静默丢')
  }
  // 改的就是更新日志本身的那条（docs(CHANGELOG)）不派生，否则日志会给自己记账
  assert.equal(classify('docs(CHANGELOG): 补三条用户可见变化').include, false)
})

test('显式覆盖优先于类型表', () => {
  assert.equal(classify('feat: 内部代号 X-1', 'Changelog: none').include, false, 'Changelog: none 不进')
  assert.equal(classify('feat: 内部代号 X-1', 'Changelog: 桌面应用可以改名了').text, '桌面应用可以改名了',
    'trailer 给的人话替换自动文案')
  assert.equal(classify('feat: 这条别记 [no-changelog]').include, false, '标题里带 [no-changelog] 也不进')
  assert.equal(classify('feat: 正文里标了', '随手一句\n[no-changelog]').include, false)
  // trailer 大小写与位置都不该影响识别
  assert.equal(classify('feat: x', 'changelog: 小写也行').text, '小写也行')
})

test('破坏性变更要被点名（脚本不擅自改版本号，只提示）', () => {
  assert.equal(classify('feat!: 换备份格式').needsVersionBump, true, '带 `!` 要提示进档')
  assert.equal(classify('fix: x', 'BREAKING CHANGE: 旧包读不了').needsVersionBump, true)
  assert.equal(classify('feat: 普通新增').needsVersionBump, false, '没破坏就不提示进档（不能留 undefined 让调用方各判一次）')
})

test('条目渲染：粗体一句话，scope 进括号', () => {
  assert.equal(renderEntry({ text: '批量加书架', scope: '书架' }), '- **批量加书架（书架）**')
  assert.equal(renderEntry({ text: '没有 scope', scope: '' }), '- **没有 scope**')
  // 提交标题里的换行要收掉：否则一条日志被写成两行，界面按续行并回去会变成半截话
  assert.equal(renderEntry({ text: '第一行\n第二行', scope: '' }), '- **第一行 第二行**')
})

const BASE = [
  '# 更新日志',
  '',
  '说明散文，不属于任何版本。',
  '',
  '## [0.9.0] - 2026-10-24',
  '',
  '### 新增',
  '',
  '- **已有的一条。**',
  '',
  '### 修复',
  '',
  '- **已有的一条修复。**',
  '',
  '## [0.8.6] - 2026-10-23',
  '',
  '### 新增',
  '',
  '- **历史条目，不许被改动。**',
  '',
].join('\n')

test('合并：写进当前版本对应的节，历史条目一个字都不动', () => {
  const { text, version, inserted, changed } = mergeEntries(BASE, [
    { section: '修复', text: '云朵误显示' },
    { section: '新增', text: '批量加书架', scope: '书架' },
  ])
  assert.equal(version, '0.9.0', '报告写进了哪个版本')
  assert.equal(inserted.length, 2)
  assert.equal(changed, true)
  assert.match(text, /- \*\*批量加书架（书架）\*\*/, '新条目在')
  assert.match(text, /- \*\*云朵误显示\*\*/, '另一节的新条目也在')
  assert.match(text, /## \[0\.8\.6\][\s\S]*历史条目，不许被改动/, '历史版本条目原样保留（往已发布版本补条目等于伪造历史）')
  assert.match(text, /已有的一条。/, '原条目不被覆盖')
})

test('合并：小节顺序不许被自动生成打乱', () => {
  // 只给一个"变更"，而原文没有这一节：它必须落在 新增 与 修复 之间，不能被追加到末尾。
  const { text } = mergeEntries(BASE, [{ section: '变更', text: '改名了' }])
  const heads = [...text.slice(text.indexOf('## [0.9.0]'), text.indexOf('## [0.8.6]')).matchAll(/^### (.+)$/gm)].map(m => m[1])
  assert.deepEqual(heads, ['新增', '变更', '修复'], heads.join(' → '))
  assert.deepEqual(heads, [...heads].sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b)),
    '小节必须按 新增→变更→修复→移除 排（这一版刚立的规矩，不能被生成器第一个破坏）')
})

test('合并：同名小节不许出现两次', () => {
  const { text } = mergeEntries(BASE, [
    { section: '修复', text: '第一条新修复' },
    { section: '修复', text: '第二条新修复' },
  ])
  const seg = text.slice(text.indexOf('## [0.9.0]'), text.indexOf('## [0.8.6]'))
  const heads = [...seg.matchAll(/^### (.+)$/gm)].map(m => m[1])
  assert.equal(heads.filter(h => h === '修复').length, 1, `修复小节只该有一个：${heads.join(',')}`)
  assert.match(seg, /第一条新修复[\s\S]*?第二条新修复/, '两条都进同一个小节且保持顺序')
})

test('合并：已有相同文案就不重复插（幂等，手写过一遍的不再插）', () => {
  // 注意得与 fixture 里的条目**逐字**相同（含句末的句号）：mergeEntries 的去重是精确比对，
  // 差一个标点就是两条不同的话，那是"该插"，不是重复。
  const once = mergeEntries(BASE, [{ section: '新增', text: '已有的一条。' }])
  assert.equal(once.changed, false, '文案已存在时不该改动文件')
  assert.equal(once.inserted.length, 0)
  assert.equal(once.skippedAsDuplicate.length, 1, '但要报告"跳过了"，不能静默')
  // 差一个标点 = 不是重复，仍要插（这条反向对着上面那条，防止去重做太松把该记的吞了）
  const near = mergeEntries(BASE, [{ section: '新增', text: '已有的一条' }])
  assert.equal(near.changed, true, '少一个句号就是另一句话，不该被当重复吞掉')
})

test('合并：原文没有小节时按固定顺序建节', () => {
  const bare = ['## [0.9.0] - 2026-10-24', '', '- **前言式的一条。**', ''].join('\n')
  const { text } = mergeEntries(bare, [{ section: '新增', text: '一条新增' }])
  assert.match(text, /^### 新增$/m, '该建节就建节')
  const heads = [...text.matchAll(/^### (.+)$/gm)].map(m => m[1])
  assert.deepEqual(heads, ['新增'])
})

test('合并：CRLF 与 LF 都按原文件行尾写回', () => {
  const crlf = BASE.replace(/\n/g, '\r\n')
  const { text, eol } = mergeEntries(crlf, [{ section: '新增', text: '一条' }])
  assert.equal(eol, '\r\n')
  assert.ok(!/[^\r]\n/.test(text), 'CRLF 文件里不该混进裸 LF（一行一种行尾，diff 会整篇翻）')
  const lf = mergeEntries(BASE, [{ section: '新增', text: '一条' }])
  assert.equal(lf.eol, '\n')
})

test('合并：没有版本条目时报错而不是悄悄新建一个版本', () => {
  // 版本号只有一个来源，脚本不擅自进档；没有当前条目时该让人去开一条。
  assert.throws(() => mergeEntries('# 更新日志\n\n还没有版本条目\n', [{ section: '新增', text: 'x' }]), /## \[/)
})

test('合并：未知小节名直接报错', () => {
  assert.throws(() => mergeEntries(BASE, [{ section: '优化', text: 'x' }]), /未知小节/)
})

test('超长条目要被点名（静默截断才是问题）', () => {
  assert.equal(overLong({ text: '短的一条' }), null)
  const long = '很'.repeat(150)
  assert.ok(overLong({ text: long }), '超上限要给出警告位，让人改成人话而不是被裁')
})

test('分组清单按固定顺序输出（--dry-run 与门禁提示共用）', () => {
  const groups = summarize([
    { section: '修复', text: 'a' },
    { section: '新增', text: 'b' },
    { section: '修复', text: 'c' },
  ])
  assert.deepEqual(groups.map((g: { section: string }) => g.section), ['新增', '修复'])
  assert.deepEqual(groups[1].entries.map((e: { text: string }) => e.text), ['a', 'c'])
})

/** 这一版立的规矩：日志只写用户可见变化。这里钉住"什么算用户可见"。 */
test('类型表与 CHANGELOG 顶部那条规矩一致（只 4 类进日志）', () => {
  const included = ['feat', 'fix', 'perf', 'revert'].map(t => classify(`${t}: x`).include)
  assert.deepEqual(included, [true, true, true, true])
  const excluded = ['docs', 'test', 'chore', 'build', 'ci', 'style', 'refactor'].map(t => classify(`${t}: x`).include)
  assert.deepEqual(excluded, [false, false, false, false, false, false, false])
})
