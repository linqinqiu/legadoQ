import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testFiles } from './discover.ts'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkinModal } from '../src/features/reader/SkinModal'
import { ColorTab } from '../src/features/reader/settingsPanel/ColorTab'
import { BackgroundLibrary } from '../src/features/reader/settingsPanel/BackgroundLibrary'
import {
  activeCustomSkin,
  activeSkin,
  availableSkins,
  BUILTIN_SKINS,
  builtinSkinCss,
  builtinSkinName,
  builtinSkinOverride,
  defaultReaderSettings,
  isBuiltinSkinHidden,
  isBuiltinSkinId,
  loadReaderSettings,
  parseBuiltinSkinOverrides,
  parseCustomSkin,
  parseCustomSkins,
  parseHiddenBuiltinSkins,
  parseReaderBackground,
  parseReaderBackgrounds,
  parseSkinId,
  readBuiltinSkinCss,
  readerBackgroundVars,
  resolveTheme,
  saveReaderSettings,
  skinLabel,
  themeClassNames,
  type CustomSkin,
  type ReaderSettings,
} from '../src/features/reader/readerSettings'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const settings = (patch: Partial<ReaderSettings> = {}): ReaderSettings => ({ ...defaultReaderSettings, ...patch })
const skin = (patch: Partial<CustomSkin> = {}): CustomSkin => ({
  id: 'midnight', name: '', css: '.theme-midnight { --canvas: #0f1213; }', ...patch,
})

/**
 * 皮肤浮层（用户 2026-10-01：「咱们这个是开源允许自定义」）。
 * 它只负责配色与皮肤库，壁纸已拆到独立的 `WallpaperModal`。
 * 界面框架 v2 那一波（侧栏 + 页头条 + 全宽）已按用户拍板整条撤掉，
 * 所以这里也钉住"只有一套外壳"这件事，别让侧栏哪天又悄悄长回来。
 *
 * 2026-10-11 起皮肤从**单套**扩成**库**（用户：「所有的自定义是可以自己定义保存……
 * 可以自定义许多个，并有记录保存」）—— 下面钉住库的增删改切换与旧数据的迁移。
 */

test('皮肤 id - 会被拼成类名，所以只留 [a-z0-9-_] 且限长', () => {
  assert.equal(parseSkinId('MidNight'), 'midnight', '大小写要归一，类名不能有两个样子的同一皮肤')
  assert.equal(parseSkinId('  my_skin-2  '), 'my_skin-2')
  // 这些如果原样拼进 `.theme-<id>`，轻则类名失效，重则把后面的 selector 拼坏
  assert.equal(parseSkinId('a b{color:red}'), 'abcolorred')
  assert.equal(parseSkinId('"><img src=x>'), 'imgsrcx')
  assert.equal(parseSkinId('中文皮肤'), '', '非 ASCII 的 id 清完就是空 —— 空即"没有自定义皮肤"')
  assert.equal(parseSkinId('x'.repeat(80)).length, 32, '长度要夹住，不然一条设置能把 localStorage 撑大')
  for (const junk of [undefined, null, 42, {}]) assert.equal(parseSkinId(junk), '')
})

test('皮肤列表 - 内置七套 + 库里每一套自定义皮肤', () => {
  assert.deepEqual(availableSkins(settings()).map(s => [s.id, s.builtin]), BUILTIN_SKINS.map(s => [s.id, true]))
  assert.equal(availableSkins(settings()).length, 7)
  assert.deepEqual(availableSkins(settings({ customSkins: [skin()] }))[7], { id: 'midnight', name: '自定义（midnight）', builtin: false })
  assert.equal(availableSkins(settings({ customSkins: [skin()] })).length, 8)
  // 起过名字就用名字
  assert.equal(availableSkins(settings({ customSkins: [skin({ name: '午夜' })] }))[7].name, '午夜')
  // 没写 CSS 的那一套不进列表（点了没反应的控件不摆）
  assert.equal(availableSkins(settings({ customSkins: [skin({ css: '   ' })] })).length, 7)
  // 库里多套都在
  assert.equal(availableSkins(settings({ customSkins: [skin(), skin({ id: 'dawn' })] })).length, 9)
})

/**
 * 用户 2026-11-02：「皮肤七套也不能，已经有的不能任意编辑删除」。
 * 内置七套在界面上没有编辑/删除入口，但如果自定义皮肤能占用同名 id，
 * 注入的 CSS 就会把内置配色盖掉 —— 那等于绕过界面改掉了内置皮肤。
 * 所以 id 必须在数据层就保留，而不是只靠界面少画两颗按钮。
 */
test('内置七套的 id 是保留字：自定义皮肤不能新增，也不能从旧数据里顶掉内置皮肤', () => {
  const collision = skin({ id: 'light', name: '假晓白', css: '.theme-light { --canvas: #000000; }' })
  assert.equal(parseCustomSkin(collision), null, '读取/保存时就要拒绝内置 id')
  assert.equal(isBuiltinSkinId('Light'), true, '大小写归一后仍是内置 id')
  assert.equal(isBuiltinSkinId('midnight'), false)

  // 旧数据或手改 localStorage 仍可能把同名条目塞进来：列表与生效对象两层都要挡住。
  const manual = settings({ theme: 'light', customSkins: [collision, skin()] })
  const listed = availableSkins(manual)
  assert.equal(listed.filter(item => item.id === 'light').length, 1, '同一个 id 只出现一张卡，内置优先')
  assert.deepEqual(listed[0], { id: 'light', name: '晓白', builtin: true })
  assert.equal(activeCustomSkin(manual), undefined, 'theme=light 时必须按内置皮肤解释，不能被同名自定义样式覆盖')
  assert.deepEqual(themeClassNames(manual), ['theme-light'])
})

test('自定义皮肤只挂自己的类，不再叠加任何内置档', () => {
  assert.deepEqual(themeClassNames(settings()), ['theme-light'])
  assert.deepEqual(themeClassNames(settings({ theme: 'dark' })), ['theme-dark'])
  // 用户 2026-10-23/2026-11-01：自定义不是叠在哪一套之上，是全权自定义。
  // 即使老数据里还留着 base/mode，解析与类名都不再认它们。
  const legacy = { id: 'midnight', name: '', css: '.theme-midnight { --canvas: #0f1213; }', base: 'dark', mode: 'overlay' }
  const custom = settings({
    customSkins: [legacy as unknown as CustomSkin],
    theme: 'midnight',
  })
  assert.deepEqual(themeClassNames(custom), ['theme-midnight'])
  assert.deepEqual(themeClassNames({ ...custom, theme: 'paper' }), ['theme-paper'], '没启用自定义时仍按所选内置皮肤')
  // 内置皮肤列表本身不受影响
  assert.equal(BUILTIN_SKINS.length, 7)
})

/**
 * 用户 2026-11-02：「固定的也能编辑或删除」。
 * 内置皮肤可以改名、换 CSS；改动是**追加**在出厂规则之后的一份，没改 CSS 时不重复注入。
 */
test('内置皮肤可以改名、换 CSS，实际生效的是改后的那一份', () => {
  const custom = settings({
    theme: 'dark',
    builtinSkinOverrides: { dark: { name: '深夜', css: '.theme-dark { --canvas: #000000; }' } },
  })
  assert.equal(builtinSkinName(custom, 'dark'), '深夜')
  assert.equal(availableSkins(custom)[2].name, '深夜', '皮肤列表也要用改后的名字')
  assert.equal(builtinSkinCss(custom, 'dark'), '.theme-dark { --canvas: #000000; }')
  assert.deepEqual(activeSkin(custom), {
    id: 'dark', name: '深夜', css: '.theme-dark { --canvas: #000000; }', builtin: true,
  })
  assert.deepEqual(themeClassNames(custom), ['theme-dark'], '内置皮肤仍然只挂自己那一个类')

  // 只改名：CSS 仍走出厂规则，activeSkin 不重复注入一份空的 / 复制的样式。
  const renamed = settings({ theme: 'dark', builtinSkinOverrides: { dark: { name: '深夜', css: '' } } })
  assert.equal(activeSkin(renamed)?.css, '')
  assert.equal(activeSkin(settings({ theme: 'dark' }))?.css, '', '没改动时不该往页面里多挂一条 style')

  // 自定义皮肤仍不能占用内置 id，内置改动必须走 builtinSkinOverrides。
  assert.equal(parseCustomSkin({ id: 'dark', name: '深夜', css: 'a{b:c}' }), null)
})

/**
 * 删除内置皮肤 = 从可选列表隐藏：改过的名字 / CSS 都保留，恢复时原样回来。
 * 只有七套全删且没有自定义皮肤时才会出现"没有主题"，这时宁可露出中性基线，
 * 也不假装一套已经删掉的皮肤还在（否则类名和界面显示会对不上）。
 */
test('内置皮肤删除只是隐藏，可恢复；全删光时不再假装某套还在', () => {
  const hiddenLight = settings({ theme: 'light', hiddenBuiltinSkins: ['light'] })
  assert.equal(isBuiltinSkinHidden(hiddenLight, 'light'), true)
  assert.equal(availableSkins(hiddenLight).length, 6)
  assert.ok(!availableSkins(hiddenLight).some(skin => skin.id === 'light'), '删掉的那套不该还在列表里')
  assert.equal(resolveTheme(hiddenLight), 'paper', '当前皮肤被删时自动落到下一套可见内置皮肤')
  assert.deepEqual(themeClassNames(hiddenLight), ['theme-paper'])

  const both = settings({
    theme: 'light',
    hiddenBuiltinSkins: ['light'],
    builtinSkinOverrides: { light: { name: '米白', css: '.theme-light { --canvas: #fff; }' } },
  })
  assert.equal(builtinSkinName(both, 'light'), '米白', '隐藏不抹掉改动，恢复后名字还在')
  assert.equal(builtinSkinOverride(both, 'light')?.css, '.theme-light { --canvas: #fff; }')
  assert.equal(availableSkins(settings({ hiddenBuiltinSkins: [] })).length, 7, '恢复后七套都回来')

  const noSkins = settings({ theme: 'light', hiddenBuiltinSkins: BUILTIN_SKINS.map(skin => skin.id) })
  assert.deepEqual(availableSkins(noSkins), [])
  assert.equal(resolveTheme(noSkins), '')
  assert.deepEqual(themeClassNames(noSkins), [], '没有可选皮肤时不硬塞一个已删除的类名')

  const fallbackCustom = settings({
    theme: 'light',
    hiddenBuiltinSkins: BUILTIN_SKINS.map(skin => skin.id),
    customSkins: [skin()],
  })
  assert.equal(resolveTheme(fallbackCustom), 'midnight', '内置全删光时退到第一套自定义皮肤')
  assert.deepEqual(themeClassNames(fallbackCustom), ['theme-midnight'])
})

test('内置改动与删除记录的清洗：只认内置 id，空改动不留档', () => {
  assert.deepEqual(parseBuiltinSkinOverrides({
    light: { name: ' 米白 ', css: ' a{b:c} ' },
    dark: { name: '', css: '   ' },
    nope: { name: 'x', css: 'a{b:c}' },
  }), { light: { name: '米白', css: ' a{b:c} ' } })
  assert.deepEqual(parseBuiltinSkinOverrides('不是对象'), {})
  assert.deepEqual(parseHiddenBuiltinSkins(['LIGHT', 'nope', 'light', 'dark']), ['light', 'dark'], '去重、归一、按内置顺序')
  assert.deepEqual(parseHiddenBuiltinSkins('不是数组'), [])

  // 没有 document（Node 测试）时读不到出厂样式，返回空串让编辑器留空，而不是抛错。
  assert.equal(readBuiltinSkinCss('light'), '')
})

/**
 * 全权自定义要能成立，前提是有一份**与皮肤无关**的中性颜色基线：
 * 历史上这 16 个颜色令牌只存在于 7 个 `.theme-*` 类里，`:root` 一个都不定义，
 * 所以"只挂自己一个类"必然花屏（字和底同色）—— 那正是当年强制叠加的理由。
 * 位置也是判据的一部分：`:root` 与 `.theme-*` 同为 (0,1,0)，靠源序定胜负，
 * 基线若排在 `.theme-*` 之后就会把 7 套预设皮肤的配色整体洗成同一个颜色。
 */
test('styles.css 给了与皮肤无关的中性颜色基线，且排在预设皮肤之前', () => {
  const css = read('../src/styles.css')
  // 按**行首选择器**定位，别用 indexOf('.theme-light')：注释里也会提到它，会把区间截错。
  const rootAt = /^:root \{$/m.exec(css)
  const lightAt = /^\.theme-light \{/m.exec(css)
  assert.ok(rootAt, '文件里要有顶格的 `:root {` 块')
  assert.ok(lightAt, '要有 `.theme-light {` 预设皮肤')
  assert.ok(rootAt.index < lightAt.index, '第一个 :root 必须排在 .theme-* 之前（同特异性靠源序定胜负）')
  const baseline = css.slice(rootAt.index, lightAt.index)
  for (const token of ['--canvas', '--surface', '--ink', '--muted', '--line', '--accent', '--accent-soft', '--on-accent', '--danger', '--shadow']) {
    assert.ok(baseline.includes(`${token}:`), `中性基线要定义 ${token}（放在 .theme-* 之前才不洗掉预设配色）`)
  }
  // 反向：颜色基线不许被塞进文件后段的 :root（那里排在 .theme-* 之后，同特异性后者胜，
  // 一旦发生就会把 7 套预设皮肤的配色整体洗成同一个颜色）。
  const afterThemes = css.slice(/\.theme-shimo \{/m.exec(css)!.index)
  assert.ok(!/^\s*--canvas:/m.test(afterThemes), '颜色基线不能出现在 .theme-* 之后的 :root 里')
})

test('皮肤库清洗：id 过白名单、空 id / 空 CSS 丢掉、同 id 只留最后一套', () => {
  assert.deepEqual(parseCustomSkins('不是数组'), [])
  assert.deepEqual(parseCustomSkins([{ id: 'MidNight', name: ' 午夜 ', css: 'a{b:c}' }]),
    [{ id: 'midnight', name: '午夜', css: 'a{b:c}' }])
  // id 清洗后为空（中文）、或 CSS 为空的那一套不成立 —— 不进库，也就不会多出一个选不中的项
  assert.deepEqual(parseCustomSkins([{ id: '中文', css: 'a{b:c}' }, { id: 'ok', css: '   ' }]), [])
  assert.equal(parseCustomSkins([{ id: 'dup', css: 'a{b:1}' }, { id: 'dup', css: 'a{b:2}' }])[0].css, 'a{b:2}')
  // 老数据的 base / mode 字段被忽略，不再进入新对象
  assert.deepEqual(parseCustomSkin({ id: 'x', css: 'a{b:c}', base: 'dark', mode: 'overlay' }),
    { id: 'x', name: '', css: 'a{b:c}' })
  assert.equal(parseCustomSkin(null), null)
  assert.equal(parseCustomSkin({ id: '', css: 'x' }), null)
  // 内置七套的 id 是保留字：任何一套都不能被自定义皮肤顶替。
  for (const builtin of BUILTIN_SKINS) {
    assert.equal(parseCustomSkin({ id: builtin.id, css: 'a{b:c}' }), null,
      `内置 id ${builtin.id} 是保留字，自定义皮肤不能占用`)
  }
  assert.deepEqual(parseCustomSkins([{ id: 'light', css: 'a{b:c}' }, { id: 'midnight', css: 'a{b:c}' }]).map(item => item.id),
    ['midnight'], '库清洗会把撞内置 id 的旧条目丢掉，其余照常保留')
})

test('当前启用的是哪一套自定义皮肤；显示名缺省回落 id', () => {
  const lib = [skin({ id: 'a' }), skin({ id: 'b' })]
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'b' }))?.id, 'b')
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'dark' })), undefined, '内置档时库里哪套都不生效')
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'midnight' })), undefined, '库里没有的 id 不算启用')
  assert.equal(skinLabel(skin({ name: '' })), '自定义（midnight）')
  assert.equal(skinLabel(skin({ name: '午夜' })), '午夜')
})

test('旧版单套皮肤会迁进皮肤库，不丢用户已存的皮肤', () => {
  // loadCustomSkins 是私有的，走公开的 loadReaderSettings 不便（要 window），
  // 所以这里直接验迁移的两半：旧字段能被 parseCustomSkin 收成一套，且空 CSS 的旧值不收。
  const migrated = parseCustomSkin({ id: 'midnight', css: '.theme-midnight { --canvas: #0f1213; }', base: 'dark' })
  assert.deepEqual(migrated, { id: 'midnight', name: '', css: '.theme-midnight { --canvas: #0f1213; }' },
    '旧版那一套只剩 id/name/css，base 不再保留')
  assert.equal(parseCustomSkin({ id: 'midnight', css: '' }), null, '旧版只填了 id 没填 CSS 的，迁过来也是空的，不收')
})

test('阅读背景预设：颜色 / 图片 / 压暗各自清洗，空颜色 + 空图片合法', () => {
  const parsed = parseReaderBackground({ id: 'bg-1', name: ' 夜读 ', color: '#112233', image: 'https://example.com/a.jpg', dim: 3 })
  assert.deepEqual(parsed, { id: 'bg-1', name: '夜读', color: '#112233', image: 'https://example.com/a.jpg', dim: 0.6 })
  assert.deepEqual(parseReaderBackground({ id: 'bg-2' }), { id: 'bg-2', name: '', color: '', image: '', dim: 0.25 })
  assert.equal(parseReaderBackground({ id: '中文', color: 'red' }), null, 'id 清洗后为空 → 这一套不成立')
  assert.deepEqual(parseReaderBackground({ id: 'bg-3', color: 'red' })?.color, '', '非法颜色清成空，但 id 合法时仍是一套')
  assert.deepEqual(parseReaderBackground({ id: 'bg-4', image: 'javascript:alert(1)' })?.image, '')
  assert.deepEqual(parseReaderBackgrounds([
    { id: 'bg-1', color: '#000' }, { id: 'bg-1', color: '#fff' }, { id: '', color: '#fff' }, null,
  ]), [{ id: 'bg-1', name: '', color: '#fff', image: '', dim: 0.25 }], '同 id 留最后一条，坏条丢掉')
})

test('阅读背景样式：压暗同时作用于颜色与图片，空背景不铺黑层', () => {
  assert.deepEqual(readerBackgroundVars({ readerBgColor: '', readerBgImage: '', readerBgDim: .25 }),
    { '--reader-bg-color': 'transparent', '--reader-bg-image': 'none' },
    '跟随主题时不能因为默认压暗把画布蒙黑')
  assert.deepEqual(readerBackgroundVars({ readerBgColor: '#112233', readerBgImage: '', readerBgDim: .25 }),
    { '--reader-bg-color': '#112233', '--reader-bg-image': 'linear-gradient(rgb(0 0 0 / 0.25), rgb(0 0 0 / 0.25))' },
    '纯色背景的压暗要真的生效，否则滑杆是个没反应的控件')
  assert.deepEqual(readerBackgroundVars({ readerBgColor: '', readerBgImage: 'https://example.com/a.jpg', readerBgDim: 0 }),
    { '--reader-bg-color': 'transparent', '--reader-bg-image': 'url("https://example.com/a.jpg")' },
    '压暗为 0 时不该多一层全透明渐变')
  assert.deepEqual(readerBackgroundVars({ readerBgColor: '#000', readerBgImage: 'https://example.com/a.jpg', readerBgDim: .4 }),
    { '--reader-bg-color': '#000', '--reader-bg-image': 'linear-gradient(rgb(0 0 0 / 0.4), rgb(0 0 0 / 0.4)), url("https://example.com/a.jpg")' })
  assert.equal(readerBackgroundVars({ readerBgColor: '#000', readerBgImage: '', readerBgDim: 9 })['--reader-bg-image'],
    'linear-gradient(rgb(0 0 0 / 0.6), rgb(0 0 0 / 0.6))', '越界压暗要夹到上限')
})

/** 用户 2026-11-01：「作为这外观怎么进阅读页面了还不能自定义」——
 * 阅读页的「颜色与背景」标签页里必须能打开同一个皮肤库，并且背景预设也在同一处。
 */
test('阅读页「颜色与背景」：皮肤库入口 + 背景预设库都在同一个标签页', () => {
  const html = renderToStaticMarkup(React.createElement(ColorTab, {
    settings: settings(), onChange: () => undefined,
  }))
  assert.match(html, /管理皮肤/)
  assert.match(html, /预设皮肤可改名、换样式或隐藏/, '阅读页入口也要说清预设皮肤现在可管理')
  assert.match(html, /阅读背景/)
  assert.match(html, /我的背景/)
  assert.match(html, /跟随整站壁纸/)
  assert.match(html, /背景图地址/)
  assert.match(html, /theme-choice/, '主题网格要真的渲染出来，不能只剩一个入口按钮')
})

test('背景预设库：当前套用的那套标「使用中」，图片预设带缩略图', () => {
  const html = renderToStaticMarkup(React.createElement(BackgroundLibrary, {
    settings: settings({
      customBackgrounds: [
        { id: 'bg-1', name: '夜读', color: '#112233', image: '', dim: .25 },
        { id: 'bg-2', name: '远山', color: '#000', image: 'https://example.com/a.jpg', dim: .4 },
      ],
      readerBgColor: '#112233',
      readerBgImage: '',
      readerBgDim: .25,
    }),
    onChange: () => undefined,
  }))
  assert.equal((html.match(/使用中/g) ?? []).length, 1, '只有与当前背景完全一致的那一套才标使用中')
  assert.match(html, /纯色 #112233 · 压暗 25%/)
  assert.match(html, /图片 · 压暗 40%/)
  assert.match(html, /example\.com\/a\.jpg/, '图片预设的色片要用图片本身，不能只显示一个色块')
})

/** 用户 2026-11-01：「做测试能否自定义并保存」—— 走真实的 load/save 往返。 */
test('自定义皮肤与背景预设随阅读设置一起存取，刷新后仍在', () => {
  const store = new Map<string, string>()
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  }
  try {
    const background = { id: 'bg-1', name: '夜读', color: '#112233', image: '', dim: 0.3 }
    const builtinSkinOverrides = {
      dark: { name: '深夜', css: '.theme-dark { --canvas: #000000; }' },
    }
    saveReaderSettings(settings({
      theme: 'midnight',
      customSkins: [skin({ name: '午夜' })],
      builtinSkinOverrides,
      hiddenBuiltinSkins: ['paper'],
      customBackgrounds: [background],
      readerBgColor: '#112233',
      readerBgDim: 0.3,
    }))
    const loaded = loadReaderSettings()
    assert.equal(loaded.theme, 'midnight', '主题选择要能保存下来')
    assert.deepEqual(loaded.customSkins, [skin({ name: '午夜' })], '自定义皮肤库要能保存下来')
    assert.deepEqual(loaded.builtinSkinOverrides, builtinSkinOverrides, '内置皮肤的改动要能保存下来')
    assert.deepEqual(loaded.hiddenBuiltinSkins, ['paper'], '删除过的内置皮肤要能保存下来')
    assert.deepEqual(loaded.customBackgrounds, [background], '背景预设要能保存下来')
    assert.equal(loaded.readerBgColor, '#112233')
    assert.equal(loaded.readerBgDim, 0.3)
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
})

test('SkinModal 静态渲染：皮肤列表 + 皮肤库，编辑器按需展开', () => {
  const html = renderToStaticMarkup(React.createElement(SkinModal, {
    settings: settings(), onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /皮肤/)
  assert.match(html, /自定义皮肤库/)
  assert.match(html, /只存在这台电脑的浏览器里/, '要说清楚只存本机：不上传服务端、不进备份包')
  assert.doesNotMatch(html, /叠在哪一套之上|叠在哪一档/, '全权自定义：不该再问"叠在某一档之上"')
  assert.match(html, /会用默认值补上/, '要说清楚没写到的颜色用默认值，不跟预设配色联动')
  assert.match(html, /新建皮肤/)
  // 文案通用化（2026-11-03）：界面不再说"内置七套 / 换 CSS / 删除只是隐藏"这类实现话，隐藏就叫隐藏。
  // 判据跟着换成用户视角的说法，守的仍然是"入口在、说得清能做什么"。
  assert.match(html, /<span>预设皮肤<\/span>/, '预设皮肤的管理入口要在皮肤浮层里')
  assert.match(html, /可改名、换样式、隐藏/, '折叠时也要说清这几套能改能藏')
  assert.match(html, /隐藏的随时能恢复/, '隐藏不是抹掉，必须说清可恢复')
  // 七套预设皮肤每一套都有编辑 / 隐藏入口；自定义库为空时不额外多出按钮。
  assert.equal((html.match(/>编辑</g) ?? []).length, 7, '七套预设皮肤都要有编辑按钮')
  assert.equal((html.match(/>隐藏</g) ?? []).length, 7, '七套预设皮肤都要有隐藏按钮')
  assert.equal((html.match(/theme-swatch-/g) ?? []).length, 7, '七套预设皮肤的色片都在')
  // 编辑器默认收起：首屏只留库与新建入口，别让一整张空表单把「保存并套用」挤到折叠线以下。
  assert.doesNotMatch(html, /customize-css|保存并套用/, '没点「新建皮肤」之前不该先摆出一张空表单')
  assert.ok(!html.includes('自定义（'), '库里没东西时，皮肤列表里不该出现一个用不了的自定义皮肤')
  assert.ok(!html.includes('界面布局'), '界面框架 v2 已撤销：这里不该再有一档"布局"可选')
  assert.doesNotMatch(html, /壁纸/, '壁纸已有独立浮层，皮肤弹窗里不该再出现一整组壁纸控件')
  assert.doesNotMatch(html, /--canvas: #0f1213/, '说明里不再附带示例样式，用法只留选择器要求')
})

test('SkinModal 里库里每一套都进皮肤列表，并给出编辑 / 删除', () => {
  const html = renderToStaticMarkup(React.createElement(SkinModal, {
    settings: settings({ customSkins: [skin()] }),
    onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /自定义（midnight）/)
  assert.match(html, /theme-swatch-custom/, '自定义皮肤要有自己的色片样式，不能长得像内置那档')
  assert.equal((html.match(/>编辑</g) ?? []).length, 8, '七套内置 + 库里这一套自定义都有编辑按钮')
  assert.equal((html.match(/>隐藏</g) ?? []).length, 7, '七套预设皮肤都是「隐藏」，不是删除')
  assert.equal((html.match(/>删除</g) ?? []).length, 1, '只有自定义库里那一套是真删除')
})

test('SkinModal 显示内置皮肤的状态：已修改、已删除、使用中与恢复入口', () => {
  const html = renderToStaticMarkup(React.createElement(SkinModal, {
    settings: settings({
      theme: 'dark',
      builtinSkinOverrides: { dark: { name: '深夜', css: '.theme-dark { --canvas: #000; }' } },
      hiddenBuiltinSkins: ['paper'],
    }),
    onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /深夜/, '改过的名字要在管理列表里出现')
  assert.match(html, /已修改/)
  assert.match(html, /已隐藏/)
  assert.match(html, /使用中/)
  assert.match(html, />恢复</, '隐藏掉的那套要有恢复按钮')
  assert.match(html, /全部恢复默认/)
  assert.equal((html.match(/>隐藏</g) ?? []).length, 6, '已隐藏的那套只剩恢复，不再有隐藏按钮')
  assert.equal((html.match(/>还原</g) ?? []).length, 1, '改过的那套可以单独还原')
})

test('SkinModal 把内置 id 挡在自定义保存入口，并给内置删除 / 恢复留路径', () => {
  const source = read('..', 'src', 'features', 'reader', 'SkinModal.tsx')
  assert.match(source, /isBuiltinSkinId\(sanitized\)/, '自定义皮肤保存时必须先拒绝内置 id')
  assert.match(source, /这些名字被预设皮肤占用了/, '拒绝时要说清为什么，而不是静默保存失败')
  assert.match(source, /isBuiltinSkinId\(skin\.id\)\) return/, '删除自定义皮肤的入口也要兜底挡住内置 id')
  assert.match(source, /window\.confirm\(/, '删除自定义皮肤不能点一下就没')
  assert.match(source, /hiddenBuiltinSkins/, '删除内置皮肤要写进隐藏表，而不是从数据里抹掉')
  assert.match(source, /restoreBuiltin/, '删掉的内置皮肤必须能恢复')
  assert.match(source, /resetBuiltin/, '改过的内置皮肤必须能单独还原')
  assert.match(source, /restoreAllBuiltins/, '还要有一条恢复全部内置的路径')
  assert.match(source, /isLastVisibleSkin/, '不能把最后一套皮肤也删掉')
})

test('内置皮肤的 CSS 预填读出的是出厂规则，不读用户自己的追加样式', () => {
  const source = read('..', 'src', 'features', 'reader', 'readerSettings.ts')
  assert.match(source, /owner\?\.id === 'legado-custom-skin'/, '跳过注入点，否则编辑一次未改动的皮肤就会把追加样式当成出厂样式')
  assert.match(source, /function readBuiltinSkinCss/)
})

test('T 键轮换只走未删除的内置皮肤，恢复默认设置不会丢内置改动', () => {
  const reader = read('..', 'src', 'features', 'reader', 'ReaderScreen.tsx')
  assert.match(reader, /BUILTIN_SKINS\.filter\(skin => !isBuiltinSkinHidden\(settings, skin\.id\)\)/, 'T 键不能切到已删除的内置皮肤')
  assert.match(reader, /const current = resolveTheme\(settings\)/, '轮换起点也要按实际生效的那套算')
  const reset = read('..', 'src', 'features', 'reader', 'settingsPanel', 'TypographyTab.tsx')
  assert.match(reset, /builtinSkinOverrides: settings\.builtinSkinOverrides/, '恢复默认排版不能清掉内置皮肤改动')
  assert.match(reset, /hiddenBuiltinSkins: settings\.hiddenBuiltinSkins/, '恢复默认排版不能把删掉的皮肤又变回来')
})

/**
 * 注入点：只允许 textContent 一条路。
 * `dangerouslySetInnerHTML` 或模板拼接会把用户写的 `</style>` 变成真标签 —— 那等于把
 * 一个本机设置项变成注入点（虽然是自己的机器，但这道子不该靠"用户不会害自己"成立）。
 */
test('皮肤 CSS 的注入方式：createElement + textContent，空了就摘掉', () => {
  const main = read('..', 'src', 'main.tsx')
  assert.match(main, /document\.createElement\('style'\)/)
  assert.match(main, /legado-custom-skin/, '注入点要有固定 id，切走皮肤时才知道摘哪一个')
  assert.match(main, /\.textContent\s*=\s*css/)
  assert.match(main, /const active = activeSkin\(settings\)/, '内置皮肤的追加 CSS 与自定义皮肤走同一个注入点')
  // 只看 SkinStyle 这一段：文件别处有一句解释"为什么不用 innerHTML"的注释，那是文字不是代码。
  // `\r?\n` 是必须的：`git checkout` 在 Windows 上给出的是 CRLF，写死 `\n}` 会取到空串。
  const skinBlock = /function SkinStyle\([\s\S]*?\r?\n\}/.exec(main)?.[0] ?? ''
  assert.ok(skinBlock.length > 200, '要真的取到 SkinStyle 这一段（取空串的话下面几条对什么都成立）')
  assert.doesNotMatch(skinBlock, /dangerouslySetInnerHTML|innerHTML/, '样式注入不许走 innerHTML')
  assert.match(main, /getElementById\(marker\)\?\.remove\(\)/, '没填皮肤或卸载时要把 style 摘掉，否则换皮肤后旧规则还在')
  // 皮肤类必须同时挂到 <html>：portal 出去的浮层（Select 的下拉）只认根上的变量
  assert.match(main, /root\.classList\.add\(\.\.\.themeClassNames\(settings\)\)/)
  assert.match(main, /const skinClasses = themeClassNames\(settings\)\.join\(' '\)/, '各处外壳要共用同一份皮肤类名')
  assert.match(main, /className=\{`app-shell \$\{skinClasses\}`\}/, '外壳用同一份类名')
  assert.doesNotMatch(main, /theme-\$\{settings\.theme\}/, '不许再有一处自己拼主题类名（拼漏基档就会花屏）')
})

/** 界面框架 v2 整条撤掉之后，"只有一套外壳"这件事要有东西守着，别哪天又长回来。 */
test('应用只有一套外壳（旧版顶栏），侧栏与页头条那套文件不在树里', () => {
  const src = path.resolve(import.meta.dirname, '..', 'src')
  assert.ok(!fs.existsSync(path.join(src, 'AppRail.tsx')), 'AppRail.tsx（侧栏外壳）应该已经删掉')
  assert.ok(!fs.existsSync(path.join(src, 'PageBar.tsx')), 'PageBar.tsx（v2 页头条）应该已经删掉')
  const testDir = path.resolve(import.meta.dirname)
  assert.ok(!fs.existsSync(path.join(testDir, 'AppRail.test.ts')), '配套用例也要一起撤，留着就是一条打不开的红')
  const settingsSrc = read('..', 'src', 'features', 'reader', 'readerSettings.ts')
  assert.doesNotMatch(settingsSrc, /uiLayout/, '设置里不该再有"界面布局"这一档')
  const css = read('..', 'src', 'styles.css')
  for (const dead of ['.app-rail', '.rail-item', '.page-bar', '.app-frame', '.rail-tabs']) {
    assert.ok(!css.includes(dead), `样式里不该再留 v2 的 ${dead}（留着会有"看着没删干净"的歧义）`)
  }
})

/** 标题栏颜色取的是算出来的 --canvas，写死的三档色表对自定义皮肤一律失真。 */
test('theme-color 跟着皮肤走，且取的是计算值', () => {
  const main = read('..', 'src', 'main.tsx')
  assert.match(main, /getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--canvas'\)/)
  assert.doesNotMatch(main, /THEME_CANVAS/, '不许再留前端写死的色表')
  assert.match(main, /meta\[name="theme-color"\]/)
})

test('样式表里这几张界面都有规则（更新日志页、皮肤弹窗、壁纸浮层、分章规则弹窗）', () => {
  const css = read('..', 'src', 'styles.css')
  // W2 并档：两张弹窗自己的宽高没了，几何在共用那一档里 —— 所以断言也搬到那一档上。
  assert.match(css, /^\.dialog-shell \{/m, '弹窗外壳那一档不见了，两张弹窗都会退回裸 div')
  assert.match(css, /^\.dialog-head \{/m, '弹窗页头那一档不见了')
  assert.match(read('..', 'src', 'features', 'reader', 'SkinModal.tsx'), /className="dialog-shell[^"]*skin-dialog"/)
  assert.match(read('..', 'src', 'features', 'settings', 'WallpaperModal.tsx'), /className="dialog-shell[^"]*wallpaper-dialog"/)
  assert.match(read('..', 'src', 'components', 'TocRulesModal.tsx'), /className="dialog-shell[^"]*toc-rules-modal"/)
  assert.match(css, /\.changelog-page \{/)
  assert.match(css, /\.theme-swatch-custom/)
  assert.match(css, /\.menu-section-action/)
  assert.match(css, /\.theme-name/)
  // 壁纸浮层的三组与底部清除条：类名不在样式表里 = 三组控件贴在一起分不开
  assert.match(css, /\.wallpaper-groups \{/)
  assert.match(css, /\.wallpaper-footer \{/)
  // 皮肤库那几条也得有样式：类名不在样式表里 = 渲染出来是一个没有布局的裸列表
  assert.match(css, /\.skin-library \{/)
  assert.match(css, /\.skin-library-row \{/)
  assert.match(css, /\.skin-editor \{/)
  assert.match(css, /\.builtin-skin-manage \{|\.builtin-skin-manage > summary \{/, '内置七套管理要有折叠头样式')
  assert.match(css, /\.skin-library-row\.is-hidden/, '已删除的内置皮肤要能看出状态')
  assert.match(css, /\.skin-library-foot \{/, '恢复全部内置的按钮要有自己的落位')
  // 搬出去的弹窗还得有自己的内容样式：类名不在样式表里 = 渲染出来是一个没有滚动的裸 div
  assert.match(css, /\.toc-rules-body \{/)
  assert.match(css, /\.toc-rule \{/)
  assert.doesNotMatch(css, /\.customize-toc-/, '分章规则的样式不姓"自定义"了，类名也跟着搬')
})

/**
 * `run-all.ts` 改成**扫目录**之后，这条判据的职责跟着换了。
 *
 * 清单时代它钉的是"每个文件都得在清单上出现过"；而清单本身的失效方式（少抄一行 = 少跑一份，
 * 套件照样全绿）在这个仓库出过三次，所以入口改成了 `discover.ts` 的 `testFiles(dir)`。
 * 现在这条钉的是**扫描规则本身**：拿一个独立的、最朴素的递归走查当参照物，两边必须一模一样。
 * 参照物故意写得"笨"（只认 `endsWith('.test.ts')`）—— 谁把过滤条件写窄（比如漏了子目录、
 * 改成只认大写开头），笨参照物就会多出一项，当场红。
 */
test('run-all.ts 的扫描规则覆盖 web/test 下每一份 *.test.ts', () => {
  const dir = path.resolve(import.meta.dirname)
  const oracle = (() => {
    const found: string[] = []
    const walk = (current: string, prefix: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) { walk(path.join(current, entry.name), `${prefix}${entry.name}/`); continue }
        if (entry.name.endsWith('.test.ts')) found.push(`${prefix}${entry.name}`)
      }
    }
    walk(dir, '')
    return found.sort()
  })()
  const discovered = testFiles(dir)
  assert.ok(oracle.length >= 60, `只枚举到 ${oracle.length} 份判据文件 —— 参照物自己也没扫对，这条无从判断`)
  assert.deepEqual(discovered, oracle,
    `run-all.ts 会加载的文件与磁盘上的对不上。少了：${oracle.filter(n => !discovered.includes(n)).join('、')}；`
    + `多了：${discovered.filter(n => !oracle.includes(n)).join('、')}`)

  // 反向对照：临时造一棵两层的小目录树，子目录那份必须被看见；非 .test.ts 的不许混进来。
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-discover-'))
  try {
    fs.mkdirSync(path.join(temp, 'reader'))
    fs.writeFileSync(path.join(temp, 'Top.test.ts'), '')
    fs.writeFileSync(path.join(temp, 'reader', 'Deep.test.ts'), '')
    fs.writeFileSync(path.join(temp, 'helper.ts'), '')
    fs.writeFileSync(path.join(temp, 'notes.md'), '')
    assert.deepEqual(testFiles(temp), ['Top.test.ts', 'reader/Deep.test.ts'],
      '扫描要么漏了子目录那份，要么把不该跑的也收进来了')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
