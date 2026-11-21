import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 预设图标（用户 2026-11-21：「获取md3上游仓库图标…让咱们也可以切换自定义图标」）。
 *
 * 9 张 PNG 是上游 legado（HapeLee/legado-with-MD3）自己那 9 套 adaptive-icon ——
 * 上游 `AndroidManifest.xml` 里正好有 9 个 `activity-alias` 分别引用它们。
 * 由 `product/tools/verify/render-brand-presets.mjs` 从 vendored 的上游矢量渲染。
 *
 * 这里钉三件事：
 * 1. **资产真的在、且真的是 512×512 PNG** —— 光有文件名、实际是空文件或占位图，预设点下去就是坏图；
 * 2. **界面确实接上了** —— 走的是既有上传 API，没有另起一条后端路径；
 * 3. **没引入新端点 / 没把 9 张塞进 SW 预缓存** —— 前者会撑破 `/api/catalog` 的端点计数，
 *    后者是白搬 ~130KB（这 9 张只在设置弹窗里按需取）。
 */
const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url)
const brandModal = readFileSync(new URL('../src/components/BrandModal.tsx', import.meta.url), 'utf8')
const brandPresets = readFileSync(new URL('../src/lib/brandPresets.ts', import.meta.url), 'utf8')
const brandApi = readFileSync(new URL('../src/lib/api/domains/brand.ts', import.meta.url), 'utf8')
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

/** 上游那 9 套 adaptive-icon 的名字（与上游 mipmap-anydpi-v26 一一对应）。 */
const PRESET_IDS = [
  'ic_launcher',
  'launcherw',
  'launcher0',
  'launcher1',
  'launcher2',
  'launcher3',
  'launcher4',
  'launcher5',
  'launcher6',
]

test('9 张预设图标都在，且真的是 512×512 的 PNG', () => {
  assert.equal(PRESET_IDS.length, 9, '预设数量变了：上游是 9 套 adaptive-icon')
  for (const id of PRESET_IDS) {
    const file = publicFile(`brand-presets/${id}.png`)
    assert.ok(existsSync(file), `预设图标 ${id}.png 不见了`)
    const bytes = readFileSync(file)
    assert.ok(bytes.length > 0, `${id}.png 是空文件`)
    // PNG 魔数：服务端按魔数判类型，认不出就拒收这个图标
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${id}.png 不是 PNG（魔数不对，服务端会拒收）`,
    )
    // IHDR 宽高在字节 16..24
    assert.equal(bytes.readUInt32BE(16), 512, `${id}.png 宽度不是 512`)
    assert.equal(bytes.readUInt32BE(20), 512, `${id}.png 高度不是 512`)
    // 服务端上限 5MB
    assert.ok(bytes.length < 5 * 1024 * 1024, `${id}.png 超过服务端的 5MB 上限`)
  }
})

test('预设清单列的就是这 9 张，且 URL 带版本号破缓存', () => {
  for (const id of PRESET_IDS) {
    assert.ok(brandPresets.includes(`'${id}'`), `预设清单里少了 ${id}`)
    assert.ok(brandPresets.includes(`/brand-presets/${id}.png`), `预设清单里 ${id} 指向的文件路径不对`)
  }
  assert.ok(
    /PRESET_ICON_VERSION\s*=\s*'5'/.test(brandPresets),
    '预设图标的版本号不是 5：与 vite.config 的 ICON_VERSION / index.html 的 ?v=5 不同步，换图后浏览器还拿旧的',
  )
  assert.ok(brandPresets.includes('?v='), '预设图标 URL 没带版本号：文件名不带 hash，靠这个破缓存')
})

test('点预设走的是既有上传 API，没有另起后端路径', () => {
  assert.ok(brandModal.includes('applyPreset'), 'BrandModal 没有处理点选预设')
  assert.ok(brandModal.includes('fetchPresetFile'), 'BrandModal 没走取预设字节那一步')
  assert.ok(brandModal.includes('uploadBrandIcon'), 'BrandModal 点预设没复用上传接口')
  assert.ok(brandPresets.includes('uploadBrandIcon') === false, 'brandPresets 不该直接调上传接口：那是弹窗的活')
  // 取字节走统一传输层 requestBlob（不让 src 里冒出裸 fetch：BareFetch 测试不允许例外）
  assert.ok(brandPresets.includes('requestBlob'), 'brandPresets 没走 requestBlob 取预设字节')
  assert.ok(
    !brandPresets.includes('fetch('),
    'brandPresets 里出现了裸 fetch：统一超时/错误口径/性能采集都在 client 层',
  )
  // 上传走 multipart，需要 filename + type，所以必须包成 File
  assert.ok(brandPresets.includes('new File('), '预设字节没包成 File：multipart 收不到文件名与类型')
  assert.ok(brandPresets.includes("type: 'image/png'"), '预设文件的 MIME 不是 image/png')
  // 取字节不建 blob URL：File 直接进 FormData，建了就得 revoke，忘了就是泄漏
  assert.ok(
    !brandPresets.includes('URL.createObjectURL'),
    'brandPresets 建了 blob URL 却没 revoke：每次切图标泄漏一个对象 URL',
  )
  // 服务端那侧：图标写路径仍然只有一条
  assert.equal(
    (brandApi.match(/'\/brand\/icon'/g) ?? []).length >= 1,
    true,
    'brand.ts 里没有 /brand/icon 路径',
  )
  assert.ok(
    !brandApi.includes('/api/brand'),
    'brand.ts 里出现了 /api/brand：品牌是静态表面，不该进 /api/catalog 的端点计数',
  )
})

test('预设选中态用 aria-pressed，且与上传/换回默认互斥', () => {
  assert.ok(brandModal.includes('aria-pressed'), '预设按钮没用 aria-pressed：读屏用户听不出当前选的是哪张')
  assert.ok(brandModal.includes('activePresetId'), 'BrandModal 没有跟踪当前选中的预设')
  // 上传自定义图 → 清掉预设选中；换回默认 → 也要清掉
  const uploadBlock = brandModal.slice(brandModal.indexOf('const upload ='), brandModal.indexOf('const applyPreset'))
  assert.ok(uploadBlock.includes('setActivePresetId(null)'), '上传自定义图后没清掉预设选中态')
  const dropBlock = brandModal.slice(brandModal.indexOf('const dropIcon ='))
  assert.ok(dropBlock.includes('setActivePresetId(null)'), '换回默认后没清掉预设选中态')
})

test('9 张预设不进 SW 预缓存', () => {
  assert.ok(
    viteConfig.includes("'brand-presets/**'"),
    "vite.config 的 globIgnores 没排除 brand-presets/**：9 张只在弹窗里按需取，收进预缓存只是白搬",
  )
})
