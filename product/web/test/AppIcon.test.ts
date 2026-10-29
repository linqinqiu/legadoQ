import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Windows 图标（`.ico`）的尺寸不能靠"看着差不多"。
 *
 * 0.1.8 之前 `make-ico.mjs` 拿 512×512 的 pwa 图去顶 256 那一帧、目录里照旧写 0
 * （ICO 里 0 = 256），声明与实际不符 —— PIL 读会警告 `Image was not the expected size`，
 * 资源管理器在 256px 视图里拿到一张 512 的图再自己缩，反而更糊。用户 2026-10-28 说的
 * 「当前图标太模糊」里，这一条是唯一纯技术、不涉及换设计的部分。
 *
 * 判据分两层：① 每一帧的 PNG 必须是照该尺寸渲染的（文件名即尺寸）；
 * ② 若本机生成过 assets/app.ico（生成物，不入库），目录里写的尺寸要与内嵌 PNG 一致。
 */
const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url)
const icoFile = new URL('../../assets/app.ico', import.meta.url)
/** Windows 真的会来取的档位；少一档它就退回去缩放，小尺寸必糊。 */
const FRAMES = [16, 24, 32, 48, 64, 128, 256]

const pngSize = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) })

test('ico 每一档都有照该尺寸渲染的 PNG，文件名与像素尺寸一致', () => {
  for (const size of FRAMES) {
    const name = `favicon-${size}.png`
    assert.ok(existsSync(publicFile(name)), `${name} 缺失：make-ico 拼不出 ${size} 那一帧`)
    const { w, h } = pngSize(readFileSync(publicFile(name)))
    assert.deepEqual({ w, h }, { w: size, h: size }, `${name} 实际是 ${w}x${h}，不是 ${size}`)
  }
})

test('app.ico 目录里声明的尺寸等于内嵌 PNG 的实际尺寸', () => {
  if (!existsSync(icoFile)) return // assets/ 是生成物；没跑过打包的机器上没有它
  const buf = readFileSync(icoFile)
  assert.equal(buf.readUInt16LE(2), 1, '不是 ICO 文件（类型字段应为 1）')
  const count = buf.readUInt16LE(4)
  const declared: number[] = []
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    // 目录里 0 表示 256；只有正好 256 才允许写 0。
    const w = buf.readUInt8(at) === 0 ? 256 : buf.readUInt8(at)
    const h = buf.readUInt8(at + 1) === 0 ? 256 : buf.readUInt8(at + 1)
    const length = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    const actual = pngSize(buf.subarray(offset, offset + length))
    assert.deepEqual(
      { w: actual.w, h: actual.h },
      { w, h },
      `第 ${i} 帧声明 ${w}x${h}，内嵌 PNG 实际是 ${actual.w}x${actual.h}`,
    )
    declared.push(w)
  }
  assert.deepEqual(declared.sort((a, b) => a - b), FRAMES, 'ico 的档位不全：Windows 会退回缩放')
})
