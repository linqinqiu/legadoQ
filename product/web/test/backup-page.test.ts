import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppHeader } from '../src/app/AppHeader'
import { toast } from '../src/components/Toast'
import { defaultReaderSettings } from '../src/features/reader/settingsPanel/readerSettings'
import { BackupPage, BackupPreviewPanel, defaultBackupSections, afterBackupImported, reportImportSummary } from '../src/plugins/backup/BackupPage'
import { api, type BackupImportPreview } from '../src/lib/api'
import { applyPreferencePatch, mapReadStyle } from '../src/features/reader/settingsPanel/backupPreferences'

const SRC = path.resolve(import.meta.dirname, '../src')

test('迁移包有独立导出入口并说明留档与恢复边界', () => {
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  assert.ok(html.includes('导出含留档的迁移包'))
  assert.ok(html.includes('冲突书源版本与原始书架引用'))
  assert.ok(html.includes('不自动激活书源版本或套用设置'))
  assert.ok(html.includes('私密配置'))
  assert.ok(html.includes('完整数据库状态'))
})

const preview: BackupImportPreview = {
  sections: [
    { id: 'sources', label: '书源', items: 2, policy: '保留本机启用状态' },
    { id: 'cookies', label: '登录凭据', items: 1, policy: '单独勾选' },
  ],
  warnings: ['包内可解析数，不是预计新增数'],
}

test('预览默认不勾凭据；没有选择时禁止确认，重试和取消可用', () => {
  assert.deepEqual(defaultBackupSections(preview), ['sources'])
  let confirmed = 0
  let cancelled = 0
  let refreshed = 0
  const panel = BackupPreviewPanel({
    preview, selected: [], busy: false, onToggle: () => undefined,
    onConfirm: () => { confirmed++ }, onCancel: () => { cancelled++ }, onRefresh: () => { refreshed++ },
  })
  const html = renderToStaticMarkup(panel)
  assert.ok(html.includes('预览尚未写入数据'))
  assert.ok(html.includes('书源（2）'))
  assert.match(html, /disabled=""[^>]*>确认导入所选内容/)
  assert.ok(!html.includes('checked=""'))
  const children = React.Children.toArray(panel.props.children)
  const actions = children.at(-1) as React.ReactElement<{ children: React.ReactNode }>
  const buttons = React.Children.toArray(actions.props.children) as React.ReactElement<{ onClick: () => void }>[]
  buttons[1].props.onClick()
  buttons[2].props.onClick()
  assert.equal(refreshed, 1)
  assert.equal(cancelled, 1)
  assert.equal(confirmed, 0)
})

test('预览与确认走同一文件：预览请求带模式，确认请求只带明确选择', async () => {
  const original = globalThis.fetch
  const requests: { url: string; form: FormData }[] = []
  globalThis.fetch = async (input, init) => {
    assert.ok(init?.body instanceof FormData)
    requests.push({ url: String(input), form: init.body })
    return new Response(JSON.stringify(preview), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const file = new File(['[]'], 'backup.json', { type: 'application/json' })
    await api.previewBackupFile(file, 'pw')
    await api.importBackupFile(file, 'pw', ['sources'])
    assert.equal(requests[0].url, '/api/backup/import?preview=true')
    assert.equal(requests[0].form.get('sections'), null)
    assert.equal(requests[1].url, '/api/backup/import')
    assert.equal(requests[1].form.get('sections'), '["sources"]')
    for (const request of requests) {
      assert.equal(request.form.get('password'), 'pw')
      assert.equal(await (request.form.get('file') as File).text(), '[]')
    }
  } finally {
    globalThis.fetch = original
  }
})

test('仅分组、凭据或个性化导入也应如实报告成功，空结果仍报告具体问题', () => {
  const messages: string[] = []
  const unsubscribe = toast.subscribe(items => { messages.splice(0, messages.length, ...items.map(item => item.message)) })
  const base = { sources: 0, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0 }
  try {
    reportImportSummary({ ...base, bookGroups: 3 })
    assert.ok(messages.at(-1)?.includes('分组 3'))
    reportImportSummary({ ...base, cookies: 2 })
    assert.ok(messages.at(-1)?.includes('登录凭据 2'))
    reportImportSummary({ ...base, keptSections: [{ name: 'readConfig.json', label: '阅读样式', bytes: 1, items: 1, appliable: true, updatedAt: 1 }] })
    assert.ok(messages.at(-1)?.includes('原样收下 1 类条目'))
    reportImportSummary({ ...base, booksSkippedDeleted: 1, cookiesNote: '密码不对', errors: ['坏书源'] })
    assert.ok(messages.some(message => message.includes('按删除保留')))
    assert.ok(messages.some(message => message.includes('密码不对')))
    assert.ok(messages.some(message => message.includes('坏书源')))
  } finally {
    unsubscribe()
  }
})

test('策略变化使预览失效并禁用确认 仅书架有数据库差异预测', () => {
  const policy = { metadata: 'keep_local', progress: 'newer' } as const
  const detailed: BackupImportPreview = {
    sections: [{ id: 'shelf', label: '书架', items: 3, policy: '保留删除决定' }], warnings: [],
    libraryPolicy: policy, previewToken: 'digest',
    libraryDiff: { booksAdded: 1, booksUpdated: 0, booksKept: 1, skippedDeleted: 1, progressApplied: 1, progressKept: 1, progressUnknownTime: 1, duplicates: 0 },
  }
  let chosen: unknown
  const props = {
    preview: detailed, selected: ['shelf'] as ('shelf')[], busy: false, policy,
    onPolicyChange: (next: unknown) => { chosen = next },
    onToggle: () => undefined, onConfirm: () => undefined, onCancel: () => undefined, onRefresh: () => undefined,
  }
  const panel = BackupPreviewPanel(props)
  const html = renderToStaticMarkup(panel)
  assert.ok(html.includes('只采用明确较新的进度'))
  assert.ok(html.includes('预计：新增 1 本'))
  assert.ok(html.includes('缺少有效进度时间 1 条'))
  const fieldset = React.Children.toArray(panel.props.children).find(child => React.isValidElement(child) && child.type === 'fieldset') as React.ReactElement<{ children: React.ReactNode }>
  const metadataLabel = React.Children.toArray(fieldset.props.children)[1] as React.ReactElement<{ children: React.ReactNode }>
  const select = React.Children.toArray(metadataLabel.props.children)[1] as React.ReactElement<{ onChange: (event: unknown) => void }>
  select.props.onChange({ target: { value: 'overwrite' } })
  assert.deepEqual(chosen, { metadata: 'overwrite', progress: 'newer' })
  const stale = renderToStaticMarkup(BackupPreviewPanel({ ...props, stale: true }))
  assert.match(stale, /disabled=""[^>]*>确认导入所选内容/)
  assert.ok(stale.includes('请重新预览后确认'))
  assert.ok(!stale.includes('预计：新增'))
})

test('冲突策略与凭证在确认请求一起提交 409 保留服务端重预览提示', async () => {
  const original = globalThis.fetch
  const policy = { metadata: 'keep_local', progress: 'newer' } as const
  const forms: FormData[] = []
  globalThis.fetch = async (_input, init) => {
    forms.push(init!.body as FormData)
    return forms.length === 1 ? new Response('{}', { status: 200 }) :
      new Response(JSON.stringify({ code: 'backup_preview_changed', message: '相关书架与进度已变化，请重新预览后确认' }), { status: 409 })
  }
  try {
    const file = new File(['[]'], 'backup.json')
    await api.previewBackupFile(file, undefined, policy)
    await assert.rejects(api.importBackupFile(file, undefined, ['shelf'], policy, 'digest'), /请重新预览后确认/)
    assert.equal(forms[0].get('libraryPolicy'), JSON.stringify(policy))
    assert.equal(forms[0].get('previewToken'), null)
    assert.equal(forms[1].get('libraryPolicy'), JSON.stringify(policy))
    assert.equal(forms[1].get('previewToken'), 'digest')
  } finally { globalThis.fetch = original }
})

test('全部按策略保留也报告处理完成与实际保留数量', () => {
  const messages: string[] = []
  const unsubscribe = toast.subscribe(items => { messages.splice(0, messages.length, ...items.map(item => item.message)) })
  try {
    reportImportSummary({ sources: 0, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0,
      libraryDiff: { booksAdded: 0, booksUpdated: 0, booksKept: 2, skippedDeleted: 0, progressApplied: 0, progressKept: 2, progressUnknownTime: 1, duplicates: 0 } })
    assert.ok(messages.some(message => message.includes('导入完成')))
    assert.ok(messages.some(message => message.includes('保留书架信息 2 本')))
    assert.ok(!messages.some(message => message.includes('没有可导入的内容')))
  } finally { unsubscribe() }
})

test('备份页以本地备份包为主 可选手动 WebDAV 明确边界', () => {
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  // 0.6.27 起备份是悬浮层：标题在层头（BackupPage 单独静态渲染看不到），正文只说清入口与动作
  assert.ok(html.includes('备份包'), '正文要点明这是备份包入口（标题在悬浮层头）')
  assert.ok(html.includes('选择备份包导入'), '主按钮必须能选本地 zip')
  assert.ok(html.includes('accept=".zip,.json,.txt,application/zip,application/json"'), '裸 JSON 分享书源与兄弟备份也要能直接选')
  // 用户 2026-09-30：「手机恢复这个名词解释有些难听，咱们这是电脑啊，支持手机端阅读的备份，但是不要这么命名」
  assert.ok(!/手机恢复|手机端|手机导入|手机端恢复/.test(html), `不许把电脑上的页面命名成手机动作：${html.slice(0, 200)}`)
  // 备份密码只是 cookies.json 一件事的钥匙，不是导入的前置条件（#64）；折叠态下给一个可展开入口
  assert.ok(html.includes('登录凭据'), '有可展开的凭据密码入口')
  assert.ok(!html.includes('backup-password-row'), '默认折叠：一进页面就摆一个密码框，看着像必填')
  assert.ok(!html.includes('需要填备份密码'), '不能再出现"某某内容需要填备份密码"式的门槛措辞')
  assert.ok(html.includes('不填也照样导入') || !html.includes('cookies'), '要说清不填密码只影响凭据那一节')
  assert.ok(html.includes('保留你本机的启用/停用选择'),
    '必须提前说清"已存在的书源不会被刷掉启用位"')
  assert.ok(html.includes('不会留在电脑上'), '要说清包不会被留下，用户才敢把备份交出来')
  assert.ok(html.includes('手动 WebDAV 迁移'), '用户要求的远端迁移使用独立区')
  assert.ok(html.includes('不会自动同步或自动恢复'), '手动迁移不冒充双向同步')
})

test('「会恢复到应用里 / 原样收下的条目」清单里不许有同名条目（同一条列两遍 = 重复 key + 说法打架）', () => {
  // 2026-10-09 抓到：「TXT 分章规则」在 KEPT_SECTIONS 里被列了两遍（一条说"可套用"、
  // 一条说"原样存着不读"，互相矛盾），同时是 React 的重复 key（只警告、不报错，门禁看不见）。
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  const labels = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1].trim())
  assert.ok(labels.length > 0, '清单没渲染出来，判据在演空戏')
  const dupes = [...new Set(labels.filter((label, index) => labels.indexOf(label) !== index))]
  assert.deepEqual(dupes, [], `这些条目列了两遍：${dupes.join('、')}`)
})

test('备份页分两层说明，且两层不交叉：会恢复到应用里 / 原样收下的条目', () => {
  // 0.6.27 之前两层混在一个「这个包会恢复什么」清单里，"恢复进应用"和"原样收下"读不出区别。
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  assert.ok(html.includes('会恢复到应用里'), '恢复那一层要有自己的标题')
  assert.ok(html.includes('原样收下的条目'), '原样收下那一层要有自己的标题')
  const restored = /会恢复到应用里([\s\S]*?)原样收下的条目/.exec(html)?.[1] ?? ''
  assert.ok(restored.length > 0, '两层之间要有内容')
  for (const kept of ['阅读样式', '朗读引擎', '字典规则']) {
    assert.ok(!restored.includes(kept), `「${kept}」属于"原样收下"那一层，不该混进"会恢复到应用里"`)
  }
})

test('备份页有"启动快照"区（②-b 恢复入口），SSR 无数据时给空态而非报错', () => {
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  assert.ok(html.includes('启动快照'), '备份页要挂上启动快照区')
  assert.ok(html.includes('排定恢复') || html.includes('还没留下过快照'),
    '快照区要么列出可排定的快照、要么给"还没有快照"的空态，不能是空白或报错')
})

/**
 * #66：包里没有原生归宿的个性化条目要说清"收下了"而不是"跳过了"。
 * 这里喂一条 keptSections 进去，验播报把这批条目念出来。
 */
test('导入结果播报：原样收下的条目单独一句，不和"不承接"混在一起', () => {
  const shown: string[] = []
  const unsubscribe = toast.subscribe(items => { items.forEach(item => { if (!shown.includes(item.message)) shown.push(item.message) }) })
  try {
    reportImportSummary({
      sources: 1, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0,
      keptSections: [
        { name: 'readConfig.json', label: '阅读样式', bytes: 2048, items: 3, appliable: true, updatedAt: 1 },
        { name: 'dictRule.json', label: '字典规则', bytes: 512, items: 2, appliable: false, updatedAt: 1 },
      ],
      skippedSections: ['replaceRule.json'],
    })
  } finally {
    unsubscribe()
  }
  const all = shown.join('\n')
  assert.ok(all.includes('另外原样收下 2 类条目'), all)
  assert.ok(all.includes('阅读样式') && all.includes('字典规则'), '收下的条目名要念出来：' + all)
  assert.ok(all.includes('连收下的地方都还没有'), '真的没承接的才用重话：' + all)
})

test('套用只在前端映射得动的条目上出现，映射结果如实播报（含换算说明）', () => {
  const current = { ...defaultReaderSettings, theme: 'dark' as const }
  const merged = applyPreferencePatch(current, mapReadStyle(JSON.stringify([{ isDefault: true, fontSize: 20, lineSpacing: 10 }]), current).patch)
  assert.equal(merged.theme, 'dark', '套用是叠加：没映射到的本机设置不许被动')
  assert.equal(merged.fontSize, 20)
  assert.equal(merged.lineHeight, 1.5, '10dp 行距 / 20 号字 = 1 + 0.5 倍')
})

test('导航：一级是 书库/书架/书源/发现/订阅/设置；书源回到顶栏，打开时高亮「书源」', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppHeader, {
      page: 'sources', // 书源 2026-10-09 回到顶栏一级
      settings: { ...defaultReaderSettings },
      onSettingsChange: () => undefined,
      onNavigate: () => undefined,
    }),
  )
  // 一级入口就是这六个（用户 2026-10-08 定框架，2026-10-09 要求把「书源」放回顶栏）
  for (const nav of ['书库', '书架', '书源', '发现', '订阅', '设置']) {
    assert.ok(html.includes(nav), `主导航要有「${nav}」这一档`)
  }
  assert.ok(html.includes('我的'), '「我的」菜单入口在位')
  assert.ok(html.includes('header-menu-btn'), '☰ 功能菜单按钮在位')
  assert.match(html, /class="active"[^<]*书源/, '打开书源时顶栏高亮的是「书源」这一档')
  assert.ok(!/WebDAV/i.test(html), '导航文案不能再承诺 WebDAV')
})

test('导入结果播报：启用位、RSS、分组、跳过项与单条错误都要念出来', () => {
  const shown: string[] = []
  const unsubscribe = toast.subscribe(items => { items.forEach(item => { if (!shown.includes(item.message)) shown.push(item.message) }) })
  try {
    reportImportSummary({
      sources: 3, sourcesUpdated: 2, rules: 1, rulesUpdated: 0, books: 4, booksUpdated: 1, progress: 5,
      cookies: 6, cookiesNote: '包内有加密凭据，未填密码已跳过',
      rssSources: 7, rssSourcesUpdated: 8, bookGroups: 9, subscriptions: 10,
      skippedSections: ['ttsSource.json', 'dictRule.json'], errors: ['第 3 条书源 JSON 解析失败'],
    })
  } finally {
    unsubscribe()
  }
  const all = shown.join('\n')
  assert.ok(all.includes('书源 5'), `新增+覆盖要合并报数：${all}`)
  assert.ok(all.includes('保留本机启用状态'), '必须说明已存在的书源没被刷启用位')
  assert.ok(all.includes('RSS 订阅源 15'), `RSS 要报：${all}`)
  assert.ok(all.includes('分组 9'), '分组要报')
  assert.ok(all.includes('书源订阅 10'), 'sourceSub.json 恢复的书源订阅要报，不能只留档不说话')
  assert.ok(all.includes('登录凭据 6'), '凭据要报')
  assert.ok(all.includes('ttsSource.json'), '不承接的条目名要如实念出来')
  assert.ok(all.includes('1 条没读进去'), '单条解析失败不许静默')
  assert.ok(all.includes('未填密码已跳过'), 'cookiesNote 要原样转达')
})

test('导入成功后必须触发宿主刷新书源缓存——否则书源页/选源下拉还是导入前那份', () => {
  // 书源走 sourceCatalog 共享缓存，load() 在 ready 时直接返回旧数组。导入写了库却没 invalidate，
  // 界面看到的就是"导了没用"。这里的回调就是宿主接的 refreshSources（sourceCatalog.invalidate）。
  let refreshes = 0
  const summary = {
    sources: 2, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0,
  }
  afterBackupImported(summary, () => { refreshes += 1 })
  assert.equal(refreshes, 1, '导入成功后恰好刷新一次书源，让共享缓存重新拉取')
  // 没接宿主时也不能抛（SSR 静态渲染 / 独立使用）
  afterBackupImported(summary)
  assert.equal(refreshes, 1, '不给回调时安静跳过，不报错')
})

test('切页容器带 key={page}：切页重挂载才能重放 .page-enter 动画', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.tsx'), 'utf8')
  assert.match(main, /<Suspense\s+key=\{page\}\s+fallback=\{<ChunkLoading\s*\/>\}>\{renderPage\(page, pageContext\)\}<\/Suspense>/,
    '页面容器必须按 page 加 key，否则 React 复用子树、切页动画不重放')
  // 书源浮层必须把宿主的刷新回调接进来
  assert.match(main, /<BackupModal[^>]*onImported=\{refreshSources\}/,
    '备份浮层要接到 refreshSources，导入成功才能刷新书源缓存')
})

test('导入结果播报：空包要警告而不是报"完成"', () => {
  const shown: string[] = []
  const unsubscribe = toast.subscribe(items => { items.forEach(item => { if (!shown.includes(item.message)) shown.push(item.message) }) })
  try {
    reportImportSummary({
      sources: 0, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0,
      rssSources: 0, rssSourcesUpdated: 0, skippedSections: ['highlight.json'],
    })
  } finally {
    unsubscribe()
  }
  assert.ok(shown.join('\n').includes('没有可导入的内容'), '空包要说空')
  assert.ok(shown.join('\n').includes('highlight.json'), '顺带说明跳过了什么')
})

test('只有书源订阅的包不能报"没有可导入的内容"', () => {
  const shown: string[] = []
  const unsubscribe = toast.subscribe(items => { items.forEach(item => { if (!shown.includes(item.message)) shown.push(item.message) }) })
  try {
    reportImportSummary({
      sources: 0, sourcesUpdated: 0, rules: 0, rulesUpdated: 0, books: 0, booksUpdated: 0, progress: 0,
      subscriptions: 3,
    })
  } finally {
    unsubscribe()
  }
  // toast 是全局 store，subscribe 会立刻回放之前用例留下的消息；只看这次播报的最后一条。
  const latest = shown[shown.length - 1] ?? ''
  assert.ok(!latest.includes('没有可导入的内容'), `订阅也算导入内容：${latest}`)
  assert.ok(latest.includes('书源订阅 3'), `只导订阅也要报数：${latest}`)
})

/** 去掉注释：残留扫描要抓的是"代码还在用 WebDAV"，不是"某句解释提到了它"。 */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

test('手动 WebDAV 只在备份域接入 不恢复旧独立设置页', () => {
  const files = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(name => /\.(ts|tsx|css)$/.test(name))
  const hits = files
    .map(name => [name, stripComments(fs.readFileSync(path.join(SRC, name), 'utf8'))] as const)
    .filter(([, code]) => /webdav/i.test(code))
    .map(([name]) => name.replaceAll('\\', '/')).sort()
  // 2026-11-28 用户授权手动迁移；旧的持久配置/自动同步不随之恢复。
  assert.deepEqual(hits, [
    'lib/api/domains/backup.ts', 'lib/api/types.ts', 'plugins/backup/BackupPage.tsx',
    'plugins/backup/BackupWebDavPanel.tsx', 'styles.css',
  ], `WebDAV 接入应限于备份域：${hits.join('、')}`)
  const panel = fs.readFileSync(path.join(SRC, 'plugins/backup/BackupWebDavPanel.tsx'), 'utf8')
  assert.ok(!/localStorage\s*\.|sessionStorage\s*\./.test(stripComments(panel)), 'WebDAV 凭据不进入持久存储')
  assert.ok(!fs.existsSync(path.join(SRC, 'WebDavSettingsPage.tsx')), '旧的那一页必须删干净')
})
