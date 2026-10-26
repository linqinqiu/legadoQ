import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * workbox 的 `urlPattern` / `navigateFallbackDenylist` 是拿**绝对 URL** 去试的
 * （`self.location.origin + path`），所以 `^\/api\/...` 这种锚在串首的写法一次都匹配不上。
 *
 * 0.6.x 的四条运行时缓存和这条导航黑名单全是这个形状 —— 封面缓存、元信息缓存从没建过，
 * `/api/` 的导航也确实会被应用壳回答。这一组判据把"锚法"和"指向的路由真存在"两件事钉住。
 */

const CONFIG = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'vite.config.ts'), 'utf8')
// 0.8.2 结构重排：书源/书架等组端点拆进了同目录的 <组>Routes.kt，
// 这条判据要看"缓存规则指向的路由真存在"，读的是整个路由面（装配点 + 全部组文件）。
const HTTP_DIR = path.resolve(import.meta.dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'io', 'legado', 'http')
const ROUTES = fs.readdirSync(HTTP_DIR)
  .filter(f => f === 'Routes.kt' || (f.endsWith('Routes.kt') && f.endsWith('.kt')))
  .map(f => fs.readFileSync(path.join(HTTP_DIR, f), 'utf8'))
  .join('\n')
const workboxRaw = CONFIG.slice(CONFIG.indexOf('workbox: {'), CONFIG.indexOf('injectManifest'))
/**
 * 只留代码行。注释里出现 `^\/api\/` 是给人看的（"别写成这样"），
 * 但把它当正则会炸 —— 第一版就是被自己写的注释绊倒的。
 */
const workboxBlock = workboxRaw.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

test('判据自证：锚在串首的 `^/api/` 对绝对 URL 就是不匹配（这就是修前的死法）', () => {
  const abs = 'https://127.0.0.1:1234/api/bookshelf'
  assert.equal(/^\/api\//.test(abs), false, '旧写法必须被证明匹配不上，否则下面几条是空判')
  assert.equal(/\/api\//.test(abs), true, '同样的式子去掉串首锚定就匹配得上 —— 差的就是那一个 ^/')
})

/** workbox 段里的代码行（注释不参与判定：注释是给人写的，`^\/api\/` 出现在那里是"别这样"）。 */
const codeLines = (): string[] =>
  workboxRaw.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('//'))

test('workbox 的每条 urlPattern 与导航黑名单都必须以 ^https?: 起头', () => {
  const patternLines = codeLines().filter(line =>
    line.includes('urlPattern:') || line.includes('navigateFallbackDenylist:'))
  assert.ok(patternLines.length >= 4, `只看到 ${patternLines.length} 行规则，配置结构大概变了，这条判据要看一眼`)
  for (const line of patternLines) {
    const literals = line.includes('urlPattern:')
      ? [line.slice(line.indexOf('urlPattern:') + 'urlPattern:'.length).replace(/,\s*$/, '').trim()]
      : line.slice(line.indexOf('[') + 1, line.lastIndexOf(']')).split(',').map(s => s.trim())
    for (const literal of literals) {
      assert.ok(literal.length > 0, `${line} 里有一个空的规则位`)
      // 字面量必须长成 /^https?:\/\//…… —— workbox 拿 href 去试，锚在串首的 ^/api/ 永远匹配不上
      assert.ok(literal.startsWith('/^https?:\\/\\/'),
        `规则必须锚在绝对 URL 上，当前这条是：${literal}`)
    }
  }
})

test('规则条数与缓存名都对得上：tts/covers/bookshelf 三条运行时缓存 + 一条导航黑名单', () => {
  const cacheNames = [...workboxRaw.matchAll(/cacheName:\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(cacheNames, ['legado-covers', 'legado-meta-api'],
    '缓存名变了要连 workbox 的旧缓存一起清，别留下没人读的孤儿缓存')
})

test('缓存规则指向的地址在服务端路由里真存在（修前两条指向不存在的 /api/book/cover 与 /api/shelf）', () => {
  for (const pathOfRule of ['/covers/{key}', '/covers/proxy', '/bookshelf"']) {
    assert.ok(ROUTES.includes(pathOfRule), `Routes.kt 里没有 ${pathOfRule}，那条缓存规则就是死的`)
  }
  assert.doesNotMatch(workboxBlock, /api\\\/book\\\/cover/, '不存在的路径不许再出现在规则里')
  assert.doesNotMatch(workboxBlock, /\(shelf\|/, '不存在的路径不许再出现在规则里')
})

test('实时音频流仍然被显式排除在缓存之外', () => {
  assert.match(workboxBlock, /api\\\/tts\\\//, 'tts 那条 NetworkOnly 规则不该被顺手删掉')
  assert.match(workboxBlock, /handler: 'NetworkOnly'/)
})
