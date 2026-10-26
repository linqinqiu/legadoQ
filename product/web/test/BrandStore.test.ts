import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * 品牌（应用名称与图标）的前端单一来源（用户 2026-10-23：「允许自定义图标和名称」）。
 *
 * 这里真正要钉的不是"能不能 set 一个值"，而是**不许再有第二处写死「legadoQ」**：
 * 「legadoQ」此前硬编码在顶栏品牌字、阅读器的 `document.title`（设置一次、卸载重置一次）、
 * index.html 三处 —— 用户改了名，那三处照旧，等于"改了个寂寞"，而且没有任何报错。
 * 所以判据是**反向扫源码**：出现裸的「legadoQ」字面量当显示值，就必须红。
 */
// 源码带扩展名（组件是 .tsx、lib 与纯逻辑是 .ts），拼路径时两种都试一次。
const read = (relative: string): string => {
  const base = new URL(`../src/${relative}`, import.meta.url)
  for (const suffix of ['.tsx', '.ts']) {
    const candidate = new URL(base.href + suffix)
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
  }
  throw new Error(`找不到源码：${relative}（试过 .tsx / .ts）`)
}

test('品牌 store：默认回落内置名，写入后同步标签页标题', async () => {
  // brandStore 是**模块级单例**：run-all 在同一进程里跑所有判据，这里写完不还原，
  // 后面任何渲染 AppHeader 的用例都会读到被本用例改过的名字（实测污染过 HeaderMenu）。
  // 所以先把原值与原来的 document 记下，结尾无条件倒回去。
  const hadDocument = 'document' in globalThis
  const previousTitle = (globalThis as { document?: { title?: string } }).document?.title
  ;(globalThis as { document?: unknown }).document = { title: '' }
  const { getBrand, reportBrand, subscribeBrand, BRAND_BUILTIN_NAME } = await import('../src/lib/brandStore')
  const before = getBrand()
  try {
    assert.equal(before.displayName, BRAND_BUILTIN_NAME, '没设置过就该是内置名（不能是空串）')
    assert.equal(before.builtinName, BRAND_BUILTIN_NAME)

    let notified = 0
    const off = subscribeBrand(() => { notified += 1 })
    try {
      reportBrand({ displayName: '我的书斋' })
      assert.equal(getBrand().displayName, '我的书斋')
      assert.equal(document.title, '我的书斋', '标签页标题必须跟着改：它是"改名有没有生效"最直观的一格')
      assert.equal(notified, 1, '订阅者该被通知一次')

      // 同值再写一次不许惊动订阅者（顶栏会因此无谓重渲染）。
      reportBrand({ displayName: '我的书斋' })
      assert.equal(notified, 1, '值没变就不该通知')
      off()
      reportBrand({ displayName: '又改一次' })
      assert.equal(notified, 1, '注销之后不该再被通知')
    } finally {
      off()
    }
  } finally {
    reportBrand(before)
    assert.equal(getBrand().displayName, before.displayName, '还原要真的生效（否则就是在污染后面的用例）')
    if (!hadDocument) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: { title?: string } }).document = { title: previousTitle }
  }
})

/** 「legadoQ」不许再作为**显示值**硬编码回来（顶栏与阅读器标题都读品牌 store）。 */
test('顶栏与阅读器标题读品牌 store，不写死应用名', () => {
  const header = read('components/AppHeader')
  assert.match(header, /getBrand|useSyncExternalStore\(subscribeBrand/, '顶栏品牌字要读单一来源')
  assert.doesNotMatch(header, /<strong>legadoQ<\/strong>|aria-label="legadoQ"/, '顶栏不许留硬编码的「legadoQ」')

  const reader = read('reader/ReaderScreen')
  // 切片从"取品牌名"那行起：标题模板用的是上一行取出的局部变量，从 `const shown` 起截会漏掉它。
  const titleBlock = /const brandName = getBrand\(\)\.displayName[\s\S]{0,220}/.exec(reader)?.[0] ?? ''
  assert.ok(titleBlock.length > 0, '要能定位到设标签页标题那一段（且它得先读品牌 store）')
  assert.match(titleBlock, /\$\{brandName\}/, '阅读器标题后缀要用读出来的品牌名')
  assert.doesNotMatch(titleBlock, /\| legadoQ/, '阅读器不许把名字写死（改名后一进书就被冲回去）')
  assert.match(reader, /document\.title = getBrand\(\)\.displayName/, '卸载时的重置也要读 store，不能回落成写死的名字')
})

/** 弹窗改完要把新值发布到 store —— 否则顶栏要刷一次页面才跟上。 */
test('品牌弹窗与启动各发布一次，形成闭环', () => {
  const modal = read('components/BrandModal')
  assert.match(modal, /reportBrand\(/, '保存/上传后要写进单一来源')
  assert.match(modal, /publishBrand\(info\)/, '打开这一屏就先把服务端现状灌进来（否则顶栏还停在默认名）')
  // 生效范围要说实话：已装到桌面的应用由浏览器自己存清单，这里控制不了。
  assert.match(modal, /浏览器同步/, '要写清"已安装的应用要等浏览器同步清单"')

  const app = read('main')
  assert.match(app, /api\.brand\(\)[\s\S]{0,160}reportBrand\(/, '启动时要拉一次品牌，首屏名字才对')
})

/** 后端那份契约也不许漂：品牌走静态表面，不进 /api/catalog 的端点计数。 */
test('品牌端点是静态表面，不进端点契约', () => {
  const catalogUrl = new URL('../../app/src/main/resources/agent-api.json', import.meta.url)
  const catalog = JSON.parse(fs.readFileSync(catalogUrl, 'utf8'))
  assert.ok(catalog.endpoints.every((e: { path: string }) => !String(e.path).includes('brand')),
    'brand 不该出现在 /api/catalog 契约里（它与 /sw.js、/manifest.webmanifest 同一档静态表面）')
  const staticWeb = fs.readFileSync(new URL('../../app/src/main/kotlin/io/legado/StaticWeb.kt', import.meta.url), 'utf8')
  assert.match(staticWeb, /get\("\/brand"\)/, '读品牌的那条要在 StaticWeb 里')
  assert.match(staticWeb, /requireSameOriginWrite/, '写品牌必须过同源闸门（跨站页面不该代用户改外观）')
})
