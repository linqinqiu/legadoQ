import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPreferencePatch, mapReadStyle, mapTtsEngine } from '../src/lib/backupPreferences'
import { defaultReaderSettings } from '../src/reader/readerSettings'

/**
 * 备份包「阅读样式 / 朗读引擎」→ 本机阅读设置的映射。
 *
 * 用户 2026-09-30：「备份包里的 TTS、字典、阅读样式、书签、书架分组以外的个性化条目，试着做一下」。
 * 这里盯的是两件容易做错的事：
 * ① 上游 `lineSpacing` / `paragraphSpacing` 是 dp 绝对值，我们是字号倍数 —— 直接抄数值会把行距
 *    设成 12 这种荒谬值，所以换算式必须写死并测；
 * ② 映射不上时必须**说清楚**而不是静默半套，所以 `notes` 与 `applied` 各有一条断言盯着。
 */

const CURRENT = { ...defaultReaderSettings }

test('阅读样式 - 能映射的字段逐项落到本机设置，dp 按倍数换算', () => {
  const raw = JSON.stringify([{
    name: '我的样式', isDefault: true, fontSize: 22, fontFamily: '思源宋体',
    lineSpacing: 11, paragraphSpacing: 22, charSpacing: 0.5, padding: 40, doubleColumn: 1,
  }])
  const result = mapReadStyle(raw, CURRENT)
  const patch = result.patch
  assert.equal(patch.fontSize, 22)
  assert.equal(patch.font, 'song')
  // 1 + 11/22 = 1.5；段间距 22/22 = 1.0
  assert.equal(patch.lineHeight, 1.5)
  assert.equal(patch.paragraphSpacing, 1)
  assert.equal(patch.letterSpacing, 0.5)
  assert.equal(patch.contentPadding, 40)
  assert.equal(patch.columnMode, 'auto')
  assert.ok(result.applied.length >= 6, result.applied.join('、'))
  assert.ok(result.notes.some(note => note.includes('默认')), result.notes.join('；'))
})

test('阅读样式 - 认不出的字体保留本机当前值并说明原因', () => {
  const result = mapReadStyle(JSON.stringify([{ name: 'x', fontSize: 20, fontFamily: '方正书宋_GBK' }]), { ...CURRENT, font: 'kai' })
  assert.equal(result.patch.font, undefined)
  assert.ok(result.notes.some(note => note.includes('保留当前的「kai」')), result.notes.join('；'))
})

test('阅读样式 - 泛用的 sans 系名归到黑体档（别因为认不出厂商名就整个丢掉字体）', () => {
  assert.equal(mapReadStyle(JSON.stringify([{ fontSize: 20, fontFamily: 'HarmonyOS Sans SC' }]), CURRENT).patch.font, 'hei')
  assert.equal(mapReadStyle(JSON.stringify([{ fontSize: 20, fontFamily: 'Source Han Serif' }]), CURRENT).patch.font, 'song')
})

test('阅读样式 - 取默认那条；没标默认时取第一条并说明', () => {
  const two = JSON.stringify([
    { name: '甲', fontSize: 16 },
    { name: '乙', fontSize: 24, isDefault: true },
  ])
  assert.equal(mapReadStyle(two, CURRENT).patch.fontSize, 24)
  const none = JSON.stringify([{ name: '甲', fontSize: 16 }, { name: '乙', fontSize: 24 }])
  const fallback = mapReadStyle(none, CURRENT)
  assert.equal(fallback.patch.fontSize, 16)
  assert.ok(fallback.notes.some(note => note.includes('没标出默认')), fallback.notes.join('；'))
})

test('阅读样式 - 换算结果一律夹进合法区间，不把包里的极端值直接搬进来', () => {
  const wild = mapReadStyle(JSON.stringify([{ fontSize: 900, lineSpacing: 900, paragraphSpacing: 900, padding: 900, charSpacing: 900 }]), CURRENT)
  assert.equal(wild.patch.fontSize, undefined, '超出 10~40 的字号视为不可信，不套')
  assert.equal(wild.patch.lineHeight, 2.4)
  assert.equal(wild.patch.paragraphSpacing, 2)
  assert.equal(wild.patch.contentPadding, 120)
  assert.equal(wild.patch.letterSpacing, 1.5)
})

test('阅读样式 - 坏 JSON / 空数组 / 全不可映射时明确说"没做修改"', () => {
  assert.ok(mapReadStyle('{坏掉', CURRENT).notes[0].includes('不是合法 JSON'))
  assert.ok(mapReadStyle('[]', CURRENT).notes.some(note => note.includes('没有可读的样式')))
  const useless = mapReadStyle(JSON.stringify([{ name: '只有名字' }]), CURRENT)
  assert.equal(useless.applied.length, 0)
  assert.ok(useless.notes[0].includes('未做任何修改'), useless.notes.join('；'))
})

test('朗读引擎 - 只取带 {{text}} 占位的那条，并说明其余被忽略', () => {
  const raw = JSON.stringify([
    { name: '坏的', url: 'https://example.com/tts', enable: true },
    { name: '我的引擎', url: 'https://tts.example.com/say?text={{text}}&rate={{rate}}', enable: true },
    { name: '另一个', url: 'https://tts2.example.com/{{text}}' },
  ])
  const result = mapTtsEngine(raw)
  assert.equal(result.patch.ttsEngine, 'custom')
  assert.equal(result.patch.ttsCustomUrl, 'https://tts.example.com/say?text={{text}}&rate={{rate}}')
  assert.ok(result.applied[0].includes('我的引擎'), result.applied.join('、'))
  assert.ok(result.notes.some(note => note.includes('只取了启用的那一个')), result.notes.join('；'))
  assert.ok(result.notes.some(note => note.includes('1 个引擎的 URL')), result.notes.join('；'))
})

test('朗读引擎 - 一个可用都没有时不动任何设置', () => {
  const result = mapTtsEngine(JSON.stringify([{ name: '坏的', url: 'https://example.com/tts' }]))
  assert.equal(result.applied.length, 0)
  assert.deepEqual(result.patch, {})
  assert.ok(result.notes[0].includes('{{text}}'), result.notes.join('；'))
})

test('套用是叠加式的：没映射到的字段保持本机当前值', () => {
  const custom = { ...CURRENT, theme: 'dark' as const, textIndent: 0 }
  const merged = applyPreferencePatch(custom, mapReadStyle(JSON.stringify([{ fontSize: 21 }]), custom).patch)
  assert.equal(merged.theme, 'dark')
  assert.equal(merged.textIndent, 0)
  assert.equal(merged.fontSize, 21)
})
