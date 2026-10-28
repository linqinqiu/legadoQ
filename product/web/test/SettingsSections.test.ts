import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSettingsSections,
  filterSettingsSections,
  type SettingsActions,
  type SettingsSection,
} from '../src/settings/settingsSections.ts'

/**
 * 「设置」分区表的**行为**判据。
 *
 * 现有 `SettingsPage.test.ts` 只读源码字符串（正则匹配 `main.tsx` 里有没有接上动作），
 * 那能证明"接线没断"，但**从没真正调用过** `buildSettingsSections` —— 于是这个文件
 * 长期只有 32% 行覆盖，主体（33-134 行）一行都没执行过。
 *
 * 这一份补上"真的调一次"：给一套假的 actions，看它产出什么。
 * 判的是**结构不变量**（不是逐字文案，否则改一句话就红）：
 * - 分组不空、每行都有 title/hint/action/onClick；
 * - 每个动作都被真的接到对应行上（点下去调到的是那个回调，不是死按钮）；
 * - 分区顺序稳定（用户靠位置记东西）。
 */

/** 一套会记录调用的假动作。 */
function fakeActions(): { actions: SettingsActions; called: string[] } {
  const called: string[] = []
  const make = (name: string) => () => { called.push(name) }
  const actions: SettingsActions = {
    openShortcuts: make('openShortcuts'),
    openOfflineCache: make('openOfflineCache'),
    openCustomize: make('openCustomize'),
    openReplaceRules: make('openReplaceRules'),
    openTocRules: make('openTocRules'),
    openBackup: make('openBackup'),
    openLogs: make('openLogs'),
    openServerPort: make('openServerPort'),
    openBrand: make('openBrand'),
    openAiConnections: make('openAiConnections'),
    openCookies: make('openCookies'),
  }
  return { actions, called }
}

const allRows = (sections: SettingsSection[]) => sections.flatMap(s => s.rows)

test('产出非空，且分组顺序稳定（用户靠位置记东西）', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 2026-10-28 收成四档：原来九档里有五档只有一行，两栏版式一半格子空着。
  assert.deepEqual(sections.map(s => s.title), ['阅读', '外观', '数据与凭据', '服务与接入'])
  // 分组标题不许重复（重复意味着有人顺手加了一组同名的）
  const titles = sections.map(s => s.title)
  assert.equal(new Set(titles).size, titles.length, `分组标题重复：${titles}`)
})

test('每一行都有完整的四件套：标题 / 说明 / 动作名 / 回调', () => {
  const { actions } = fakeActions()
  const rows = allRows(buildSettingsSections(actions))
  assert.ok(rows.length >= 8, `至少 8 行，实际 ${rows.length}`)
  for (const row of rows) {
    assert.ok(row.title && row.title.trim().length > 0, `行缺标题：${JSON.stringify(row)}`)
    assert.ok(row.hint && row.hint.trim().length > 0, `「${row.title}」缺说明`)
    assert.ok(row.action && row.action.trim().length > 0, `「${row.title}」缺动作名`)
    assert.equal(typeof row.onClick, 'function', `「${row.title}」的 onClick 不是函数`)
  }
})

test('每一行的 onClick 真的调到对应回调（不是死按钮）', () => {
  const { actions, called } = fakeActions()
  const rows = allRows(buildSettingsSections(actions))

  // 逐个点一遍：每次点完，"被调用过"的集合应恰好增加一项
  for (const row of rows) {
    const before = new Set(called)
    row.onClick()
    const added = called.filter(c => !before.has(c))
    assert.equal(added.length, 1, `点「${row.title}」应恰好触发 1 个动作，实际触发 ${added.length} 个：${added}`)
  }
  // 全部点完后，每一个动作都被点到过至少一次（没有哪一行是摆设）。
  // 数目从 actions 本身派生而不是写死：加一行设置项时这里不许跟着改一个魔数。
  const totalActions = Object.keys(actions).length
  assert.equal(new Set(called).size, totalActions, `应有 ${totalActions} 个不同动作被触发，实际 ${new Set(called).size}：${[...new Set(called)]}`)
})

test('服务与接入分组：AI 接入仍在，插件架构已移除', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  const rows = sections.find(section => section.title === '服务与接入')?.rows ?? []
  const titles = rows.map(r => r.title)
  assert.ok(titles.includes('AI 接入'), `应有一行「AI 接入」，实际 ${titles}`)
  assert.ok(!titles.includes('插件'), `不该再有「插件」一行，实际 ${titles}`)
})

test('页内搜索：命中留整档，不命中收整档，空查询原样返回', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)

  // 空查询 = 原样返回（同一个引用即可，不必深比较）
  assert.equal(filterSettingsSections(sections, ''), sections, '空查询应原样返回')
  assert.equal(filterSettingsSections(sections, '   '), sections, '纯空白查询应原样返回')

  // 搜一个必然存在的词：命中的行留着、其它行没了
  const hit = filterSettingsSections(sections, '快捷键')
  const hitRows = allRows(hit)
  assert.ok(hitRows.length > 0, '搜「快捷键」应有结果')
  assert.ok(hitRows.every(r => (r.title + r.hint).includes('快捷键')),
    `命中行里混进了不含关键词的行：${hitRows.map(r => r.title)}`)

  // 搜一个必然不存在的词：整档收起来
  assert.deepEqual(filterSettingsSections(sections, '这个词肯定不存在zzz'), [],
    '搜不到时应返回空数组（整档收起）')
})

test('搜索大小写不敏感，且能搜到 hint 里的词', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 用 hint 里的一个词搜（证明不只搜标题）
  const byHint = filterSettingsSections(sections, '按键表')
  assert.ok(allRows(byHint).length > 0, '应能搜到 hint 里的「按键表」')
  // 大小写：搜 CSS 与 css 结果一致
  const upper = allRows(filterSettingsSections(sections, 'CSS')).length
  const lower = allRows(filterSettingsSections(sections, 'css')).length
  assert.equal(upper, lower, `大小写应不敏感：CSS=${upper} / css=${lower}`)
})

test('长关键词照样能搜到（搜索不许有长度阈值）', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 这几个都是 6 字以上的真设置项：曾经有一段「查询超过 5 个字就不算命中」的阈值，
  // 理由是躲一行根本不存在的「登录」入口 —— 结果把这些真词全挡成了空结果。
  for (const word of ['替换净化规则', 'TXT 分章规则', '应用名称与图标']) {
    const hit = allRows(filterSettingsSections(sections, word))
    assert.ok(hit.length > 0, `「${word}」应能搜到，实际为空 —— 搜索又加了长度阈值？`)
  }
})

test('反向对照：把搜索改成"只搜标题"必须被这条判据逮住', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 找一个只出现在 hint、不出现在任何 title 里的词
  const titles = new Set(allRows(sections).map(r => r.title))
  const rows = allRows(sections)
  const hintOnly = rows
    .map(r => r.hint)
    .flatMap(h => h.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [])
    .find(word => ![...titles].some(t => t.includes(word)) && rows.some(r => r.hint.includes(word)))
  assert.ok(hintOnly, '找不到只出现在 hint 里的词 —— 这条反向对照失去意义，应换一个词')

  const hit = filterSettingsSections(sections, hintOnly)
  assert.ok(allRows(hit).length > 0,
    `「${hintOnly}」只出现在 hint 里，若搜索只看标题这里就会是空 —— 说明搜索范围退化了`)
})

test('Cookie 收进「数据与凭据」：一行入口，点开走全局弹窗', () => {
  const { actions, called } = fakeActions()
  const sections = buildSettingsSections(actions)
  const section = sections.find(item => item.title === '数据与凭据')!
  assert.ok(section, '应有「数据与凭据」分组')
  assert.equal(section.content, undefined, '「Cookie」不再内联渲染，入口是一行按钮')
  const row = section.rows.find(item => item.title === 'Cookie 管理')!
  assert.ok(row, `「数据与凭据」里应有 Cookie 行，实际 ${section.rows.map(r => r.title)}`)
  assert.equal(row.action, '管理 Cookie', '入口动作名要说清打开弹窗')
  row.onClick()
  assert.ok(called.includes('openCookies'), '这一行必须真的去开 Cookie 弹窗')
})

test('搜分组名给出整组，搜具体项只留那一行', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 搜「外观」：用户想看这一类有什么，只回一行会让他以为只有一项
  const group = filterSettingsSections(sections, '外观')
  assert.equal(group.length, 1, `「外观」应命中一组，实际 ${group.map(s => s.title)}`)
  assert.equal(group[0].rows.length, sections.find(s => s.title === '外观')!.rows.length,
    '命中分组名时应整组保留')
  // 搜「端口」：只留服务端口那一行，不把同组的 AI 接入、运行日志倒出来
  const row = allRows(filterSettingsSections(sections, '端口'))
  assert.deepEqual(row.map(r => r.title), ['服务端口'])
})
