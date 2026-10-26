import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createConverter,
  IDENTITY_CONVERTER,
  loadScriptConverter,
  parseScriptMode,
  SCRIPT_MODE_OPTIONS,
  type ScriptDict,
} from '../src/reader/scriptConvert'
import * as realDict from '../src/reader/dict/openccData'
import { defaultReaderSettings } from '../src/reader/readerSettings'

/**
 * 「简繁转换」（用户 2026-10-11 的 A–F 里 C 项）。
 *
 * 判据分两层：
 * ① 逻辑 —— 用一份**手写的小表**验最长匹配、逐字兜底、码点边界。小表是故意的：
 *    拿真表测逻辑的话，逻辑错了也可能因为表恰好兜住而变绿。
 * ② 数据 —— 拿真表跑一批**读者一眼能看出对错**的词（头发/干净/里面/公里…）。
 *    这一层才是"整页繁体里混着几个简体"的防线，光测逻辑测不出来。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const FAKE: ScriptDict = {
  S2T_CHARS: 'a b|𠀀 𠀁',
  S2T_PHRASES: 'ab X|abc Y',
  S2T_TW_CHARS: 'b B',
  T2S_CHARS: 'x y',
  T2S_PHRASES: 'xy Z',
}

test('parseScriptMode：只认 s2t / t2s，其余一律 off', () => {
  assert.equal(parseScriptMode('s2t'), 's2t')
  assert.equal(parseScriptMode('t2s'), 't2s')
  assert.equal(parseScriptMode('off'), 'off')
  for (const bad of [undefined, null, '', 'S2T', 'zh', 1, {}, ['s2t']]) {
    assert.equal(parseScriptMode(bad), 'off', `${JSON.stringify(bad)} 应当回 off`)
  }
})

test('off 档拿到的是恒等转换器，不是"转了个空"', () => {
  const off = createConverter('off', FAKE)
  assert.equal(off, IDENTITY_CONVERTER)
  assert.equal(off('头发 abc'), '头发 abc')
})

test('词组最长匹配优先，匹配不上才逐字查表', () => {
  const s2t = createConverter('s2t', FAKE)
  assert.equal(s2t('abc'), 'Y', 'abc 要赢过 ab')
  assert.equal(s2t('ab'), 'X')
  assert.equal(s2t('a'), 'B', '逐字查表 a→b，再过台港字形 b→B')
  assert.equal(s2t('z'), 'z', '表里没有的原样保留')
  assert.equal(s2t('abcz'), 'Yz')
})

test('按码点走：扩展 B 区的字（代理对）不许被劈成两半', () => {
  const s2t = createConverter('s2t', FAKE)
  assert.equal(s2t('𠀀'), '𠀁')
  assert.equal(s2t('x𠀀y'), 'x𠀁y')
})

test('繁→简 走另一套表，不和简→繁 串味', () => {
  const t2s = createConverter('t2s', FAKE)
  assert.equal(t2s('xy'), 'Z')
  assert.equal(t2s('xx'), 'yy')
  assert.equal(t2s('a'), 'a', '简→繁 的表不该在这里生效')
})

test('真表 · 简→繁：一词多形靠词组定，不是靠猜', () => {
  const s2t = createConverter('s2t', realDict)
  assert.equal(s2t('头发'), '頭髮', '发 在这里是髮')
  assert.equal(s2t('干净'), '乾淨')
  assert.equal(s2t('干杯'), '乾杯')
  assert.equal(s2t('干活'), '幹活')
  assert.equal(s2t('干涉'), '干涉', '干涉 的干就是干')
  assert.equal(s2t('里面'), '裡面')
  assert.equal(s2t('这里'), '這裡')
  assert.equal(s2t('一只猫'), '一隻貓', '只 在这里是隻')
  assert.equal(s2t('关系'), '關係')
  assert.equal(s2t('复杂'), '複雜')
  assert.equal(s2t('重复'), '重複')
  assert.equal(s2t('历史'), '歷史')
  assert.equal(s2t('日历'), '日曆')
  assert.equal(s2t('皇后'), '皇后', '皇后的后就是后，不是後')
  assert.equal(s2t('后来'), '後來')
})

test('真表 · 简→繁：字表够不到的常用词也得对（漏一个就是半简半繁）', () => {
  const s2t = createConverter('s2t', realDict)
  assert.equal(s2t('为什么'), '為什麼')
  assert.equal(s2t('面条'), '麵條')
  assert.equal(s2t('轻松'), '輕鬆')
  assert.equal(s2t('尽管'), '儘管')
  assert.equal(s2t('一干二净'), '一乾二淨')
  assert.equal(s2t('五脏六腑'), '五臟六腑')
})

test('真表 · 简→繁：公里 / 千里 里的里不是裏（最常见的那个坑）', () => {
  const s2t = createConverter('s2t', realDict)
  assert.equal(s2t('公里'), '公里')
  assert.equal(s2t('千里'), '千里')
})

test('真表 · 简→繁：末了过一遍台港字形（因为→因為 而不是因爲）', () => {
  const s2t = createConverter('s2t', realDict)
  assert.equal(s2t('因为'), '因為')
  assert.equal(s2t('伪造'), '偽造')
  assert.equal(s2t('学习'), '學習')
  assert.equal(s2t('时间'), '時間')
  assert.equal(s2t('网络'), '網絡')
})

test('真表 · 繁→简：台港正体和异体都要收得回来', () => {
  const t2s = createConverter('t2s', realDict)
  assert.equal(t2s('頭髮'), '头发')
  assert.equal(t2s('乾淨'), '干净')
  assert.equal(t2s('裡面'), '里面')
  assert.equal(t2s('因為'), '因为')
  assert.equal(t2s('爲什麼'), '为什么', '《康熙》那一路的爲也要认')
  assert.equal(t2s('偽造'), '伪造')
  assert.equal(t2s('複雜'), '复杂')
  assert.equal(t2s('一隻'), '一只')
  assert.equal(t2s('關係'), '关系')
  assert.equal(t2s('衆人'), '众人')
  assert.equal(t2s('啓動'), '启动')
  assert.equal(t2s('纔是'), '才是')
  assert.equal(t2s('公里'), '公里')
})

test('非中文原样穿过去：换行、ASCII、标点一个都不许动', () => {
  const s2t = createConverter('s2t', realDict)
  const t2s = createConverter('t2s', realDict)
  const raw = 'Chapter 12: OK!\n第二行\t「引号」——破折号 100%'
  assert.equal(s2t(raw).slice(0, 16), 'Chapter 12: OK!\n')
  assert.match(s2t(raw), /100%$/)
  assert.match(t2s(raw), /100%$/)
  assert.equal(s2t(''), '')
  assert.equal(t2s(''), '')
})

test('loadScriptConverter：off 不碰字典；同档只建一次', async () => {
  assert.equal(await loadScriptConverter('off'), IDENTITY_CONVERTER)
  const first = await loadScriptConverter('t2s')
  const second = await loadScriptConverter('t2s')
  assert.equal(first, second, '同一个档要复用，不要每次重造表')
  assert.equal(first('裡面'), '里面')
})

test('设置项：默认关着，读时过清洗', () => {
  assert.equal(defaultReaderSettings.scriptMode, 'off')
  assert.match(read('../src/reader/readerSettings.ts'), /scriptMode: parseScriptMode\(saved\.scriptMode\)/)
})

test('设置面板那三档与转换器是同一份清单', () => {
  assert.deepEqual(SCRIPT_MODE_OPTIONS.map(option => option.id), ['off', 's2t', 't2s'])
  const readerScreen = read('../src/reader/ReaderScreen.tsx')
  // PROPOSAL-020 P4：简繁这一节从「行为」页搬去了「设置」弹层（OtherSettingsPanel）。
  assert.match(read('../src/reader/OtherSettingsPanel.tsx'), /SCRIPT_MODE_OPTIONS\.map\(/, '面板要按同一份清单列，别各写一份')
  assert.match(readerScreen, /settings\.scriptMode/, '正文要真的按这一项走')
})

test('正文与章名都过转换器，不是只转正文', () => {
  const readerScreen = read('../src/reader/ReaderScreen.tsx')
  assert.match(readerScreen, /splitParagraphs\([^)]*\)\.map\(convert\)|splitBody\(/, '正文段落要过转换器')
  assert.match(readerScreen, /<h1>\{convert\(/, '章名也要转，否则正文繁体、标题简体')
})

test('转换器是函数：useState 初始化器必须包一层（否则被当惰性初始化器调用 → convert 变 undefined）', () => {
  /**
   * 这是 2026-10-11 真出过的事故：`useState<ScriptConverter>(IDENTITY_CONVERTER)`
   * 里 `IDENTITY_CONVERTER` 是函数，React 把它当**惰性初始化器**调用一次
   * （`(text => text)()` 无参 → `undefined`），于是 `convert` 是 `undefined`，
   * 阅读器一渲染就 `convert is not a function`、整屏"阅读器崩了"。
   * 静态渲染的门禁（paginate-flow 等）能逮住它，但那一层要起服务 + 浏览器；
   * 这里用源码判据把它钉在最便宜的一层，别再让同一句话第二次掉进同一个坑。
   */
  const readerScreen = read('../src/reader/ReaderScreen.tsx')
  assert.match(readerScreen, /useState<ScriptConverter>\(\(\) => IDENTITY_CONVERTER\)/, '初始化器要包一层 () => …')
  assert.doesNotMatch(readerScreen, /useState<ScriptConverter>\(IDENTITY_CONVERTER\)/, '裸函数会被当惰性初始化器调用，绝不能这么写')
  // 另一半：setter 同样要包一层（loaded 本身是函数，会被当 updater）
  assert.match(readerScreen, /setConvert\(\(\) => loaded\)/)
})
