import test from 'node:test'
import assert from 'node:assert/strict'
import {
  READER_CUSTOM_SPECS,
  READER_SCALAR_SPECS,
  READER_SETTING_SPECS,
  getScalarSpec,
  readScalarSetting,
  readerScalarDefaults,
} from '../src/features/reader/settingsPanel/readerConfigRegistry'
import { defaultReaderSettings, loadReaderSettings } from '../src/features/reader/settingsPanel/readerSettings'

/**
 * 「阅读设置注册表」的判据（维护切片 1a）。
 *
 * 这张表存在的唯一理由是**加一项设置不再要改三处**。所以这里钉三件事：
 * 1. 清单完整：`ReaderSettings` 的每个键都在表里，且只出现一次（少登记 = 新设置读不回来；
 *    多登记 = 表里挂着一个不存在的字段，两种都会让下一个人以为改表就够了）。
 * 2. 默认值同源：`defaultReaderSettings` 的标量部分必须等于表里的 default。
 * 3. 读回口径不变：数字夹取、布尔只认 boolean、枚举回落，与旧的 `parse*` 函数逐条一致。
 */

function withStorage(initial: Record<string, string>, body: () => void) {
  const store = new Map(Object.entries(initial))
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  }
  try {
    body()
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previous
  }
}

test('阅读设置注册表 - 每个设置键都登记且只登记一次', () => {
  const registered = READER_SETTING_SPECS.map(spec => spec.key)
  const settingsKeys = Object.keys(defaultReaderSettings)

  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...settingsKeys].sort(),
    '注册表与 ReaderSettings 的键集合必须双向一致',
  )
  assert.equal(new Set(registered).size, registered.length, '同一个键不许登记两次')
})

test('阅读设置注册表 - 标量默认值与 defaultReaderSettings 同源', () => {
  const defaults = readerScalarDefaults()
  for (const spec of READER_SCALAR_SPECS) {
    assert.equal(
      (defaultReaderSettings as Record<string, unknown>)[spec.key],
      spec.default,
      `${spec.key} 的出厂值应来自注册表`,
    )
    assert.equal(defaults[spec.key], spec.default)
  }
})

test('阅读设置注册表 - 数字读回：脏值回落、越界夹取、整数项四舍五入', () => {
  const fontSize = getScalarSpec('fontSize')
  assert.equal(readScalarSetting(fontSize, 999), 28)
  assert.equal(readScalarSetting(fontSize, 4), 15)
  assert.equal(readScalarSetting(fontSize, 21), 21)
  for (const junk of ['19', NaN, Infinity, null, undefined, {}, []]) {
    assert.equal(readScalarSetting(fontSize, junk), 19, `${String(junk)} 应回落到默认值`)
  }

  const maxWidth = getScalarSpec('maxWidth')
  assert.equal(readScalarSetting(maxWidth, 999.6), 1000, '整数项先夹取再四舍五入')
  assert.equal(readScalarSetting(maxWidth, 9999), 1400)
  assert.equal(readScalarSetting(maxWidth, 100), 560)
})

test('阅读设置注册表 - 布尔只认真正的 boolean，字符串 "true" 不算', () => {
  const mangaSpread = getScalarSpec('mangaSpread')
  assert.equal(readScalarSetting(mangaSpread, true), true)
  assert.equal(readScalarSetting(mangaSpread, false), false)
  for (const junk of ['true', 1, 0, null, undefined]) {
    assert.equal(readScalarSetting(mangaSpread, junk), false)
  }
})

test('阅读设置注册表 - 枚举只认登记过的值', () => {
  assert.equal(readScalarSetting(getScalarSpec('font'), 'kai'), 'kai')
  assert.equal(readScalarSetting(getScalarSpec('font'), 'invalid-font'), 'song')
  assert.equal(readScalarSetting(getScalarSpec('pageAnim'), 'fade'), 'fade')
  assert.equal(readScalarSetting(getScalarSpec('pageAnim'), 'flip'), 'slide')
  assert.equal(readScalarSetting(getScalarSpec('ttsCustomMethod'), 'POST'), 'POST')
  assert.equal(readScalarSetting(getScalarSpec('ttsCustomMethod'), 'post'), 'GET')
})

test('阅读设置注册表 - 每条登记都说明了生效形态', () => {
  const surfaces = new Set(['scroll', 'paginate', 'desktop', 'web'])
  for (const spec of READER_SETTING_SPECS) {
    assert.ok(spec.appliesTo.length > 0, `${spec.key} 必须声明 appliesTo`)
    for (const surface of spec.appliesTo) {
      assert.ok(surfaces.has(surface), `${spec.key} 的 appliesTo 出现了未知形态 ${surface}`)
    }
  }
  for (const spec of READER_CUSTOM_SPECS) {
    assert.ok(spec.why.trim().length > 0, `${spec.key} 必须写明为什么不能走通用清洗`)
  }
})

test('阅读设置注册表 - 只存 v1 键的老存档仍能读回，坏值逐项回落', () => {
  withStorage({
    'legado-reader-settings-v1': JSON.stringify({
      fontSize: 22,
      pageMode: 'paginate',
      maxWidth: 1200,
      lineHeight: 'broken',
      font: 'kai',
    }),
  }, () => {
    const loaded = loadReaderSettings()
    assert.equal(loaded.fontSize, 22)
    assert.equal(loaded.pageMode, 'paginate')
    assert.equal(loaded.maxWidth, 1200)
    assert.equal(loaded.lineHeight, defaultReaderSettings.lineHeight)
    assert.equal(loaded.font, 'kai')
  })
})

test('阅读设置注册表 - v2 存档优先于 v1（旧键只用于回读）', () => {
  withStorage({
    'legado-reader-settings-v2': JSON.stringify({ fontSize: 24 }),
    'legado-reader-settings-v1': JSON.stringify({ fontSize: 16 }),
  }, () => {
    assert.equal(loadReaderSettings().fontSize, 24)
  })
})
