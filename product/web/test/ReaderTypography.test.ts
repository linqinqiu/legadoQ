import test from 'node:test'
import assert from 'node:assert/strict'
import {
  READER_TEXT_INDENTS,
  clampNumber,
  defaultReaderSettings,
  loadReaderSettings,
  parseTextIndent,
  saveReaderSettings,
} from '../src/reader/readerSettings'

/**
 * 「阅读设置 · 排版」这一组的判据。
 *
 * 用户 2026-09-30：「阅读设置里面的排版功能丰富完善检验一下，比如首行缩进」。
 * 检验下来两件事：① 首行缩进根本不存在（没有字段、没有 CSS，而且段落 `.trim()` 会把源站
 * 自带的 U+3000 缩进一起剥掉，所以连"源站替我们缩好了"都不成立）；
 * ② 所有数值项的读取只判 `typeof === 'number'`，而 `NaN` 也满足它，`Math.min/max(NaN)` 又回 NaN，
 * 于是 `--reader-font-size: NaNpx` 会一路发到 CSS 被浏览器整条作废 —— 表现为"设置突然不生效"。
 * 这两条都在这里钉住，而不是只测"滑块能拖动"。
 */

function withStorage(initial: Record<string, string> | undefined, body: () => void) {
  const previous = (globalThis as any).window
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  }
  try {
    body()
  } finally {
    if (previous === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previous
  }
}

test('排版 - 首行缩进默认 2 字（中文排版惯例，也是上游 Legado 的默认）', () => {
  assert.equal(defaultReaderSettings.textIndent, 2)
  assert.deepEqual([...READER_TEXT_INDENTS], [0, 1, 2])
})

test('排版 - parseTextIndent 只认三档，脏值一律回到默认', () => {
  for (const value of [0, 1, 2]) assert.equal(parseTextIndent(value), value)
  // 旧数据里出现中间值时取最近的一档，而不是原样发一个没有排版惯例的 1.3em
  assert.equal(parseTextIndent(1.4), 1)
  assert.equal(parseTextIndent(1.6), 2)
  assert.equal(parseTextIndent(99), 2)
  assert.equal(parseTextIndent(-5), 0)
  for (const junk of [undefined, null, 'two', NaN, Infinity, {}, []]) assert.equal(parseTextIndent(junk), 2)
})

test('排版 - clampNumber 挡住 NaN / Infinity / 字符串，不再让 NaNpx 发到 CSS', () => {
  assert.equal(clampNumber(NaN, 15, 28, 19), 19)
  assert.equal(clampNumber(Infinity, 15, 28, 19), 19)
  assert.equal(clampNumber('19', 15, 28, 19), 19)
  assert.equal(clampNumber(undefined, 15, 28, 19), 19)
  assert.equal(clampNumber(4, 15, 28, 19), 15)
  assert.equal(clampNumber(40, 15, 28, 19), 28)
  assert.equal(clampNumber(21, 15, 28, 19), 21)
})

test('排版 - 存档被写坏时逐项回落，不整份丢设置', () => {
  withStorage({ 'legado-reader-settings-v2': JSON.stringify({ fontSize: NaN, lineHeight: 'x', textIndent: 77, theme: 'dark' }) }, () => {
    const loaded = loadReaderSettings()
    assert.equal(loaded.fontSize, defaultReaderSettings.fontSize)
    assert.equal(loaded.lineHeight, defaultReaderSettings.lineHeight)
    assert.equal(loaded.textIndent, 2)
    // 坏字段不该连累好字段
    assert.equal(loaded.theme, 'dark')
  })
})

test('排版 - 三档缩进存得回、读得出', () => {
  for (const indent of READER_TEXT_INDENTS) {
    withStorage(undefined, () => {
      saveReaderSettings({ ...defaultReaderSettings, textIndent: indent })
      assert.equal(loadReaderSettings().textIndent, indent)
    })
  }
})

test('排版 - 老存档（v1，没有 textIndent 字段）读出来是默认 2 而不是 0', () => {
  withStorage({ 'legado-reader-settings-v1': JSON.stringify({ fontSize: 22, theme: 'paper' }) }, () => {
    const loaded = loadReaderSettings()
    assert.equal(loaded.textIndent, defaultReaderSettings.textIndent)
    assert.equal(loaded.fontSize, 22)
    assert.equal(loaded.theme, 'paper')
  })
})
