import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rssImageSrc } from '../src/lib/rssImage'

/**
 * 「订阅」页的配图取法（`lib/rssImage.ts`）。
 *
 * 依据是量出来的：浏览器直连外域图 + `referrerPolicy="no-referrer"`，防盗链站回 403，
 * 那一行的 `onError` 就把图整张藏起来 —— 看着像"这条没图"。服务端代取那一路补 Referer，
 * 并且按落地域名带 Cookie（0.7.4 起），登录过的源这才出得了图。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('外域图走服务端代取，并把文章地址当 Referer 带上', () => {
  const src = rssImageSrc('https://img.example.com/a/b.jpg?w=300', 'https://www.example.com/post/9')
  assert.ok(src, '外域图不该被判成"没有图"')
  assert.ok(src!.startsWith('/api/book/image?'), `没走代理：${src}`)
  assert.ok(src!.includes(`url=${encodeURIComponent('https://img.example.com/a/b.jpg?w=300')}`), `图地址没编码带上：${src}`)
  assert.ok(src!.includes(`page=${encodeURIComponent('https://www.example.com/post/9')}`), `Referer 没带上：${src}`)
})

test('站内相对地址原样交给浏览器，不绕服务端一圈', () => {
  assert.equal(rssImageSrc('/covers/abc123', 'https://www.example.com/post/9'), '/covers/abc123')
})

test('没有可用文章地址时只带图地址，不硬造一个 Referer', () => {
  const src = rssImageSrc('https://img.example.com/a.jpg', null)!
  assert.ok(src.startsWith('/api/book/image?'))
  assert.ok(!src.includes('page='), `凭空多了 Referer：${src}`)
})

test('协议相对地址补成 https 再交给服务端，不留原样（原样等于绕过代理直连外域）', () => {
  const src = rssImageSrc('//img.example.com/a.jpg', 'https://www.example.com/')!
  assert.ok(src.startsWith('/api/book/image?'), `没走代理：${src}`)
  assert.ok(src.includes(encodeURIComponent('https://img.example.com/a.jpg')), `协议没补齐：${src}`)
})

test('不是 http(s) 也不是站内路径的一律不画（javascript: 之类不给 src）', () => {
  assert.equal(rssImageSrc('javascript:alert(1)', 'https://www.example.com/'), null)
  assert.equal(rssImageSrc('data:image/svg+xml;base64,AAA=', ''), null)
  assert.equal(rssImageSrc('', ''), null)
  assert.equal(rssImageSrc(undefined, undefined), null)
})

test('反向对照：那一页不许再把外域地址直接写进 <img src>', () => {
  const panel = read('..', 'src', 'pages', 'RssPanel.tsx')
  const rows = panel.split(/\r?\n/).filter(line => line.includes('<img') && /src=\{/.test(line))
  assert.ok(rows.length >= 2, `只解析到 ${rows.length} 处 <img src>，这条在演空戏`)
  for (const row of rows) {
    assert.ok(/src=\{rssImageSrc\(/.test(row), `这一行还在自己拼图的地址：${row.trim().slice(0, 90)}`)
  }
  // 同一条正则必须逮得住违规写法，否则上面那个断言没有力气
  const fake = '<img className="x" src={sanitizeImageUrl(item.image)!} alt="" />'
  assert.equal(/src=\{rssImageSrc\(/.test(fake), false, '反向对照失效：违规写法也被放过')
})
