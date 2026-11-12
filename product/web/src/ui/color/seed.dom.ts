/**
 * 封面 URL → 种子色。**ui/ 下唯一允许碰 DOM 的文件**（其余颜色逻辑必须能在 node:test 里裸跑）。
 *
 * 三条产品约束：
 * 1. **缩到 64px 再取色**：封面动辄 1200px，原图跑 Celebi 会在主线程卡住几百毫秒；
 *    缩到 maxEdge 后色彩分布几乎不变，却能稳定在几毫秒量级。
 * 2. **永不 reject**：封面 404 / 跨域无 CORS / 解码失败 / 超时，一律安静回落到 fallback。
 *    书架的渲染不该因为一张封面取不到色而出现未捕获异常。
 * 3. **按 URL 缓存**：同一本书反复打开、列表重渲染都会重复请求这个 URL；
 *    缓存 Promise（不是结果）还能把并发请求合并成一次加载。
 */
import { DEFAULT_SEED_FALLBACK, seedFromPixels } from './seed'
import type { Pixels } from './seed'

export interface SeedFromImageUrlOptions {
  /** 加载+解码超时，默认 5000ms；超时回落到 fallback。 */
  timeoutMs?: number
  /** 取色前缩放的最长边，默认 64。 */
  maxEdge?: number
  /** 取不到色时的回落色，默认品牌绿。 */
  fallback?: string
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_EDGE = 64
/** 缓存条数上限：书架滚动几屏足够覆盖，又不至于把整库封面 Promise 攒在内存里。 */
const MAX_CACHE_ENTRIES = 100

const cache = new Map<string, Promise<string>>()

function resolveFallback(fallback: string | undefined): string {
  if (fallback === undefined) return DEFAULT_SEED_FALLBACK
  return /^#[0-9a-f]{6}$/i.test(fallback) ? fallback.toLowerCase() : DEFAULT_SEED_FALLBACK
}

function normalizeMaxEdge(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_EDGE
  return Math.floor(value)
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return value
}

/** canvas 2d 缩图 + getImageData。只在这个文件里调用，node 环境下不会被走到。 */
function pixelsFromImage(image: HTMLImageElement, maxEdge: number): Pixels {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (!sourceWidth || !sourceHeight) throw new Error('封面尺寸为 0')
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('拿不到 canvas 2d context')
  context.drawImage(image, 0, 0, width, height)
  return { width, height, data: context.getImageData(0, 0, width, height).data }
}

function loadSeed(url: string, fallback: string, maxEdge: number, timeoutMs: number): Promise<string> {
  // node/SSR：没有 Image/document 时直接回落，判据可以放心 import 本文件。
  if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(fallback)
  return new Promise<string>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    const image = new Image()
    // 封面多半在别的域：不带 CORS 时 canvas 会被污染，getImageData 直接抛 SecurityError。
    image.crossOrigin = 'anonymous'
    image.onload = (): void => {
      try {
        finish(seedFromPixels(pixelsFromImage(image, maxEdge), { fallback }))
      } catch {
        finish(fallback)
      }
    }
    image.onerror = (): void => finish(fallback)
    timer = setTimeout(() => {
      // 超时后断开 src，让浏览器停掉还在飞的请求（否则慢封面会继续占连接）。
      image.src = ''
      finish(fallback)
    }, timeoutMs)
    image.src = url
  })
}

/**
 * 封面取种子色。同一 URL 并发/重复调用共享同一个 Promise；任何失败都 resolve fallback，**永不 reject**。
 * 空 URL 也走 fallback（书架里没封面的书很多，不该让它变成异常）。
 */
export function seedFromImageUrl(url: string, options: SeedFromImageUrlOptions = {}): Promise<string> {
  const fallback = resolveFallback(options.fallback)
  if (typeof url !== 'string' || url.trim() === '') return Promise.resolve(fallback)
  const cached = cache.get(url)
  if (cached) return cached
  const promise = loadSeed(url, fallback, normalizeMaxEdge(options.maxEdge), normalizeTimeout(options.timeoutMs))
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(url, promise)
  return promise
}

/** 清空 URL 缓存（判据/切库时用）。 */
export function clearSeedCache(): void {
  cache.clear()
}
