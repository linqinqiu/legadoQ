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

test('键表与各模块里的 localStorage 常量逐字一致（改一处没跟 = 设置赎不回来）', () => {
  assert.ok(readSrc('lib', 'wallpaper.ts').includes(`'${UI_PREF_STORAGE.wallpaper}'`),
    'wallpaper.ts 的 SETTINGS_KEY 与本表不一致')
  assert.ok(readSrc('features', 'reader', 'settingsPanel', 'readerSettings.ts').includes(`'${UI_PREF_STORAGE['reader-settings']}'`),
    'readerSettings.ts 的 storageKey 与本表不一致')
  assert.ok(readSrc('components', 'FirstRunAgreement.tsx').includes(`'${UI_PREF_STORAGE.agreement}'`),
    'FirstRunAgreement.tsx 的 STORAGE_KEY 与本表不一致')
  // 2026-11-14 扩容的那几项：用户在界面上改过、换端口/换机器后应当还在
  assert.ok(readSrc('lib', 'shelfLayout.ts').includes(`'${UI_PREF_STORAGE['shelf-layout']}'`),
    'shelfLayout.ts 的书架布局 KEY 与本表不一致')
  assert.ok(readSrc('lib', 'shelfLayout.ts').includes(`'${UI_PREF_STORAGE['search-layout']}'`),
    'shelfLayout.ts 的搜索结果 KEY 与本表不一致')
  assert.ok(readSrc('lib', 'shelfLayout.ts').includes(`'${UI_PREF_STORAGE['shelf-sort']}'`),
    'shelfLayout.ts 的排序 KEY 与本表不一致')
  assert.ok(readSrc('lib', 'sidebarWidth.ts').includes(`'${UI_PREF_STORAGE['sidebar-width']}'`),
    'sidebarWidth.ts 的 SIDEBAR_WIDTH_KEY 与本表不一致')
  assert.ok(readSrc('features', 'reader', 'tts', 'ttsBarPosition.ts').includes(`'${UI_PREF_STORAGE['tts-bar-position']}'`),
    'ttsBarPosition.ts 的 STORAGE_KEY 与本表不一致')
  assert.ok(readSrc('features', 'bookshelf', 'LibraryPage.tsx').includes(`'${UI_PREF_STORAGE['search-history']}'`),
    'LibraryPage.tsx 的 SEARCH_HISTORY_KEY 与本表不一致')
  assert.ok(readSrc('components', 'PwaManager.tsx').includes(`'${UI_PREF_STORAGE['pwa-banner']}'`),
    'PwaManager.tsx 的提示条 key 与本表不一致')
  // 所有键互不相同（同一份数据写进同一个键，后写的会把前一份挤掉）
  assert.equal(new Set(Object.values(UI_PREF_STORAGE)).size, Object.keys(UI_PREF_STORAGE).length)
})

/**
 * 登记了却没人上行 = 等于没同步。
 *
 * 这是这条链最容易半途而废的地方：在表里加一行、忘了在保存处调 pushUiPref，
 * 表面上"已支持跨端口"，实际永远只有默认值。所以逐个 key 反查它在哪个模块被 push。
 */
test('表里每个 key 都有人在保存时 push（只登记不上行 = 永远不会同步）', () => {
  // 每条是**路径分段**（readSrc 是变参），不是单个字符串 —— 之前写成 string[] 时
  // tsc 只在本机之外的红（本地没跑 check 就提交了），CI 一跑 typecheck 就红。
  const pushers: Record<keyof typeof UI_PREF_STORAGE, string[][]> = {
    agreement: [['components', 'FirstRunAgreement.tsx']],
    wallpaper: [['lib', 'wallpaper.ts']],
    'reader-settings': [['features', 'reader', 'settingsPanel', 'readerSettings.ts']],
    'shelf-layout': [['lib', 'shelfLayout.ts']],
    'search-layout': [['lib', 'shelfLayout.ts']],
    'shelf-sort': [['lib', 'shelfLayout.ts']],
    'sidebar-width': [['lib', 'sidebarWidth.ts']],
    'tts-bar-position': [['features', 'reader', 'tts', 'ttsBarPosition.ts']],
    'search-history': [['features', 'bookshelf', 'LibraryPage.tsx']],
    'pwa-banner': [['components', 'PwaManager.tsx']],
  }
  for (const key of Object.keys(UI_PREF_STORAGE) as Array<keyof typeof UI_PREF_STORAGE>) {
    const sources = pushers[key]
    assert.ok(sources && sources.length > 0, `${key} 没有登记上行点`)
    const pushed = sources.some(parts => readSrc(...parts).includes(`pushUiPref('${key}')`))
    assert.ok(pushed, `${key} 在表里但没有模块调 pushUiPref('${key}') —— 这个设置换端口照样丢`)
  }
})

test('没有 window 时 hydrate 直接返回失败，不发请求也不抛', async () => {
  resetHydrateForTest()
  const result = await hydrateUiPrefs(50)
  assert.equal(result.ok, false)
  assert.deepEqual(result.restored, [])
})

test('请求路径必须带 /api 前缀：少了不报错、只静默 404，然后"设置还是丢了"', () => {
  // 这条是发版后真浏览器验收抓出来的真 bug：域文件照 brand.ts 写成 '/ui-prefs'，
  // 而品牌是 StaticWeb 挂在根路径的特例。请求 404 → hydrate 静默失败 → 症状与没修一样。
  const domain = readSrc('lib', 'api', 'domains', 'prefs.ts')
  assert.match(domain, /const BASE = '\/api\/ui-prefs'/, '域端点必须落在 route("/api") 之下')
  assert.doesNotMatch(domain, /request<[^>]*>\('\/ui-prefs'/, '不许再有裸 /ui-prefs 调用')
})
