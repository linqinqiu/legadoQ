import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoTagBatches,
  buildGroupingPlan,
  currentTiers,
  HEALTH_TAGS,
  tagPlan,
  tierCounts,
  tierOf,
} from '../src/sources/sourceGrouping'

/**
 * 用户 2026-09-30：「书源体检……不能根据获得信息正确规划分组」。
 * 这一组测的是"把体检结论变成分组标签"的那套规则，重点是两条红线：
 * ① 只追加，不覆盖书源自带的 `bookSourceGroup`；
 * ② 认不出来的状态一律算"待确认"，不许凭猜测判源已死（上一轮把 4,874 个源停成 2 个就是这类误判）。
 */

test('体检档位 - 只有明确连不上才算异常，其余未知都进待确认', () => {
  assert.equal(tierOf('valid'), 'good')
  assert.equal(tierOf('slow'), 'good')
  assert.equal(tierOf('unreachable'), 'bad')
  assert.equal(tierOf('tls'), 'bad')
  assert.equal(tierOf('broken'), 'bad')
  assert.equal(tierOf('invalid'), 'bad')
  for (const state of ['empty', 'blocked', 'needs_login', 'needs_webview']) assert.equal(tierOf(state), 'pending')
  // 以后服务端加新状态时，默认落"待确认"而不是"异常" —— 宁可让人看一眼，不要自动判死
  assert.equal(tierOf('brand_new_category'), 'pending')
  assert.equal(tierOf(''), 'pending')
})

test('标签计划 - 追加而不覆盖原有分组', () => {
  assert.equal(tagPlan('网络小说 精品', ['good']), '网络小说 精品 体检可用')
  assert.equal(tagPlan('网络小说,精品', ['bad']), '网络小说 精品 体检异常')
  assert.equal(tagPlan('', ['pending']), '体检待确认')
  assert.equal(tagPlan(undefined, ['good']), '体检可用')
  // 重复打同一个标签不该长出一串
  assert.equal(tagPlan('网络小说 体检可用', ['good']), '网络小说 体检可用')
})

test('标签计划 - 撤销只摘我们自己的标签，用户写的原样留着', () => {
  assert.equal(tagPlan('网络小说 体检可用 精品', [], ['good']), '网络小说 精品')
  assert.equal(tagPlan('体检可用', [], ['good']), '')
  assert.equal(tagPlan('网络小说 体检可用 体检异常', [], ['good']), '网络小说 体检异常')
  // 换档 = 一次调用里同时摘与加
  assert.equal(tagPlan('网络小说 体检可用', ['bad'], ['good']), '网络小说 体检异常')
})

test('currentTiers - 认出源当前带着哪几档我们的标签', () => {
  assert.deepEqual(currentTiers('网络小说 体检可用'), ['good'])
  assert.deepEqual(currentTiers('网络小说'), [])
  assert.deepEqual(currentTiers('体检可用 体检异常'), ['good', 'bad'])
  assert.deepEqual(currentTiers(''), [])
})

test('分组计划 - 按档位汇总，并算出"已经打过"的有多少', () => {
  const rows = [
    { id: 'a', name: 'A源', statusCategory: 'valid', latencyMs: 300 },
    { id: 'b', name: 'B源', statusCategory: 'slow', latencyMs: 4200 },
    { id: 'c', name: 'C源', statusCategory: 'needs_login', latencyMs: 900 },
    { id: 'd', name: 'D源', statusCategory: 'unreachable', latencyMs: 0 },
  ]
  const plans = buildGroupingPlan(rows, { a: '网络小说 体检可用', b: '', c: '', d: '' })
  assert.deepEqual(plans.map(plan => plan.tier), ['good', 'pending', 'bad'])
  const good = plans.find(plan => plan.tier === 'good')!
  assert.deepEqual(good.ids, ['a', 'b'])
  assert.equal(good.alreadyApplied, 1, 'A 源已经带「体检可用」，不该再写一遍')
  assert.equal(good.tag, HEALTH_TAGS.good)
  assert.equal(good.examples.length, 2)
  assert.match(good.examples[0], /A源（valid 300ms）/)
})

test('分组计划 - 空档位不占一行，没结果时整个面板不出现', () => {
  const onlyGood = buildGroupingPlan([{ id: 'a', name: 'A', statusCategory: 'valid', latencyMs: 1 }], {})
  assert.deepEqual(onlyGood.map(plan => plan.tier), ['good'])
  assert.deepEqual(buildGroupingPlan([], {}), [])
})

/**
 * 「书源的体检当前出了问题」（用户 2026-10-03）。实测根因：库里 5,574 个源有 652 个
 * 顶层 `searchUrl` 是空（`ruleSearch.url` 全库皆空 —— Legado 的搜索地址本来就在顶层），
 * 服务端让 `runner.search()` 抛「该书源未配置 searchUrl」，落进 `classify()` 的 else
 * → `broken`「规则失效」→ 计入「连不上」→ 被「一键停用 / 一键删除」圈走。
 * 一个从没发出请求的源被说成"连不上"，还是整库 12% 都这样，体检结论就没法用了。
 * 拍板：拆成单独一档，不算坏。
 */
test('没配搜索地址 ≠ 连不上：单独一档，且不进危险按钮的口径', () => {
  assert.equal(tierOf('explore_only'), 'unconfigured', '配了发现页的：能浏览不能搜')
  assert.equal(tierOf('no_search'), 'unconfigured', '两样都没配的：在本服务里做不了任何事')
  // 危险按钮（一键停用/删除）数的是 `bad` 那一档，这两类绝不能落进去
  assert.notEqual(tierOf('explore_only'), 'bad')
  assert.notEqual(tierOf('no_search'), 'bad')
  assert.equal(HEALTH_TAGS.unconfigured, '未配搜索')
})

test('tierCounts - 完成提示按四档报数，不用服务端的 failedCount（= !ok，会把两类混成一个数）', () => {
  const counts = tierCounts([
    { statusCategory: 'valid' }, { statusCategory: 'slow' },
    { statusCategory: 'needs_login' },
    { statusCategory: 'explore_only' }, { statusCategory: 'no_search' },
    { statusCategory: 'unreachable' },
  ])
  assert.deepEqual(counts, { good: 2, pending: 1, unconfigured: 2, bad: 1 })
})

test('自动打标不碰「未配搜索」：那是源写死的属性，每轮都一样，打标只会把分组字符串改脏', () => {
  const rows = [
    { id: 'a', statusCategory: 'unreachable' },
    { id: 'b', statusCategory: 'needs_login' },
    { id: 'c', statusCategory: 'explore_only' },
    { id: 'd', statusCategory: 'no_search' },
    { id: 'e', statusCategory: 'valid' },
  ]
  const buckets = autoTagBatches(rows, {}, new Set<string>())
  const tiers = buckets.map(bucket => bucket.tier).sort()
  assert.deepEqual(tiers, ['bad', 'pending'], '只自动打"确认有问题"与"待确认"两档')
  assert.deepEqual(buckets.find(bucket => bucket.tier === 'bad')!.ids, ['a'])
})

test('分组面板列得出「未配搜索」这一行（人可以显式点一次打标签，但不自动打）', () => {
  const plans = buildGroupingPlan([
    { id: 'c', name: 'C源', statusCategory: 'explore_only', latencyMs: 0 },
    { id: 'd', name: 'D源', statusCategory: 'no_search', latencyMs: 0 },
  ], {})
  assert.deepEqual(plans.map(plan => plan.tier), ['unconfigured'])
  assert.deepEqual(plans[0].ids, ['c', 'd'])
})
