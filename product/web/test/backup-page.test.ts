import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppHeader } from '../src/components/AppHeader'
import { toast } from '../src/components/Toast'
import { defaultReaderSettings } from '../src/reader/readerSettings'
import { BackupPage, reportImportSummary } from '../src/pages/BackupPage'
import { applyPreferencePatch, mapReadStyle } from '../src/lib/backupPreferences'

const SRC = path.resolve(import.meta.dirname, '../src')

test('备份页静态渲染：主语是备份包，不是"手机恢复"，也不再教用户连网络服务', () => {
  const html = renderToStaticMarkup(React.createElement(BackupPage))
  // 0.6.27 起备份是悬浮层：标题在层头（BackupPage 单独静态渲染看不到），正文只说清入口与动作
  assert.ok(html.includes('备份包'), '正文要点明这是备份包入口（标题在悬浮层头）')
  assert.ok(html.includes('选择备份包导入'), '主按钮必须能选本地 zip')
  // 用户 2026-09-30：「手机恢复这个名词解释有些难听，咱们这是电脑啊，支持手机端阅读的备份，但是不要这么命名」
  assert.ok(!/手机恢复|手机端|手机导入|手机端恢复/.test(html), `不许把电脑上的页面命名成手机动作：${html.slice(0, 200)}`)
  // 备份密码只是 cookies.json 一件事的钥匙，不是导入的前置条件（#64）；折叠态下给一个可展开入口
  assert.ok(html.includes('登录凭据'), '有可展开的凭据密码入口')
  assert.ok(!html.includes('backup-password-row'), '默认折叠：一进页面就摆一个密码框，看着像必填')
  assert.ok(!html.includes('需要填备份密码'), '不能再出现"某某内容需要填备份密码"式的门槛措辞')
  assert.ok(html.includes('不填也照样导入') || !html.includes('cookies'), '要说清不填密码只影响凭据那一节')
  assert.ok(html.includes('保留你本机的启用/停用选择'),
    '必须提前说清"已存在的书源不会被刷掉启用位"')
  assert.ok(html.includes('临时文件'), '要说清包不落盘，用户才敢把备份交出来')
  assert.ok(!/WebDAV|webdav/i.test(html), '页面上不许再出现 WebDAV 字样')
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
      rssSources: 7, rssSourcesUpdated: 8, bookGroups: 9,
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
  assert.ok(all.includes('登录凭据 6'), '凭据要报')
  assert.ok(all.includes('ttsSource.json'), '不承接的条目名要如实念出来')
  assert.ok(all.includes('1 条没读进去'), '单条解析失败不许静默')
  assert.ok(all.includes('未填密码已跳过'), 'cookiesNote 要原样转达')
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

/** 去掉注释：残留扫描要抓的是"代码还在用 WebDAV"，不是"某句解释提到了它"。 */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

test('前端代码里彻底没有 WebDAV 残留（注释里的历史说明不算）', () => {
  const files = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(name => /\.(ts|tsx|css)$/.test(name))
  const hits = files
    .map(name => [name, stripComments(fs.readFileSync(path.join(SRC, name), 'utf8'))] as const)
    .filter(([, code]) => /webdav/i.test(code))
    .map(([name]) => name)
  assert.deepEqual(hits, [], `这些文件的代码还提到 WebDAV：${hits.join('、')}`)
  assert.ok(!fs.existsSync(path.join(SRC, 'WebDavSettingsPage.tsx')), '旧的那一页必须删干净')
})
