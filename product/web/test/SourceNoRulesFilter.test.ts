import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「无规则」书源的可见与可清理（用户 2026-11-08：「丰富完善具体功能」）。
 *
 * 兄弟包的备份里真实存在只剩元数据的条目（本机 5,600 条里 582 条）：
 * 导入不报错、列表里也看得见，但搜索 / 目录 / 正文一步都跑不出来。
 * 只提示不够 —— 得能**筛出来、批量删掉**，否则 5,600 条里那 582 条永远埋着。
 *
 * 判据盯四件事：类型有标记、两种列表行都打标、分组筛选里有入口、样式有命中。
 */
const here = import.meta.dirname
const page = fs.readFileSync(path.resolve(here, '../src/features/source-editor/SourcesPage.tsx'), 'utf8')
const types = fs.readFileSync(path.resolve(here, '../src/lib/api/types.ts'), 'utf8')
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

test('摘要类型带 hasRules，后端不返回时按"有规则"处理', () => {
  assert.match(types, /hasRules\?: boolean/, 'SourceSummary 要有 hasRules')
  // 判据只用 `=== false`：老数据/老响应没有这个字段时不能把整库标成"无规则"。
  assert.match(page, /source\.hasRules === false/, '只认显式的 false')
  assert.doesNotMatch(page, /!source\.hasRules/, '别用取反：undefined 会被当成"无规则"')
})

test('两种列表行都打「无规则」标', () => {
  const badges = page.match(/source-norules-badge/g) ?? []
  assert.equal(badges.length, 2, `批量模式与普通模式各一处，实际 ${badges.length}`)
  assert.match(page, /只有元数据、没有任何规则/, 'title 要说清后果')
})

test('分组筛选里有「无规则」入口，且只在有这种源时出现', () => {
  assert.match(page, /const noRulesCount = useMemo\(\(\) => sources\.filter\(source => source\.hasRules === false\)\.length/)
  assert.match(page, /value: '__norules__', label: `无规则 \(\$\{noRulesCount\}\)`/)
  assert.match(page, /\.\.\.\(noRulesCount > 0 \?/, '没有这种源时不要多一个恒为 0 的选项')
  assert.match(page, /if \(groupFilter === '__norules__'\) return source\.hasRules === false/, '筛选要真的按标记过')
  // 分组筛选栏本身也要在有「无规则」源时出现（新库可能一个分组都没有）
  assert.match(page, /\{\(allGroups\.length > 0 \|\| noRulesCount > 0\) && \(/, '筛选栏的显示条件要带上它')
})

test('徽标有样式命中，且用 danger 色与「已停用」区分开', () => {
  const rule = /\.source-norules-badge \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.ok(rule, '找不到 .source-norules-badge 规则')
  assert.match(rule, /var\(--danger\)/, '这不是"被关掉"，是跑不起来')
  assert.match(rule, /white-space: nowrap/, '别把「无规则」折成两行')
})
