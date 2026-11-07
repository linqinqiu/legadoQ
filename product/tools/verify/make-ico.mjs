/**
 * 生成 Windows 多尺寸 .ico（内嵌 PNG），供桌面快捷方式使用。
 * 放在应用目录里而不是 C 盘：快捷方式的 IconLocation 指到这里，
 * 用户把整个应用挪去哪，图标就跟去哪。
 *
 * 这里只做**拼装**，不做缩放：每一帧都必须是 render-icons.mjs 照该尺寸直接渲染出来的
 * 同名 PNG。以前是拿 512×512 的 pwa 顶 256 那一帧、目录里照旧写 0（ICO 里 0 表示 256），
 * 于是"声明的尺寸"与"PNG 实际尺寸"对不上（PIL 读的时候会警告
 * `Image was not the expected size`），Explorer 的 256px 视图只能自己再缩一次，更糊。
 * 所以入口处先按 PNG 头比对，对不上直接失败 —— 拼装错了宁可不产出，也别产出一个坏图标。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.mjs'

/** 按 Windows 会真的来取的尺寸从小到大排（16/24/32/48 是列表与小图标，256 是大图标）。 */
const FRAMES = [
  'favicon-16.png',
  'favicon-24.png',
  'favicon-32.png',
  'favicon-48.png',
  'favicon-64.png',
  'favicon-128.png',
  'favicon-256.png',
]

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const images = FRAMES.map(name => {
  const file = path.join(ROOT, 'web/public', name)
  const data = fs.readFileSync(file)
  const { w, h } = pngSize(data)
  const declared = Number(name.match(/-(\d+)\.png$/)?.[1])
  if (!declared || w !== declared || h !== declared) {
    throw new Error(`${name} 实际是 ${w}x${h}，与文件名里的 ${declared} 不符：先跑 render-icons.mjs`)
  }
  return { name, data, w, h }
})

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // 类型：图标
header.writeUInt16LE(images.length, 4)

const ENTRY = 16
let offset = header.length + images.length * ENTRY
const entries = images.map(image => {
  const entry = Buffer.alloc(ENTRY)
  // ICO 目录里 0 是"256"的缩写，只有正好 256 才写 0；写别的都必须是真实边长。
  entry.writeUInt8(image.w === 256 ? 0 : image.w, 0)
  entry.writeUInt8(image.h === 256 ? 0 : image.h, 1)
  entry.writeUInt16LE(1, 4) // 色平面
  entry.writeUInt16LE(32, 6) // 位深
  entry.writeUInt32LE(image.data.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += image.data.length
  return entry
})

const out = path.join(ROOT, 'assets/app.ico')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map(image => image.data)]))
console.log(`写出 ${out}`)
console.log(`包含尺寸：${images.map(image => `${image.w}x${image.h}`).join(', ')}  ·  ${fs.statSync(out).size} B`)
