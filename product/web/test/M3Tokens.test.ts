import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

/**
 * R3 令牌补齐的判据：M3 角色令牌必须定义在文件最开头的 :root 里。
 * 位置约束与 CustomizeSkin 的中性基线同源：`:root` 与 `.theme-*` 同为 (0,1,0)，靠源序定胜负，
 * 排在预设皮肤之后就会把 7 套皮肤的配色洗成同一个颜色；排在前面才能给自定义皮肤兜底。
 * 这一批只加变量与一套默认映射，不加结构——所以判据也只查「定义过」，不查谁在用。
 */
test('M3 角色令牌在第一个 :root 里定义，且排在预设皮肤之前', () => {
  const css = read('../src/styles.css')
  const rootAt = /^:root \{$/m.exec(css)
  const lightAt = /^\.theme-light \{/m.exec(css)
  assert.ok(rootAt, '文件里要有顶格的 `:root {` 块')
  assert.ok(lightAt, '要有 `.theme-light {` 预设皮肤')
  assert.ok(rootAt.index < lightAt.index, '第一个 :root 必须排在 .theme-* 之前')
  const baseline = css.slice(rootAt.index, lightAt.index)
  for (const token of [
    '--surface-container-lowest',
    '--surface-container-low',
    '--surface-container',
    '--surface-container-high',
    '--surface-container-highest',
    '--outline-variant',
    '--inverse-surface',
    '--inverse-on-surface',
    '--inverse-primary',
    '--primary-container',
    '--on-primary-container',
  ]) {
    assert.ok(baseline.includes(`${token}:`), `第一个 :root 要定义 M3 令牌 ${token}`)
  }
})