/**
 * 封面取色（纯函数，不碰 DOM）。
 *
 * 为什么需要它：动态主题的入口是"这本书的封面"，但封面图里有文字、留白、纯色占位图。
 * 直接把平均色当种子，全白封面会得到灰色主题、深色封面会得到黑主题 —— 那不是"呼应封面"，
 * 是"配色坏了"。所以流程是：像素 → 量化 → 按 M3 Score 的规则过滤/打分 → 第一个合适色。
 *
 * 与 Material 库的分工：
 * - 量化用库的 QuantizerCelebi（0.4.0 的 quantize 是**同步**的，返回 Map<ARGB, 像素数>）；
 * - 打分照 Score.score 的规则（色度/色相分散度/占比）自己实现一份，因为库只回颜色、
 *   不回"这个颜色占多少像素" —— 而 scoreSeeds 的契约要求带 population。
 * - 额外过滤接近纯黑/纯白（tone < 8 或 > 92）：Score 只滤色度 < 5，近白灰仍可能漏进来。
 * - 另带一条**完全不依赖库**的纯 JS 降级路径（HSL 饱和度过滤 + 4bit/通道分桶），
 *   库升级/环境异常时兜底，也让判据可以只测纯逻辑。
 */
import { Hct, QuantizerCelebi, hexFromArgb } from '@material/material-color-utilities'

export interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface ScoredSeed {
  hex: string
  /** 占全图非透明像素的百分比（0..100，两位小数）。一半红一半蓝 ≈ 50 / 50。 */
  population: number
}

/** 封面不可用（全白/全黑/极低饱和）时的默认种子：品牌绿，和内置浅色皮肤的 accent 同源。 */
export const DEFAULT_SEED_FALLBACK = '#247a58'

const MAX_QUANTIZE_COLORS = 128
const DEFAULT_MAX_COLORS = 4

// 与 Material Score 的常量保持一致，便于对照库的行为。
const TARGET_CHROMA = 48
const WEIGHT_PROPORTION = 0.7
const WEIGHT_CHROMA_ABOVE = 0.3
const WEIGHT_CHROMA_BELOW = 0.1
const CUTOFF_CHROMA = 5
const CUTOFF_EXCITED_PROPORTION = 0.01

// 纯黑/纯白单独再挡一道：封面大面积留白与黑边都很常见。
const MIN_TONE = 8
const MAX_TONE = 92

// 纯 JS 降级路径的阈值（HSL 近似，足够挡住灰阶与极亮/极暗）。
const FALLBACK_MIN_SATURATION = 0.12
const FALLBACK_MIN_LIGHTNESS = 0.06
const FALLBACK_MAX_LIGHTNESS = 0.94

interface QuantizedColor {
  argb: number
  population: number
  hct: Hct
  score: number
}

function assertPixels(pixels: Pixels): void {
  if (!pixels || typeof pixels !== 'object') throw new TypeError('Pixels: 必须是 { width, height, data }')
  const { width, height, data } = pixels
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError(`Pixels: width/height 必须是正整数，收到 ${width}x${height}`)
  }
  if (!data || typeof data.length !== 'number') throw new TypeError('Pixels: data 必须是 Uint8ClampedArray')
  if (data.length < width * height * 4) {
    throw new RangeError(`Pixels: data 长度 ${data.length} 不足 ${width}x${height}x4`)
  }
}

function resolveFallback(fallback: string | undefined): string {
  if (fallback === undefined) return DEFAULT_SEED_FALLBACK
  if (!/^#[0-9a-f]{6}$/i.test(fallback)) {
    throw new TypeError(`seedFromPixels: fallback 必须是 #rrggbb，收到 ${JSON.stringify(fallback)}`)
  }
  return fallback.toLowerCase()
}

function clampMaxColors(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_COLORS
  return Math.min(16, Math.max(1, Math.floor(value)))
}

function sanitizeDegreesInt(degrees: number): number {
  const value = degrees % 360
  return value < 0 ? value + 360 : value
}

function differenceDegrees(a: number, b: number): number {
  return 180 - Math.abs(Math.abs(a - b) - 180)
}

function roundPopulation(population: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((population / total) * 10000) / 100
}

/** RGBA 字节 → ARGB 整数。alpha < 128 视为透明跳过（PNG 封面大量透明区不参与统计）。 */
function collectArgb(pixels: Pixels): number[] {
  const count = pixels.width * pixels.height
  const data = pixels.data
  const colors: number[] = []
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4
    const alpha = data[offset + 3]
    if (alpha < 128) continue
    colors.push(((alpha << 24) | (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]) >>> 0)
  }
  return colors
}

/**
 * 按 Material Score 的规则给「颜色 → 像素数」打分并挑出最多 maxColors 个色相分散的颜色。
 * 与库的差异只有两点，都是为了可测性：① 额外过滤近黑/近白；② 同分时按人口、色值稳定排序。
 */
function rankQuantized(map: Map<number, number>, maxColors: number): ScoredSeed[] {
  const entries = [...map.entries()]
  if (entries.length === 0) return []

  const hctByArgb = new Map<number, Hct>()
  const huePopulation = new Array<number>(360).fill(0)
  let populationSum = 0
  for (const [argb, population] of entries) {
    const hct = Hct.fromInt(argb)
    hctByArgb.set(argb, hct)
    huePopulation[sanitizeDegreesInt(Math.floor(hct.hue))] += population
    populationSum += population
  }
  if (populationSum <= 0) return []

  // 邻近 30° 的色相也计入"兴奋度"，避免同一片颜色被拆成几簇后每簇占比都很低。
  const hueExcitedProportions = new Array<number>(360).fill(0)
  for (let hue = 0; hue < 360; hue += 1) {
    const proportion = huePopulation[hue] / populationSum
    for (let i = hue - 14; i < hue + 16; i += 1) {
      hueExcitedProportions[sanitizeDegreesInt(i)] += proportion
    }
  }

  const scored: QuantizedColor[] = []
  for (const [argb, population] of entries) {
    const hct = hctByArgb.get(argb) as Hct
    if (hct.tone < MIN_TONE || hct.tone > MAX_TONE) continue
    const hue = sanitizeDegreesInt(Math.round(hct.hue))
    const proportion = hueExcitedProportions[hue]
    if (hct.chroma < CUTOFF_CHROMA || proportion <= CUTOFF_EXCITED_PROPORTION) continue
    const proportionScore = proportion * 100 * WEIGHT_PROPORTION
    const chromaWeight = hct.chroma < TARGET_CHROMA ? WEIGHT_CHROMA_BELOW : WEIGHT_CHROMA_ABOVE
    const chromaScore = (hct.chroma - TARGET_CHROMA) * chromaWeight
    scored.push({ argb, population, hct, score: proportionScore + chromaScore })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.population !== a.population) return b.population - a.population
    return a.argb - b.argb
  })

  // 色相分散：从 90° 开始往下试，优先挑"彼此不像"的颜色。
  let chosen: QuantizedColor[] = []
  for (let difference = 90; difference >= 15; difference -= 1) {
    chosen = []
    for (const candidate of scored) {
      const duplicate = chosen.some((color) => differenceDegrees(candidate.hct.hue, color.hct.hue) < difference)
      if (!duplicate) chosen.push(candidate)
      if (chosen.length >= maxColors) break
    }
    if (chosen.length >= maxColors) break
  }

  return chosen.map((color) => ({
    hex: hexFromArgb(color.argb).toLowerCase(),
    population: roundPopulation(color.population, populationSum),
  }))
}

/**
 * 量化 + 打分。返回按"适合当主题色"从高到低排列的颜色。
 * 全白/全黑/纯灰图返回空数组（而不是库自带的 Google Blue 兜底）—— 由调用方决定 fallback。
 */
export function scoreSeeds(pixels: Pixels, options: { maxColors?: number } = {}): ScoredSeed[] {
  assertPixels(pixels)
  const maxColors = clampMaxColors(options.maxColors)
  const argb = collectArgb(pixels)
  if (argb.length === 0) return []
  let quantized: Map<number, number>
  try {
    quantized = QuantizerCelebi.quantize(argb, MAX_QUANTIZE_COLORS)
  } catch {
    // 库在极端输入下抛错（空数组/异常像素数）：退回纯 JS 路径，别让封面取色把界面拖挂。
    return scoreSeedsFallback(pixels, { maxColors })
  }
  return rankQuantized(quantized, maxColors)
}

/**
 * 像素 → 种子色。找不到合适颜色时返回 fallback（默认品牌绿）。
 * 这是 theme 层唯一应该直接调用的入口。
 */
export function seedFromPixels(pixels: Pixels, options: { fallback?: string } = {}): string {
  const fallback = resolveFallback(options.fallback)
  const scored = scoreSeeds(pixels)
  if (scored.length > 0) return scored[0].hex
  return seedFromPixelsFallback(pixels, { fallback })
}

interface Bucket {
  key: number
  count: number
  r: number
  g: number
  b: number
}

function hslSaturation(r: number, g: number, b: number): { saturation: number; lightness: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  const delta = max - min
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return { saturation, lightness }
}

/**
 * 纯 JS 降级路径：4bit/通道分桶 + HSL 过滤，**不依赖 Material 库**。
 * 与库路径的差别：没有色相分散度打分，只按人口排序（同人口按桶号升序，保证确定性）。
 * 它的存在价值：库是 ESM + 深度 import 的第三方代码，万一升级后行为变了，
 * 主题至少还能出一个"能看的颜色"，判据也能单独核这条路径。
 */
export function scoreSeedsFallback(pixels: Pixels, options: { maxColors?: number } = {}): ScoredSeed[] {
  assertPixels(pixels)
  const maxColors = clampMaxColors(options.maxColors)
  const count = pixels.width * pixels.height
  const data = pixels.data
  const buckets = new Map<number, Bucket>()
  let opaque = 0
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4
    if (data[offset + 3] < 128) continue
    opaque += 1
    const r = data[offset]
    const g = data[offset + 1]
    const b = data[offset + 2]
    const { saturation, lightness } = hslSaturation(r, g, b)
    if (saturation < FALLBACK_MIN_SATURATION) continue
    if (lightness < FALLBACK_MIN_LIGHTNESS || lightness > FALLBACK_MAX_LIGHTNESS) continue
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
    } else {
      buckets.set(key, { key, count: 1, r, g, b })
    }
  }
  if (opaque === 0) return []
  const ranked = [...buckets.values()].sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key - b.key))
  return ranked.slice(0, maxColors).map((bucket) => {
    const average = (sum: number): string => Math.round(sum / bucket.count).toString(16).padStart(2, '0')
    return {
      hex: `#${average(bucket.r)}${average(bucket.g)}${average(bucket.b)}`,
      population: roundPopulation(bucket.count, opaque),
    }
  })
}

/** 纯 JS 路径的种子入口：与 seedFromPixels 同语义，但完全不 import 库的算法。 */
export function seedFromPixelsFallback(pixels: Pixels, options: { fallback?: string } = {}): string {
  const fallback = resolveFallback(options.fallback)
  const scored = scoreSeedsFallback(pixels)
  return scored.length > 0 ? scored[0].hex : fallback
}
