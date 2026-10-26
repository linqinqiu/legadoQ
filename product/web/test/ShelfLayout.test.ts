import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LAYOUT,
  decodeLayout,
  encodeLayout,
  layoutFromLegacyCode,
  readShelfLayout,
  writeShelfLayout,
} from '../src/shelf/shelfLayout'

// node:test 在同一进程里跑所有文件，offline-pwa.test.ts 也自带一份 localStorage mock，
// 所以桩件必须用完就还原（还原成调用现场的值，模块顶层缓存的那份可能是空的）。
function withStorage(initial: Record<string, string> | undefined, body: (store: Map<string, string>) => void) {
  const previous = (globalThis as any).localStorage
  const store = new Map(Object.entries(initial || {}))
  const writable = initial !== undefined
  ;(globalThis as any).localStorage = writable
    ? {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      }
    : undefined
  try {
    body(store)
  } finally {
    ;(globalThis as any).localStorage = previous
  }
}

test('ShelfLayout - 三种视图都能编码再解码回来', () => {
  for (const mode of ['grid', 'list', 'compact'] as const) {
    assert.deepEqual(decodeLayout(encodeLayout({ mode })), { mode }, `${mode} 应能往返`)
  }
  // 编码里不再带任何密度后缀（用户判定只留小封面）
  assert.equal(encodeLayout({ mode: 'grid' }), 'grid')
})

test('ShelfLayout - 废弃的密度档读得到但不再产生，认不出的值返回 null', () => {
  // 老用户 localStorage 里存着 grid:sm|md|lg，必须还能读成"网格"这一件事，不能变成空布局
  for (const legacy of ['grid:sm', 'grid:md', 'grid:lg', 'grid:']) {
    assert.deepEqual(decodeLayout(legacy), { mode: 'grid' }, `${legacy} 应回落成网格`)
  }
  for (const junk of ['', 'grid:xl', 'LIST', '7', 'compact:sm']) {
    assert.equal(decodeLayout(junk), null, `${JSON.stringify(junk)} 不是合法值`)
  }
})

test('ShelfLayout - 旧的列数编号搬到三种视图', () => {
  // v1 存的是上游编号：0=列表 1=紧凑 2~6=固定列数 7=自动
  assert.deepEqual(layoutFromLegacyCode(0), { mode: 'list' })
  assert.deepEqual(layoutFromLegacyCode(1), { mode: 'compact' })
  for (const columns of [2, 3, 4, 5, 6, 7]) {
    assert.deepEqual(layoutFromLegacyCode(columns), { mode: 'grid' }, `${columns} 列搬到网格`)
  }
})

test('ShelfLayout - 没有偏好时吃默认值，有旧编号时迁移并清掉旧键', () => {
  assert.deepEqual(DEFAULT_LAYOUT, { mode: 'grid' })
  withStorage({}, store => {
    assert.deepEqual(readShelfLayout(), DEFAULT_LAYOUT)
    assert.equal(store.size, 0, '只读不该写盘')
  })

  withStorage({ 'legado-shelf-layout-v1': '2' }, store => {
    assert.deepEqual(readShelfLayout(), { mode: 'grid' })
    assert.equal(store.get('legado-shelf-layout-v1'), '2', '读取本身不迁移，等用户下次改动再落新键')
    writeShelfLayout({ mode: 'list' })
    assert.equal(store.get('legado-shelf-layout-v2'), 'list')
    assert.equal(store.has('legado-shelf-layout-v1'), false, '写新键时旧键要清掉，避免下次又被搬一遍')
  })

  withStorage({ 'legado-shelf-layout-v1': '1', 'legado-shelf-layout-v2': 'compact' }, () => {
    assert.deepEqual(readShelfLayout(), { mode: 'compact' }, '新键优先于旧键')
  })
})

test('ShelfLayout - localStorage 不可用时不抛异常', () => {
  withStorage(undefined, () => {
    assert.deepEqual(readShelfLayout(), DEFAULT_LAYOUT)
    assert.doesNotThrow(() => writeShelfLayout({ mode: 'list' }))
  })
})
