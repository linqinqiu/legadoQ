/**
 * 弹簧动效的参数化：「软、弹、跟手」。
 *
 * 为什么不是 cubic-bezier：bezier 只能描述单段单调曲线，**表达不了回弹**。
 * 想用 bezier 装出弹跳，只能把关键帧拆成多条 @keyframes —— 每条都要手调，
 * 改一个刚度就得重调全部，而且 forJS（Element.animate）与 CSS 过渡用的是两套曲线。
 * 这里换成**欠阻尼解析解**：一个 (stiffness, damping, mass) 三元组决定整条运动，
 * 导出成 CSS `linear()` 逐点采样（Chrome 113+/Safari 17.2+），
 * 同一个函数同时喂 CSS 与 JS 采样，视觉上不会再出现「CSS 一套、JS 另一套」。
 *
 * 本文件是**纯函数**：不碰 document / window / performance，判据能在裸 node 里跑。
 * 真正的动画由调用方（apply.ts 写 CSS 变量、组件用 element.animate）落地。
 *
 * 单位约定：对外时间一律 ms（与 `Web Animations API` 的 duration 一致），
 * 内部解析解用秒（ω₀ 的量纲是 1/s），只在采样入口处换算，避免两套单位混着用。
 */

export interface SpringSpec {
  /** 刚度 k（N/m 量纲）。越大越快。 */
  stiffness: number
  /** 阻尼 c。越大越不弹。 */
  damping: number
  /** 质量 m。默认 1，调大等于整体变慢变沉。 */
  mass: number
}

/**
 * 五档预设。名字是**语义档位**，不是具体数值：想换手感只改这张表，
 * 所有调用点（按钮、面板、拖拽归位、翻页）自动跟着变。
 *
 * | 档位 | 手感 | 用在哪 |
 * |---|---|---|
 * | responsive | 快、几乎不弹（临界阻尼，严格单调无过冲） | 按钮按下/抬起、开关 |
 * | gentle | 柔，收尾有一点呼吸感 | 面板/弹层进出 |
 * | snappy | 跟手，回正干脆 | 拖拽松手归位 |
 * | bouncy | 明显回弹（ζ≈0.52，峰值过冲约 15%） | 强调、点赞、加入书架 |
 * | pageTurn | 落点稳，像纸页压下去（ζ≈0.98） | 翻页落点 |
 *
 * 数值关系（settleEpsilon=0.005 时）：responsive 285ms < snappy 430ms
 * < gentle 662ms < pageTurn 705ms < bouncy 923ms。**bouncy 比 responsive 久不是巧合**：
 * 回弹要能量，低阻尼下"进到 1 附近"的时间由 ζω₀ 决定，ζ 越小衰减越慢。
 */
export const SPRINGS = {
  responsive: { stiffness: 1600, damping: 80, mass: 1 },
  gentle: { stiffness: 260, damping: 26, mass: 1 },
  snappy: { stiffness: 560, damping: 44, mass: 1 },
  bouncy: { stiffness: 300, damping: 18, mass: 1 },
  pageTurn: { stiffness: 190, damping: 27, mass: 1 },
} as const satisfies Record<string, SpringSpec>

export type SpringName = keyof typeof SPRINGS

/** 默认判稳阈值：|1-x| 与 |v| 都要小于它才算「停住」。0.5% 在 300px 位移上约 1.5px，肉眼不可见。 */
const DEFAULT_EPSILON = 0.005

/** 时长下限/上限：低于 80ms 看不出动画，高于 1200ms 会让人等。 */
const MIN_DURATION_MS = 80
const MAX_DURATION_MS = 1200

/** ζ 与 1 差多少以内按临界阻尼处理（此时 ω_d≈0，欠阻尼公式会 0/0）。 */
const CRITICAL_BAND = 1e-6

interface Dynamics {
  /** 无阻尼固有频率 ω₀ = √(k/m)，单位 1/s。 */
  omega0: number
  /** 阻尼比 ζ = c / (2√(km))。<1 欠阻尼（会回弹），=1 临界，>1 过阻尼。 */
  zeta: number
}

function assertSpec(spec: SpringSpec): void {
  const raw = spec as Partial<Record<keyof SpringSpec, unknown>> | null | undefined
  for (const key of ['stiffness', 'damping', 'mass'] as const) {
    const value = raw?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      // 静默回落会得到 NaN 位移（整段动画直接跳到终点），比抛错难查得多。
      throw new RangeError(`spring: ${key} 必须是有限正数，收到 ${String(value)}`)
    }
  }
}

function dynamics(spec: SpringSpec): Dynamics {
  assertSpec(spec)
  return {
    omega0: Math.sqrt(spec.stiffness / spec.mass),
    zeta: spec.damping / (2 * Math.sqrt(spec.stiffness * spec.mass)),
  }
}

/**
 * 归一化位移 x(t)：0 = 起点，1 = 落点，**允许 >1（回弹过冲）与 <0（对冲）**。
 *
 * 三种阻尼区间的解析解（初值 x(0)=0、v(0)=0，即静止起步）：
 * - 欠阻尼 ζ<1：x = 1 − e^{−ζω₀t}(cos(ω_d t) + (ζω₀/ω_d)·sin(ω_d t))，ω_d = ω₀√(1−ζ²)
 * - 临界 ζ=1：x = 1 − (1 + ω₀t)·e^{−ω₀t}
 * - 过阻尼 ζ>1：x = 1 + (r₂e^{r₁t} − r₁e^{r₂t})/(r₁ − r₂)，r₁,₂ = −ζω₀ ± ω₀√(ζ²−1)
 *
 * t=0 时三式都精确等于 0（不是"约等于"）：欠阻尼里 cos0=1、sin0=0；另外两式同理。
 * 判据直接断言 ===0，任何数值近似（比如从 0.001 起步）都会当场红。
 */
export function springSample(spec: SpringSpec, elapsedMs: number): number {
  const { omega0, zeta } = dynamics(spec)
  if (!(elapsedMs > 0)) return 0 // 负时间/NaN 都当起点，避免 e^{+…} 炸成 Infinity

  const t = elapsedMs / 1000

  if (Math.abs(zeta - 1) <= CRITICAL_BAND) {
    const w = omega0 * t
    return 1 - (1 + w) * Math.exp(-w)
  }

  if (zeta < 1) {
    const wd = omega0 * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-zeta * omega0 * t)
    return 1 - decay * (Math.cos(wd * t) + ((zeta * omega0) / wd) * Math.sin(wd * t))
  }

  const root = omega0 * Math.sqrt(zeta * zeta - 1)
  const r1 = -zeta * omega0 + root // 更靠近 0，衰减更慢，决定收尾
  const r2 = -zeta * omega0 - root
  return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2)
}

/** x'(t)，单位 1/s。只给判稳用，不导出：调用方要的是位移，不是速度。 */
function springVelocity(spec: SpringSpec, elapsedMs: number): number {
  const { omega0, zeta } = dynamics(spec)
  if (!(elapsedMs > 0)) return 0
  const t = elapsedMs / 1000

  if (Math.abs(zeta - 1) <= CRITICAL_BAND) {
    return omega0 * omega0 * t * Math.exp(-omega0 * t)
  }
  if (zeta < 1) {
    const wd = omega0 * Math.sqrt(1 - zeta * zeta)
    return Math.exp(-zeta * omega0 * t) * ((omega0 * omega0) / wd) * Math.sin(wd * t)
  }
  const root = omega0 * Math.sqrt(zeta * zeta - 1)
  const r1 = -zeta * omega0 + root
  const r2 = -zeta * omega0 - root
  return (r1 * r2 * (Math.exp(r1 * t) - Math.exp(r2 * t))) / (r1 - r2)
}

/**
 * 临界阻尼没有初等闭式（要 Lambert W），但两个残差都在 t ≥ 1/ω₀ 后单调递减，
 * 所以对 max(|1−x|, |v|) 做二分：60 次迭代 ≈ 1e-15 相对精度，确定性、无魔法数。
 */
function criticalSettleSeconds(omega0: number, epsilon: number): number {
  const residual = (t: number): number => {
    const decay = Math.exp(-omega0 * t)
    return Math.max((1 + omega0 * t) * decay, omega0 * omega0 * t * decay)
  }
  let lo = 1 / omega0 // 此处残差 2/e ≈ 0.736，一定大于任何合理 epsilon
  let hi = lo
  while (residual(hi) > epsilon && hi < 1e6) hi *= 2
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (residual(mid) > epsilon) lo = mid
    else hi = mid
  }
  return hi
}

/**
 * 从静止到达「停住」的时间（ms），夹在 [80, 1200]。
 *
 * "停住"的判据：|1−x| < ε 且 |v| < ε。用**包络**解闭式，不靠逐帧试：
 * - 欠阻尼：|1−x| ≤ e^{−ζω₀t}/√(1−ζ²)，|v| ≤ e^{−ζω₀t}·ω₀/√(1−ζ²)
 *   ⇒ t ≥ max(ln(1/(ε√(1−ζ²))), ln(ω₀/(ε√(1−ζ²)))) / (ζω₀)
 * - 过阻尼：x、v 都是两个指数项的线性组合，取慢根 r₁ 作包络：
 *   |1−x| ≤ (|r₁|+|r₂|)/(r₁−r₂)·e^{r₁t}，|v| ≤ 2|r₁r₂|/(r₁−r₂)·e^{r₁t}
 *
 * 包络是**充分条件**（比真实第一次进带略保守），换来的是无迭代、无平台差异。
 * 这也是 bouncy > responsive 的原因：包络的衰减率就是 ζω₀。
 */
export function springDurationMs(spec: SpringSpec, settleEpsilon = DEFAULT_EPSILON): number {
  const { omega0, zeta } = dynamics(spec)
  const epsilon = Number.isFinite(settleEpsilon) && settleEpsilon > 0 ? settleEpsilon : DEFAULT_EPSILON

  let seconds: number

  if (Math.abs(zeta - 1) <= CRITICAL_BAND) {
    seconds = criticalSettleSeconds(omega0, epsilon)
  } else if (zeta < 1) {
    const spread = Math.sqrt(1 - zeta * zeta)
    const decayRate = zeta * omega0
    const xBound = Math.log(1 / (epsilon * spread)) / decayRate
    const vBound = Math.log(omega0 / (epsilon * spread)) / decayRate
    seconds = Math.max(xBound, vBound)
  } else {
    const root = omega0 * Math.sqrt(zeta * zeta - 1)
    const r1 = -zeta * omega0 + root
    const r2 = -zeta * omega0 - root
    const gap = r1 - r2
    const slowRoot = Math.abs(r1)
    const xAmp = (Math.abs(r1) + Math.abs(r2)) / gap
    const vAmp = (2 * Math.abs(r1 * r2)) / gap
    seconds = Math.max(Math.log(xAmp / epsilon) / slowRoot, Math.log(vAmp / epsilon) / slowRoot)
  }

  // 夹紧：极硬/极软的 spec 可能算出 20ms 或 4s，直接照搬会让 UI 显得卡死或闪一下。
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, seconds * 1000))
}

/** 4 位小数、去尾零：`1.0000→'1'`、`0.5000→'0.5'`、`-0.0000→'0'`。CSS 数里不能出现 `-0`。 */
function fixed(value: number): string {
  let text = value.toFixed(4)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

/**
 * 生成 CSS `linear()` 缓动串，形如 `linear(0, 0.21, …, 1)`。
 *
 * 为什么是 `linear()` 而不是 cubic-bezier：见文件头 —— bezier 表达不了回弹。
 * 采样**在时间轴上均匀**（CSS 就是在时间上线性插值，均不均匀由采样点决定，不是由手感决定）：
 * 第 i 个点取 t = duration·i/(samples−1)。
 *
 * 首尾强制为精确的 0 与 1：末尾解析解是 0.995 之类（判稳阈值内），照搬会让
 * 动画最后一帧停在 99.5% 的位置上，做 opacity/transform 收尾时那一丝偏移是可见的。
 *
 * @param samples 采样点数量（含首尾），默认 24。低于 2 会被抬到 2。
 */
export function springEasing(spec: SpringSpec, samples = 24): string {
  const count = Number.isFinite(samples) ? Math.max(2, Math.floor(samples)) : 24
  const duration = springDurationMs(spec)
  const values: string[] = []
  for (let i = 0; i < count; i += 1) {
    if (i === 0) values.push('0')
    else if (i === count - 1) values.push('1')
    else values.push(fixed(springSample(spec, (duration * i) / (count - 1))))
  }
  return `linear(${values.join(', ')})`
}

/** CSS 自定义属性按惯例用小写连字符：pageTurn → page-turn。 */
// 键名必须与 styles.css 末尾那份「JS 没跑时的 cubic-bezier 兜底」逐字一致，
// 否则运行期写进去的变量在兜底里没人读 —— 表现是「动画只在 JS 跑完后才生效」。
function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)
}

/**
 * 五档弹簧 → CSS 自定义属性，供 `apply.ts` 写进 `:root{…}`。
 * 只产出曲线本身，时长由调用方按需取 `springDurationMs`（同一条曲线换时长会改变观感，
 * 所以不在这里偷偷打包成一个 `--spring-x-duration`：契约就五个键）。
 * 键名是 **kebab-case**（`--spring-page-turn`），与 styles.css 里的同名兜底变量对齐。
 */
export function springVars(): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const name of Object.keys(SPRINGS) as SpringName[]) {
    vars[`--spring-${kebabCase(name)}`] = springEasing(SPRINGS[name])
  }
  return vars
}
