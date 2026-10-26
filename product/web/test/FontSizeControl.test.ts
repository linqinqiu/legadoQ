import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { clampFontSize, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, stepFontSize } from '../src/reader/fontSizeControl'

/**
 * 字号口径的唯一出处（P1 收敛）：设置步进器/快捷键/Ctrl+滚轮都走这里。
 * 边界一变三处齐变 —— 这份测试钉的就是"只有一个出处"这件事。
 */
test('clampFontSize：夹在 15–28，非法值回落', () => {
  assert.equal(clampFontSize(19), 19)
  assert.equal(clampFontSize(5), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(99), READER_FONT_SIZE_MAX)
  // 非法值（NaN/±Infinity）一律回落到最小档：宁小勿炸，防呆优先。
  assert.equal(clampFontSize(Number.NaN), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(Number.POSITIVE_INFINITY), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(Number.NEGATIVE_INFINITY), READER_FONT_SIZE_MIN)
})

test('stepFontSize：步进后仍夹在边界内；到头不再动', () => {
  assert.equal(stepFontSize(19, 1), 20)
  assert.equal(stepFontSize(19, -1), 18)
  assert.equal(stepFontSize(READER_FONT_SIZE_MAX, 1), READER_FONT_SIZE_MAX)
  assert.equal(stepFontSize(READER_FONT_SIZE_MIN, -1), READER_FONT_SIZE_MIN)
})

test('边界值就是旧三处写死的 15/28，不许悄悄改', () => {
  // 旧代码三处各写 Math.min(28, Math.max(15, …)) —— 收敛后边界变了要同步排版设置的范围。
  assert.equal(READER_FONT_SIZE_MIN, 15)
  assert.equal(READER_FONT_SIZE_MAX, 28)
})

/**
 * "只有一个出处"必须是**扫出来的**，不是注释里说的。
 * 这份测试的表头从 P1 起就写着"钉的就是只有一个出处"，而它一条也没扫过 ——
 * 于是 `readerSettings.ts` 读回 localStorage 与 `lib/backupPreferences.ts` 折算备份 dp 时
 * 各自又抄了一遍 `15, 28`，套件全绿了三周（2026-10-14 通读 0.7.0 时才发现）。
 */
const CLAMPED_RANGE = /(?:clamp\w*|Math\.min|Math\.max)\b[^\n]*\b15,\s*28\b|Math\.min\(\s*28\s*,[^\n]*Math\.max\(\s*15\b/

function hardcodedBoundsIn(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name === 'fontSizeControl.ts') continue
      fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, at) => {
        if (CLAMPED_RANGE.test(line)) found.push(`${entry.name}:${at + 1}`)
      })
    }
  }
  walk(dir)
  return found
}

test('字号边界除 fontSizeControl.ts 之外不许再出现字面量', () => {
  const hits = hardcodedBoundsIn(path.join(import.meta.dirname, '../src'))
  assert.deepEqual(hits, [], `这些行又把 15/28 抄了一遍（改边界就得改这里，界面不会报错）：${hits.join('、')}`)
  // 反向对照：把上一轮实际存在过的两种写法喂进去，都必须被逮住 —— 否则上面那条是恒真。
  const samples = [
    '      fontSize: clampNumber(saved.fontSize, 15, 28, defaultReaderSettings.fontSize),',
    '    patch.fontSize = clamp(Math.round(fontSize), 15, 28)',
  ]
  for (const sample of samples) assert.ok(CLAMPED_RANGE.test(sample), `反扫漏了：${sample}`)
  assert.ok(CLAMPED_RANGE.test('  const size = Math.min(28, Math.max(15, raw))'), '反扫漏了老式三段夹法')
  assert.ok(!CLAMPED_RANGE.test('      lineHeight: clampNumber(saved.lineHeight, 1.45, 2.4, d.lineHeight),'),
    '把别的区间（行距 1.45–2.4）也判成字号边界就是误报')
})
