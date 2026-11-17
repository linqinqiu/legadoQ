import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSettingsSections,
  filterSettingsSections,
  type SettingsActions,
  type SettingsSection,
} from '../src/features/settings/settingsSections.ts'

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
    openSkins: make('openSkins'),
    openWallpaper: make('openWallpaper'),
    openReplaceRules: make('openReplaceRules'),
    openTocRules: make('openTocRules'),
    openBackup: make('openBackup'),
    openLogs: make('openLogs'),
    openServerPort: make('openServerPort'),
    openBrand: make('openBrand'),
    openCookies: make('openCookies'),
  }
  return { actions, called }
}

const allRows = (sections: SettingsSection[]) => sections.flatMap(s => s.rows)

test('产出非空，且分组顺序稳定（用户靠位置记东西）', () => {
  const { actions } = fakeActions()
  const sections = buildSettingsSections(actions)
  // 2026-10-28 收成四档；2026-11-12 拆出第五档「AI」（用户：ai是ai，服务是服务）。
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
