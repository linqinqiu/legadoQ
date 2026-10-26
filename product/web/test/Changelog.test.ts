import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseChangelog, ChangelogPage } from '../src/pages/ChangelogPage'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

/**
 * 应用内「更新日志」页（用户 2026-10-01：「你还没有做更新日志」）。
 * 判据分两层：解析器喂已知文本对结构，接口层对"随包文件读不到时必须给 404"。
 */
const SAMPLE = [
  '# 更新日志',
  '',
  '前言一行，不属于任何版本。',
  '',
  '## [0.2.0] - 2026-10-01',
  '',
  '版本说明的续行，要并到前言里。',
  '',
  '### 界面',
  '- 顶栏换成**侧栏**：一行一个入口',
  '  这一行是上一条的续行',
  '- 页头条压到 44px（`--ctl`）',
  '- 备份条目收进 `data/backup_kept/`，其中 `config.xml` /',
  '  `videoConfig.xml` 仍不收',
  '- an English bullet that wraps',
  '  onto a second line',
  '',
  '### 服务端',
  '* 加了 `GET /api/changelog`',
  '',
  '## [0.1.0] - 2026-09-20',
  '- 第一版',
].join('\n')

test('parseChangelog - 版本 / 日期 / 分组 / 条目按结构取出来', () => {
  const releases = parseChangelog(SAMPLE)
  assert.equal(releases.length, 2, '两个 ## [x] 段就该是两个版本')
  assert.deepEqual(releases.map(r => r.version), ['0.2.0', '0.1.0'])
  assert.equal(releases[0].date, '2026-10-01')
  assert.deepEqual(releases[0].groups.map(g => g.title), ['界面', '服务端'])
  assert.deepEqual(releases[0].groups[0].items, [
    '顶栏换成**侧栏**：一行一个入口这一行是上一条的续行',
    '页头条压到 44px（`--ctl`）',
    '备份条目收进 `data/backup_kept/`，其中 `config.xml` / `videoConfig.xml` 仍不收',
    'an English bullet that wraps onto a second line',
  ], '缩进续行必须并回上一条：一条日志常占多行，拆开发给用户看就是半截话。'
    + '两端都是中文时不补空格（补了会在每个全角括号前留一个洞），其余情况补一个空格；'
    + '以反引号开头的续行也算续行（曾经被当成新条目，把一句话劈成两条）')
  assert.deepEqual(releases[0].groups[1].items, ['加了 `GET /api/changelog`'], '`*` 开头的条目也要收进来')
  assert.deepEqual(releases[1].groups.map(g => g.items), [['第一版']])
})

test('parseChangelog - 版本段落开头那句话不会被吞掉', () => {
  const releases = parseChangelog(SAMPLE)
  // "前言一行" 在第一个 ## [ 之前，按解析器规则丢弃；0.2.0 段的续行在 ### 之前，进 preamble
  assert.deepEqual(releases[0].preamble, ['版本说明的续行，要并到前言里。'])
  assert.deepEqual(releases[1].preamble, [])
})

test('parseChangelog - 没有版本段时给空数组（界面据此说"日志是空的"，不是"没有更新"）', () => {
  assert.deepEqual(parseChangelog('随便一句话\n\n- 有条目但没有版本标题'), [])
  assert.deepEqual(parseChangelog(''), [])
})

test('parseChangelog - 只有 ## 不带方括号时不算版本（防止把正文标题当版本）', () => {
  assert.deepEqual(parseChangelog('## 未发布\n- 一条'), [])
})

/**
 * 仓库里的真 CHANGELOG：这一条同时钉住两件事 ——
 * ① 随包文本确实存在且能被同一个解析器读出结构；
 * ② 最上面那条版本号必须等于 `app/build.gradle` 里的版本（改版本忘写日志是常见漂移）。
 */
test('仓库 CHANGELOG 能解析，且最新一条就是当前版本号', () => {
  const text = read('..', '..', 'CHANGELOG.md')
  const releases = parseChangelog(text)
  assert.ok(releases.length >= 1, 'CHANGELOG.md 至少要有一个 `## [版本号]` 段')
  const gradle = read('..', '..', 'app', 'build.gradle')
  const version = /version\s*=\s*['"]([^'"]+)['"]/.exec(gradle)?.[1]
  assert.ok(version, 'app/build.gradle 里要有 version = \'x.y.z\'（版本号唯一来源）')
  assert.equal(releases[0].version, version, `CHANGELOG 最新一条是 ${releases[0].version}，但 gradle 报 ${version} —— 改了版本要补日志`)
  assert.ok(releases[0].groups.length > 0 || releases[0].preamble.length > 0, '当前版本这一条不许是空的')
})

/**
 * 版本号只有一个书写处（gradle），但它被**抄**到了很多地方。
 * `tools/verify/version-check.mjs` 盯的是构建链上那 5 处（清单 / healthz / 顶栏 / 日志 / 契约），
 * 而**手抄的散点零覆盖** —— 历次漂移（0.8.2→0.8.3 时 README、VERSION、package.json 集体滞后）
 * 恰好全都发生在这里。version-check 需要服务在跑 + 真浏览器（只在 PR 冒烟里跑），
 * 而这一条是纯静态的：每次 `npm test` 都跑，秒级，改版本忘了同步当场红。
 *
 * 规则：这些抄写点必须与 gradle 一模一样；而**不该带版本号的散文**（架构文档那种）
 * 不许写版本号 —— 写一次就多一处会忘记改的地方。
 */
test('抄出去的版本号处处与 gradle 一致，散文里不写版本号', () => {
  const gradle = read('..', '..', 'app', 'build.gradle')
  const version = /^\s*version\s*=\s*'([^']+)'/m.exec(gradle)?.[1] ?? ''
  assert.match(version, /^\d+\.\d+\.\d+$/, `gradle 里读不到 x.y.z 版本号：${version || '空'}`)

  // read() 以 web/test 为基准：'..' = web，'../..' = legado，'../../..' = 父仓库根。
  const copies: Array<[string, string[]]> = [
    ['VERSION（父仓库根）', ['..', '..', '..', 'VERSION']],
    ['根 package.json', ['..', '..', '..', 'package.json']],
    ['legado/package.json', ['..', '..', 'package.json']],
    ['legado/web/package.json', ['..', 'package.json']],
    ['README.md「当前版本」', ['..', '..', '..', 'README.md']],
    ['agent-api.json', ['..', '..', 'app', 'src', 'main', 'resources', 'agent-api.json']],
  ]
  const stale: string[] = []
  for (const [name, parts] of copies) {
    const text = read(...parts)
    if (name.startsWith('VERSION')) {
      if (text.trim() !== version) stale.push(`${name} 是 ${text.trim() || '空'}，gradle 是 ${version}`)
      continue
    }
    // 取文件里第一个 x.y.z 出现在 `"version"` 或「当前版本」之后那个（README 写的是「当前版本 **0.8.6**」）
    const marker = name.startsWith('README') ? '当前版本' : '"version"'
    const at = text.indexOf(marker)
    if (at < 0) { stale.push(`${name} 里找不到「${marker}」那一句`); continue }
    const found = /\d+\.\d+\.\d+/.exec(text.slice(at, at + marker.length + 40))?.[0] ?? ''
    if (found !== version) stale.push(`${name} 写的是 ${found || '没有版本号'}，gradle 是 ${version}`)
  }
  assert.deepEqual(stale, [], `版本号漂移：\n  ${stale.join('\n  ')}`)

  // 反向：脚本与散文不许写死版本号（要写就现读 gradle）。
  const banned: string[] = []
  const coverage = read('..', '..', 'scripts', 'coverage-report.mjs')
  const covVer = /版本 (\d+\.\d+\.\d+)/.exec(coverage)?.[1] ?? ''
  if (covVer && covVer !== version) banned.push(`coverage-report.mjs 写死了「版本 ${covVer}」（应改为现读 gradle 的 appVersion()）`)
  const arch = read('..', '..', '..', 'docs', 'ARCHITECTURE.md')
  const archVer = /（(\d+\.\d+\.\d+)）/.exec(arch)?.[1] ?? ''
  if (archVer) banned.push(`docs/ARCHITECTURE.md 的散文里写了 ${archVer}（这类带数字的说明必然滞后，应改成"以 /api/catalog 为准"）`)
  assert.deepEqual(banned, [], `不该存在版本号的地方出现了一个：\n  ${banned.join('\n  ')}`)
})

/**
 * 每个版本条目内的小节要按固定顺序、且同名小节不重复。
 * 这条判据的存在理由很具体：0.8.4 那一条里出现过**三个** `### 新增`（中间夹着一个 `### 变更`），
 * 而更新日志页是按文档出现顺序原样渲染的、不去重也不排序 —— 用户在界面上会看到
 * 三个并列的"新增"标题，同一类变化被拆到三处，读不出"这版到底多了什么"。
 *
 * 两条规则的适用范围**不一样**，这是刻意的分界：
 * - **同名小节重复 = 全文件都判**。它跟年代无关：并列的同名标题在界面上永远是缺陷，
 *   历史条目里留着它同样是骗人的显示（0.8.4 就是历史条目，正是它把这规则逼出来的）。
 * - **小节名白名单与顺序 = 只判当前版本**。那是这一版新立的写作规矩，
 *   历史条目里确实存在「优化」「界面」「测试」「重做」这类小节名 ——
 *   为了过门禁去重写历史等于伪造历史，所以那些留在原样。
 */
test('小节不许重复（全文件），且当前版本按 新增→变更→修复→移除 排', () => {
  const ORDER = ['新增', '变更', '修复', '移除']
  const text = read('..', '..', 'CHANGELOG.md')

  // —— 全文件：同名小节不许出现两次 ——
  const dupeProblems: string[] = []
  const byVersion = text.split(/^(?=## \[)/m).filter(chunk => /^## \[/.test(chunk))
  for (const chunk of byVersion) {
    const version = /^## \[(.+?)\]/.exec(chunk)?.[1] ?? '?'
    const headings = [...chunk.matchAll(/^### (.+)$/gm)].map(m => m[1].trim())
    const dupes = headings.filter((name, index) => headings.indexOf(name) !== index)
    if (dupes.length) dupeProblems.push(`${version}: ${[...new Set(dupes)].join('、')}`)
  }
  assert.deepEqual(dupeProblems, [],
    `这些版本条目里有重复的同名小节（更新日志页按文档顺序原样渲染，会画出并列的同名标题）：\n  ${dupeProblems.join('\n  ')}`)

  // —— 仅当前版本：白名单 + 固定顺序 ——
  const firstVersionAt = text.search(/^## \[\d+\.\d+\.\d+\]/m)
  const nextVersionAt = text.indexOf('\n## [', firstVersionAt + 1)
  const block = text.slice(firstVersionAt, nextVersionAt < 0 ? text.length : nextVersionAt)
  const headings = [...block.matchAll(/^### (.+)$/gm)].map(m => m[1].trim())

  const unknown = headings.filter(name => !ORDER.includes(name))
  assert.deepEqual(unknown, [], `当前版本的小节名必须是这四个之一：多了 ${unknown.join('、')}`)
  const positions = headings.map(name => ORDER.indexOf(name))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
    `小节顺序必须是 新增→变更→修复→移除（用户最先该看到"多了什么"），实际是 ${headings.join(' → ')}`)
})

/** 接口层：读不到就 404，绝不能 200 + 空文本（前端会把"包里没有"念成"没有更新"）。 */
test('服务端 /changelog 读不到时报 404，不报"空日志"', () => {
  const routes = read('..', '..', 'app', 'src', 'main', 'kotlin', 'io', 'legado', 'http', 'Routes.kt')
  assert.match(routes, /get\("\/changelog"\)/, '要有 GET /api/changelog 这一条路由')
  assert.match(routes, /meta\/changelog\.md/, '它读的是随包的 meta/changelog.md（打进 jar 才谈得上"随包"）')
  assert.match(routes, /changelog_missing/, '读不到时给一个明确的错误码')
  assert.match(routes, /HttpStatusCode\.NotFound/, '读不到时必须是 404，不能 200 空字符串')
  const gradle = read('..', '..', 'app', 'build.gradle')
  assert.match(gradle, /changelog\.md/, '打包环节要把 CHANGELOG.md 拷进 meta/（否则运行时的包里没有它）')
})

/** 前端读的是同一个地址，且拿不到文本时如实报错。 */
test('api.changelog 读 /api/changelog，非 2xx 要抛而不是返回空串', () => {
  const api = read('..', 'src', 'lib', 'api.ts')
  assert.match(api, /changelog:.*\/api\/changelog/s, 'api.ts 要有 changelog()，打到 /api/changelog')
  const body = /changelog:[\s\S]{0,400}/.exec(api)?.[0] ?? ''
  assert.match(body, /res\.ok/, '要判断 res.ok')
  assert.match(body, /throw/, '非 2xx 必须抛（静默返回空串会被界面念成"没有更新"）')
})

test('ChangelogPage 初始态是"正在读取"，不是空列表', () => {
  const html = renderToStaticMarkup(React.createElement(ChangelogPage, { serverVersion: '0.2.0' }))
  assert.match(html, /changelog-loading/, '未到手之前要显示读取中')
  assert.match(html, /正在读取/, '文案要直说在读取')
  assert.doesNotMatch(html, /changelog-empty/, '还没读到就不许说"更新日志是空的"')
  assert.match(html, /当前运行的是 0\.2\.0/, '要报出服务端版本号')
  // 0.6.27 起更新日志是悬浮层：标题由层头给，正文改用 .page-lead 引导语，不再重复一遍大标题
  assert.match(html, /page-lead/, '引导语沿用悬浮层正文那一档式样')
  assert.doesNotMatch(html, /<h1>/, '标题在层头，正文不再重复一遍 h1')
})
