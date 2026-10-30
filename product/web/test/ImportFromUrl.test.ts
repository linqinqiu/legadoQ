import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeImportText, normalizeImportUrl } from '../src/lib/importFromUrl'

/**
 * 从地址/文件导入书源时的文本解码。
 *
 * `response.text()` 与 `File.text()` 永远按 UTF-8 解：GBK 存的老书源 JSON 会被静默换成
 * 一串 U+FFFD，再解析就只剩「书源格式无效」。这里钉住 BOM → UTF-8 → GB18030 的口径，
 * 与后端 `decodeTextAuto` 保持一致。
 */

function bytesOf(...values: number[]): ArrayBuffer {
  const bytes = new Uint8Array(values)
  return bytes.buffer.slice(0) as ArrayBuffer
}

function utf8(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(0) as ArrayBuffer
}

test('UTF-8 中文书源 JSON 原样读出', () => {
  const text = '{"name":"书源"}'
  assert.equal(decodeImportText(utf8(text)), text)
})

test('GBK 字节按 GB18030 认出来，而不是变成替换字符', () => {
  // 「书源」的 GBK 编码：CA E9 D4 B4
  assert.equal(decodeImportText(bytesOf(0xca, 0xe9, 0xd4, 0xb4)), '书源')
})

test('UTF-8 BOM 会被剥掉', () => {
  const body = new TextEncoder().encode('书源')
  const bytes = new Uint8Array(3 + body.length)
  bytes.set([0xef, 0xbb, 0xbf])
  bytes.set(body, 3)
  assert.equal(decodeImportText(bytes.buffer.slice(0) as ArrayBuffer), '书源')
})

test('UTF-16LE 的 BOM 内容能读', () => {
  // 「书源」的 UTF-16LE：66 4E 90 6E
  assert.equal(decodeImportText(bytesOf(0xff, 0xfe, 0x66, 0x4e, 0x90, 0x6e)), '书源')
})

test('认不出的字节退化成替换字符但不抛异常', () => {
  // 0x80 在 GBK/GB18030 里是欧元符号（单字节），所以这里用 0xFF：两种编码都不接受它。
  assert.equal(decodeImportText(bytesOf(0xff)), '\uFFFD')
})

test('空内容返回空串', () => {
  assert.equal(decodeImportText(new ArrayBuffer(0)), '')
})

test('只接受 http(s) 地址', () => {
  assert.equal(normalizeImportUrl(' https://example.com/a.json '), 'https://example.com/a.json')
  assert.throws(() => normalizeImportUrl(''))
  assert.throws(() => normalizeImportUrl('ftp://example.com/a.json'))
  assert.throws(() => normalizeImportUrl('not a url'))
})
