import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书源页的版面：**只剩页头 + 编辑器**（用户 2026-10-22 明确要求）。
 *
 * 演变过程：
 * 1. 最初 `<SourceSubscriptionPanel>` 贴在编辑器 `<section>` 内，一展开就把编辑表单挤变形；
 * 2. 后来把它挪到 `.editor-region`（与编辑器平级），书源页还是背着订阅；
 * 3. 用户指出「书源界面的订阅和地址你还没有移除改掉」→ 订阅整体搬到顶栏「订阅」页，
 *    书源页右栏只剩 `.editor-region`（页头）与 `.sources-content`（编辑器）。
 *
 * 这条测"书源页不再有任何订阅痕迹"这个结构事实。措辞不管，结构改了才是事故。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `找不到顶层 function ${name}(`)
  const rest = text.slice(text.indexOf('\n', start) + 1)
  const next = rest.search(/^[\w]/m)
  return next < 0 ? rest : rest.slice(0, next)
}

/** 去注释：注释里写"这里原来有订阅"是历史，不该让判据变红。 */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const sourcesPage = () => stripComments(functionBody(read('pages/SourcesPage.tsx'), 'SourcesPage'))

test('书源页彻底没有订阅：不渲染面板、没有「订阅地址」按钮、没有开合状态', () => {
  const body = sourcesPage()
  assert.ok(!body.includes('<SourceSubscriptionPanel'), 'SourcesPage 又在渲染订阅面板 —— 它该在「订阅」页')
  assert.ok(!/\bsubsOpen\b/.test(body), 'SourcesPage 里还有 subsOpen 开合状态 —— 订阅那一档已经移走')
  assert.ok(!body.includes('订阅地址'), 'SourcesPage 里还有「订阅地址」按钮 —— 已移到「订阅」页')
})

test('书源页右栏仍分两块：页头 .editor-region 与编辑器 .sources-content', () => {
  const body = sourcesPage()
  assert.ok(body.includes('className="sources-main"'), '右栏缺少 .sources-main 包装容器')
  assert.ok(body.includes('className="editor-region"'), '缺少 .editor-region（页头所在块）')

  const mainIdx = body.indexOf('<div className="sources-main">')
  const regionIdx = body.indexOf('<div className="editor-region">')
  const contentIdx = body.indexOf('<section className="sources-content">')
  assert.ok(regionIdx > mainIdx, '.editor-region 应包在 .sources-main 内')
  assert.ok(contentIdx > mainIdx, '编辑器 <section> 应包在 .sources-main 内')
  assert.ok(regionIdx < contentIdx, '.editor-region 应排在编辑器 <section> 之前')
})

test('订阅页接管书源订阅：两块并列、各有分区容器', () => {
  const rss = read('pages/RssPage.tsx')
  assert.ok(rss.includes('<SourceSubscriptionPanel'), '「订阅」页要渲染书源订阅面板')
  assert.ok(rss.includes('<RssPanel'), '「订阅」页要渲染 RSS 面板')
  assert.ok(rss.includes('subscription-block'), '两块要有各自的分区容器，视觉上分得清')

  // 书源订阅必须在 RSS 之前（产物是书源，是"更靠近书源"的那一类）
  const srcIdx = rss.indexOf('<SourceSubscriptionPanel')
  const rssIdx = rss.indexOf('<RssPanel')
  assert.ok(srcIdx < rssIdx, '书源订阅应排在 RSS 之前')
})

test('书源订阅面板不再强制要求 onClose（订阅页里没有"收起这一档"）', () => {
  const panel = read('sources/SourceSubscriptionPanel.tsx')
  assert.match(panel, /onClose\?:/, 'onClose 应为可选参数')
  // 只在传了 onClose 时才渲染收起按钮
  assert.match(panel, /\{onClose &&/, '收起按钮要按 onClose 是否存在来决定')
})
