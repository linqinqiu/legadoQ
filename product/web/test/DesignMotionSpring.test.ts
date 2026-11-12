import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SPRINGS, springDurationMs, springEasing, springSample, springVars } from '../src/ui/motion/spring.ts'

/**
 * 弹簧动效的判据 —— 为什么需要这一份。
 *
 * 动效是最容易「看着差不多就算过」的东西：曲线错了只是"手感有点怪"，
 * 不报错、不崩溃、截图也看不出来。于是它可以静默坏很久，直到有人抱怨"这 app 点着发飘"。
 * 这份判据把「手感」拆成可断言的物理性质：
 *
 * 1. **边界精确**：t=0 必须恰好 0，判稳时长处必须 ≈1。这两条只要有一条错，
 *    就会出现"动画起始跳一帧"或"最后一帧停在 99.5%"——都是真实出现过的 CSS 过渡 bug。
 * 2. **回弹是真的**：bouncy 必须采样出 >1 的过冲。用 cubic-bezier 冒充弹簧的写法过不了这条，
 *    因为它数学上不可能超过 1。
 * 3. **CSS 产物可用**：`linear()` 语法、采样点数、数值范围。浏览器解析失败时
 *    整条 animation 会静默失效（退回无动画），比曲线难看严重得多。
 * 4. **纯函数**：不碰 DOM，才能在没有浏览器的 node:test 里跑；也才能被 SSR/导出复用。
 *
 * 判据不钉具体数值（那会让调手感变成改判据），只钉**关系**与**量纲**：
 * 时长区间、bouncy 比 responsive 久、档位参数全为正数。
 */

const NAMES = ['responsive', 'gentle', 'snappy', 'bouncy', 'pageTurn'] as const

/** 阻尼比 ζ = c / (2√(km))。<1 会回弹，=1 临界（不越过 1）。 */
function zetaOf(spec: { stiffness: number; damping: number; mass: number }): number {
  return spec.damping / (2 * Math.sqrt(spec.stiffness * spec.mass))
}

/** 采样 n 个点（含首尾）。 */
function sampleSeries(name: (typeof NAMES)[number], count = 160): number[] {
  const spec = SPRINGS[name]
  const duration = springDurationMs(spec)
  return Array.from({ length: count }, (_, i) => springSample(spec, (duration * i) / (count - 1)))
}

test('t=0 时位移精确为 0（不是约等于）', () => {
  for (const name of NAMES) {
    assert.equal(springSample(SPRINGS[name], 0), 0, `${name} 在 t=0 必须恰好 0，否则动画起始会跳一帧`)
    // 负时间/非法时间当起点处理，不能因为 e^{+…} 炸成 Infinity。
    assert.equal(springSample(SPRINGS[name], -16), 0, `${name} 负时间应当钳到起点`)
    assert.equal(springSample(SPRINGS[name], Number.NaN), 0, `${name} NaN 时间应当钳到起点`)
  }
})

test('到达判稳时长时位移落在 1 的 ±2% 内', () => {
  for (const name of NAMES) {
    const spec = SPRINGS[name]
    const duration = springDurationMs(spec)
    const x = springSample(spec, duration)
    assert.ok(
      Math.abs(1 - x) <= 0.02,
      `${name} 在 ${duration.toFixed(1)}ms 处位移是 ${x.toFixed(4)}，偏离 1 超过 2%`,
    )
  }
})

test('responsive 严格单调逼近 1，绝不越过 1（临界阻尼，按钮态要"稳"）', () => {
  const series = sampleSeries('responsive')
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(
      series[i] >= series[i - 1] - 1e-9,
      `responsive 在第 ${i} 个采样点回退了：${series[i - 1]} → ${series[i]}（按钮态回退会看起来"抖"）`,
    )
  }
  assert.ok(series.every((x) => x <= 1 + 1e-9), '临界阻尼数学上不可能超过 1')
  assert.ok(series[series.length - 1] > 0.98, '收尾必须贴近 1')
})

test('bouncy 必须出现 >1 的过冲，并在时长内收敛回 1 附近', () => {
  const series = sampleSeries('bouncy')
  const peak = Math.max(...series)
  assert.ok(peak > 1.02, `bouncy 峰值只有 ${peak.toFixed(4)}，说明它根本没回弹（cubic-bezier 冒充弹簧就是这样）`)
  assert.ok(series.filter((x) => x > 1).length >= 1, '至少一个采样点要越过 1')
  assert.ok(Math.abs(1 - series[series.length - 1]) <= 0.02, '过冲之后必须收敛，不能一直荡')

  // gentle 是「柔」，允许抖一点点但幅度必须远小于 bouncy —— 否则档位就没有区分度。
  const gentlePeak = Math.max(...sampleSeries('gentle'))
  assert.ok(gentlePeak < peak, `gentle 峰值 ${gentlePeak.toFixed(4)} 不该达到 bouncy 的 ${peak.toFixed(4)}`)
})

test('五个预设齐全、顺序稳定，阻尼比覆盖「不弹 / 会弹」两段', () => {
  assert.deepEqual(Object.keys(SPRINGS), [...NAMES], '档位名与顺序是契约，改名会让调用点静默拿到 undefined')
  assert.ok(Math.abs(zetaOf(SPRINGS.responsive) - 1) < 0.01, 'responsive 应贴近临界阻尼（快且不回弹）')
  for (const name of ['gentle', 'snappy', 'bouncy', 'pageTurn'] as const) {
    const zeta = zetaOf(SPRINGS[name])
    assert.ok(zeta > 0 && zeta < 1, `${name} 的阻尼比是 ${zeta.toFixed(3)}，落不进欠阻尼区间就不会回弹`)
  }
  assert.ok(zetaOf(SPRINGS.bouncy) < 0.7, 'bouncy 的阻尼比要明显低于其它档，否则"强调"没有力度')
})

test('所有档位的 stiffness/damping/mass 都是有限正数', () => {
  for (const name of NAMES) {
    const spec = SPRINGS[name]
    for (const key of ['stiffness', 'damping', 'mass'] as const) {
      const value = spec[key]
      assert.ok(Number.isFinite(value) && value > 0, `${name}.${key} 必须是有限正数，实际是 ${value}`)
    }
  }
})

test('springDurationMs 落在 [80, 1200]，且 bouncy 比 responsive 久', () => {
  const durations = {} as Record<string, number>
  for (const name of NAMES) {
    const d = springDurationMs(SPRINGS[name])
    assert.ok(Number.isFinite(d), `${name} 时长不是有限数`)
    assert.ok(d >= 80 && d <= 1200, `${name} 时长 ${d}ms 超出 [80, 1200]：更短会看不清，更长会像卡住`)
    durations[name] = d
  }
  // 回弹要能量：低阻尼下衰减率就是 ζω₀，bouncy 的 ζ 小、ω₀ 也不高，所以收尾更久。
  // 这不是"随手定的关系"，是包络解的必然结果（见 spring.ts 的注释）。
  assert.ok(
    durations.bouncy > durations.responsive,
    `bouncy(${durations.bouncy.toFixed(1)}ms) 应当比 responsive(${durations.responsive.toFixed(1)}ms) 久`,
  )
  assert.equal(new Set(Object.values(durations).map((d) => Math.round(d))).size, NAMES.length, '五档时长不该撞在一起')
})

test('极端参数被夹到 [80, 1200]，不会算出 4 秒或 20 毫秒', () => {
  const tooSoft = springDurationMs({ stiffness: 1, damping: 0.1, mass: 10 })
  const tooHard = springDurationMs({ stiffness: 250_000, damping: 1_000, mass: 1 })
  assert.equal(tooSoft, 1200, '极软弹簧必须夹在上限，否则面板要等好几秒')
  assert.equal(tooHard, 80, '极硬弹簧必须夹在下限，否则等于无动画')
})

test('springEasing 产物是 linear()：首尾精确 0 与 1，采样点数量等于请求值', () => {
  for (const name of NAMES) {
    const easing = springEasing(SPRINGS[name])
    assert.ok(easing.startsWith('linear('), `${name} 必须以 linear( 开头，实际是 ${easing.slice(0, 24)}…`)
    assert.ok(easing.endsWith('1)'), `${name} 末尾必须恰为 1)`)
    const values = easing.slice('linear('.length, -1).split(',').map((part) => part.trim())
    assert.equal(values.length, 24, `${name} 默认应采样 24 个点（含首尾），实际 ${values.length}`)
    assert.equal(values[0], '0', '首个采样点必须精确写 0')
    assert.equal(values[values.length - 1], '1', '末个采样点必须精确写 1')
  }
  const eight = springEasing(SPRINGS.snappy, 8)
  assert.equal(eight.slice('linear('.length, -1).split(',').length, 8, 'samples 参数要真的生效')
  assert.equal(springEasing(SPRINGS.snappy, 1).slice('linear('.length, -1).split(',').length, 2, 'samples < 2 时抬到 2，不能生成非法的 linear(0)')
})

test('springEasing 里每个数值都是合法 CSS 数字且在 [-0.5, 1.5] 内', () => {
  for (const name of NAMES) {
    const body = springEasing(SPRINGS[name]).slice('linear('.length, -1)
    for (const part of body.split(',').map((item) => item.trim())) {
      assert.match(part, /^-?\d+(\.\d{1,4})?$/, `${name} 产出非法数字 "${part}"：CSS 解析失败会让整条动画静默失效`)
      assert.notEqual(part, '-0', 'CSS 里不该出现 -0（不同引擎对它的解析不一致）')
      const value = Number(part)
      assert.ok(value >= -0.5 && value <= 1.5, `${name} 的采样值 ${part} 超出 [-0.5, 1.5]`)
    }
  }
})

test('springVars 恰好产出 5 个 --spring-* 变量', () => {
  const vars = springVars()
  // 键名是 kebab-case：与 styles.css 的兜底变量同名（pageTurn → --spring-page-turn）。
  assert.deepEqual(Object.keys(vars), [
    '--spring-responsive',
    '--spring-gentle',
    '--spring-snappy',
    '--spring-bouncy',
    '--spring-page-turn',
  ])
  assert.equal(Object.keys(vars).length, 5)
  for (const [name, value] of Object.entries(vars)) {
    assert.ok(value.startsWith('linear(') && value.endsWith(')'), `${name} 的值必须是 linear(...) 字符串`)
  }
})

test('settleEpsilon 越小，判稳时长不会更短（阈值单调）', () => {
  const loose = springDurationMs(SPRINGS.bouncy, 0.02)
  const normal = springDurationMs(SPRINGS.bouncy, 0.005)
  const strict = springDurationMs(SPRINGS.bouncy, 0.001)
  assert.ok(loose <= normal && normal <= strict, `阈值收紧却更早判稳：${loose} / ${normal} / ${strict}`)
  assert.equal(springDurationMs(SPRINGS.bouncy, Number.NaN), springDurationMs(SPRINGS.bouncy), '非法阈值回落到默认值')
})

test('spring.ts 是纯函数：不碰 DOM、不 import 任何模块', () => {
  const source = fs
    .readFileSync(path.resolve(import.meta.dirname, '../src/ui/motion/spring.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(source, /\b(document|window|localStorage|performance)\b/, '动效参数化不许依赖浏览器 API，否则 node:test 里跑不了')
  assert.doesNotMatch(source, /^\s*import\s/m, 'spring.ts 不该 import 任何东西（连 ui/ 内部都不需要）')
})
