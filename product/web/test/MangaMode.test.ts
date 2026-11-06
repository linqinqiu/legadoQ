import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  MANGA_SPREAD_MIN_WIDTH,
  mangaFraction,
  mangaIndexAtOffset,
  mangaNextStart,
  mangaPageLabel,
  mangaPages,
  mangaPrevStart,
  mangaSpreadPages,
  mangaSpreadSize,
  mangaSpreadStart,
} from '../src/features/reader/content/mangaPages'

/**
 * 漫画分页算术（双页对开 / 从右到左 / 页进度换算）。
 *
 * 这套判据盯的是**边界**：末屏只剩一张、页号对齐到偶数、往回翻落末屏、
 * 存档偏移落在两张图之间。这些在 DOM 里试很贵，所以算术单独抽出来钉住。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const paragraphs = [
  '第一张前的说明',
  '![图片](https://img.example.com/1.jpg)',
  '![图片](https://img.example.com/2.jpg)',
  '中间夹一行字',
  '![图片](https://img.example.com/3.jpg)',
]

test('只把图片占位行当页，并记住它在段落里的位置', () => {
  const pages = mangaPages(paragraphs)
  assert.deepEqual(pages.map(page => page.url), [
    'https://img.example.com/1.jpg',
    'https://img.example.com/2.jpg',
    'https://img.example.com/3.jpg',
  ])
  assert.deepEqual(pages.map(page => page.paragraph), [1, 2, 4], '页号 → 段落下标要留着，页进度靠它换算')
  assert.deepEqual(mangaPages(['只有文字']), [])
})

test('双页要宽屏，窄屏自动退回一张', () => {
  assert.equal(mangaSpreadSize(true, MANGA_SPREAD_MIN_WIDTH), 2)
  assert.equal(mangaSpreadSize(true, MANGA_SPREAD_MIN_WIDTH - 1), 1, '窄屏两张各自不到 300px，不如一张大图')
  assert.equal(mangaSpreadSize(false, 2000), 1, '用户关掉就一律单页')
})

test('页号按屏对齐：第 3 张也要从第 2 张开始配对', () => {
  assert.equal(mangaSpreadStart(3, 2), 2)
  assert.equal(mangaSpreadStart(2, 2), 2)
  assert.equal(mangaSpreadStart(1, 2), 0)
  assert.equal(mangaSpreadStart(3, 1), 3, '单页原样，不吸到偶数')
  assert.equal(mangaSpreadStart(-1, 2), 0)
})

test('翻屏边界：末屏只剩一张也能停住，到底返回 null', () => {
  // 5 张、双页：0 → 2 → 4（末屏只有第 5 张），再翻就是换章
  assert.equal(mangaNextStart(0, 2, 5), 2)
  assert.equal(mangaNextStart(2, 2, 5), 4)
  assert.equal(mangaNextStart(4, 2, 5), null)
  assert.equal(mangaNextStart(3, 2, 5), 4, '落在奇数页也要按屏对齐后再前进')
  // 4 张、双页：0 → 2，第 3–4 张正好一屏
  assert.equal(mangaNextStart(0, 2, 4), 2)
  assert.equal(mangaNextStart(2, 2, 4), null)
  // 单页
  assert.equal(mangaNextStart(0, 1, 2), 1)
  assert.equal(mangaNextStart(1, 1, 2), null)
  // 往回
  assert.equal(mangaPrevStart(2, 2), 0)
  assert.equal(mangaPrevStart(3, 2), 0)
  assert.equal(mangaPrevStart(0, 2), null, '第一屏再往回是换上一章（落在末屏）')
  assert.equal(mangaPrevStart(1, 1), 0)
})

test('从右到左＝前一张排右边，页号本身不反过来', () => {
  assert.deepEqual(mangaSpreadPages(0, 2, 5, 'ltr'), [0, 1])
  assert.deepEqual(mangaSpreadPages(0, 2, 5, 'rtl'), [1, 0])
  assert.deepEqual(mangaSpreadPages(4, 2, 5, 'rtl'), [4], '末屏只有一张时不倒序')
  assert.deepEqual(mangaSpreadPages(4, 2, 5, 'ltr'), [4])
  assert.deepEqual(mangaSpreadPages(0, 1, 5, 'rtl'), [0], '单页模式顺序无关')
})

test('存档的字符偏移换回页号：落在两页之间取前一张', () => {
  const pages = mangaPages(paragraphs)
  // 段起点：0 / 9 / 28 / 47 / 55（按"段长 + 换行"累加）
  const starts: number[] = []
  let running = 0
  for (const line of paragraphs) { starts.push(running); running += line.length + 1 }
  assert.equal(mangaIndexAtOffset(starts, pages, 0), 0, '章首')
  assert.equal(mangaIndexAtOffset(starts, pages, starts[1]), 0, '正好第一张')
  assert.equal(mangaIndexAtOffset(starts, pages, starts[1] + 5), 0, '第一张中间')
  assert.equal(mangaIndexAtOffset(starts, pages, starts[2]), 1, '正好第二张')
  assert.equal(mangaIndexAtOffset(starts, pages, starts[3]), 1, '夹在第二、三张之间的文字仍算第二张')
  assert.equal(mangaIndexAtOffset(starts, pages, starts[4] + 99), 2, '末张之后夹到末张')
  assert.equal(mangaIndexAtOffset([], pages, 100), 0, '没有正文时退回第一张')
})

test('角标与章内进度', () => {
  assert.equal(mangaPageLabel(0, 2, 60), '1–2 / 60')
  assert.equal(mangaPageLabel(58, 2, 60), '59–60 / 60')
  assert.equal(mangaPageLabel(59, 2, 60), '60 / 60', '末屏只剩一张时不写成 60–61')
  assert.equal(mangaPageLabel(2, 1, 60), '3 / 60')
  assert.equal(mangaFraction(0, 60), 0)
  assert.equal(mangaFraction(59, 60), 1)
  assert.equal(mangaFraction(0, 1), 0, '只有一张时没有"章内进度"可言')
})

test('接线：双页顺序、按屏翻页、页进度都接上了', () => {
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /const mangaSpread = mangaSpreadSize\(settings\.mangaSpread, viewportWidth\)/)
  assert.match(screen, /const mangaStart = mangaSpreadStart\(/, '双页要按屏对齐')
  assert.match(screen, /mangaSpreadPages\(mangaStart, mangaSpread, mangaImages\.length, settings\.mangaDirection\)/)
  assert.match(screen, /const next = mangaNextStart\(mangaIndex, mangaSpread, mangaImages\.length\)/, '按屏前进')
  assert.match(screen, /const prev = mangaPrevStart\(mangaIndex, mangaSpread\)/, '按屏后退')
  assert.match(screen, /if \(isMangaMode\) mangaTargetRef\.current = targetPage === 'last' \? 'last' : 'first'/, '跨章落点')
  assert.match(screen, /if \(isMangaMode\) \{\s*const page = mangaRef\.current\.pages\[mangaRef\.current\.start\]/, '页号换成字符偏移落库')
  assert.match(screen, /mangaIndexAtOffset\(paragraphStarts, mangaPageList, saved\.charOffset\)/, '重开回到上次那一屏')
  assert.match(screen, /reportProgress\(\{ chapterIndex, total: currentBook\.chapters\.length, fraction: position \}\)/, '漫画按屏上报进度')
  assert.match(screen, /const paginate = settings\.pageMode === 'paginate' \|\| isMangaMode/, '滚动模式下漫画也按屏翻')
  assert.match(screen, /manga-page-spread/, '双页要挂得上去')
})

test('设置项：双页与顺序有出厂值、有清洗、有入口', () => {
  const settings = read('../src/features/reader/settingsPanel/readerSettings.ts')
  assert.match(settings, /mangaSpread: boolean/)
  assert.match(settings, /mangaDirection: MangaDirection/)
  assert.match(settings, /mangaSpread: false/, '出厂单页 —— 与改动前一致')
  assert.match(settings, /mangaDirection: saved\.mangaDirection === 'rtl' \? 'rtl' : 'ltr'/, '脏数据回落')
  const tab = read('../src/features/reader/settingsPanel/BehaviorTab.tsx')
  assert.match(tab, /漫画双页/)
  assert.match(tab, /从右到左/)
})
