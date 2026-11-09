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
} from '../src/features/reader/interaction/readerMenu'
import { defaultReaderSettings } from '../src/features/reader/settingsPanel/readerSettings'

/**
 * 「阅读菜单可配置」（用户 2026-10-11）。判据钉三件事：清单是唯一来源、读回来的值一定安全、
 * 工具栏与配置面板用的是同一份 —— 不靠"页面上看着有按钮"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const readerScreen = read('../src/features/reader/ReaderScreen.tsx')

test('菜单清单是唯一来源：id 不重复、默认顺序就是登记顺序', () => {
  const ids = READER_MENU_ITEMS.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  assert.deepEqual(DEFAULT_READER_MENU, ids)
  // 「切换书源」已从菜单撤掉：目录抽屉顶部常年有「换源」，顶栏再放一份就是同一个动作的两个入口。
  assert.deepEqual(DEFAULT_READER_MENU, ['settings', 'fullscreen', 'tts'])
})

test('parseReaderMenu：只认登记过的、去重、保序', () => {
  assert.deepEqual(parseReaderMenu(['tts', 'switchSource', 'tts', 'nope']), ['tts'], '旧设置里的 switchSource 当未登记项丢掉')
  assert.deepEqual(parseReaderMenu(['settings', 'fullscreen']), ['settings', 'fullscreen'])
})

test('parseReaderMenu：读不出合法项时回默认（工具栏是设置抽屉的入口，不许空）', () => {
  assert.deepEqual(parseReaderMenu(undefined), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu('tts'), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu([]), [...DEFAULT_READER_MENU])
  assert.deepEqual(parseReaderMenu(['nope', 'x']), [...DEFAULT_READER_MENU])
})

test('toggleReaderMenu：显示 / 隐藏；不许把最后一项也去掉', () => {
  assert.deepEqual(toggleReaderMenu(['settings', 'fullscreen'], 'tts'), ['settings', 'fullscreen', 'tts'])
  assert.deepEqual(toggleReaderMenu(['settings', 'fullscreen', 'tts'], 'settings'), ['fullscreen', 'tts'])
  assert.deepEqual(toggleReaderMenu(['tts'], 'tts'), ['tts'], '只剩一项时不许清空')
})

test('moveReaderMenu：上移 / 下移；到头不动', () => {
  const base: ReaderMenuAction[] = ['settings', 'fullscreen', 'tts']
  assert.deepEqual(moveReaderMenu(base, 'fullscreen', -1), ['fullscreen', 'settings', 'tts'])
  assert.deepEqual(moveReaderMenu(base, 'fullscreen', 1), ['settings', 'tts', 'fullscreen'])
  assert.deepEqual(moveReaderMenu(base, 'settings', -1), base, '第一项上移不动')
  assert.deepEqual(moveReaderMenu(base, 'tts', 1), base, '最后一项下移不动')
  assert.equal(moveReaderMenu(base, 'nope' as ReaderMenuAction, 1), base, '找不到就原样返回')
})

test('工具栏按 settings.menuItems 渲染，且与配置面板同源', () => {
  // 工具栏在 PROPOSAL-019 F 里抽成 ReaderHeader，外壳再收进 ReaderChrome：清单从 settings.menuItems 传进去。
  const shell = read('../src/features/reader/ReaderChrome.tsx')
  assert.match(shell, /menuItems=\{settings\.menuItems\}/, '工具栏要拿 settings.menuItems')
  assert.match(read('../src/features/reader/ReaderHeader.tsx'), /menuItems\.map\(/, '工具栏要逐项渲染')
  assert.match(read('../src/features/reader/settingsPanel/OtherSettingsPanel.tsx'), /READER_MENU_ITEMS\.map\(/, '配置面板要按同一份清单列（PROPOSAL-020 P4 后这一节住在「设置」弹层）')
  // 旧版那四个写死的按钮不该再直接挂在 header 里（否则配置改了它也不动）
  assert.doesNotMatch(readerScreen, /<IconButton label="切换书源" icon="sliders"/)
  // 「换源」只留在目录抽屉顶部：两套顶栏都不许再挂；抽屉那条是唯一可见入口。
  assert.doesNotMatch(readerScreen, /onOpenSourceSwitch=\{\(\) => setShowSourceSwitch\(true\)\}/,
    '顶栏不该再直接接换源（目录抽屉已经有一条）')
  assert.match(read('../src/features/reader/dialogs/TocDrawerHeader.tsx'), /label="换源"/, '目录抽屉顶部的换源要保留')
})

test('桌面端目录是普通覆盖式抽屉：没有固定侧栏与拖宽', () => {
  const header = read('../src/features/reader/dialogs/TocDrawerHeader.tsx')
  const styles = read('../src/styles.css')
  assert.doesNotMatch(header, /desktop-pin-btn|onTogglePin|pinOff|sidebarPinned/, '抽屉里不再有固定键与固定态文案')
  assert.match(header, /label="关闭目录"/, '关闭键只负责关闭抽屉')
  assert.doesNotMatch(readerScreen, /sidebarPinned|sidebar-pinned|sidebarWidth|reader-sidebar-resizer/, '调用方不再有固定侧栏状态、拖宽与分隔条')
  assert.doesNotMatch(styles, /sidebar-pinned|reader-sidebar-resizer/, '样式里不再有固定侧栏与拖宽')
  const shell = read('../src/features/reader/ReaderChrome.tsx')
  const tocToggles = shell.match(/onToggleToc=\{actions\.onToggleToc\}/g) ?? []
  assert.equal(tocToggles.length, 3, '顶栏（新旧两套）与底栏的目录键都只切换覆盖式抽屉')
  assert.match(shell, /activeDrawer === 'toc' \|\| !uiV2/, '目录抽屉打开时始终有遮罩')
})

test('设置项随包存读：默认带 menuItems，读时过清洗', () => {
  assert.deepEqual(defaultReaderSettings.menuItems, DEFAULT_READER_MENU)
  assert.match(read('../src/features/reader/settingsPanel/readerSettings.ts'), /menuItems: parseReaderMenu\(saved\.menuItems\)/)
})
