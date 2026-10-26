import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「订阅」这一处的两件事必须**分居但同页**（用户 2026-10-22 明确要求）。
 *
 * 上游三家在这里都是两个数据模型：`RssSource`（要**读**的文章源）与 `RuleSub`
 * （远程**书源** JSON 的下载地址）。我们以前把它们焊在同一页的两个页签里，
 * 于是「订阅」一词同时指两件事，页签上还得各挂一条计数。
 *
 * 后来书源订阅被挪到「书源」页（产物是书源），但用户指出那让书源页右栏被订阅面板撑长、
 * 「订阅地址」跑错了地方。**现在的契约**：
 * - 「订阅」页（`pages/RssPage.tsx`）同时装两块：书源订阅 + RSS 文章源，各有自己的标题；
 * - 「书源」页（`pages/SourcesPage.tsx`）**只管书源**，不许再出现任何订阅面板或「订阅地址」按钮。
 *
 * 扫描都做成对文本的纯函数 + 注入反扫：只判"真文件里没长回来"证不了分辨力，
 * 得证明把旧形状塞回去时它一定报。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** 取一个顶层 `function Name(`（0.8.2 起可能是 `export function`）到下一个顶层声明之间的源码 */
function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `找不到顶层 function ${name}(`)
  // 从声明行的**下一行**起算：从 `function` 中间切开的话，第一行仍是顶格，
  // 下面的 `^[\w]` 立刻命中，函数体就成了空串 —— 三条判据会一起变成空判。
  const rest = text.slice(text.indexOf('\n', start) + 1)
  const next = rest.search(/^[\w]/m)
  return next < 0 ? rest : rest.slice(0, next)
}

/** 去掉注释：判据只该盯代码。注释里写"这里原来有订阅地址"是历史，不该让判据变红。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s\/\/[^\n]*/g, '')
}

/**
 * 扫一遍界面源码，返回"订阅又长错地方"的清单。
 * 判**结构与引用**，不判界面措辞：措辞改了事实没变不该红，结构改了才是事故。
 */
function auditSubscriptionSplit(files: { name: string; text: string }[]): string[] {
  const problems: string[] = []
  const byName = new Map(files.map(f => [f.name, f.text]))
  const sourcesPageText = byName.get('pages/SourcesPage.tsx') ?? ''
  const rssPage = stripComments(byName.get('pages/RssPage.tsx') ?? '')
  const panel = byName.get('sources/SourceSubscriptionPanel.tsx') ?? ''

  // ① 页签不许长回来：`.subscription-tabs` 在界面与样式表里都不该再出现
  for (const f of files) {
    if (f.text.includes('subscription-tabs')) problems.push(`${f.name} 里还有 .subscription-tabs —— 两件事又被并进同一页的两个页签`)
  }

  // ② 书源页必须干净：不许渲染订阅面板、不许有「订阅地址」按钮/状态
  const sourcesPage = sourcesPageText.includes('function SourcesPage(')
    ? stripComments(functionBody(sourcesPageText, 'SourcesPage'))
    : ''
  if (!sourcesPage) problems.push('找不到 SourcesPage 的函数体，无法确认书源页是否干净')
  if (sourcesPage.includes('<SourceSubscriptionPanel')) {
    problems.push('SourcesPage 里又渲染了 <SourceSubscriptionPanel —— 书源订阅该在「订阅」页，书源页只管书源')
  }
  if (/\bsubsOpen\b/.test(sourcesPage)) {
    problems.push('SourcesPage 里又出现 subsOpen —— 那是「订阅地址」那一档的开合状态，已经移走了')
  }
  if (sourcesPage.includes('订阅地址')) {
    problems.push('SourcesPage 里又出现「订阅地址」按钮 —— 已移到「订阅」页')
  }

  // ③ 订阅页必须装两块：书源订阅 + RSS
  if (!rssPage.includes('<SourceSubscriptionPanel')) {
    problems.push('pages/RssPage.tsx 没有渲染 <SourceSubscriptionPanel —— 书源订阅没在「订阅」页')
  }
  if (!rssPage.includes('<RssPanel')) {
    problems.push('pages/RssPage.tsx 没有渲染 <RssPanel —— RSS 文章源丢了')
  }

  // ④ 书源订阅面板必须仍由 sources/ 提供（它在书源域，只是换了宿主）
  if (!panel.includes('export function SourceSubscriptionPanel')) {
    problems.push('sources/SourceSubscriptionPanel.tsx 里找不到 SourceSubscriptionPanel —— 组件被误删或改名')
  }

  // ⑤ 旧的两个内联件不许复活
  for (const name of ['SubscriptionPage', 'SubscriptionPanel']) {
    const bare = new RegExp(`(?<!Source)\\b${name}\\b`)
    for (const f of files) if (bare.test(f.text)) problems.push(`${f.name} 还引用着 ${name}（合体页已解散，留着就是两份真相）`)
  }
  return problems
}

const filesToScan = () => {
  const collect = (dir: string, base = ''): { name: string; text: string }[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? collect(path.join(dir, entry.name), path.join(base, entry.name))
      : (/\.(tsx|ts|css)$/.test(entry.name) ? [{ name: path.join(base, entry.name).replace(/\\/g, '/'), text: fs.readFileSync(path.join(dir, entry.name), 'utf8') }] : []))
  return collect(SRC)
}

test('订阅两件事分居同页：书源页干净、订阅页装两块、页签不再长回来', () => {
  const problems = auditSubscriptionSplit(filesToScan())
  assert.deepEqual(problems, [], problems.join('\n  '))
})

test('形状核对：书源页只剩编辑器，订阅页两块并列', () => {
  const pages = read('app/pages.tsx')
  assert.match(pages, /import \{ RssPage \} from '\.\.\/pages\/RssPage'/, '「订阅」页要由 pages/RssPage 提供')

  const sourcesPage = stripComments(functionBody(read('pages/SourcesPage.tsx'), 'SourcesPage'))
  assert.ok(sourcesPage.length > 3000, `SourcesPage 只切出 ${sourcesPage.length} 字，切分本身没在做事`)
  assert.doesNotMatch(sourcesPage, /SourceSubscriptionPanel/, '书源页不该再引用订阅面板')
  assert.doesNotMatch(sourcesPage, /订阅地址/, '书源页不该再有「订阅地址」')

  const rssPage = read('pages/RssPage.tsx')
  assert.match(rssPage, /import \{ SourceSubscriptionPanel \}/, '订阅页要引入书源订阅面板')
  assert.match(rssPage, /import \{ RssPanel \}/, '订阅页要引入 RSS 面板')
  assert.match(rssPage, /subscription-block/, '两块要有各自的分区容器（视觉上分得清）')

  // 书源订阅面板的 onClose 现在是可选的（订阅页里没有"收起这一档"）
  assert.match(read('sources/SourceSubscriptionPanel.tsx'), /onClose\?:/, 'onClose 应为可选')

  const rss = read('pages/RssPanel.tsx')
  assert.doesNotMatch(rss, /onChanged/, 'RssPanel 的 onChanged 只为页签计数而存在，页签没了就该一起删')
})

test('反向对照：把旧形状塞回去必须报，而且逐项报得出是哪一条', () => {
  const base = filesToScan()
  const patch = (name: string, fn: (text: string) => string) =>
    base.map(f => (f.name === name ? { ...f, text: fn(f.text) } : f))

  // 页签长回来
  const tabs = auditSubscriptionSplit(patch('pages/RssPage.tsx', t => `${t}\n<nav className="subscription-tabs" />\n`))
  assert.ok(tabs.some(p => p.includes('.subscription-tabs')), `加了页签没报：${tabs.join(' / ')}`)

  // 书源页又把订阅塞回来（注入到函数体内，才等于"书源页真的又渲染了它"）
  const back = auditSubscriptionSplit(patch('pages/SourcesPage.tsx', t =>
    t.replace('const [isBatchMode, setIsBatchMode] = useState(false)',
      'const subsOpen = false\n  const injected = <SourceSubscriptionPanel onSourcesChange={() => {}} />\n  const [isBatchMode, setIsBatchMode] = useState(false)')))
  assert.ok(back.some(p => p.includes('又渲染了 <SourceSubscriptionPanel')), `塞回订阅面板没报：${back.join(' / ')}`)
  assert.ok(back.some(p => p.includes('subsOpen')), `塞回 subsOpen 没报：${back.join(' / ')}`)

  // 订阅页丢掉书源订阅
  const dropped = auditSubscriptionSplit(patch('pages/RssPage.tsx', t => t.split('<SourceSubscriptionPanel').join('')))
  assert.ok(dropped.some(p => p.includes('没有渲染 <SourceSubscriptionPanel')), `拆掉书源订阅没报：${dropped.join(' / ')}`)

  // 解散掉的合体组件复活
  const revived = auditSubscriptionSplit(patch('main.tsx', t => `${t}\nfunction SubscriptionPage() { return null }\n`))
  assert.ok(revived.some(p => p.includes('SubscriptionPage')), `合体页复活没报：${revived.join(' / ')}`)

  // 干净样本必须一条都不报 —— 否则上面那些红可能只是扫描本身在乱咬
  assert.deepEqual(auditSubscriptionSplit(base), [])
})
