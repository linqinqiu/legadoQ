import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { defaultReaderSettings, parseTocRuleKey, ttsSessionKey } from '../src/reader/readerSettings'

/**
 * 「阅读设置 → 本地书目录」（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 * 端到端那一条在 `tools/verify/toc-rule-check.mjs`（真造一本书、真换规则、量章数差），
 * 这里只钉三件静态就能判的事：脏值回落、别污染朗读会话、面板与导入确实接上了。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('parseTocRuleKey - 只认形状不硬编码清单（合法取值来自服务端，前端抄一份迟早漂移）', () => {
  assert.equal(defaultReaderSettings.txtTocRule, 'auto', '默认让服务端按正文打分选')
  for (const ok of ['auto', 'builtin', '-1', '-24', '7']) {
    assert.equal(parseTocRuleKey(ok), ok, `${ok} 是合法键`)
  }
  assert.equal(parseTocRuleKey('  -8  '), '-8', '两端空白要清掉')
  for (const junk of ['', '   ', 'AUTO', '- 1', 'a;DROP', '-1234567', '1.5', 'auto\n', undefined, null, 42, {}]) {
    assert.equal(parseTocRuleKey(junk), 'auto', `${JSON.stringify(junk)} 该回落到默认而不是原样存进去`)
  }
})

test('目录规则不参与朗读会话身份（换规则不该打断正在读的那一句）', () => {
  const base = { ...defaultReaderSettings }
  const changed = { ...defaultReaderSettings, txtTocRule: '-12' }
  assert.equal(ttsSessionKey(base), ttsSessionKey(changed),
    'txtTocRule 进了 ttsSessionKey 的话，改目录规则会把正在播的朗读打断')
})

/**
 * 三个入口各管一件事（用户 2026-10-03：「『自定义』弹窗成了杂物间」+「抽屉里只留
 * 『这本用的哪条 + 重切』」）。原来"下一本的默认规则"同时挂在阅读设置抽屉和「自定义」里，
 * 而抽屉里那颗选择器一动手就把全局默认改了 —— 同一个旗标兼两个职务，跟 `enable` 那个 bug 同形状。
 *
 * 现在的分法：书架「导入本地」旁边 = 下一本用哪条 + 哪几条参与自动打分；
 * 阅读设置抽屉 = 只对着手上这本（暂选，不写全局）。
 */
test('默认规则长在书架的导入动作旁边，不在「自定义」里', () => {
  const customize = read('../src/components/CustomizeModal.tsx')
  // 判的是代码痕迹，不是那句"搬走了"的说明文字
  assert.doesNotMatch(customize, /api\.tocRules|txtTocRule|<Select/, '「自定义」只剩皮肤；分章规则的代码别再长回来')
  // 0.8.2 拆组：弹窗挂在书架页（pages/ShelfPage.tsx），那份阅读设置仍在宿主（main.tsx），
  // P2 起页面渲染表在 app/pages.tsx —— 读三面，断言不变
  const main = read('../src/main.tsx') + '\n' + read('../src/app/pages.tsx') + '\n' + read('../src/pages/ShelfPage.tsx')
  assert.match(main, /<TocRulesModal/, '书架渲染这个弹窗')
  assert.match(main, /<span>分章规则<\/span>/, '入口按钮就挨着「导入本地」')
  assert.match(main, /onTxtTocRuleChange=\{value => ctx\.onSettingsChange\(\{ \.\.\.ctx\.settings, txtTocRule: value \}\)\}/,
    '它写的是宿主那一份阅读设置，不是又造一份状态')
  const modal = read('../src/components/TocRulesModal.tsx')
  assert.match(modal, /api\.tocRules\(\)/, '它自己去服务端取规则清单')
  assert.match(modal, /onClick=\{onImport\}/, '弹窗里能直接接着导书，不用关掉再找那颗按钮')

  // 备份里那份要真的能套用到服务端规则表（不是只"收下"）
  const backup = read('../src/pages/BackupPage.tsx')
  assert.match(backup, /api\.applyTocRulesFromBackup\(\)/, '备份页对这条有真的套用动作')
  assert.match(backup, /TXT 分章规则/, '「原样收下的条目」清单里说得出它能套用')
  const store = read('../../app/src/main/kotlin/io/legado/backup/BackupStore.kt')
  assert.match(store, /APPLYABLE_NAMES = listOf\([^)]*"txtTocRule\.json"/, '服务端也把这条标成可套用（界面上的按钮按它出现）')
})

test('阅读设置抽屉里那一档只对着手上这本', () => {
  const reader = read('../src/reader/ReaderScreen.tsx')
  // PROPOSAL-020 P4：「本地书目录」这节从「行为」页搬去了「设置」弹层（OtherSettingsPanel），
  // 重切那两条链路（打到服务端、回填服务端说的那条）仍在 ReaderScreen 上。
  const panel = read('../src/reader/OtherSettingsPanel.tsx')
  assert.match(panel, /\{!!localBook && \(tocRuleOptions\?\.length \?\? 0\) > 0 && \(/,
    '在线书没有"目录规则"这件事，这一组就跟着本地书出现')
  assert.match(panel, /title="本地书目录"/, "面板里有这一组")
  assert.match(panel, /现在用的是「\{ruleLabelOf\(localBook\.tocRule\)\}」/, '报的是这本书**实际**用的规则')
  assert.match(panel, /ariaLabel="换一条规则重切这本"/, '那颗选择器的名字就说清了它只管这本')
  assert.match(panel, /按这条规则重新识别目录/, '有"重切"这个动作，不是选了不生效')
  assert.match(reader, /api\.reparseLocalBook/, '重切真的打到服务端')
  assert.match(reader, /setShelfTocRule\(item\?\.tocRule/, '重切之后把服务端说的那条回填进面板，界面不沿用旧值')
  assert.doesNotMatch(panel, /ariaLabel="TXT 目录规则"/, '"下一本用哪条"不在抽屉里改：抽屉与弹窗各留一条路，避免重复入口')
  assert.doesNotMatch(panel, /update\(\{ txtTocRule/, '抽屉里的暂选绝不写全局默认（那是"改这本"时最不该发生的事）')
  assert.match(panel, /onReparseLocal\(repickRule\)/, '重切用的是那颗选择器的暂选')
  assert.match(panel, /useEffect\(\(\) => \{ setRepick\(null\) \}, \[localBook\?\.name\]\)/,
    '换书时暂选归零：抽屉是常驻挂载的，不清就会带着上一本的选择')
  const main = read('../src/pages/ShelfPage.tsx')
  assert.match(main, /api\.importLocalBooks\(list, txtTocRule\)/, '导入用的是书架那一份选择')
})

/**
 * 「txt目录规则可新建可编辑」（用户 2026-10-03）。判的是三件事：
 * 写接口有、坏正则被服务端挡在门外（不是存进去再让解析层跳过）、删除只对自己建的条目开。
 */
test('分章规则可新建可编辑：接口、就地编辑、删除键的可见性', () => {
  const api = read('../src/lib/api.ts')
  assert.match(api, /saveTocRule: \(rule: \{ key\?: string; name: string; rule: string/, '有新建/修改这一条')
  assert.match(api, /deleteTocRule: \(key: string\)/, '有删除这一条')
  assert.match(api, /removable\?: boolean/, '清单要报得出"这条能不能删"，界面不能猜')

  // 0.8.2 拆组：分章规则面住在 TocRulesRoutes.kt
  const routes = read('../../app/src/main/kotlin/io/legado/http/TocRulesRoutes.kt')
  assert.match(routes, /post\("\/books\/toc-rules\/save"\)/)
  assert.match(routes, /post\("\/books\/toc-rules\/delete"\)/)
  assert.match(routes, /rule_uncompilable/, '编不出来的正则回 400 并说清原因，而不是存进去')
  assert.match(routes, /packaged_rule/, '删随包那条要回一句"删不掉，可以取消勾选"')
  const model = read('../../app/src/main/kotlin/io/legado/localbook/TxtTocRule.kt')
  assert.match(model, /fun patternUsable\(pattern: String\): Boolean/, '保存前自己编译一遍，不依赖解析层的静默跳过')
  assert.match(model, /fun removable\(id: Int\): Boolean = all\.any \{ it\.id == id \} && packaged\.none/,
    '可删 = 在表里 且 不是随包那条')

  const modal = read('../src/components/TocRulesModal.tsx')
  assert.match(modal, /新建一条/)
  assert.match(modal, /aria-label=\{`编辑 \$\{rule\.label\}`\}/, '编辑就在这一行上，不套第二层弹窗')
  assert.match(modal, /\{!!rule\.removable && \(/, '随包那 26 条不摆删除键')
  assert.match(modal, /window\.confirm\(/, '删除要先问一句：这是不可逆的')
  assert.match(modal, /key: draft\.key \?\? undefined/,
    '新建时 key 传 undefined（服务端按"没有 key"分配 10000 段的 id，前端不自己编 id）')
})

/**
 * 「txt目录规则没有做好」（用户 2026-10-03）。根因不是规则不够，是一个旗标兼了两件事：
 * 选择清单只发"启用的"那 12 条，于是另外 12 条（章回体「第N回」这类都在里面）
 * 既看不见也选不了，而界面上根本没有启用开关。
 */
test('手动可选 与 参与自动打分 是两件事，界面和服务端都按两件事做', () => {
  const routes = read('../../app/src/main/kotlin/io/legado/http/TocRulesRoutes.kt')
  assert.match(routes, /TocRules\.all\.map/, '清单发的是全表，不再是 candidates')
  assert.doesNotMatch(routes, /options = listOf\([\s\S]{0,220}\+ TocRules\.candidates\.map/,
    'candidates 只能用于自动打分，拿它当选择清单就是把 12 条规则藏起来')
  assert.match(routes, /post\("\/books\/toc-rules\/toggle"\)/, '有开关这条规则的入口')
  const model = read('../../app/src/main/kotlin/io/legado/localbook/TxtTocRule.kt')
  assert.match(model, /val selectable: List<TxtTocRule> get\(\) = all\.filter \{ compiles\(it\.id\) \}/,
    '可选只看用不用得了，不看 enable')
  assert.match(model, /fun compiles\(id: Int\): Boolean = id == PACKAGED_BUILTIN_ID \|\| compile\(id\) != null/,
    '内置那条（id -100）没有正则但不算坏规则')
  assert.match(model, /fun setEnable\(id: Int, enable: Boolean\)/)

  const api = read('../src/lib/api.ts')
  assert.match(api, /toggleTocRule: \(key: string, enable: boolean\)/)
  assert.match(api, /enable\?: boolean/, '选项要带得上"参不参与自动"')
  assert.match(api, /broken\?: boolean/, '以及"正则坏没坏"')

  const modal = read('../src/components/TocRulesModal.tsx')
  assert.match(modal, /pickable = options\.filter\(option => !option\.broken\)/,
    '默认规则选择器列的是全部能用的规则')
  assert.match(modal, /rows = options\.filter\(option => !option\.builtIn && option\.key !== 'auto'\)/,
    '另有一张规则清单（开关在那儿，不在选择器里）')
  assert.match(modal, /aria-label=\{`\$\{rule\.label\} 参与自动选择`\}/, '开关说的是它真正管的那件事')
  assert.match(modal, /<code title=\{rule\.rule\}>/, '正则原文要露出来，否则没人判断得了它适不适合自己的书')
  assert.match(modal, /手动选一条不需要先"启用"它/, '界面文案把这两件事分开讲')

  const panel = read('../src/reader/OtherSettingsPanel.tsx')
  assert.match(panel, /\.filter\(option => !option\.broken\)/, '阅读设置里那颗选择器同样排除坏正则')
  assert.match(panel, /（不参与自动）/, '选得到但不打分的那几条要标出来，别让人以为勾了就等于生效')
})
