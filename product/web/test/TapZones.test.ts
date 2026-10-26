import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addCut,
  clampCut,
  DEFAULT_MAPS,
  MAX_CUTS,
  mapCells,
  migrateGrid,
  MIN_CUT_GAP,
  remapActions,
  sanitizeMap,
  TAP_ACTION_ORDER,
  TAP_PRESETS,
  zoneAt,
  type TapMap,
} from '../src/reader/tapZones.ts'

/**
 * 点击分区（用户 2026-10-04：「可以自定义点击区域范围并设置，自定义管理」；
 * 2026-10-09：「区域设置改提供横竖虚线，自定义，但是要区分翻页方式的影响」）。
 *
 * 这里钉几件容易悄悄坏掉的事：
 * ① **出厂默认必须与"格子表"时代逐字一致** —— 这次只是把格子换成虚线，
 *    顺手"改得更合理"就是无谓地换掉用户已经习惯的手感。
 * ② 动作表长度必须等于格数 —— 不等时缺的那些格会静默变成「不做任何事」，
 *    界面上看不出来，用户只会说"这一格点了没反应"。
 * ③ 读设置时必须清洗 + 迁移旧格子表 —— 不清洗会拿到 undefined 动作；不迁移等于设置被重置。
 * ④ 拖动 / 加删虚线时动作要跟着走，不能一拖就全变"不做任何事"。
 */

test('出厂默认 = 格子表时代那三区（翻页按列、滚动按段），一格都不许多', () => {
  assert.deepEqual(DEFAULT_MAPS.paginate, { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'toggle', 'next'] })
  assert.deepEqual(DEFAULT_MAPS.scroll, { x: [], y: [1 / 3, 2 / 3], actions: ['previous', 'toggle', 'next'] })
})

test('zoneAt 的边界归"更靠外"那一格，与旧的 1/3、2/3 口径同一形状', () => {
  const map = DEFAULT_MAPS.paginate
  assert.equal(zoneAt(map, 0, 400, 1200, 800), 'previous')
  assert.equal(zoneAt(map, 399, 400, 1200, 800), 'previous')
  assert.equal(zoneAt(map, 400, 400, 1200, 800), 'toggle')
  assert.equal(zoneAt(map, 800, 400, 1200, 800), 'next')
  assert.equal(zoneAt(map, 1199, 400, 1200, 800), 'next')
  // 越界坐标（子像素、负数、比视口还靠外）不许算出格外的下标
  assert.equal(zoneAt(map, -50, 0, 1200, 800), 'previous')
  assert.equal(zoneAt(map, 9999, 9999, 1200, 800), 'next')
})

test('滚动模式按横虚线分段：上=上一页、中=工具栏、下=下一页', () => {
  const map = DEFAULT_MAPS.scroll
  assert.equal(zoneAt(map, 600, 100, 1200, 900), 'previous')
  assert.equal(zoneAt(map, 600, 450, 1200, 900), 'toggle')
  assert.equal(zoneAt(map, 600, 800, 1200, 900), 'next')
})

test('视口宽或高为 0（折叠、隐藏、还没排版）时不许凭空翻页', () => {
  assert.equal(zoneAt(DEFAULT_MAPS.paginate, 10, 10, 0, 800), 'none')
  assert.equal(zoneAt(DEFAULT_MAPS.scroll, 10, 10, 1200, 0), 'none')
})

test('每个预设的动作表长度 = 格数（缺的格会静默变成"不做任何事"）', () => {
  for (const preset of TAP_PRESETS) {
    for (const [mode, map] of [['paginate', preset.paginate], ['scroll', preset.scroll]] as const) {
      assert.equal(map.actions.length, mapCells(map), `${preset.key}/${mode} 的动作数与格数不符`)
      for (const action of map.actions) assert.ok(TAP_ACTION_ORDER.includes(action), `${preset.key} 里有认不出的动作 ${action}`)
    }
  }
})

test('九宫格预设：正中呼出工具栏，左右两侧都是翻页（与手机端同一形状）', () => {
  const nine = TAP_PRESETS.find(preset => preset.key === 'nine')
  assert.ok(nine)
  assert.equal(nine.paginate.actions[4], 'toggle')
  assert.equal(zoneAt(nine.paginate, 1100, 400, 1200, 900), 'next')
  assert.equal(zoneAt(nine.paginate, 100, 850, 1200, 900), 'previous')
})

test('清洗：缺项、认不出的动作、越界/贴死的虚线都回到能用的表', () => {
  const fallback = DEFAULT_MAPS.paginate
  assert.deepEqual(sanitizeMap(undefined, fallback), fallback)
  assert.deepEqual(sanitizeMap({}, fallback), fallback)
  assert.deepEqual(sanitizeMap({ x: [1 / 3, 2 / 3], actions: ['next'] }, fallback),
    { x: [1 / 3, 2 / 3], y: [], actions: ['next', 'toggle', 'next'] })
  assert.deepEqual(sanitizeMap({ x: [1 / 3, 2 / 3], actions: ['nope', 'toc', 'settings'] }, fallback),
    { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'toc', 'settings'] })
  // 越界（0 / 1 / 负数 / 超大）夹回合法范围；贴死的两条并成一条
  assert.deepEqual(sanitizeMap({ x: [0, 0.5, 0.51, 1], actions: [] }, fallback).x, [MIN_CUT_GAP, 0.5, 1 - MIN_CUT_GAP])
  // 上限：不许存出 99 条线把界面撑爆
  assert.equal(sanitizeMap({ x: Array.from({ length: 99 }, (_, i) => (i + 1) / 100), actions: [] }, fallback).x.length, MAX_CUTS)
})

test('迁移旧格子表：均匀切分，动作原样搬过来（不迁 = 用户设置被重置）', () => {
  const old = { rows: 1, cols: 3, actions: ['previous', 'toggle', 'next'] }
  assert.deepEqual(migrateGrid(old, DEFAULT_MAPS.paginate), { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'toggle', 'next'] })
  const old3x3 = { rows: 3, cols: 3, actions: Array.from({ length: 9 }, () => 'next') }
  const migrated = migrateGrid(old3x3, DEFAULT_MAPS.paginate)
  assert.deepEqual(migrated.x, [1 / 3, 2 / 3])
  assert.deepEqual(migrated.y, [1 / 3, 2 / 3])
  assert.equal(migrated.actions.length, 9)
})

test('clampCut：不许出界、不许越过相邻那条', () => {
  const cuts = [0.3, 0.6]
  assert.equal(clampCut(cuts, 0, -1), MIN_CUT_GAP)
  assert.equal(clampCut(cuts, 0, 0.9), 0.6 - MIN_CUT_GAP)
  assert.equal(clampCut(cuts, 1, 0.1), 0.3 + MIN_CUT_GAP)
  assert.equal(clampCut(cuts, 1, 5), 1 - MIN_CUT_GAP)
})

test('addCut：插进最大的空隙中间；到上限就不再插', () => {
  assert.deepEqual(addCut([]), [0.5])
  assert.deepEqual(addCut([0.2]), [0.2, 0.6])
  assert.deepEqual(addCut([0.4, 0.9]), [0.4, 0.65, 0.9])
  const full = Array.from({ length: MAX_CUTS }, (_, i) => (i + 1) / (MAX_CUTS + 1))
  assert.equal(addCut(full), full, '到上限应原样返回（同一引用）')
})

test('remapActions：加一条线后，原来那几格的动作按位置保留', () => {
  const before: TapMap = { x: [0.5], y: [], actions: ['previous', 'next'] }
  const after = remapActions(before, [0.25, 0.75], [])
  assert.equal(after.actions.length, 3)
  // 左格中心 0.125 落在旧左格 → previous；中格中心 0.5 与右格中心 0.875 都落在旧右格（>=0.5）→ next
  assert.deepEqual(after.actions, ['previous', 'next', 'next'])
})

test('反向对照：把中间那格改成 next，正中间就必须是"下一页"（证明 zoneAt 真的在读这张表）', () => {
  const map: TapMap = { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'next', 'next'] }
  assert.equal(zoneAt(map, 600, 400, 1200, 800), 'next')
  assert.equal(zoneAt(DEFAULT_MAPS.paginate, 600, 400, 1200, 800), 'toggle')
})
