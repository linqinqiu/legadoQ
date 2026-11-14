import test from 'node:test'
import assert from 'node:assert/strict'
import { healthyDisabledOf, previewNames } from '../src/features/source-editor/SourceHealthModal.tsx'
import type { SourceHealthCheckItem, SourceSummary } from '../src/lib/api.ts'

/**
 * 书源体检「批量启停」的判据（第三阶段：状态过滤 / 分档 / 详细错误 / 批量启停）。
 *
 * 「停」那一半早就有（一键停用 + 一键删除，删除带确认）；这一轮补的是**「启」那一半**：
 * 以前一刀切停过一批源，体检完发现大半其实好好的，人只能一个个点回去。
 *
 * 这条判据钉的是「批量启用到底认哪一批」——认错了就是替用户改了状态：
 * 只认「体检通过 + 当前停用」，待确认/未配搜索那些不是坏，但也不许被顺手打开。
 */

function item(overrides: Partial<SourceHealthCheckItem> = {}): SourceHealthCheckItem {
  return {
    id: 'https://a.example',
    name: '源A',
    ok: true,
    latencyMs: 120,
    statusCategory: 'valid',
    statusCode: 200,
    error: null,
    ...overrides,
  } as SourceHealthCheckItem
}

function source(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return { id: 'https://a.example', name: '源A', url: 'https://a.example', group: '', enabled: true, isJsSource: false, hasLogin: false, hasRules: true, updatedAt: 0, ...overrides } as SourceSummary
}

test('previewNames - 确认框只念三个名字 + 总数，不撑成一面墙', () => {
  assert.equal(previewNames([]), '')
  assert.equal(previewNames(['甲']), '甲')
  assert.equal(previewNames(['甲', '乙', '丙']), '甲、乙、丙')
  assert.equal(previewNames(['甲', '乙', '丙', '丁', '戊']), '甲、乙、丙 等共 5 个')
})

test('healthyDisabledOf - 只认「体检通过 + 当前停用」', () => {
  const results = [
    item({ id: 'ok-disabled', name: '好用但停用' }),
    item({ id: 'ok-enabled', name: '好用且启用' }),
    item({ id: 'slow-disabled', name: '慢但停用', statusCategory: 'slow', latencyMs: 4200 }),
    item({ id: 'dead-disabled', name: '连不上', ok: false, statusCategory: 'unreachable', error: '超时' }),
    item({ id: 'needs-login', name: '需登录', ok: false, statusCategory: 'needs_login' }),
    item({ id: 'not-in-list', name: '清单里没有' }),
  ]
  const sources = [
    source({ id: 'ok-disabled', enabled: false }),
    source({ id: 'ok-enabled', enabled: true }),
    source({ id: 'slow-disabled', enabled: false }),
    source({ id: 'dead-disabled', enabled: false }),
    source({ id: 'needs-login', enabled: false }),
    // not-in-list 故意不给：清单没刷新到位时不许猜它是停用的
  ]
  const picked = healthyDisabledOf(results, sources).map(r => r.id)
  assert.deepEqual(picked.sort(), ['ok-disabled', 'slow-disabled'],
    '只有「通过(valid/slow) + 停用 + 清单里查得到」这三条同时成立才该被启用')
  assert.ok(!picked.includes('dead-disabled'), '连不上的源不该被这条顺手打开')
  assert.ok(!picked.includes('needs-login'), '待确认档不该被这条顺手打开')
  assert.ok(!picked.includes('not-in-list'), '清单里没有的 id 不许猜')
  assert.ok(!picked.includes('ok-enabled'), '本来就启用的不该重复启用')
})

test('healthyDisabledOf - 全空 / 全停用 / 全启用三种极端都不抛、也不乱认', () => {
  assert.deepEqual(healthyDisabledOf([], []), [])
  const onlyDisabled = [item({ id: 'x' })]
  assert.deepEqual(healthyDisabledOf(onlyDisabled, [source({ id: 'x', enabled: false })]).map(r => r.id), ['x'])
  assert.deepEqual(healthyDisabledOf(onlyDisabled, [source({ id: 'x', enabled: true })]), [])
  assert.deepEqual(healthyDisabledOf(onlyDisabled, []), [], '清单空着时一个都不认')
})
