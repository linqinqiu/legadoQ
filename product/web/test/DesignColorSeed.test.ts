/**
 * 为什么需要这条判据：
 * 封面取色的失败模式不是抛异常，而是"看起来能跑但主题很脏"——
 * 全白封面得到灰主题、纯黑封面得到黑主题、半张图一个颜色时人口统计错位。
 * 这些只能靠像素级判据钉住。这里覆盖：
 * 1. 红蓝各半的图必须量化出两种颜色，population 各 ≈ 50%（人口算错就挑不出主色）；
 * 2. 全白/全黑/纯灰必须被过滤，落到 fallback 而不是 '#ffffff'；
 * 3. 纯 JS 降级路径与库路径在同样的输入上给出一致结论（库升级/异常时还有得救）；
 * 4. seed.dom 在没有 DOM 的环境里必须安静回落，绝不能 reject。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SEED_FALLBACK,
  scoreSeeds,
  scoreSeedsFallback,
  seedFromPixels,
  seedFromPixelsFallback,
} from '../src/ui/color/seed'
import type { Pixels } from '../src/ui/color/seed'
import { clearSeedCache, seedFromImageUrl } from '../src/ui/color/seed.dom'

type RGBA = [number, number, number, number]

function makePixels(width: number, height: number, paint: (x: number, y: number) => RGBA): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const [r, g, b, a] = paint(x, y)
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = a
    }
  }
  return { width, height, data }
}

function fromHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

function solid(hex: string, width = 16, height = 16): Pixels {
  const [r, g, b] = fromHex(hex)
  return makePixels(width, height, () => [r, g, b, 255])
}

/** 左半 left、右半 right；默认 16x16，各 128 像素。 */
function split(left: string, right: string, width = 16, height = 16): Pixels {
  const [lr, lg, lb] = fromHex(left)
  const [rr, rg, rb] = fromHex(right)
  return makePixels(width, height, (x) => (x < width / 2 ? [lr, lg, lb, 255] : [rr, rg, rb, 255]))
}

const near = (actual: number, expected: number, tolerance = 1): boolean => Math.abs(actual - expected) <= tolerance

test('量化打分 - 一半红一半蓝的图返回两种颜色，population 各 ≈ 50%', () => {
  const pixels = split('#ff0000', '#0000ff')
  const seeds = scoreSeeds(pixels)
  assert.equal(seeds.length, 2, `期望 2 种颜色，实际 ${JSON.stringify(seeds)}`)
  assert.deepEqual(seeds.map((seed) => seed.hex).sort(), ['#0000ff', '#ff0000'])
  for (const seed of seeds) assert.ok(near(seed.population, 50), `${seed.hex} 的 population 应接近 50，实际 ${seed.population}`)
  const total = seeds.reduce((sum, seed) => sum + seed.population, 0)
  assert.ok(near(total, 100, 0.5), '人口总和应接近 100%')
  assert.equal(seedFromPixels(pixels), seeds[0].hex, '种子色就是打分第一名')
})

test('量化打分 - 纯色封面只返回一种颜色且人口 100%', () => {
  const seeds = scoreSeeds(solid('#247a58'))
  assert.equal(seeds.length, 1)
  assert.equal(seeds[0].hex, '#247a58')
  assert.ok(near(seeds[0].population, 100, 0.01))
})

test('全白封面 - 不能返回 #ffffff，必须落到 fallback', () => {
  const white = solid('#ffffff')
  assert.deepEqual(scoreSeeds(white), [], '纯白没有色度，不该被当成主题色')
  assert.notEqual(seedFromPixels(white), '#ffffff')
  assert.equal(seedFromPixels(white), DEFAULT_SEED_FALLBACK)
  assert.equal(seedFromPixels(white, { fallback: '#123456' }), '#123456', '调用方指定的 fallback 优先')
})

test('全黑与灰阶 - 同样被过滤，不会算出黑/灰主题', () => {
  for (const hex of ['#000000', '#050505', '#808080', '#f0f0f0']) {
    assert.deepEqual(scoreSeeds(solid(hex)), [], `${hex} 应当被过滤`)
    assert.equal(seedFromPixels(solid(hex)), DEFAULT_SEED_FALLBACK, `${hex} 应回落到默认种子`)
  }
})

test('透明像素 - alpha < 128 的像素不参与统计（PNG 封面常见大片透明）', () => {
  const pixels = makePixels(16, 16, (x) => (x < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
  assert.equal(seedFromPixels(pixels), '#ff0000')
})

test('确定性 - 同一像素数组两次调用结果完全一致', () => {
  const pixels = split('#ff0000', '#0000ff')
  assert.deepEqual(scoreSeeds(pixels), scoreSeeds(pixels))
  assert.equal(seedFromPixels(pixels), seedFromPixels(pixels))
})

test('纯 JS 降级路径 - 不依赖库也能过滤灰阶、按人口挑色', () => {
  const pixels = split('#ff0000', '#0000ff')
  const seeds = scoreSeedsFallback(pixels)
  assert.equal(seeds.length, 2)
  assert.deepEqual(seeds.map((seed) => seed.hex).sort(), ['#0000ff', '#ff0000'])
  for (const seed of seeds) assert.ok(near(seed.population, 50), `${seed.hex} population 应接近 50`)
  assert.deepEqual(scoreSeedsFallback(solid('#ffffff')), [])
  assert.equal(seedFromPixelsFallback(solid('#ffffff')), DEFAULT_SEED_FALLBACK)
  assert.equal(seedFromPixelsFallback(solid('#ffffff'), { fallback: '#123456' }), '#123456')
})

test('像素契约 - 尺寸/数据长度不合法时抛错，不静默算出垃圾色', () => {
  assert.throws(() => seedFromPixels({ width: 2, height: 2, data: new Uint8ClampedArray(4) }), RangeError)
  assert.throws(() => seedFromPixels({ width: 0, height: 2, data: new Uint8ClampedArray(0) }), TypeError)
  assert.throws(() => seedFromPixels(solid('#ff0000'), { fallback: 'red' }), TypeError)
})

test('封面 URL - 没有 DOM 时安静回落到 fallback，绝不 reject，且按 URL 缓存', async () => {
  clearSeedCache()
  const url = 'https://example.invalid/cover.jpg'
  const first = seedFromImageUrl(url)
  const second = seedFromImageUrl(url, { fallback: '#123456' })
  assert.equal(await first, DEFAULT_SEED_FALLBACK)
  assert.equal(await second, DEFAULT_SEED_FALLBACK, '同一 URL 复用缓存结果（契约：按 URL 缓存）')
  assert.equal(await seedFromImageUrl(''), DEFAULT_SEED_FALLBACK, '空 URL 也只是回落')
  clearSeedCache()
  assert.equal(await seedFromImageUrl(url, { fallback: '#123456' }), '#123456', '清缓存后新选项生效')
})
