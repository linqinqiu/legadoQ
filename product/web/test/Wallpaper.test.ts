import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WallpaperModal } from '../src/components/WallpaperModal'
import {
  DEFAULT_WALLPAPER_SETTINGS,
  getWallpaperSnapshot,
  parseWallpaperSettings,
  subscribeWallpaper,
  updateWallpaperSettings,
} from '../src/lib/wallpaper'

/**
 * 壁纸设置模型的行为判据（不碰 DOM / IndexedDB —— 那些在浏览器里才有的东西由壁纸层自己降级）。
 *
 * 判的是"存下来的东西坏掉时界面还能不能跑"：localStorage 里可能是旧版本、手改过、或者干脆是
 * 一段坏 JSON，解析必须给出字段齐全、取值合法的设置，而不是把整份设置丢掉或让滑杆越界。
 */

test('解析：缺字段回落默认，坏数据不抛错', () => {
  assert.deepEqual(parseWallpaperSettings(null), DEFAULT_WALLPAPER_SETTINGS)
  assert.deepEqual(parseWallpaperSettings(undefined), DEFAULT_WALLPAPER_SETTINGS)
  assert.deepEqual(parseWallpaperSettings('一段坏数据'), DEFAULT_WALLPAPER_SETTINGS)
  assert.deepEqual(parseWallpaperSettings({}), DEFAULT_WALLPAPER_SETTINGS)
})

test('解析：越界值夹回合法区间，地址去掉首尾空白', () => {
  const parsed = parseWallpaperSettings({
    enabled: true,
    source: 'url',
    url: '  https://example.com/a.jpg  ',
    opacity: 3,
    mask: -1,
    blur: 999,
    fill: 'stretch',
  })
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.source, 'url')
  assert.equal(parsed.url, 'https://example.com/a.jpg')
  assert.equal(parsed.opacity, 1, '不透明度上限是 1')
  assert.equal(parsed.mask, 0, '遮罩下限是 0')
  assert.equal(parsed.blur, 60, '模糊上限是 60px')
  assert.equal(parsed.fill, 'cover', '不认识的填充方式回落 cover')
})

test('解析：模糊取整到像素，来源与填充只认白名单', () => {
  assert.equal(parseWallpaperSettings({ blur: 13.7 }).blur, 14)
  assert.equal(parseWallpaperSettings({ source: 'whatever' }).source, 'upload')
  assert.equal(parseWallpaperSettings({ fill: 'contain' }).fill, 'contain')
})

test('改设置会通知订阅者，且不改变图片版本号', () => {
  const before = getWallpaperSnapshot()
  let calls = 0
  const unsubscribe = subscribeWallpaper(() => { calls += 1 })

  const next = updateWallpaperSettings({ enabled: true, opacity: 0.5 })
  assert.equal(next.opacity, 0.5)
  assert.equal(calls, 1, '一次改动只通知一次')
  assert.equal(getWallpaperSnapshot().settings.opacity, 0.5)
  assert.equal(getWallpaperSnapshot().imageVersion, before.imageVersion, '改设置不该让壁纸层重读图片')

  // 归一化后没有变化就不通知：滑杆拖回同一格不该让整层重渲染
  updateWallpaperSettings({ opacity: 0.5 })
  assert.equal(calls, 1)

  unsubscribe()
  updateWallpaperSettings({ ...DEFAULT_WALLPAPER_SETTINGS })
  assert.equal(calls, 1, '取消订阅后不再收到通知')
})

test('WallpaperModal 只放壁纸：图片 / 观感 / 界面三组，清除单独一条', () => {
  const html = renderToStaticMarkup(React.createElement(WallpaperModal, { onClose: () => undefined }))
  assert.match(html, /壁纸/)
  // 11 项控件分成三组，不在一张长表里平铺
  assert.equal((html.match(/class="settings-rows"/g) ?? []).length, 3, '应分成图片 / 观感 / 界面三组')
  assert.match(html, /<h3>图片<\/h3>[\s\S]*<h3>观感<\/h3>[\s\S]*<h3>界面<\/h3>/, '三组顺序固定，用户靠位置找控件')
  for (const label of ['启用壁纸', '本地图片', '图片地址', '不透明度', '遮罩', '模糊', '填充方式', '面板不透明度', '毛玻璃模糊', '阅读区跟随壁纸']) {
    assert.ok(html.includes(label), `壁纸浮层缺控件「${label}」`)
  }
  assert.ok(html.includes('清除壁纸'), '清除壁纸要有自己的动作')
  assert.match(html, /wallpaper-footer/, '清除壁纸要放在三组控件之外，别和启用开关紧挨着')
  assert.doesNotMatch(html, /自定义皮肤库|theme-/, '皮肤库不该再挤进壁纸浮层')
})
