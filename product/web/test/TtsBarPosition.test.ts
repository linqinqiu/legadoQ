import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { clampPosition } from '../src/reader/ttsBarPosition'

/**
 * 朗读悬浮条的位置（用户 2026-10-03：「长按可以调节位置，防止遮挡文本内容，
 * 记忆下次启动还是上次的位置，双击『朗读本章』恢复默认位置」）。
 * 拖动手势要在真浏览器里量（`tts-bar-check` 那一段），这里钉的是纯算术与接线：
 * 位置怎么夹、默认位置归谁、双击那颗键真的接没接上。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

/**
 * `clampPosition` 会去量窄屏底部导航的实测高度（`bottomReserve`），所以这里要连带桩一个
 * `document`。`navHeight` 不给 = 页面上没有那条导航（宽屏就是这种情况），下边界只留边距。
 */
function withViewport(width: number, height: number, run: () => void, navHeight?: number) {
  const g = globalThis as { window?: unknown; document?: unknown; getComputedStyle?: unknown }
  const previous = { window: g.window, document: g.document, getComputedStyle: g.getComputedStyle }
  const nav = navHeight === undefined ? null : { getBoundingClientRect: () => ({ height: navHeight }) }
  g.window = { innerWidth: width, innerHeight: height }
  g.document = { querySelector: () => nav }
  g.getComputedStyle = () => ({ display: nav ? 'flex' : 'none' })
  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete g[key as keyof typeof g]
      else (g as Record<string, unknown>)[key] = value
    }
  }
}

test('clampPosition - 拖出视口会被夹回来，永远留 8px 边距（不留"找不回来"的位置）', () => {
  withViewport(1440, 900, () => {
    assert.deepEqual(clampPosition({ x: 500, y: 300 }, { width: 600, height: 48 }), { x: 500, y: 300 })
    // 右溢出：bar 宽 600 → 最大 x = 1440 - 600 - 8
    assert.deepEqual(clampPosition({ x: 99999, y: 300 }, { width: 600, height: 48 }), { x: 832, y: 300 })
    assert.deepEqual(clampPosition({ x: -500, y: 300 }, { width: 600, height: 48 }), { x: 8, y: 300 })
    assert.deepEqual(clampPosition({ x: 500, y: 99999 }, { width: 600, height: 48 }), { x: 500, y: 844 })
    // 视口比 bar 还窄时也不能给出负的最大值（那会让 bar 从左边消失）
    assert.deepEqual(clampPosition({ x: 4000, y: 4000 }, { width: 2000, height: 48 }).x, 8)
  })
})

test('clampPosition - 窄屏要给底部导航让位，不然六颗键被糊住', () => {
  // 有 56px 高的导航时，下边界 = 900 - 48 - 56 - 8
  withViewport(390, 900, () => {
    assert.deepEqual(clampPosition({ x: 8, y: 99999 }, { width: 300, height: 48 }), { x: 8, y: 788 })
  }, 56)
  // 没那条导航（宽屏）时回到只留边距，两档差 56px
  withViewport(390, 900, () => {
    assert.deepEqual(clampPosition({ x: 8, y: 99999 }, { width: 300, height: 48 }), { x: 8, y: 844 })
  })
})

test('默认位置归 CSS：没拖过时一条内联样式都不写，"恢复默认"= 清掉那份覆盖', () => {
  const bar = read('../src/reader/TtsPlayerBar.tsx')
  assert.match(bar, /style=\{style\}/, '位置由 hook 给，组件自己不算坐标')
  assert.match(bar, /className="tts-floating-bar"/, '默认位置仍然由样式表那一档决定')
  const hook = read('../src/reader/ttsBarPosition.ts')
  assert.match(hook, /position \? \{ left: position\.x[\s\S]{0,120}transform: 'none' \} as const : undefined/,
    '没拖过 = undefined，不写内联样式（写了就有第二个事实来源）')
  assert.match(hook, /localStorage\.removeItem\(STORAGE_KEY\)/, '复位是把那份覆盖清掉，不是写回一组常量坐标')
  assert.match(hook, /legado-tts-bar-reset/, '清完要通知正在显示的那条 bar，不然它停在原地')
})

test('长按才进入拖动，且按在按钮上不抓走整条', () => {
  const hook = read('../src/reader/ttsBarPosition.ts')
  assert.match(hook, /const HOLD_MS = 250/, '按住 250ms 才算"抓起来"')
  assert.match(hook, /const SLOP = 9/, '容差之内松手 = 一次普通点击')
  assert.match(hook, /if \(!active\.moved && Math\.hypot\(dx, dy\) < SLOP\) return/,
    '过了容差才开始跟手（长按但没移动 = 一次点击）')
  assert.match(hook, /if \(active\.moved\) \{[\s\S]{0,240}localStorage\.setItem\(STORAGE_KEY/,
    '没真的移动过就不写位置')
  assert.match(hook, /closest\('button, a, input, select, textarea'\)/,
    'bar 上六个键都是控件，按在它们上面不该把播放器拖走')
  // 拖完那一下浏览器还会补一次 click，会误触发按到的那个按钮 —— 只吞这一次
  assert.match(hook, /suppressClick\.current = false/, '抑制标记用完就落回去，不能永久吞点击')
})

test('双击「朗读本章」接上了复位', () => {
  const reader = read('../src/reader/ReaderScreen.tsx')
  // 工具栏在 PROPOSAL-019 F 里抽成了 ReaderHeader：双击回调从 ReaderScreen 传下去，两边都要接上。
  const header = read('../src/reader/ReaderHeader.tsx')
  assert.match(header, /onDoubleClick=\{onResetTtsBar\}/)
  assert.match(reader, /onResetTtsBar=\{resetTtsBarPosition\}/)
  assert.match(reader, /import \{ resetTtsBarPosition \} from '\.\/ttsBarPosition'/)
})
