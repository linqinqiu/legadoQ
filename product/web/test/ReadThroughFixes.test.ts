import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { removeCut } from '../src/reader/tapZones'
import { splitSentences } from '../src/reader/ttsTextProcessor'
import { searchStore } from '../src/lib/searchStore'

/**
 * 2026-10-11 全量通读那轮改掉的缺陷，在 0.7.0 这条线上重新落一次 —— 判据也跟着回来。
 *
 * 为什么要专门记一句：main 当时只取走了文档提交，带代码修复的 `2fd86de` 与
 * `CodeMapFresh` / `ShelfState` 两个文件从没进过这条线，于是同一批缺陷悄悄回到了树上，
 * 而**套件全绿**。"改了却没判据盯着"和"判据被丢了"都属于静默失效，所以这里每条都带反向对照。
 *
 * 分两类：能演的（removeCut、分句、store 的两道闸门）直接演行为；
 * 只在 JSX 分支里、或要真浏览器才暴露的（书架三态、Esc 只挂一份、书签判状态）钉源码结构 ——
 * 与 `sourceHealthRun` 那轮同一做法，钉的是"不许再长回去的形状"。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8')

test('removeCut 按下标删线，横竖两条把手都用它', () => {
  assert.deepEqual(removeCut([0.25, 0.5, 0.75], 1), [0.25, 0.75])
  assert.deepEqual(removeCut([0, 0.5], 0), [0.5], '值为 0 的第一条也要删得掉')
  assert.deepEqual(removeCut([0.5], 0), [], '只剩一条时双击要真的把它摘掉')
  assert.deepEqual(removeCut([0.5], 5), [0.5], '下标越界不该动任何东西')

  const editor = read('reader', 'TapZoneEditor.tsx')
  assert.equal((editor.match(/filter\(\(_, item\)/g) || []).length, 0, '按下标比值的写法要清零')
  assert.match(editor, /withCuts\('x', removeCut\(map\.x, index\)\)/, '竖线把手')
  assert.match(editor, /withCuts\('y', removeCut\(map\.y, index\)\)/, '横线把手（曾与竖线同一次笔误）')
})

test('全角数字与字母是有效内容，纯标点碎片仍然丢掉', () => {
  assert.deepEqual(splitSentences('风声呼啸。１２３４５。天亮了。'), ['风声呼啸。', '１２３４５。', '天亮了。'])
  assert.deepEqual(splitSentences('ＡＢＣＤＥ！'), ['ＡＢＣＤＥ！'])
  assert.deepEqual(splitSentences('他开口了：“”。走了两步。'), ['他开口了：“”。', '走了两步。'],
    '反向对照：真·纯标点仍然要被丢掉')
  // 两处"什么算标点"必须同源：引擎侧与分句侧各写一份迟早漂
  const range = /\/\[\\s[^/\n]*\]\/g/g
  const engine = read('reader', 'ttsEngine.ts').match(range) ?? []
  const processor = read('reader', 'ttsTextProcessor.ts').match(range) ?? []
  assert.equal(engine.length, 1, 'ttsEngine 里应当只有一处剥除区间')
  assert.equal(processor.length, 1, 'ttsTextProcessor 里应当只有一处剥除区间')
  assert.deepEqual(processor, engine, '两处剥除区间不许是两个答案')
})

test('搜索范围是空表时一次请求都不发；非空时照常发（反向对照在同一条里）', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalLocation = globalThis.location
  let opened = 0
  class CountingWebSocket {
    static OPEN = 1
    readyState = 1
    addEventListener(_event: string, _cb: unknown) {}
    send(_data: string) {}
    close() {}
    constructor() { opened += 1 }
  }
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = CountingWebSocket
  ;(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:8080' }
  try {
    searchStore.reset()
    searchStore.setSelectedSourceIds([])
    searchStore.startSearch('空范围关键词')
    assert.equal(opened, 0, '零个源不该发出搜索请求（服务端把空 sourceIds 当"不限制"）')
    assert.equal(searchStore.getSnapshot().loading, false, '没发请求就不许装成在搜')

    searchStore.setSelectedSourceIds(['https://one.example'])
    searchStore.startSearch('有范围关键词')
    assert.equal(opened, 1, '反向对照：范围非空时必须真的开一条')
    assert.equal(searchStore.getSnapshot().loading, true)
    searchStore.stopSearch()
  } finally {
    globalThis.WebSocket = originalWebSocket
    globalThis.location = originalLocation
    searchStore.reset()
  }
})

test('换源的晚到响应不许把上一轮的书写回屏幕（§4.1 那条 P1）', async () => {
  const store = read('lib', 'searchStore.ts')
  const choose = /chooseSource = async \(choice: SourceChoice[^{]*\{([\s\S]*?)\r?\n  \}\r?\n/.exec(store)
  assert.ok(choose, 'chooseSource 的实现要还在（换了写法就同步改这条）')
  assert.match(choose[0], /const gen = this\.openGroupGen/, '入口要记下这一轮的代次')
  assert.match(choose[1], /if \(gen !== this\.openGroupGen\) return/, 'await 回来之后要判过期再写屏')
  // 上面两条只钉了「入口记代次 / 回来判过期」的形状，**钉不住代次有没有真的推进**：
  // 原来 chooseSource 写的是 `const gen = this.openGroupGen`（只读不自增），两次并发换源
  // 拿到同一个 gen，两道守卫全放行，慢的响应后到就覆盖了用户当前打开的书。
  // 这条判据补的就是那个缺口 —— 入口必须在取 gen 之前/同时推进代次。
  //
  // 必须**先剥注释再判**：注释里为了说明会写到 `++this.openGroupGen`，不剥的话
  // 把自增删掉判据仍然是绿的（这条最初就写错过，靠"临时改回 bug 写法看它红不红"发现）。
  const codeOnly = choose[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
  assert.match(
    codeOnly,
    /this\.openGroupGen \+= 1|this\.openGroupGen\+\+|(?:\+\+)this\.openGroupGen/,
    '入口必须推进代次（++this.openGroupGen 或 this.openGroupGen += 1），只读不自增 = 竞态没修',
  )
})

/**
 * 书架页三件事，都发生在 effect 与 JSX 分支里，静态渲染演不出"加载中的那一帧"，
 * 所以钉源码结构（每条都带反向对照 —— 光扫"新写法在不在"是空判）。
 */
test('书架：还没到手 / 取失败了 / 确实没有 是三件事，全选只看可见那一列', () => {
  // 0.8.2 拆组：ShelfPage 从 main.tsx 搬进 pages/ShelfPage.tsx，断言逐字不变
  const shelf = read('pages', 'ShelfPage.tsx')
  const body = shelf.slice(shelf.indexOf('function ShelfPage'))
  assert.match(body, /const \[itemsLoaded, setItemsLoaded\] = useState\(false\)/, '要有一个"到手了"的旗标')
  assert.match(body, /setItemsLoaded\(true\)/, '旗标要在 load 的 finally 里置位')
  assert.match(body, /!itemsLoaded && !message \?/, '加载中给的是"正在读书架…"，不是空态卡')
  assert.doesNotMatch(body, /items\.length === 0 && !message \? \(/,
    '反向对照：那句"没到手就说你空的"要清零')
  assert.match(body, /const shelfFailedEmpty = !!message && items\.length === 0/,
    '取失败且手里没有东西时要有专门一档')

  const selectAll = /const selectAllBooks = \(\) => \{([\s\S]*?)\n  \}/.exec(body)
  assert.ok(selectAll, '全选的实现要还在')
  assert.match(selectAll[0], /visibleItems\.map/, '按可见那一列取键（title 写着"全选当前页所有书籍"）')
  assert.doesNotMatch(selectAll[0], /items\.map/, '反向对照：按整架取键要清零 —— 批量删除会动到筛不出来的书')
  assert.ok(body.indexOf('const visibleItems = useMemo') < body.indexOf('const selectAllBooks'),
    'selectAllBooks 必须定义在 visibleItems 之后')
})

test('一张卡只有一个百分比口径，本地同步的进度分子只数这一次切片', () => {
  const shelf = read('pages', 'ShelfPage.tsx')
  const meta = /className="shelf-meta-percent"[\s\S]{0,220}/.exec(shelf)
  assert.ok(meta, '卡底部那格百分比要还在')
  assert.match(meta[0], /\(\(item\.chapterIndex \?\? 0\) \+ 1\) \/ item\.totalChapters/, '与 hover 层同口径')
  assert.doesNotMatch(meta[0], /\(item\.chapterIndex \?\? 0\) \/ item\.totalChapters/, '反向对照：不加一的那份要清零')

  const offline = read('lib', 'offlineStorage.ts')
  assert.match(offline, /onProgress\?\.\(chapters\.length - total \+ completed, chapters\.length\)/,
    '分子=本次切片已完成数')
  assert.doesNotMatch(offline, /onProgress\?\.\(existingSet\.size \+ completed/,
    '反向对照：拿整本书的已缓存集合当分子，会念成「350 / 50 章」')
})

test('Esc 只挂一份、登录浮层保留本地界面与两条凭据路径、两个死导出不再长回来', () => {
  const logs = read('components', 'LogsModal.tsx')
  assert.doesNotMatch(logs, /addEventListener\('keydown'/, 'LogsModal 不该再自己挂一份 keydown')
  assert.match(logs, /useEscapeClose\(onClose\)/, '统一那一套要在')
  const debug = read('sources', 'SourceDebugModal.tsx')
  assert.doesNotMatch(debug, /addEventListener\('keydown'/, '调试台同理（收流留在卸载清理里）')
  assert.match(debug, /useEffect\(\(\) => \(\) => \{ streamRef\.current\?\.close\(\) \}, \[\]\)/, '卸载要收 EventSource')

  // 内置浏览器抓不到需要站点脚本才写出的 Cookie、表单只对少数源有意义、书签脚本已被真浏览器取代：
  // 凭据路径只留「真浏览器」与「粘贴 Cookie」两条（用户 2026-10-28）。
  // 2026-10-28 追加「书源界面」：有 loginUi 的源按 APK 的方式在本地渲染字段与按钮；
  // 它不是第三条凭据路径，而是书源自己的登录界面。
  const login = read('sources', 'SourceLoginModal.tsx')
  assert.doesNotMatch(login, /SourceWebViewModal|bookmarkletCode/, '内置浏览器 / 书签同步不许回来')
  const tabs = [...login.matchAll(/tab\('(external|cookie|form|browser|bookmark)', '([^']+)'\)/g)].map(m => m[2])
  assert.deepEqual(tabs, ['书源界面', '真浏览器', '粘贴 Cookie'], '登录方式：书源界面 + 两条凭据路径')
  assert.match(login, /api\.externalLoginStart\(sourceId, res\.openUrl\)/,
    '登录脚本要浏览器时必须交给真浏览器，不能弹到日常浏览器或内嵌沙箱')

  assert.doesNotMatch(read('sources', 'bookSourceFields.ts'), /SOURCE_FIELD_COUNT/,
    '与列表漂移的死常量不回来（总数由编辑器现算）')
  assert.doesNotMatch(read('sources', 'sourceInspector.ts'), /createInitialInspections/,
    '纯别名不回来')
})

test('四份文件里那批"把两条 import 粘成一行"的裸 CR 不许长回来', () => {
  // 裸 \r 是合法的 JS 行结束，所以 tsc 与页面都正常；但任何按行处理的工具
  // （门禁的 grep、判据的行数、Prettier）会把两条语句读成一条。
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
  const offenders = walk(SRC)
    .filter(file => /\.(ts|tsx)$/.test(file))
    .filter(file => /\r(?!\n)/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC, file))
  assert.deepEqual(offenders, [], `这些文件里还有裸 CR：${offenders.join('、')}`)
})

test('底部弹层只在开着的时候接 Esc', () => {
  // 阅读设置现在合并成**一张** ReaderSheet（层内用「阅读 / 其它」标签页切换，不再两张同挂）。
  // useEscapeClose 的监听挂在 window 上，与 open 无关 —— 关闭态必须不接 Esc，否则按一次 Esc
  // 会连触发两次关闭。这条判据仍然盯着那个「只在 open 时接 Esc」的写法。
  const sheet = read('reader', 'ReaderSheet.tsx')
  assert.match(sheet, /useEscapeClose\(open \? onClose : ignoreEscape\)/,
    '关闭态不许接 Esc（0.7.0 那轮的修法）')
  assert.doesNotMatch(sheet, /useEscapeClose\(onClose\)/,
    '反向对照：无条件接 Esc 的写法')
  const screen = read('reader', 'ReaderScreen.tsx')
  assert.equal((screen.match(/<ReaderSheet /g) ?? []).length, 1,
    '阅读设置合并成一张弹层；再冒出第二张说明又把两个设置拆回去了')
})

test('MD3 外壳的注释不许把"默认"写回旧界面', () => {
  // PROPOSAL-020 P1 时 MD3 确实是回退档，0.7.0（2360391）把它上线成默认，
  // 注释还说"默认走旧界面" —— 读注释的人会以为要开开关才用得上。
  const chrome = read('reader', 'Md3Chrome.tsx')
  assert.doesNotMatch(chrome, /默认走旧界面/, '过期状态描述要跟着改，不然是拿注释当事实')
  const screen = read('reader', 'ReaderScreen.tsx')
  assert.match(screen, /localStorage\.getItem\('reader-ui-v2'\) !== '0'/,
    '现行默认：只有显式置 0 才回旧界面')
})

test('源码注释里不许写跨文件的裸行号（行号归文档，且由判据核对）', () => {
  // `TocDrawerHeader.tsx` 原本写「核了 :1917 的 className」、`ReaderScreen.tsx` 写
  // 「RuleRunner.kt:1389」—— 被指的那头一加长就指到别处，而且没有任何东西会红。
  // 文档里的指针有 CodeMapFresh.test.ts 逐条核，注释里的没人管。
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
  const offenders: string[] = []
  for (const file of walk(SRC).filter(f => /\.(ts|tsx)$/.test(f))) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, at) => {
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) return
      const hit = /[\w.-]+\.(?:kt|tsx?|css):\d{2,}/.exec(line)
      if (hit) offenders.push(`${path.relative(SRC, file)}:${at + 1} 写着 ${hit[0]}`)
      if (/（`?:\d{3,}）/.test(line) || /核了 :\d/.test(line)) offenders.push(`${path.relative(SRC, file)}:${at + 1} 裸行号指代`)
    })
  }
  assert.deepEqual(offenders, [], `注释请用符号名或类名指代，别用行号：${offenders.join('、')}`)
})
