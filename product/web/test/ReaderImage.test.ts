import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readerImageSrc } from '../src/reader/readerImage'

/**
 * 正文配图（漫画每一页）的取法与"重取这一张"（`reader/readerImage.ts`）。
 *
 * 要钉住的两件事：① 渲染、预热、重取三处用**同一个**地址算法，且代次只进浏览器侧的缓存键；
 * ② 取失败的那一张**不许被静默藏掉** —— 以前 `onError` 给整个 `<figure>` 挂 `hidden`，
 * 于是"这张没取到"与"这一页本来没图"在界面上是同一个样子，而站点用同一个 URL 换过图时
 * 用户没有任何出路（服务端那份按 `sha256(地址)` 落盘，永不过期）。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('第一次取不带代次，重取过两次就带 v=2', () => {
  const plain = readerImageSrc('https://img.example/a.png', 'https://book.example/ch/1')
  assert.ok(plain.startsWith('/api/book/image?'), `没走服务端代取：${plain}`)
  assert.ok(!plain.includes('&v='), `不该凭空带代次：${plain}`)
  const twice = readerImageSrc('https://img.example/a.png', 'https://book.example/ch/1', 2)
  assert.ok(twice.includes('&v=2'), `代次没进地址：${twice}`)
  assert.equal(twice.replace('&v=2', ''), plain, '代次只许多一个参数，不许改动原图地址或 Referer')
})

test('站内地址（本地 EPUB 插图）原样交给浏览器，不过代理也不带代次', () => {
  assert.equal(readerImageSrc('/api/books/local/asset?bookId=aa&path=a.png', 'https://x', 3), '/api/books/local/asset?bookId=aa&path=a.png')
  assert.equal(readerImageSrc('', undefined), '')
})

test('取失败的那一张要给一句结论和一条出路，不许整块藏掉', () => {
  const screen = read('..', 'src', 'reader', 'ReaderScreen.tsx')
  const failedRow = screen.split('\n').filter(line => line.includes('reader-image-failed'))
  assert.equal(failedRow.length, 1, `失败行应当恰好一处，实测 ${failedRow.length}`)
  assert.ok(/重取这一张/.test(screen), '那一行要有「重取这一张」这颗按钮')
  assert.ok(/api\.refreshBookImage\(image, referer\)/.test(screen), '按钮要真去叫服务端重取，且带上这一段的 Referer')
  // 反向对照：老写法（把整个 figure 藏掉）必须被这条逮住
  const oldShape = '<figure key={i} className="reader-paragraph-image"><img onError={event => { event.currentTarget.closest(\'figure\')?.setAttribute(\'hidden\', \'\') }} /></figure>'
  assert.ok(/closest\('figure'\)[\s\S]{0,40}setAttribute\('hidden'/.test(oldShape), '反扫正则失效：老写法也逮不住')
  assert.equal(/closest\('figure'\)[\s\S]{0,40}setAttribute\('hidden'/.test(screen), false, '那一页还在把失败的图整块藏掉')
})

test('重取接口是写操作，地址与回包字段要对得上', () => {
  const api = read('..', 'src', 'lib', 'api.ts')
  assert.ok(/refreshBookImage:[\s\S]{0,200}\/api\/book\/image\/refresh\?url=/.test(api), '没走 /api/book/image/refresh')
  assert.ok(/refreshBookImage:[\s\S]{0,300}method: 'POST'/.test(api), '重取必须是 POST（写操作才过同源闸门）')
  assert.ok(/export type RefreshedImage = \{/.test(api), '回包要有具名类型，不许是裸 Map')
})
