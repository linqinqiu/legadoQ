import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { glassClassName, glassStyle } from '../src/ui/material/glass.ts'

/**
 * Liquid Glass 材质的判据 —— 为什么需要这一份。
 *
 * 玻璃效果是**纯装饰**：写错了页面照样能读，只是"看着廉价"或"文字糊了"。
 * 正因为它不会报错，才需要判据把这几件事钉住：
 *
 * 1. **三档真的不同**：如果三档参数被复制粘贴成一样，UI 上就只剩一种玻璃，
 *    设计里的层级（浮层 / 弹窗 / 全屏面板）全部塌成一层。backdrop-filter 三档互不相同是底线。
 * 2. **不透明回落必须存在**：没有 backdrop-filter 的内核里，半透明背景会让白底黑字
 *    变成灰底灰字。`@supports` 与 `prefers-reduced-transparency` 两条分支缺一条，
 *    就有一类用户拿到不可读的面板。
 * 3. **颜色参数不可信**：tint 来自主题/封面，可能是空串或非法值，甚至带 `;` `}`。
 *    材质层不能因此抛错（整整一屏渲染失败），也不能把注入内容拼进 CSS。
 * 4. **CSS 与 TS 同源**：两处各写一套参数一定会漂（这个仓库在"前后端词表各存一份"上栽过）。
 *    判据直接比 glass.ts 算出的 blur/tint 百分比与 glass.css 里的变量值。
 *
 * CSS 一律先 `
 → 
` 再匹配：仓库 eol=lf，但 Windows 检出/别的工具可能写成 CRLF，
 * 判据不该因为换行符变红。
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(WEB_ROOT, 'src/ui/material/glass.css'), 'utf8').replace(/\r\n?/g, '\n')

const LEVELS = ['thin', 'regular', 'thick'] as const

/** 从 CSS 的 `.lg-glass--<level> { … }` 块里取出自定义属性。 */
function cssLevelVars(level: (typeof LEVELS)[number]): Record<string, string> {
  const block = new RegExp('\\.lg-glass--' + level + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? ''
  const vars: Record<string, string> = {}
  for (const match of block.matchAll(/(--lg-[\w-]+)\s*:\s*([^;]+);/g)) vars[match[1]] = match[2].trim()
  return vars
}

const blurRadii = (value: string): number[] => [...value.matchAll(/blur\(([\d.]+)px\)/g)].map((m) => Number(m[1]))

test('glassStyle 返回五段非空样式，缺省档位是 regular', () => {
  const style = glassStyle({})
  for (const key of ['background', 'backdropFilter', 'border', 'boxShadow', 'sheen'] as const) {
    assert.equal(typeof style[key], 'string', `${key} 必须是字符串`)
    assert.ok(style[key].trim().length > 0, `${key} 不能是空串`)
  }
  assert.deepEqual(glassStyle({ level: 'regular' }), style, '不传 level 与传 regular 必须是同一套材质')
  assert.deepEqual(glassStyle({ level: 'nope' as never }), style, '非法 level 应回落 regular，而不是抛错或产出空样式')
})

test('三档的 backdropFilter 互不相同，且都含 blur()、模糊半径随厚度递增', () => {
  const filters = LEVELS.map((level) => glassStyle({ level }).backdropFilter)
  assert.equal(new Set(filters).size, 3, '三档的 backdrop-filter 必须各不相同，否则层级感不存在')
  const radii = filters.map((filter) => {
    assert.match(filter, /blur\(/, `${filter} 里没有 blur()：不算玻璃`)
    return Math.max(...blurRadii(filter))
  })
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2], `模糊半径应随 thin→thick 递增，实际 ${radii.join(' / ')}`)
})

test('越厚越不透明：白色填充 alpha 与 tint 比例都随档位递增', () => {
  const sheenAlpha = LEVELS.map((level) => {
    const match = /rgba\(255, 255, 255, ([\d.]+)\)/.exec(glassStyle({ level }).background)
    assert.ok(match, `${level} 的 background 里找不到白色高光填充`)
    return Number(match[1])
  })
  const tintPct = LEVELS.map((level) => {
    const match = /#247a58\)\s+([\d.]+)%/.exec(glassStyle({ level }).background)
    assert.ok(match, `${level} 的 background 里找不到 tint 混合比例`)
    return Number(match[1])
  })
  assert.ok(sheenAlpha[0] < sheenAlpha[1] && sheenAlpha[1] < sheenAlpha[2], `白色填充应递增：${sheenAlpha.join(' / ')}`)
  assert.ok(tintPct[0] < tintPct[1] && tintPct[1] < tintPct[2], `tint 比例应递增：${tintPct.join(' / ')}`)
})

test('非法 tint 不抛错、不带注入内容，一律回落安全色', () => {
  const bad = ['not-a-color', '', '   ', 'red; } body { display: none }', 'url(javascript:alert(1))', 'var(--x', '#12']
  for (const tint of bad) {
    let style: ReturnType<typeof glassStyle>
    assert.doesNotThrow(() => {
      style = glassStyle({ tint })
    }, `tint="${tint}" 不该让材质层抛错：一屏渲染失败比配色难看严重得多`)
    const joined = Object.values(style!).join(' ')
    assert.ok(!joined.includes('display: none') && !joined.includes('javascript:'), `tint="${tint}" 的内容被拼进了样式（CSS 注入）`)
    assert.ok(/#[0-9a-f]{6}/i.test(joined), `tint="${tint}" 没有回落到任何具体颜色`)
  }
  // 合法值必须真的生效，别把"回落"做成"永远忽略参数"。
  assert.ok(glassStyle({ tint: '#ff0000' }).background.includes('#ff0000'), '合法 hex tint 必须进入 background')
  assert.ok(glassStyle({ tint: 'rgba(10, 20, 30, 0.4)' }).border.includes('rgba(10, 20, 30, 0.4)'), '合法 rgba() tint 必须生效')
})

test('tint 缺省走 var(--accent) 且一定带回落', () => {
  const style = glassStyle({})
  assert.ok(style.background.includes('var(--accent, #247a58)'), '缺省 tint 应跟随 --accent，并带 #247a58 回落')
  assert.ok(style.border.includes('var(--accent, #247a58)'), '描边也要跟随 --accent 并带回落')

  const bare = glassStyle({ tint: 'var(--accent)' })
  assert.ok(bare.background.includes('var(--accent, #247a58)'), '调用方传裸 var(--accent) 时，材质层要补上回落')
})

test('深色与浅色不是同一套材质（深色投影更重）', () => {
  const light = glassStyle({ scheme: 'light' })
  const dark = glassStyle({ scheme: 'dark' })
  assert.notEqual(light.background, dark.background, '明暗两套底色必须不同')
  assert.notEqual(light.boxShadow, dark.boxShadow, '明暗两套投影必须不同')

  const alphaOf = (shadow: string): number => Number(/rgba\(0, 0, 0, ([\d.]+)\)/.exec(shadow)?.[1] ?? '0')
  assert.ok(alphaOf(dark.boxShadow) > alphaOf(light.boxShadow), '深色背景上投影必须更重，否则浮层"贴"在背景里')
})

test('glassClassName 与三档一一对应，非法 level 回落 regular', () => {
  assert.equal(glassClassName(), 'lg-glass lg-glass--regular')
  for (const level of LEVELS) {
    assert.equal(glassClassName({ level }), `lg-glass lg-glass--${level}`)
  }
  assert.equal(glassClassName({ level: 'nope' as never }), 'lg-glass lg-glass--regular')
})

test('glass.css：三档选择器、.lg-glass 底座与 .lg-sheen 都在', () => {
  assert.match(css, /^\.lg-glass\s*\{/m, '缺少 .lg-glass 底座规则')
  for (const level of LEVELS) {
    assert.match(css, new RegExp('\\.lg-glass--' + level + '\\s*\\{'), `缺少 .lg-glass--${level} 选择器`)
  }
  assert.match(css, /^\.lg-sheen\s*\{/m, '缺少 .lg-sheen 顶缘高光层')
})

test('glass.css：无 backdrop-filter 时有 @supports 不透明回落', () => {
  assert.match(
    css,
    /@supports\s+not\s*\(\s*\(\s*backdrop-filter:\s*blur\(1px\)\s*\)\s*or\s*\(\s*-webkit-backdrop-filter:\s*blur\(1px\)\s*\)\s*\)/,
    '缺少 @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) 分支',
  )
  const supportsBlock = css.slice(css.indexOf('@supports not'))
  assert.match(supportsBlock, /backdrop-filter:\s*none/, '回落分支必须关掉 backdrop-filter')
  assert.match(supportsBlock, /background:\s*color-mix|background:\s*var\(--lg-fallback-surface/, '回落分支必须给不透明底色')
  assert.match(supportsBlock, /\.lg-sheen\s*\{\s*display:\s*none/, '不支持模糊时高光层应关掉，避免发灰')
})

test('glass.css：prefers-reduced-transparency 直接降级为不透明面', () => {
  assert.match(css, /@media\s*\(prefers-reduced-transparency:\s*reduce\)/, '缺少 prefers-reduced-transparency 分支')
  const mediaBlock = css.slice(css.indexOf('@media (prefers-reduced-transparency'))
  assert.match(mediaBlock, /backdrop-filter:\s*none/, '减少透明偏好下必须去掉模糊')
  assert.match(mediaBlock, /background:/, '减少透明偏好下必须给不透明底色')
  assert.match(mediaBlock, /\.lg-sheen\s*\{\s*display:\s*none/, '减少透明偏好下高光层应关掉')
})

test('glass.css：每个 var() 都带回落（裸 var(--x) 会让整条声明作废）', () => {
  const bare = [...css.matchAll(/var\(\s*--[\w-]+\s*\)/g)].map((m) => m[0])
  assert.deepEqual(bare, [], `这些 var() 没有回落：${bare.join('、')}`)
  // 反向对照：正则必须真能认出裸 var，否则这条判据永远绿。
  assert.equal([...'color: var(--accent)'.matchAll(/var\(\s*--[\w-]+\s*\)/g)].length, 1)
})

test('glass.css 的参数与 glass.ts 同源（防两套数值漂移）', () => {
  for (const level of LEVELS) {
    const style = glassStyle({ level })
    const vars = cssLevelVars(level)
    const blur = blurRadii(style.backdropFilter)
    assert.equal(vars['--lg-blur'], `${blur[blur.length - 1]}px`, `${level}: CSS --lg-blur 与 glass.ts 主模糊半径不一致`)
    assert.equal(vars['--lg-blur-soft'], `${blur[0]}px`, `${level}: CSS --lg-blur-soft 与 glass.ts 柔化半径不一致`)
    const saturate = Number(/saturate\(([\d.]+)%\)/.exec(style.backdropFilter)?.[1])
    assert.equal(vars['--lg-saturate'], `${saturate}%`, `${level}: CSS --lg-saturate 与 glass.ts 饱和度不一致`)
    const tintPct = Number(/#247a58\)\s+([\d.]+)%/.exec(style.background)?.[1])
    assert.equal(vars['--lg-tint-alpha'], `${tintPct}%`, `${level}: CSS --lg-tint-alpha 与 glass.ts 混合比例不一致`)
  }
})
