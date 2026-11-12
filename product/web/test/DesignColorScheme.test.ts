/**
 * 为什么需要这条判据：
 * 动态配色是"皮肤之上的覆盖层"，算错一个角色就会让整屏文字/按钮失去对比度，
 * 而这种问题在界面上往往只表现为"某个字看不清"，没有报错、很难回归定位。
 * 所以这里把三件事钉死在数据层：
 * 1. 38 个角色必须齐全、必须是 6 位小写 hex（旧 CSS 和 <meta theme-color> 都直接吃这个格式）；
 * 2. 同一输入必须**完全确定**（主题随切书反复重算，抖动 = 界面闪色）；
 * 3. 默认 tonalSpot 的浅色 primary 必须就是用户看到的封面色（#6750A4 → #6750a4），
 *    且 onPrimary 对 primary 的对比度 ≥ 4.5（WCAG AA）。
 * legacy 桥另外钉住 16 个旧令牌的语义与 skinCss 的完整规则格式 —— 少一个键，
 * 现有 6,600 行 styles.css 就会回落到别的皮肤颜色。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Contrast, Hct, argbFromHex } from '@material/material-color-utilities'
import { COLOR_ROLES, buildDynamicTheme, normalizeSeed } from '../src/ui/color/scheme'
import { LEGACY_VARS, rolesToSkinVars, skinCss } from '../src/ui/color/legacy'

const SEED = '#6750A4'
const HEX6 = /^#[0-9a-f]{6}$/

const wcagContrast = (background: string, foreground: string): number =>
  Contrast.ratioOfTones(Hct.fromInt(argbFromHex(background)).tone, Hct.fromInt(argbFromHex(foreground)).tone)

const parseVars = (css: string): Record<string, string> =>
  Object.fromEntries([...css.matchAll(/--([a-z-]+)\s*:\s*([^;}]+)/g)].map((match) => [match[1], match[2].trim()]))

test('归一化种子 - 大小写/短写/ARGB 数字都收敛到同一个 6 位小写值', () => {
  assert.equal(normalizeSeed('#6750A4'), '#6750a4')
  assert.equal(normalizeSeed('  #6750A4  '), '#6750a4', '前后空白不该改变颜色')
  assert.equal(normalizeSeed('6750A4'), '#6750a4', '不带 # 也要认（CSS 变量里很常见）')
  assert.equal(normalizeSeed(0xff6750a4), '#6750a4', '32 位 ARGB 数字丢掉 alpha')
  assert.equal(normalizeSeed(0x6750a4), '#6750a4', '24 位数字同样认')
  assert.equal(normalizeSeed('#675'), '#667755', '三位短写按 CSS 规则展开')
  assert.equal(normalizeSeed('#6750A4FF'), '#6750a4', '八位 RRGGBBAA 只取 RGB')
})

test('归一化种子 - 非法输入抛错，不静默回落成某个默认色', () => {
  const invalid = ['', '   ', '#', '#12345', 'rebeccapurple', '#6750a4g', -1, 0x1_0000_0000, 1.5, Number.NaN]
  for (const input of invalid) {
    assert.throws(() => normalizeSeed(input as never), TypeError, `${String(input)} 应当抛 TypeError`)
  }
})

test('M3 基线 - tonalSpot 浅色 primary 就是种子本身（#6750A4）', () => {
  const theme = buildDynamicTheme(SEED)
  assert.equal(theme.seed, '#6750a4')
  assert.equal(theme.variant, 'tonalSpot')
  assert.equal(theme.contrast, 0, '不传 contrast 就是默认对比度')
  assert.equal(theme.light.primary.toLowerCase(), '#6750a4', '用户看到的封面色必须原样成为主色')
  assert.match(theme.light.primary, HEX6)
})

test('38 个角色 - 浅深两套都齐全，且全部是 6 位小写 hex', () => {
  assert.equal(COLOR_ROLES.length, 38)
  assert.equal(new Set(COLOR_ROLES).size, 38, '角色名不能重复')
  const theme = buildDynamicTheme('#247a58')
  for (const roles of [theme.light, theme.dark]) {
    assert.deepEqual(Object.keys(roles), [...COLOR_ROLES], '键顺序必须稳定（skinCss 按它输出）')
    for (const [role, value] of Object.entries(roles)) {
      assert.match(value, HEX6, `角色 ${role} 必须是 #rrggbb，实际 ${value}`)
    }
  }
})

test('确定性 - 同一输入两次结果完全相等，#6750A4 与 #6750a4 也必须是同一主题', () => {
  assert.deepEqual(buildDynamicTheme(SEED), buildDynamicTheme(SEED))
  assert.deepEqual(buildDynamicTheme('#6750A4'), buildDynamicTheme('#6750a4'))
})

test('明暗对比 - 深色 primary 与浅色不同，且浅/深 onPrimary 对 primary 都 ≥ 4.5', () => {
  const { light, dark } = buildDynamicTheme(SEED)
  assert.notEqual(light.primary, dark.primary, '深浅两套不能是同一个主色')
  assert.ok(wcagContrast(light.primary, light.onPrimary) >= 4.5, '浅色 onPrimary 对比度不足 4.5')
  assert.ok(wcagContrast(dark.primary, dark.onPrimary) >= 4.5, '深色 onPrimary 对比度不足 4.5')
})

test('变体开关 - 七个变体都能出主题，且 tonalSpot 与 monochrome 的主色不同', () => {
  const variants = ['tonalSpot', 'content', 'fidelity', 'vibrant', 'expressive', 'neutral', 'monochrome'] as const
  for (const variant of variants) {
    const theme = buildDynamicTheme(SEED, { variant })
    assert.equal(theme.variant, variant)
    assert.match(theme.light.primary, HEX6)
  }
  assert.notEqual(
    buildDynamicTheme(SEED, { variant: 'tonalSpot' }).light.primary,
    buildDynamicTheme(SEED, { variant: 'monochrome' }).light.primary,
  )
  assert.throws(() => buildDynamicTheme(SEED, { variant: 'nope' as never }), TypeError)
})

test('对比度参数 - 越界夹到 [-1,1]，NaN 按默认 0，非零对比度会改变主色', () => {
  assert.equal(buildDynamicTheme(SEED, { contrast: 5 }).contrast, 1)
  assert.equal(buildDynamicTheme(SEED, { contrast: -5 }).contrast, -1)
  assert.equal(buildDynamicTheme(SEED, { contrast: Number.NaN }).contrast, 0)
  assert.equal(buildDynamicTheme(SEED, { contrast: 0.5 }).contrast, 0.5)
  assert.notEqual(buildDynamicTheme(SEED, { contrast: 1 }).light.primary, buildDynamicTheme(SEED).light.primary)
})

test('旧令牌桥 - 恰好 16 个键，语义与 M3 角色逐一对得上', () => {
  const theme = buildDynamicTheme(SEED)
  const vars = rolesToSkinVars(theme.light)
  assert.deepEqual(Object.keys(vars), [...LEGACY_VARS], '键顺序固定，CSS 输出才不会每次重排')
  assert.equal(Object.keys(vars).length, 16)
  assert.equal(vars.canvas, theme.light.surface, 'canvas 是最底层背景')
  assert.equal(vars.surface, theme.light.surfaceContainer, 'surface 是卡片底')
  assert.equal(vars['surface-muted'], theme.light.surfaceContainerHigh, 'surface-muted 是次级卡片')
  assert.equal(vars.ink, theme.light.onSurface)
  assert.equal(vars.muted, theme.light.onSurfaceVariant)
  assert.equal(vars.line, theme.light.outlineVariant)
  assert.equal(vars.accent, theme.light.primary)
  assert.equal(vars['accent-soft'], theme.light.primaryContainer)
  assert.equal(vars['accent-ink'], theme.light.onPrimaryContainer)
  assert.equal(vars['on-accent'], theme.light.onPrimary)
  assert.equal(vars.danger, theme.light.error)
  assert.equal(vars['danger-solid'], theme.light.error)
  assert.equal(vars['on-danger'], theme.light.onError)
  assert.equal(vars.shadow, '0 12px 30px rgba(0,0,0,.08)', '浅色阴影是固定 box-shadow 字符串')
  for (const name of LEGACY_VARS) {
    if (name === 'shadow') continue
    assert.match(vars[name], HEX6, `${name} 必须是 6 位小写 hex`)
  }
})

test('skinCss - 完整规则（选择器+花括号），且每个令牌都能被正则解析回来', () => {
  const theme = buildDynamicTheme(SEED)
  const css = skinCss(theme)
  assert.ok(css.startsWith('.theme-dynamic{'), '缺省选择器必须是 .theme-dynamic')
  assert.ok(css.endsWith('}'))
  const vars = rolesToSkinVars(theme.light)
  const parsed = parseVars(css)
  assert.deepEqual(parsed, vars, '产物里抠出的每个 --变量 都必须和 rolesToSkinVars 一致')
  assert.match(css, /--canvas:#[0-9a-f]{6}/, '--canvas 必须能被正则从产物里单独抠出来（meta theme-color 依赖它）')
  assert.equal(parsed.canvas, vars.canvas)
})

test('skinCss - dark=true 输出深色组，selector 可覆盖，id 只当注释', () => {
  const theme = buildDynamicTheme(SEED)
  const css = skinCss(theme, { selector: 'html.theme-dynamic', dark: true })
  assert.ok(css.startsWith('html.theme-dynamic{'), 'apply.ts 靠 html 前缀压过 .theme-* 皮肤')
  const parsed = parseVars(css)
  const darkVars = rolesToSkinVars(theme.dark)
  assert.deepEqual(parsed, darkVars)
  assert.equal(parsed.shadow, '0 12px 30px rgba(0,0,0,.25)', '深色阴影要更重')
  assert.ok(skinCss(theme, { id: 'legado-dynamic-theme' }).startsWith('/* legado-dynamic-theme */'))
})
