import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_READER_MENU,
  moveReaderMenu,
  parseReaderMenu,
  READER_MENU_ITEMS,
  toggleReaderMenu,
  type ReaderMenuAction,
} from '../src/reader/readerMenu'
import { defaultReaderSettings } from '../src/reader/readerSettings'

/**
 * 「阅读菜单可配置」（用户 2026-10-11）。判据钉三件事：清单是唯一来源、读回来的值一定安全、
 * 工具栏与配置面板用的是同一份 —— 不靠"页面上看着有按钮"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const readerScreen = read('../src/reader/ReaderScreen.tsx')

test('菜单清单是唯一来源：id 不重复、默认顺序就是登记顺序', () => {
  const ids = READER_MENU_ITEMS.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  assert.deepEqual(DEFAULT_READER_MENU, ids)
  // 默认顺序必须等于改动前工具栏那一排（切换书源 → 阅读设置 → 全屏 → 朗读），不动就不漂
  assert.deepEqual(DEFAULT_READER_MENU, ['switchSource', 'settings', 'fullscreen', 'tts'])
})

test('parseReaderMenu：只认登记过的、去重、保序', () => {
  assert.deepEqual(parseReaderMenu(['tts', 'switchSource', 'tts', 'nope']), ['tts', 'switchSource'])
  assert.deepEqual(parseReaderMenu(['settings', 'fullscreen']), ['settings', 'fullscreen'])
})

test('parseReaderMenu：读不出合法项时回默认（工具栏是设置抽屉的入口，不许空）', () => {
  assert.deepEqual(parseReaderMenu(undefined), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu('tts'), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu([]), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu(['nope', 'x']), [...DEFAULT_READER_MENU])
})

test('toggleReaderMenu：显示 / 隐藏；不许把最后一项也去掉', () => {
  assert.deepEqual(toggleReaderMenu(['switchSource', 'settings'], 'tts'), ['switchSource', 'settings', 'tts'])
  assert.deepEqual(toggleReaderMenu(['switchSource', 'settings', 'tts'], 'settings'), ['switchSource', 'tts'])
  assert.deepEqual(toggleReaderMenu(['tts'], 'tts'), ['tts'], '只剩一项时不许清空')
})

test('moveReaderMenu：上移 / 下移；到头不动', () => {
  const base: ReaderMenuAction[] = ['switchSource', 'settings', 'fullscreen', 'tts']
  assert.deepEqual(moveReaderMenu(base, 'settings', -1), ['settings', 'switchSource', 'fullscreen', 'tts'])
  assert.deepEqual(moveReaderMenu(base, 'settings', 1), ['switchSource', 'fullscreen', 'settings', 'tts'])
  assert.deepEqual(moveReaderMenu(base, 'switchSource', -1), base, '第一项上移不动')
  assert.deepEqual(moveReaderMenu(base, 'tts', 1), base, '最后一项下移不动')
  assert.equal(moveReaderMenu(base, 'nope' as ReaderMenuAction, 1), base, '找不到就原样返回')
})

test('工具栏按 settings.menuItems 渲染，且与配置面板同源', () => {
  // 工具栏在 PROPOSAL-019 F 里抽成了 ReaderHeader：清单从 settings.menuItems 传进去，逐项渲染。
  assert.match(readerScreen, /menuItems=\{settings\.menuItems\}/, '工具栏要拿 settings.menuItems')
  assert.match(read('../src/reader/ReaderHeader.tsx'), /menuItems\.map\(/, '工具栏要逐项渲染')
  assert.match(read('../src/reader/OtherSettingsPanel.tsx'), /READER_MENU_ITEMS\.map\(/, '配置面板要按同一份清单列（PROPOSAL-020 P4 后这一节住在「设置」弹层）')
  // 旧版那四个写死的按钮不该再直接挂在 header 里（否则配置改了它也不动）
  assert.doesNotMatch(readerScreen, /<IconButton label="切换书源" icon="sliders"/)
})

test('设置项随包存读：默认带 menuItems，读时过清洗', () => {
  assert.deepEqual(defaultReaderSettings.menuItems, DEFAULT_READER_MENU)
  assert.match(read('../src/reader/readerSettings.ts'), /menuItems: parseReaderMenu\(saved\.menuItems\)/)
})
