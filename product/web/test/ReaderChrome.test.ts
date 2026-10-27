import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 阅读器外壳的章节导航位置（用户：底栏那行进度条整行不要了，上一章/下一章挪到顶栏）。
 *
 * 判据都在源码结构上：这套壳是 JSX + CSS，本仓库前端判据没有 jsdom，纯组件渲染跑不通
 * （与 ImmersiveDefault.test.ts 同一套办法）。每条都带反向对照，避免「扫到新写法」的空判。
 */
const SRC = path.resolve(import.meta.dirname, '../src')
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8')

const chrome = read('reader', 'Md3Chrome.tsx')
const legacy = read('reader', 'ReaderHeader.tsx')
const screen = read('reader', 'ReaderScreen.tsx')
const styles = read('styles.css')

test('底栏那行进度条彻底删除：DOM 与样式都不许再出现', () => {
  assert.doesNotMatch(chrome, /md3-progress-row/, 'Md3BottomBar 不许再渲染 .md3-progress-row')
  assert.doesNotMatch(chrome, /md3-progress\b/, '进度条那组 class 要从底栏清掉')
  assert.doesNotMatch(chrome, /type="range"/, '进度滑杆不该还挂在底栏里')
  assert.doesNotMatch(chrome, /onSeekChapter/, '滑杆的跳章回调一起删掉')
  assert.doesNotMatch(styles, /\.md3-progress-row/, '样式里那行进度条要清零')
  assert.doesNotMatch(styles, /\.md3-progress\b/, '进度条的样式要清零')
  // 反向对照：动作 pill 那一排**不在**本次删除范围（宽屏隐藏、窄屏可见）。
  assert.match(chrome, /md3-actions-row/, '底栏那排动作 pill 必须保留')
  assert.match(chrome, /className="md3-pill"/, '动作 pill 仍在')
})

test('上一章/下一章挪到 MD3 顶栏，且禁用态按 chapterIndex 判', () => {
  assert.match(chrome, /onPrevChapter/, 'Md3TopBar 要接 onPrevChapter')
  assert.match(chrome, /onNextChapter/, 'Md3TopBar 要接 onNextChapter')
  assert.match(chrome, /chapterIndex/, '禁用态要按 chapterIndex 算')
  assert.match(chrome, /aria-label="上一章"/, '顶栏要有上一章按钮')
  assert.match(chrome, /aria-label="下一章"/, '顶栏要有下一章按钮')
  assert.match(chrome, /disabled=\{atStart\}/, '首章禁用上一章')
  assert.match(chrome, /disabled=\{atEnd\}/, '末章禁用下一章')
  // 旧底栏不再接收这两个动作
  assert.doesNotMatch(chrome, /onPrev:/, '底栏不该再接收 onPrev')
  assert.doesNotMatch(chrome, /onNext:/, '底栏不该再接收 onNext')
})

test('legacy 顶栏同样有上一章/下一章，别只改默认界面', () => {
  assert.match(legacy, /onPrevChapter/, 'ReaderHeader 要接 onPrevChapter')
  assert.match(legacy, /onNextChapter/, 'ReaderHeader 要接 onNextChapter')
  assert.match(legacy, /label="上一章"/, 'legacy 顶栏要有上一章按钮')
  assert.match(legacy, /label="下一章"/, 'legacy 顶栏要有下一章按钮')
  assert.match(legacy, /disabled=\{atStart\}/, 'legacy 首章禁用上一章')
  assert.match(legacy, /disabled=\{atEnd\}/, 'legacy 末章禁用下一章')
})

test('ReaderScreen 把章节导航接到两套顶栏，并沿用旧的先落进度再切章', () => {
  assert.match(screen, /onPrevChapter=\{goPrevChapter\}/, '默认顶栏接 goPrevChapter')
  assert.match(screen, /onNextChapter=\{goNextChapter\}/, '默认顶栏接 goNextChapter')
  assert.match(screen, /const goPrevChapter = useCallback\(\(\) => \{\s*if \(chapterIndex <= 0\) return\s*persist\(\)/, '上一章：首章直接返回，否则先落进度')
  assert.match(screen, /const goNextChapter = useCallback\(\(\) => \{\s*if \(chapterIndex >= currentBook\.chapters\.length - 1\) return\s*persist\(\)/, '下一章：末章直接返回，否则先落进度')
  // 底栏不再传被删掉的 props
  assert.doesNotMatch(screen, /onSeekChapter=/, 'ReaderScreen 不该再给底栏传滑杆回调')
})
