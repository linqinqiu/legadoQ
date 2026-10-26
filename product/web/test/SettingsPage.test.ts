import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage, type SettingsSection } from '../src/pages/SettingsPage'
import { filterSettingsSections } from '../src/settings/settingsSections'

/**
 * 「设置」页存在的意义是"分类"：用户 2026-10-03 让它收纳 txt 目录规则 / 备份 / 替换净化，
 * 2026-10-08 又把 书源 / 替换净化规则 / 备份包 从顶栏搬进来（对齐 Legado-with-MD3 的 IA）。
 * 判的重点是：它有没有偷偷变成第二套实现，以及搬进来的东西还找不找得到。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const sections: SettingsSection[] = [{
  title: '本地书',
  rows: [{
    title: 'TXT 分章规则',
    hint: '下一本导入的 TXT 按哪条切目录。',
    action: '打开规则表',
    onClick: () => undefined,
  }],
}]

test('静态渲染：分组、一行一句说明、一个动作', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsPage, { sections }))
  assert.match(html, /设置/)
  assert.match(html, /本地书/, '分组标题')
  assert.match(html, /TXT 分章规则/)
  assert.match(html, /下一本导入的 TXT 按哪条切目录/, '这一行说得出它管什么')
  assert.match(html, /打开规则表/, '右侧一个动作')
  // 「就近：…」那条元话术已在 0.6.10 去掉：告诉用户"别处还有一条路"对使用者没用（用户点名）
  assert.doesNotMatch(html, /就近：/, '不该再出现"就近入口"那句解释')
})

test('这一页只是路由：不读写数据，也不持有设置的值', () => {
  const page = read('../src/pages/SettingsPage.tsx')
  // 出现这些就说明有人把第二套实现搬进来了（两处都能改 → 迟早两处不一样）
  assert.doesNotMatch(page, /localStorage|fetch\(|api\./, '设置页不该自己读写数据')
  assert.doesNotMatch(page, /saveReaderSettings|onSettingsChange|settings\./, '它不持有设置的值：值仍存在原来那一处')
  // 它确实有一份 useState，装的只能是搜索框里的字（界面态，不是任何设置项）
  assert.equal((page.match(/useState\(/g) ?? []).length, 1, '这一页只该有一份自己的界面态，多一处就要问它存的是谁的设置')
  assert.match(page, /const \[query, setQuery\] = useState\(''\)/, '那份状态是搜索词')
  // 搜索框必须是 `type="search"`：`/` 与 Ctrl/⌘+F 找"这一页的搜索框"认的就是它
  assert.match(page, /type="search"/, '不是 type=search，`/` 快捷键在这一页就是哑的')
})

test('一级目的地只在顶栏列一次；规则/备份 收在「设置」页 —— 收放改了，功能一条没少', () => {
  // 2026-10-08 用户定的框架（对齐 Legado-with-MD3）：顶栏只留 书库/书架/发现/订阅/设置，
  // 书源 / 替换净化规则 / 备份包 从顶栏搬进「设置」页；2026-10-09 用户要求把「书源」放回顶栏。
  // 判的仍是同一件事：**不许有功能只剩下一个找不到的入口**，也不许同一个目的地在两处各留一条路。
  const header = read('../src/components/AppHeader.tsx')
  assert.match(header, /PRIMARY_PAGES\.map/, '顶栏入口由那张表渲染（手写一排按钮迟早漏一项）')
  assert.ok(!/<span>设置<\/span>/.test(header), '「设置」已是一级入口，不该再在「我的」菜单里留第二条路')
  assert.ok(!/<span>规则<\/span>|<span>备份<\/span>|<span>书源<\/span>/.test(header), '规则 / 备份 / 书源 不在菜单里重复')

  const table = read('../src/app/pageMeta.ts')
  // 书源已回到顶栏：它必须是一级入口，且不再出现在收编清单里
  assert.ok(/\{ key: 'sources'/.test(table), '书源要回到顶栏一级表里')
  // 规则 / 备份 仍从「设置」页进：规则是悬浮层（PageDialog），备份是**成熟功能浮层**
  // （plugins/），可独立卸载。两者都不占顶栏、不占路由，但入口必须真的接上。
  const app = read('../src/main.tsx')
  assert.ok(!new RegExp(`\\{ key: 'rules'`).test(table), 'rules 不该占顶栏')
  assert.ok(app.includes(`setPageDialog('rules')`), 'rules 的悬浮层没接线')
  assert.ok(!new RegExp(`\\{ key: 'backup'`).test(table), 'backup 不该占顶栏')
  assert.ok(app.includes("openModalDirect('backup')"), 'backup 的入口要接到备份浮层')
  assert.match(read('../src/plugins/backup/BackupModal.tsx'), /<BackupPage \/>/,
    '备份浮层里要真的渲染这一页，不是挂个空组件')
  assert.doesNotMatch(app, /showReplaceRules/,
    '「规则开没开」只有 pageDialog 一个出处；再留一份布尔旗标就是两处状态互相顶（设置页改走 pageDialog 后它已无人置真）')
  assert.ok(table.includes("'settings'"), '设置必须留在一级表里')

  // 分区表只有**一份出处**：`settings/settingsSections.ts`（P0.3 从 main.tsx 搬出来）。
  const main = read('../src/main.tsx')
  // 判两件事：表里声明了哪些动作，以及 main.tsx 是不是把每一个都接到了原来那一份实现上。
  const sectionsFile = read('../src/settings/settingsSections.ts')
  assert.doesNotMatch(main, /const settingsSections: SettingsSection\[\] = \[/,
    '分区表又内联回 App 组件了 —— 一张要给人读的清单不该长在三千多行那个文件中间')
  const declared = [...sectionsFile.matchAll(/^ {2}(open[A-Z]\w*): \(\) => void$/gm)].map(m => m[1])
  assert.ok(declared.length >= 8, `只从 SettingsActions 认出 ${declared.length} 个动作，这条正则瞎了`)
  const wiredBlock = /buildSettingsSections\(\{([\s\S]*?)\}\)/.exec(main)?.[1] ?? ''
  assert.ok(wiredBlock.length > 120, '取不到 main.tsx 里 buildSettingsSections 那一段（取空串的话下面的断言对什么都成立）')
  for (const name of declared) {
    assert.match(wiredBlock, new RegExp(`^\\s+${name}: \\(\\) =>`, 'm'), `${name} 在 main.tsx 里没接上动作`)
  }
  // 接的都是原来那一份实现，不是第二套：逐个点名。
  // 「备份」是插件（plugins/），动作是开对应浮层 —— 期望值跟着换，
  // 但"必须接到某一份真实现"这条不变（不接就是死按钮）。
  // 同一轮把 5 个独立布尔收成一个 openModal：弹窗类动作的期望值从 setShowXxx(true) 变成 setOpenModal('xxx')，
  // 语义完全等价（同一时刻只开一个），判据跟着换写法而不是放宽要求。
  for (const call of ["openModalDirect('shortcuts')", "openModalDirect('offline-cache')", "openModalDirect('customize')",
    "setPageDialog('rules')", 'setTocRulesSignal(value => value + 1)', "openModalDirect('backup')",
    "openModalDirect('logs')", "openModalDirect('server-port')"]) {
    assert.ok(wiredBlock.includes(call), `设置页的动作没接到 ${call}（悬浮层/弹窗/浮层那一份）`)
  }
  const sectionsBody = /export function buildSettingsSections[\s\S]*$/m.exec(sectionsFile)?.[0] ?? ''
  assert.ok(sectionsBody.length > 800, '要真的取到分区表那一段（取空串下面几条对什么都成立）')
  assert.match(sectionsBody, /离线缓存/, '离线缓存仍是设置页的一行')
  assert.match(sectionsBody, /运行日志/, '运行日志仍是设置页的一行')
  // 2026-10-09 书源回到顶栏：同一个目的地只留一条路
  assert.doesNotMatch(sectionsBody, /navigate\('sources'\)/, '书源回了顶栏，设置页不该再留第二条路')
})

test('路由与"去书架开弹窗"的信号接上了', () => {
  // 0.8.2 拆组：路由与信号发出在 main.tsx，消费那半在 pages/ShelfPage.tsx。
  // P2 起路由解析搬到 app/pageMeta.ts，页面渲染表在 app/pages.tsx —— 读整个应用面，
  // 断言仍是"接上了"，不放宽任何一条。
  const route = read('../src/app/pageMeta.ts')
  assert.match(route, /pageFromHash/, 'hash 解析要由页面元数据表提供')
  assert.match(route, /\{ key: 'settings'/, 'settings 必须在页面表里')
  const pages = read('../src/app/pages.tsx')
  const main = [read('../src/main.tsx'), pages, read('../src/pages/ShelfPage.tsx')].join('\n')
  // 结构判据：settings 分支里渲染 SettingsPage，sections 来自宿主接好的分区表。
  assert.match(pages, /<SettingsPage sections=\{ctx\.settingsSections\}/)
  assert.match(main, /settingsSections: buildSettingsSections\(\{/)
  assert.match(main, /tocRulesSignal=\{ctx\.tocRulesSignal\}/)
  assert.match(main, /if \(tocRulesSignal > 0\) setShowTocRules\(true\)/,
    '第一次挂载（0）不弹：刷新页面就跳出弹窗是凭空多出来的行为')
  assert.match(read('../src/styles.css'), /\.settings-page \{/)
})

/** 喂给筛选算式的夹具：两档四行，标题与说明里各留一个只有那一行才有的词。 */
const searchFixture = [
  {
    title: '阅读',
    rows: [
      { title: '快捷键', hint: '阅读器与全局的按键表。', action: '看按键表', onClick: () => undefined },
      { title: '离线缓存', hint: '下载到这台电脑浏览器里的正文。', action: '管理离线缓存', onClick: () => undefined },
    ],
  },
  {
    title: '服务',
    rows: [
      { title: '服务端口', hint: '青阅跑在哪个端口。', action: '改端口', onClick: () => undefined },
      { title: '运行日志', hint: '这台服务写了什么：级别、失败原因。', action: '看日志', onClick: () => undefined },
    ],
  },
]

test('页内搜索的算式：命中的行留着、整档空了就收起、空查询原样给回', () => {
  assert.equal(filterSettingsSections(searchFixture, ''), searchFixture, '空查询要原样返回同一份，不复制出新数组')
  assert.deepEqual(filterSettingsSections(searchFixture, '   ').map(s => s.title), ['阅读', '服务'], '只有空白等于没搜')
  const one = filterSettingsSections(searchFixture, '端口')
  assert.deepEqual(one.map(s => s.title), ['服务'], '只有那一档还在')
  assert.deepEqual(one[0].rows.map(r => r.title), ['服务端口'], '只留命中那一行，同档其余的不许跟着出来')
  assert.deepEqual(filterSettingsSections(searchFixture, '按键表').flatMap(s => s.rows.map(r => r.title)), ['快捷键'],
    '说明里的词也搜得到 —— 用户记的是"管什么的"，不是分区名')
  assert.equal(filterSettingsSections(searchFixture, 'PORT').length, 0, '大小写不敏感：确实没有就说没有')
})

test('反向对照：把算式换成"整档留不留"这种粗筛，必须被逮住', () => {
  const coarse = (sections: SettingsSection[], query: string) => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return sections
    // 常见写坏的一版：按档标题匹配，于是搜"端口"把整档四行都吐出来
    return sections.filter(section => `${section.title} ${section.rows.map(r => r.title).join(' ')}`.toLowerCase().includes(needle))
  }
  const strict = filterSettingsSections(searchFixture, '端口')
  const loose = coarse(searchFixture, '端口')
  assert.ok(loose[0].rows.length > strict[0].rows.length,
    `粗筛与细筛结果一样时，上面那条"只留命中那一行"就是空判：${JSON.stringify(loose.map(s => s.rows.length))}`)
})

test('搜索框画在界面上，且"没搜到"只在真搜过时才说', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsPage, { sections: searchFixture }))
  assert.match(html, /<input type="search"[^>]*aria-label="搜设置项"/, '输入框要有可访问名字，读屏里不能是一句光秃秃的"编辑框"')
  assert.match(html, /<h2>阅读<\/h2>[\s\S]*快捷键[\s\S]*<h2>服务<\/h2>[\s\S]*服务端口/, '两档四行都画得出')
  assert.doesNotMatch(html, /没有匹配/, '没搜过不许说"没有匹配"—— 空列表被说成搜不到是另一回事')
  // 「没有匹配」那一支必须同时要求"真的输入过"：少了这个条件，sections 为空时界面会凭空说"没有匹配「」"。
  // 0.8.3 起这个条件收进 nothingMatched（= searching && 内置与插件分区都空），
  // 判据改成查它的定义里确实带了 searching，而不是钉死内联写法。
  const settingsSrc = read('../src/pages/SettingsPage.tsx')
  assert.match(settingsSrc, /const nothingMatched = searching &&/, '空态条件里必须包含"真的输入过"')
  assert.match(settingsSrc, /\{nothingMatched \?/, '空态要用那个条件把关')
})
