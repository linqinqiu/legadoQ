import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { backup } from '../src/lib/api/domains/backup'
import type { SourceVersionAlias, SourceVersionPreview } from '../src/lib/api/types'
import {
  BackupSourceVersionsPanel, isSourceVersionArchive, SourceVersionReview,
} from '../src/plugins/backup/BackupSourceVersionsPanel'

const archive = `source-variants-${'a'.repeat(64)}.json`
const aliases: SourceVersionAlias[] = [
  { sourceId: 'https://source.example/', bookUrl: '/book/one', name: '可选关联书', conflict: false },
  { sourceId: 'https://source.example//', bookUrl: '/book/two', name: '冲突书', conflict: true },
]
const preview: SourceVersionPreview = {
  sourceId: 'https://source.example', name: '留档书源', sourceVersion: 3,
  affectedBooks: 25, affectedBookNames: ['现有书籍'], cacheEntries: 99,
  aliases, previewToken: 'fixture-preview-token', warnings: ['本次规则变化将影响后续请求'],
}
const noop = () => undefined
const reviewMarkup = (overrides: Partial<React.ComponentProps<typeof SourceVersionReview>> = {}) =>
  renderToStaticMarkup(React.createElement(SourceVersionReview, {
    preview: null, aliases, relink: [], blocked: false, selected: true,
    onToggle: noop, onPreview: noop, onActivate: noop, ...overrides,
  }))

test('书源版本入口仅接受服务端版本留档名', () => {
  assert.equal(isSourceVersionArchive(archive), true)
  for (const name of ['bookSource.json', 'source-variants-test.json', `../${archive}`, `${archive}.zip`, archive.toUpperCase()]) {
    assert.equal(isSourceVersionArchive(name), false, name)
  }
})

test('书源版本面板明确全局规则替换及整库恢复边界 初始不可直接启用', () => {
  const html = renderToStaticMarkup(React.createElement(BackupSourceVersionsPanel, {
    archive, disabled: false, onClose: noop, onBusyChange: noop, onActivated: async () => undefined,
  }))
  for (const text of ['全局替换同一标准化书源 ID', '影响全部关联书籍', '保留当前启用状态、排序、缓存、登录与脚本状态', '完整数据库快照', '整库回滚', '不是单书撤销']) {
    assert.ok(html.includes(text), text)
  }
  assert.match(html, /disabled=""[^>]*>预览启用影响/)
  assert.match(html, /disabled=""[^>]*>确认启用此版本/)
})

test('别名默认不勾选且冲突项禁用 无预览令牌时确认禁用', () => {
  const html = reviewMarkup()
  const checkboxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(match => match[0])
  assert.equal(checkboxes.length, 2)
  assert.ok(checkboxes.every(input => !input.includes('checked=""')))
  assert.ok(!checkboxes[0].includes('disabled=""'))
  assert.ok(checkboxes[1].includes('disabled=""'))
  assert.match(html, /disabled=""[^>]*>确认启用此版本/)
  assert.ok(html.includes('更改勾选后需重新预览'))
  assert.ok(html.includes('原始书源别名与精确书籍 URL'))
})

test('确认需要有效预览、选中版本及非忙碌状态 预览展示影响书籍和缓存', () => {
  const html = reviewMarkup({ preview, relink: [aliases[0]] })
  assert.match(html, /class="primary-button">确认启用此版本/)
  assert.ok(html.includes('影响全部 25 本关联书籍，现有缓存 99 条'))
  assert.ok(html.includes('关联书籍（最多列出 20 本）：现有书籍'))
  assert.ok(html.includes('规则版本 3'))
  assert.ok(html.includes(preview.warnings[0]))
  assert.match(html, /type="checkbox"[^>]*checked=""/)
  assert.ok(!html.includes(preview.previewToken), '令牌不输出到页面内容')
  assert.match(reviewMarkup({ preview, blocked: true }), /disabled=""[^>]*>确认启用此版本/)
  assert.match(reviewMarkup({ preview, selected: false }), /disabled=""[^>]*>确认启用此版本/)
  assert.match(reviewMarkup({ preview: { ...preview, previewToken: '' } }), /disabled=""[^>]*>确认启用此版本/)
  const withoutVersion = { ...preview, sourceVersion: undefined }
  assert.ok(!reviewMarkup({ preview: withoutVersion }).includes('规则版本'))
})

test('书源版本三个 API 使用同源 POST JSON 预览和启用精确传递关联及令牌', async () => {
  const original = globalThis.fetch
  const seen: { url: string; body: unknown }[] = []
  const list = { total: 21, offset: 20, groups: [{
    sourceId: preview.sourceId,
    variants: [{ index: 23, name: preview.name, originalId: aliases[0].sourceId, winner: false }],
  }] }
  const result = { sourceId: preview.sourceId, relinked: 1, snapshot: 'source-version-before-fixture.db' }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
    seen.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(url.endsWith('/list') ? list : url.endsWith('/preview') ? preview : result))
  }
  try {
    assert.deepEqual(await backup.sourceVersions({ archive, offset: 20, query: '留档' }), list)
    const config = { archive, index: 23, relink: [{ sourceId: aliases[0].sourceId, bookUrl: aliases[0].bookUrl }] }
    const inspected = await backup.sourceVersionPreview(config)
    assert.deepEqual(inspected, preview)
    assert.deepEqual(await backup.activateSourceVersion({ ...config, previewToken: inspected.previewToken }), result)
    assert.deepEqual(seen, [
      { url: '/api/backup/source-versions/list', body: { archive, offset: 20, query: '留档' } },
      { url: '/api/backup/source-versions/preview', body: config },
      { url: '/api/backup/source-versions/activate', body: { ...config, previewToken: preview.previewToken } },
    ])
  } finally { globalThis.fetch = original }
})

test('书源版本 API 保留服务端预览失效错误 默认不请求别名迁移', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { archive, index: 0, relink: [] })
    return new Response(JSON.stringify({ code: 'source_version_stale', message: '书源或书架已变化，请重新预览' }), { status: 409 })
  }
  try {
    await assert.rejects(backup.sourceVersionPreview({ archive, index: 0, relink: [] }), /书源或书架已变化，请重新预览/)
  } finally { globalThis.fetch = original }
})
