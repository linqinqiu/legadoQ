import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 阅读器外壳的入口分布：章节导航与笔记各自只留必要的一份。
 *
 * 用户 2026-11-02：「这顶部导航栏内容有冲突的要将上下一章的功能删掉，部分重复的功能也改掉」。
 * 上一章 / 下一章走翻页键、点按区、键盘 ←→ 与目录抽屉，顶栏不再摆；笔记入口只留
 * 宽屏顶栏 / 窄屏底栏那一份，目录头不再重复。legacy 回退档没有别处常驻入口，保留原样。
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

test('MD3 顶栏不再摆上一章/下一章（翻页键/点按区/键盘/目录已经覆盖）', () => {
  assert.doesNotMatch(chrome, /onPrevChapter|onNextChapter/, 'Md3TopBar 不该再接章节回调')
  assert.doesNotMatch(chrome, /aria-label="上一章"|aria-label="下一章"/, '顶栏不该再有这两颗键')
  assert.doesNotMatch(chrome, /disabled=\{atStart\}|disabled=\{atEnd\}/, '章节禁用态判据一起走')
  assert.doesNotMatch(chrome, /chapterIndex|totalChapters/, '章节序号不再进顶栏 props')
  // 反向对照：顶栏不是空壳，返回与目录仍在（删过头会只剩标题）。
  assert.match(chrome, /aria-label="返回书架"/, '返回书架仍在')
  assert.match(chrome, /aria-label="目录"/, '目录仍在')
  // 旧底栏也不再接收这两个动作
  assert.doesNotMatch(chrome, /onPrev:/, '底栏不该再接收 onPrev')
  assert.doesNotMatch(chrome, /onNext:/, '底栏不该再接收 onNext')
})

test('legacy 回退档保留上一章/下一章（没有别的常驻入口）', () => {
  assert.match(legacy, /onPrevChapter/, 'ReaderHeader 要接 onPrevChapter')
  assert.match(legacy, /onNextChapter/, 'ReaderHeader 要接 onNextChapter')
  assert.match(legacy, /label="上一章"/, 'legacy 顶栏要有上一章按钮')
  assert.match(legacy, /label="下一章"/, 'legacy 顶栏要有下一章按钮')
  assert.match(legacy, /disabled=\{atStart\}/, 'legacy 首章禁用上一章')
  assert.match(legacy, /disabled=\{atEnd\}/, 'legacy 末章禁用下一章')
})

test('ReaderScreen 只把章节导航交给 legacy 顶栏，并沿用旧的先落进度再切章', () => {
  const md3Call = /<Md3TopBar([\s\S]*?)\/>/.exec(screen)?.[1] ?? ''
  assert.ok(md3Call, '找不到 Md3TopBar 调用（正则会退化成对空串断言）')
  assert.doesNotMatch(md3Call, /chapterIndex|totalChapters|onPrevChapter|onNextChapter/, 'MD3 顶栏不该再接章节导航')
  // 回退档那一份还在；计数写死一次，避免复制粘贴出第二个入口。
  assert.equal((screen.match(/onPrevChapter=\{goPrevChapter\}/g) ?? []).length, 1, '上一章只该接给 legacy 顶栏')
  assert.equal((screen.match(/onNextChapter=\{goNextChapter\}/g) ?? []).length, 1, '下一章只该接给 legacy 顶栏')
  assert.match(screen, /const goPrevChapter = useCallback\(\(\) => \{\s*if \(chapterIndex <= 0\) return\s*persist\(\)/, '上一章：首章直接返回，否则先落进度')
  assert.match(screen, /const goNextChapter = useCallback\(\(\) => \{\s*if \(chapterIndex >= currentBook\.chapters\.length - 1\) return\s*persist\(\)/, '下一章：末章直接返回，否则先落进度')
  // 底栏不再传被删掉的 props
  assert.doesNotMatch(screen, /onSeekChapter=/, 'ReaderScreen 不该再给底栏传滑杆回调')
})

/**
 * 笔记入口只留一份（用户 2026-11-02「部分重复的功能也改掉」）：
 * 宽屏顶栏与窄屏底栏各一处，目录头不再摆第二个「笔记」；图标也从 bookmark 改成 edit，
 * 免得和目录头的「加入书架」书签并排时像同一件事。
 */
test('笔记入口只留一份：目录头不再重复，图标与书架键区分', () => {
  const tocHeader = read('reader', 'TocDrawerHeader.tsx')
  assert.doesNotMatch(tocHeader, /onToggleNotes|notesCount/, '目录头不再接笔记开关')
  assert.doesNotMatch(tocHeader, /笔记（/, '目录头没有第二个笔记入口')
  assert.match(tocHeader, /label="回到目录"[\s\S]{0,60}?icon="arrowLeft"/, '「回到目录」要能返回，且别和倒序键共用 list 图标')
  assert.match(tocHeader, /label=\{inShelf \? '移出书架' : '加入书架'\}[\s\S]{0,80}?icon="bookmark"/, '书架键仍是 bookmark')
  assert.equal((screen.match(/onToggleNotes=/g) ?? []).length, 2, '笔记入口只该有顶栏与底栏两处')
  assert.match(screen, /onBackToToc=\{\(\) => setNotesPanel\(false\)\}/, '「回到目录」要真的把面板切回目录')
  // 顶栏与底栏的笔记键改用 edit：同一个 bookmark 不再分别表示「书架」和「笔记」。
  assert.match(chrome, /md3-topbar-notes[\s\S]{0,300}?<Icon name="edit" \/>/, '顶栏笔记键用 edit 图标')
  assert.match(chrome, /aria-label=\{`笔记（\$\{notesCount\}）`\}[\s\S]{0,120}?<Icon name="edit" \/>/, '窄屏底栏笔记 pill 也用 edit')
  assert.doesNotMatch(chrome, /aria-label=\{`笔记（\$\{notesCount\}）`\}[\s\S]{0,120}?<Icon name="bookmark" \/>/, '笔记入口不该再用 bookmark 图标')
})

/**
 * 用户 2026-11-02：「阅读界面多余的按钮比如翻页，有些功能重复」。
 *
 * 翻页已经有三条路：左右点按区（`tapZones`）、键盘左右键、滚轮/滑动。页脚再摆一排
 * 「上一页 / 下一页」是同一件事的第三份可见入口；滚动模式那条「上一章 / 进度 / 下一章」
 * 也和键盘/点按区 + 目录抽屉重复。这条判据盯的是"别再长回来"。
 */
test('分页页脚只报状态，不再挂翻页键', () => {
  const footer = /<footer className="reader-paginated-footer">([\s\S]*?)<\/footer>/.exec(screen)?.[1] ?? ''
  assert.ok(footer, '找不到分页页脚（正则会退化成对空串断言）')
  assert.doesNotMatch(footer, /<button/, '页脚又出现按钮了：翻页/跳章已有三条入口，这里是第四份')
  assert.match(footer, /reader-paginated-pagecount/, '页码是状态，要保留')
  assert.doesNotMatch(styles, /\.reader-paginated-pager/, '旧的翻页键容器样式要清零')
})

test('滚动模式的章节页脚与旧移动导航只在 legacy 外壳渲染', () => {
  assert.match(screen, /\{!uiV2 && content && <footer className="reader-navigation">/,
    'MD3 下滚动模式不该再有文末「上一章 / 进度 / 下一章」——键盘/点按区与目录已经覆盖')
  assert.match(screen, /\{!uiV2 && <nav className="mobile-reader-nav">/,
    'MD3 下旧移动导航会和新底栏叠在一起（390px 实测三层相压），只能留给 legacy')
})

/**
 * 窄屏顶栏去重：底栏已经承载 目录 / 搜书 / 笔记 / 朗读 / 设置，顶栏不要再来一份。
 * 这条同时钉死层叠顺序 —— 隐藏规则必须排在 `.md3-icon-btn` 的 `display: grid` 之后，
 * 否则同权重被盖回去，实拍时 390px 顶栏照样十颗图标、标题被挤成一条缝。
 */
test('窄屏顶栏不重复底栏动作，且隐藏规则排在图标基础样式之后', () => {
  for (const cls of ['md3-topbar-toc', 'md3-topbar-search', 'md3-topbar-notes']) {
    assert.ok(chrome.includes(cls), `顶栏缺少定位类 ${cls}，窄屏无法只藏重复项`)
  }
  assert.match(chrome, /const className = `md3-icon-btn md3-action-\$\{id\}`/,
    '可配置动作要带上 md3-action-<id>，窄屏才能按动作藏')
  const hide = /@media \(max-width: 959px\) \{[\s\S]*?\.md3-topbar-toc,[\s\S]*?\.md3-topbar-search,[\s\S]*?\.md3-topbar-notes,[\s\S]*?\.md3-action-settings,[\s\S]*?\.md3-action-tts \{ display: none; \}/
  assert.match(styles, hide, '窄屏隐藏 目录/搜书/笔记/朗读/设置 的规则不在了')
  const hideAt = styles.search(/@media \(max-width: 959px\) \{[\s\S]*?\.md3-topbar-toc,/)
  const baseAt = styles.indexOf('.md3-icon-btn {')
  assert.ok(hideAt > baseAt,
    '隐藏规则排在 .md3-icon-btn 前面会被它的 display:grid 盖回去（2026-11-02 实拍确认过）')
})
