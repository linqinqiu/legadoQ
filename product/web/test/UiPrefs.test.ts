import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  hydrateUiPrefs,
  jsonToStorageText,
  mergePrefsIntoStorage,
  resetHydrateForTest,
  storageTextToJson,
  UI_PREF_STORAGE,
} from '../src/lib/uiPrefs'

/**
 * 「换端口不丢设置」这条链的判据（2026-11-12）。
 *
 * 用户报的现象：改端口后壁纸恢复默认、免责声明又弹一次。根因不是某一行写错，
 * 而是 **localStorage 按 origin 隔离** —— 端口变了，浏览器就当它是另一个网站。
 * 修法是把这几个小 JSON 也存一份到服务端（`/api/ui-prefs`），启动时补回。
 *
 * 这里钉三件事：
 * 1. 序列化两端对齐（localStorage 存字符串、服务端存 JSON 值），字符串/对象/坏 JSON 都不能丢；
 * 2. 补写只补**缺的**，绝不覆盖本地更新的一份（否则等于用旧数据回滚用户的修改）；
 * 3. 键表必须与三个模块里的 localStorage 常量逐字一致 —— 它们分布在三个文件里，
 *    任何一处改名而这里没跟，用户就会"设置存了但赎不回来"，而且不报错。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')
const readSrc = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8')

/** 极简 localStorage 替身：只实现被测代码用到的三个方法。 */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

test('两端序列化：对象进 JSON、字符串原样、坏 JSON 不丢内容', () => {
  assert.deepEqual(storageTextToJson('{"a":1}'), { a: 1 })
  assert.equal(storageTextToJson('2026-11-12T00:00:00.000Z'), '2026-11-12T00:00:00.000Z')
  // 坏 JSON 当作原始字符串 —— 宁可原样搬回去，也不要把它吃成 undefined 把用户设置抹掉
  assert.equal(storageTextToJson('{oops'), '{oops')
  assert.equal(storageTextToJson(null), undefined)

  assert.equal(jsonToStorageText({ a: 1 }), '{"a":1}')
  assert.equal(jsonToStorageText('2026-11-12'), '2026-11-12')
  assert.equal(jsonToStorageText(undefined), null)
  assert.equal(jsonToStorageText(null), null)

  // 往返：对象 → 文本 → 对象
  const settings = { enabled: true, opacity: 0.8, url: '' }
  assert.deepEqual(storageTextToJson(jsonToStorageText(settings)!), settings)
})

test('补写只补缺的：本地已有的一律不覆盖（本地才是用户刚改的那份）', () => {
  const original = globalThis.localStorage
  const storage = fakeStorage({ [UI_PREF_STORAGE.wallpaper]: '{"enabled":false}' })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  try {
    const restored = mergePrefsIntoStorage({
      agreement: '2026-11-12T00:00:00.000Z',
      wallpaper: { enabled: true },           // 本地已有 → 不许覆盖
      'reader-settings': { fontSize: 22 },
    })
    assert.deepEqual(restored.sort(), ['agreement', 'reader-settings'].sort())
    assert.equal(storage.getItem(UI_PREF_STORAGE.wallpaper), '{"enabled":false}', '本地设置被服务端旧值回滚了')
    assert.equal(storage.getItem(UI_PREF_STORAGE.agreement), '2026-11-12T00:00:00.000Z')
    assert.deepEqual(JSON.parse(storage.getItem(UI_PREF_STORAGE['reader-settings'])!), { fontSize: 22 })
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
  }
})

test('服务端没有的键不动本地：不许把用户的设置"补"成空', () => {
  const original = globalThis.localStorage
  const storage = fakeStorage({ [UI_PREF_STORAGE.agreement]: 'x' })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  try {
    const restored = mergePrefsIntoStorage({})
    assert.deepEqual(restored, [])
    assert.deepEqual(storage.dump(), { [UI_PREF_STORAGE.agreement]: 'x' })
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
  }
})

test('键表与三个模块里的 localStorage 常量逐字一致（改一处没跟 = 设置赎不回来）', () => {
  assert.ok(readSrc('lib', 'wallpaper.ts').includes(`'${UI_PREF_STORAGE.wallpaper}'`),
    'wallpaper.ts 的 SETTINGS_KEY 与本表不一致')
  assert.ok(readSrc('features', 'reader', 'settingsPanel', 'readerSettings.ts').includes(`'${UI_PREF_STORAGE['reader-settings']}'`),
    'readerSettings.ts 的 storageKey 与本表不一致')
  assert.ok(readSrc('components', 'FirstRunAgreement.tsx').includes(`'${UI_PREF_STORAGE.agreement}'`),
    'FirstRunAgreement.tsx 的 STORAGE_KEY 与本表不一致')
  // 三个键互不相同（同一份数据写进同一个键，后写的会把前一份挤掉）
  assert.equal(new Set(Object.values(UI_PREF_STORAGE)).size, Object.keys(UI_PREF_STORAGE).length)
})

test('没有 window 时 hydrate 直接返回失败，不发请求也不抛', async () => {
  resetHydrateForTest()
  const result = await hydrateUiPrefs(50)
  assert.equal(result.ok, false)
  assert.deepEqual(result.restored, [])
})
