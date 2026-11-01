import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 公开反馈入口与兼容性边界（用户 2026-11-01）。
 *
 * Issue 模板曾经是「整份 YAML 挤成一行 + UTF-8 BOM」——GitHub 解析不了，等于没有反馈入口，
 * 而界面上完全看不出这件事。这里按结构判，不按"文件存在"判；README 的兼容矩阵同理：
 * 用户需要先知道哪些写法不支持，才不会把源的问题都算到解析器头上。
 */
const repo = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (...parts: string[]) => fs.readFileSync(path.join(repo, ...parts), 'utf8')
const template = (name: string) => read('.github', 'ISSUE_TEMPLATE', name)

test('Issue 模板是 GitHub 能解析的多行 YAML，且品牌为 legadoQ', () => {
  for (const file of ['01-bug-report.yml', '02-feature-request.yml', '03-source-issue.yml', 'config.yml']) {
    const text = template(file)
    assert.doesNotMatch(text, /^\uFEFF/, `${file} 不应带 UTF-8 BOM`)
    assert.match(text, /\n/, `${file} 必须有换行；整份挤成一行时 GitHub 解析不出字段`)
    assert.doesNotMatch(text, /\bname:\s*"[^"\n]*legado[^Q]/, `${file} 不应把品牌写成 legado`)
  }
})

test('Bug 与功能请求模板都提供可填写的正文结构', () => {
  const bug = template('01-bug-report.yml')
  assert.match(bug, /name: "Bug 报告"/)
  assert.match(bug, /id: reproduction/)
  assert.match(bug, /id: environment/)
  assert.match(bug, /server\.log/, '要告诉用户日志在哪里，而不是只让他"贴日志"')

  const feature = template('02-feature-request.yml')
  assert.match(feature, /name: "功能请求"/)
  assert.match(feature, /id: problem-statement/)
  assert.match(feature, /id: proposed-solution/)
})

test('模板入口指向本仓库，而不是相对路径或原版 Legado', () => {
  const config = template('config.yml')
  assert.match(config, /https:\/\/github\.com\/linqinqiu\/legadoQ\/discussions/)
  assert.match(config, /https:\/\/github\.com\/linqinqiu\/legadoQ#readme/)
  assert.doesNotMatch(config, /url: "\.\//, '相对链接在 issue 选择页会指错地方')
})

test('README 有书源语法兼容矩阵，且明确列出不支持项', () => {
  const readme = read('README.md')
  assert.match(readme, /## 书源语法兼容性/)
  for (const item of ['@xpath:', '`<js>', 'JavaImporter', 'webView', 'ruleReview', 'RSS/Atom', '`<1,2,3>`']) {
    assert.ok(readme.includes(item), `兼容矩阵缺「${item}」`)
  }
  assert.match(readme, /不支持/, '只说支持什么等于没给边界')
  assert.match(readme, /product\/docs\/compatibility\.md/, '细项应指到权威文档')
})

test('兼容性文档不再把 JavaImporter 写成空替身', () => {
  const doc = read('product', 'docs', 'compatibility.md')
  assert.doesNotMatch(doc, /JavaImporter.*空替身|importClass.*no-op|importPackage.*no-op/, '0.2.9 起已按白名单提供真实替身')
  assert.match(doc, /JavaPackages\.kt/, '要指到实际实现')
  assert.match(doc, /白名单/, '要说明能力边界是白名单，不是全开')
})
