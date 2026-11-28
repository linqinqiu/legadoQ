/**
 * 备份预览/确认的真实浏览器验收。先构建当前 UI 与 fatJar，再执行：
 *   node tools/verify/backup-preview-ui-check.mjs
 * 自建随机回环端口、临时数据目录和浏览器 profile；忽略 LEGADO_BASE_URL，绝不连接日常实例。
 * 样本为脚本生成的 ZIP，不代表真实手机备份的格式验收。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { ROOT, OUT, chromePath } from './env.mjs'
import { makeZip } from './zip-make.mjs'
import { hashStaticDirectory } from '../../scripts/runtime.mjs'

const puppeteer = createRequire(path.join(ROOT, 'web/package.json'))('puppeteer-core')
const executablePath = chromePath()
assert.ok(executablePath, '需要 Chromium：设置 LEGADO_CHROME 或 CHROME_PATH')
const libs = path.join(ROOT, 'app/build/libs')
const jars = fs.readdirSync(libs).filter(name => name.endsWith('-all.jar'))
assert.equal(jars.length, 1, '先构建当前版本 fatJar；目录中应只有一个 *-all.jar')
const jar = path.join(libs, jars[0])
const output = path.join(OUT, 'backup-preview-ui')
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: false, phase: 'started' }))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-backup-preview-ui-'))
const dataDir = path.join(tmpRoot, 'data')
fs.mkdirSync(dataDir)
const checks = []
const requests = []
const pageErrors = []
let serviceLog = ''
let child
let browser
let serviceError
let base
let page
let serviceClosed
let health
const sourceId = 'https://backup-preview.example/'
const bookUrl = 'book'
const password = 'preview-fixture-only'
const progressPath = `/api/reading-progress?${new URLSearchParams({ sourceId, bookUrl })}`
const fixtureBook = (name, chapter, time) => ({
  origin: sourceId, bookUrl, name, durChapterIndex: chapter, durChapterPos: 7, durChapterTime: time,
})

function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name)
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, signal: AbortSignal.timeout(15_000) })
  const text = await response.text()
  assert.ok(response.ok, `${route}: HTTP ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function state() {
  const [sources, shelf, progress, kept] = await Promise.all([
    api('/api/sources'), api('/api/bookshelf'), api(progressPath), api('/api/backup/kept'),
  ])
  return { sources, shelf, progress, kept }
}

async function click(label, scope = '') {
  const selector = `${scope ? `${scope} ` : ''}button`
  const buttons = await page.$$(selector)
  try {
    for (const button of buttons) {
      if (await button.evaluate(node => node.textContent.trim()) === label) {
        await button.scrollIntoView()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const hit = await button.evaluate(node => {
          const box = node.getBoundingClientRect()
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          return { blocked: !target || !node.contains(target), target: target?.tagName, className: target?.className, disabled: node.disabled }
        })
        assert.equal(hit.blocked || hit.disabled, false, `${label}: ${JSON.stringify(hit)}`)
        await button.click()
        return
      }
    }
  } finally {
    await Promise.all(buttons.map(button => button.dispose()))
  }
  throw new Error(`没有找到按钮：${label}`)
}

const previewSelector = '[aria-label="备份导入预览"]'
async function preview(action) {
  const response = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/backup/import' && new URL(response.url()).searchParams.get('preview') === 'true')
  await action()
  const received = await response
  assert.equal(received.status(), 200, await received.text())
  const json = await received.json()
  await page.waitForSelector(`${previewSelector} fieldset:not([disabled])`)
  return json
}

async function confirm(expectedStatus = 200) {
  const response = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/backup/import' && !new URL(response.url()).search)
  await click('确认导入所选内容', previewSelector)
  const received = await response
  assert.equal(received.status(), expectedStatus, await received.text())
  if (expectedStatus === 200) await page.waitForSelector(previewSelector, { hidden: true })
  else await page.waitForFunction(selector => !!document.querySelector(`${selector} [role="alert"]`), {}, previewSelector)
  return received.json()
}

async function confirmDisabled() {
  return page.$eval(`${previewSelector} .primary-button`, node => node.disabled)
}

async function selectedSections() {
  return page.$$eval(`${previewSelector} input[type="checkbox"]`, nodes => nodes.map(node => ({
    label: node.closest('label').textContent, selected: node.checked,
  })))
}

async function onlyShelf() {
  const boxes = await page.$$(`${previewSelector} input[type="checkbox"]`)
  try {
    for (const box of boxes) {
      const { selected, shelf } = await box.evaluate(node => ({
        selected: node.checked, shelf: node.closest('label').textContent.includes('书架与阅读进度'),
      }))
      if (selected !== shelf) await box.click()
    }
  } finally {
    await Promise.all(boxes.map(box => box.dispose()))
  }
}

try {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  base = `http://127.0.0.1:${port}`
  console.log(`隔离实例 ${base}；数据 ${dataDir}；产物 ${jar}`)
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
  child = spawn(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    `-Djava.io.tmpdir=${tmpRoot}`, '-jar', jar], {
    cwd: tmpRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LEGADO_HOST: '127.0.0.1', LEGADO_PORT: String(port),
      LEGADO_DATA_DIR: dataDir, LEGADO_DATABASE: path.join(dataDir, 'legado.sqlite'),
      LEGADO_HOME: tmpRoot, LEGADO_NEXT_DIR: path.join(tmpRoot, 'next'),
      LEGADO_ACCESS_TOKEN: '' },
  })
  serviceClosed = new Promise(resolve => child.once('close', resolve))
  child.on('error', error => { serviceError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    serviceLog = (serviceLog + chunk.toString('utf8')).slice(-200_000)
  })
  const started = Date.now()
  while (Date.now() - started < 90_000) {
    if (serviceError) throw serviceError
    assert.equal(child.exitCode, null, `隔离服务意外退出：${serviceLog.slice(-2000)}`)
    try { health = await api('/healthz'); break } catch { await delay(500) }
  }
  assert.ok(health, `隔离服务启动超时：${serviceLog.slice(-2000)}`)
  const staticHashes = hashStaticDirectory(path.join(ROOT, 'web/dist'))
  assert.ok(Object.hasOwn(staticHashes, 'index.html'), '需要完整的 web/dist；先构建当前 UI')
  const mismatches = []
  for (const [file, expected] of Object.entries(staticHashes)) {
    const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(10_000) })
    const actual = crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')
    if (response.status !== 200 || actual !== expected) mismatches.push(`${file}:HTTP ${response.status}`)
  }
  check(`隔离实例全部 ${Object.keys(staticHashes).length} 个静态文件与本次 dist 一致`, mismatches, [])

  const seed = new FormData()
  seed.append('file', new Blob([JSON.stringify({ bookshelf: [fixtureBook('本机书名', 2, 100)] })]), 'seed.json')
  seed.append('sections', JSON.stringify(['shelf']))
  await api('/api/backup/import', { method: 'POST', body: seed })
  const initial = await state()
  check('夹具仅初始化临时书架', initial.shelf.length, 1)
  check('临时库没有预置书源', initial.sources, [])
  const cipher = crypto.createCipheriv('aes-128-ecb',
    Buffer.from(crypto.createHash('md5').update(password).digest('hex').slice(0, 16), 'ascii'), null)
  const cookies = Buffer.concat([
    cipher.update(JSON.stringify([{ url: sourceId, cookie: 'fixture=1' }]), 'utf8'), cipher.final(),
  ]).toString('base64')
  const file = path.join(tmpRoot, 'backup-preview.zip')
  fs.writeFileSync(file, makeZip([
    // 超过网络分块缓冲，覆盖 streamProvider 在 Netty event loop 上阻塞的大包回归。
    // 两个规则版本仍各小于单源 1 MiB 上限，归一化后只保留最后一个。
    { name: 'bookSource.json', data: JSON.stringify([
      { bookSourceUrl: `${sourceId}#旧版本`, bookSourceName: '浏览器旧版本',
        ruleSearch: { bookList: '.archived-book', name: '.archived-title@text' }, sourceComment: 'x'.repeat(768 * 1024) },
      { bookSourceUrl: sourceId, bookSourceName: '浏览器夹具源',
        ruleSearch: { bookList: '.current-book', name: '.current-title@text' }, sourceComment: 'x'.repeat(768 * 1024) },
    ]) },
    // 留足浏览器冷启动余量；这是合成的新时间，不借本机时钟竞速判定。
    { name: 'bookshelf.json', data: JSON.stringify([fixtureBook('备份书名', 6, Date.now() + 86_400_000)]) },
    { name: 'readConfig.json', data: JSON.stringify([{ name: '夹具样式', fontSize: 22 }]) },
    { name: 'cookies.json', data: cookies },
  ]))

  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(tmpRoot, 'profile'),
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-background-networking', '--disable-component-update'], timeout: 60_000 })
  page = await browser.newPage()
  page.setDefaultTimeout(25_000)
  await page.setViewport({ width: 1280, height: 960 })
  await page.evaluateOnNewDocument(() => localStorage.setItem('legadoq-agreement-v1', '1'))
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === base && url.pathname.startsWith('/api/backup/')) requests.push({ method: request.method(), path: url.pathname + url.search })
  })
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForSelector('nav[aria-label="主导航"] button')
  await click('设置', 'nav[aria-label="主导航"]')
  await page.waitForSelector('.settings-page')
  await click('打开备份', '.settings-page')
  await page.waitForSelector('input[type="file"][accept*=".zip"]')
  const upload = async () => {
    const input = await page.$('input[type="file"][accept*=".zip"]')
    try { await input.uploadFile(file) } finally { await input.dispose() }
  }
  const first = await preview(upload)
  check('页面预览返回处理预测', first.libraryDiff.progressApplied, 1)
  check('大包上传完成且页面显示书源版本合并警告', await page.$eval(previewSelector,
    node => /2 条有效书源[\s\S]*合并 1 条/.test(node.textContent)))
  check('预览未改书源、书架、进度和留档', await state(), initial)
  await click('取消', previewSelector)
  await page.waitForSelector(previewSelector, { hidden: true })
  check('取消预览没有写入', await state(), initial)

  await preview(upload)
  await page.type('input[aria-label="凭据解密密码"]', password)
  check('修改密码后确认按钮禁用', await confirmDisabled())
  await preview(() => click('重新预览', previewSelector))
  const credentials = (await selectedSections()).find(section => section.label.includes('登录凭据'))
  check('正确密码解出登录凭据但默认不勾选', credentials?.selected, false)
  await page.select(`${previewSelector} select`, 'overwrite')
  check('修改冲突策略后确认按钮禁用', await confirmDisabled())
  await preview(() => click('重新预览', previewSelector))
  await page.select(`${previewSelector} select`, 'keep_local')
  await preview(() => click('重新预览', previewSelector))
  check('重新预览仍然没有导入写入', await state(), initial)

  await api('/api/reading-progress', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, bookUrl, chapterUrl: 'local-chapter-9', chapterIndex: 9 }) })
  const changed = await state()
  const stale = await confirm(409)
  check('本机进度变化返回明确的失效原因', stale.code, 'backup_preview_changed')
  check('失效确认没有部分导入书源/留档或改动书架进度', await state(), changed)
  check('失效后必须重新预览', await confirmDisabled())
  await page.screenshot({ path: path.join(output, 'stale-preview.png'), fullPage: true })

  const refreshed = await preview(() => click('重新预览', previewSelector))
  await onlyShelf()
  const imported = await confirm()
  check('确认结果与重新预览预测一致', imported.libraryDiff, refreshed.libraryDiff)
  const restored = await state()
  check('默认策略保留本机书名', restored.shelf[0].name, '本机书名')
  check('默认策略采用明确较新的备份进度', restored.progress.chapterIndex, 6)
  check('未选书源和个性化条目均未写入', { sources: restored.sources, kept: restored.kept }, { sources: [], kept: [] })
  check('未选凭据计数为零', imported.cookies ?? 0, 0)

  await preview(upload)
  const selects = await page.$$(`${previewSelector} select`)
  try {
    await selects[0].select('overwrite')
    await selects[1].select('keep_local')
  } finally { await Promise.all(selects.map(select => select.dispose())) }
  const policyPreview = await preview(() => click('重新预览', previewSelector))
  check('重新预览采用用户的两个独立策略', policyPreview.libraryPolicy, { metadata: 'overwrite', progress: 'keep_local' })
  await onlyShelf()
  await confirm()
  const metadataOnly = await state()
  check('显式策略恢复备份书名', metadataOnly.shelf[0].name, '备份书名')
  check('不恢复进度策略完整保留已有进度', metadataOnly.progress, restored.progress)
  await preview(upload)
  await page.screenshot({ path: path.join(output, 'ready-preview.png'), fullPage: true })
  const remaining = await confirm()
  const complete = await state()
  check('显式确认默认所选模块后才写入书源', complete.sources.length, 1)
  check('显式确认后个性化条目和冲突书源进入留档', complete.kept.length, 2)
  const variant = complete.kept.find(entry => /^source-variants-[a-f0-9]{64}\.json$/.test(entry.name))
  check('冲突版本在留档列表中可下载且不可套用', Boolean(variant && !variant.appliable))
  await page.waitForFunction(name => Array.from(document.querySelectorAll('a.backup-kept-download'))
    .some(link => link.getAttribute('download') === name), {}, variant.name)
  const archiveHref = await page.evaluate(name => Array.from(document.querySelectorAll('a.backup-kept-download'))
    .find(link => link.getAttribute('download') === name)?.getAttribute('href'), variant.name)
  check('真实页面显示冲突版本下载入口', archiveHref?.includes(variant.name) === true)
  check('页面下载入口返回冲突版本 JSON', (await api(archiveHref)).format, 'legadoq-source-variants-v1')
  check('多轮重新预览后凭据仍需单独勾选', remaining.cookies ?? 0, 0)
  // The import response precedes the UI's kept-list refresh/finally; export stays disabled until both finish.
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
    .some(button => button.textContent.trim() === '导出含留档的迁移包' && !button.disabled))
  const migrationResponse = page.waitForResponse(response => response.url().endsWith('/api/backup/export?domain=recovery'))
  await click('导出含留档的迁移包')
  const download = await migrationResponse
  check('页面迁移按钮请求成功', download.status(), 200)
  check('迁移下载文件名明确标明迁移包', download.headers()['content-disposition']?.includes('legadoq-migration-') === true)
  check('迁移下载实际返回 ZIP 字节', (await download.buffer()).subarray(0, 2).toString(), 'PK')
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '导出含留档的迁移包')?.disabled)

  // Exercise the actual archive-version UI and backend against this isolated database, without
  // replacing the earlier import checks or the following synthetic WebDAV transport lifecycle.
  const versionSelector = '[aria-label="书源历史版本"]'
  const versionPath = '/api/backup/source-versions/'
  const sourceRecordPath = `/api/sources/${encodeURIComponent(complete.sources[0].id)}`
  const archiveBytes = async () => {
    const response = await fetch(`${base}${archiveHref}`, { signal: AbortSignal.timeout(15_000) })
    assert.equal(response.status, 200, '书源版本留档可读')
    return Buffer.from(await response.arrayBuffer())
  }
  const beforeVersion = await state()
  const beforeVersionRecord = await api(sourceRecordPath)
  const beforeVersionSnapshots = await api('/api/backup/snapshots')
  const originalArchiveBytes = await archiveBytes()
  check('版本操作前仍采用当前夹具规则', JSON.parse(beforeVersionRecord.json).ruleSearch,
    { bookList: '.current-book', name: '.current-title@text' })
  const listResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${versionPath}list`)
  await click('查看版本')
  const listedResponse = await listResponse
  check('查看版本按钮调用真实书源版本列表接口', listedResponse.status(), 200)
  const listedVersions = await listedResponse.json()
  check('版本列表属于当前留档', JSON.parse(listedResponse.request().postData()).archive, variant.name)
  check('真实版本列表展示一个标准化书源的两个版本',
    { total: listedVersions.total, sizes: listedVersions.groups.map(group => group.variants.length) }, { total: 1, sizes: [2] })
  await page.waitForSelector(`${versionSelector} input[type="radio"]:not(:disabled)`)
  await page.waitForFunction(selector => {
    const panel = document.querySelector(selector)
    return panel && [...panel.querySelectorAll('fieldset')].every(fieldset => !fieldset.disabled)
  }, {}, versionSelector)
  const versionRadios = await page.$$(`${versionSelector} input[type="radio"]`)
  try {
    const oldVersion = []
    for (const radio of versionRadios) {
      if (await radio.evaluate(node => node.closest('label').textContent.includes('浏览器旧版本'))) oldVersion.push(radio)
    }
    assert.equal(oldVersion.length, 1, '应只有一个浏览器旧版本选项')
    await oldVersion[0].scrollIntoView()
    await oldVersion[0].click()
  } finally { await Promise.all(versionRadios.map(radio => radio.dispose())) }
  check('选中留档旧版后未预览不能确认', await page.$eval(`${versionSelector} .primary-button`, node => node.disabled))
  const versionPreviewResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${versionPath}preview`)
  await click('预览启用影响', versionSelector)
  const versionPreviewed = await versionPreviewResponse
  check('旧版规则通过真实接口预览', versionPreviewed.status(), 200)
  const versionPreview = await versionPreviewed.json()
  check('预览对应旧版本且覆盖现有关联书籍',
    { name: versionPreview.name, affected: versionPreview.affectedBooks, caches: versionPreview.cacheEntries },
    { name: '浏览器旧版本', affected: beforeVersion.shelf.length, caches: 0 })
  check('预览不改书源书架进度和留档清单', await state(), beforeVersion)
  check('预览不改完整书源规则记录', await api(sourceRecordPath), beforeVersionRecord)
  check('预览不创建数据库快照', await api('/api/backup/snapshots'), beforeVersionSnapshots)
  check('预览保持留档原始字节不变', await archiveBytes(), originalArchiveBytes)
  await page.waitForFunction(selector => !document.querySelector(`${selector} .primary-button`)?.disabled, {}, versionSelector)
  check('真实版本面板说明全局影响与缓存数量', await page.$eval(versionSelector, (node, impact) => {
    const text = node.textContent
    return text.includes('全局替换同一标准化书源 ID') && text.includes('全部关联书籍') &&
      text.includes(`影响全部 ${impact.affectedBooks} 本关联书籍，现有缓存 ${impact.cacheEntries} 条`) &&
      text.includes('保留当前启用状态、排序、缓存、登录与脚本状态') && text.includes('整库回滚')
  }, versionPreview))
  check('原始别名关联默认均未勾选', await page.$$eval(`${versionSelector} input[type="checkbox"]`,
    nodes => nodes.every(node => !node.checked)))
  await page.$eval(versionSelector, node => node.scrollIntoView())
  await page.screenshot({ path: path.join(output, 'source-version-preview.png'), fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  await page.$eval(versionSelector, node => node.scrollIntoView())
  const versionMobileBounds = await page.evaluate(selector => {
    const panel = document.querySelector(selector)
    return [panel, panel.closest('.backup-page'), panel.closest('.page-dialog-body'), panel.closest('.dialog-shell')]
      .map(node => {
        const box = node.getBoundingClientRect()
        return { left: box.left, right: box.right, client: node.clientWidth, scroll: node.scrollWidth }
      })
  }, versionSelector)
  check('390px 版本预览面板及备份弹层无横向溢出',
    versionMobileBounds.every(box => box.left >= 0 && box.right <= 390 && box.scroll <= box.client + 1))
  await page.screenshot({ path: path.join(output, 'source-version-mobile.png') })
  await page.$eval(`${versionSelector} .primary-button`, node => node.scrollIntoView({ block: 'center' }))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  check('390px 下版本确认按钮可滚动到可视区且未被遮挡', await page.$eval(`${versionSelector} .primary-button`, node => {
    const box = node.getBoundingClientRect()
    return !node.disabled && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
      node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  }))
  await page.screenshot({ path: path.join(output, 'source-version-mobile-review.png') })
  await page.setViewport({ width: 1280, height: 960 })
  const activationResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${versionPath}activate`)
  await click('确认启用此版本', versionSelector)
  const activatedResponse = await activationResponse
  check('真实版本面板确认启用旧版成功', activatedResponse.status(), 200)
  const activatedVersion = await activatedResponse.json()
  const activationBody = JSON.parse(activatedResponse.request().postData())
  check('确认绑定当前预览令牌且不默认关联别名',
    { archive: activationBody.archive, token: activationBody.previewToken, relink: activationBody.relink },
    { archive: variant.name, token: versionPreview.previewToken, relink: [] })
  const afterVersion = await state()
  const afterVersionRecord = await api(sourceRecordPath)
  check('启用后书源名称与可执行规则均替换为旧版',
    { name: afterVersion.sources[0].name, rules: JSON.parse(afterVersionRecord.json).ruleSearch },
    { name: '浏览器旧版本', rules: { bookList: '.archived-book', name: '.archived-title@text' } })
  check('版本启用保留原始标准化 ID 并递增规则版本',
    { id: afterVersionRecord.id, version: afterVersionRecord.version },
    { id: beforeVersionRecord.id, version: beforeVersionRecord.version + 1 })
  check('规则启用完整保留书架与阅读进度',
    { shelf: afterVersion.shelf, progress: afterVersion.progress }, { shelf: beforeVersion.shelf, progress: beforeVersion.progress })
  check('规则启用保留书源启用选择与排序',
    { enabled: afterVersion.sources[0].enabled, order: afterVersion.sources[0].sortOrder ?? null },
    { enabled: beforeVersion.sources[0].enabled, order: beforeVersion.sources[0].sortOrder ?? null })
  const afterVersionSnapshots = await api('/api/backup/snapshots')
  const safetySnapshot = afterVersionSnapshots.find(snapshot => snapshot.name === activatedVersion.snapshot)
  check('启用结果返回的整库安全快照通过服务端校验',
    Boolean(safetySnapshot?.verified && !beforeVersionSnapshots.some(snapshot => snapshot.name === safetySnapshot.name)))
  check('规则启用后留档仍保持原始字节不变', await archiveBytes(), originalArchiveBytes)
  await page.waitForFunction((selector, snapshot) => {
    const panel = document.querySelector(selector)
    return panel?.textContent.includes(snapshot) && !panel.querySelector('button')?.disabled
  }, {}, versionSelector, activatedVersion.snapshot)
  check('版本面板显示快照名与重启整库恢复指引', await page.$eval(versionSelector, (node, snapshot) =>
    node.textContent.includes(snapshot) && node.textContent.includes('排定恢复') && node.textContent.includes('然后重启'), activatedVersion.snapshot))
  await page.screenshot({ path: path.join(output, 'source-version-activated.png'), fullPage: true })
  const replayResponse = await page.evaluate(async ({ route, body }) => {
    const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }, { route: `${versionPath}activate`, body: activationBody })
  check('旧版本确认请求重放被拒绝',
    { status: replayResponse.status, code: replayResponse.body.code }, { status: 409, code: 'source_version_changed' })
  check('重放失败不再改动任何已检查数据', await state(), afterVersion)
  check('重放失败不改书源版本也不新增快照',
    { source: await api(sourceRecordPath), snapshots: await api('/api/backup/snapshots') },
    { source: afterVersionRecord, snapshots: afterVersionSnapshots })

  // UI lifecycle uses intercepted synthetic WebDAV responses. Actual transport/security is covered
  // by BackupWebDavTest + BackupWebDavHttpTest, without relaxing the production network policy.
  const davSelector = '[aria-label="手动 WebDAV 迁移"]'
  const remoteBytes = await download.buffer()
  const remoteHash = crypto.createHash('sha256').update(remoteBytes).digest('hex')
  const remoteName = `legadoq-migration-20261127-120000-${'b'.repeat(32)}-${remoteHash}.zip`
  const davRequests = []
  const interceptionErrors = []
  let listDenied = true
  let uploadVerified = false
  await page.setRequestInterception(true)
  page.on('request', async request => {
    try {
      const url = new URL(request.url())
      if (url.origin !== base || !url.pathname.startsWith('/api/backup/webdav/')) {
        await request.continue(); return
      }
      const config = JSON.parse(request.postData())
      assert.equal(request.method(), 'POST')
      assert.equal(config.password, 'dav-ui-fixture-password')
      assert.equal(config.username, 'dav-ui-fixture-user')
      davRequests.push(url.pathname)
      const json = async (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname.endsWith('/list')) {
        if (listDenied) await json({ code: 'webdav_denied', message: 'WebDAV 认证或权限不足' }, 502)
        else await json([{ name: remoteName }])
      } else if (url.pathname.endsWith('/upload')) {
        await json({ name: remoteName, bytes: remoteBytes.length, sha256: remoteHash, verified: uploadVerified })
      } else if (url.pathname.endsWith('/pull')) {
        assert.equal(config.name, remoteName)
        await request.respond({ status: 200, contentType: 'application/zip', body: remoteBytes })
      } else throw new Error('unexpected WebDAV UI path')
    } catch (error) {
      interceptionErrors.push(error.message)
      if (!request.isInterceptResolutionHandled()) await request.abort()
    }
  })
  await page.type(`${davSelector} input[type="url"]`, 'https://dav-ui.example/legadoq/')
  await page.type(`${davSelector} input:not([type])`, 'dav-ui-fixture-user')
  await page.type(`${davSelector} input[type="password"]`, 'dav-ui-fixture-password')
  const waitDav = text => page.waitForFunction((selector, value) =>
    document.querySelector(selector)?.textContent.includes(value) && !document.querySelector(`${selector} fieldset`).disabled,
  {}, davSelector, text)
  await click('刷新远端列表', davSelector)
  await waitDav('认证或权限不足')
  check('WebDAV 模拟认证失败不显示成功文件列表', await page.$$eval(`${davSelector} li`, nodes => nodes.length), 0)
  listDenied = false
  await click('刷新远端列表', davSelector)
  await waitDav('目录已刷新')
  check('WebDAV 模拟列表渲染完整迁移文件名', await page.$eval(`${davSelector} li`, node => node.textContent.includes('legadoq-migration-')))
  check('WebDAV 缺少可选大小时显示未知 不显示 NaN', await page.$eval(`${davSelector} li`, node =>
    node.textContent.includes('大小未知') && !node.textContent.includes('NaN')))
  await page.type(`${davSelector} input[type="url"]`, 'changed/')
  check('修改连接地址立即清掉旧列表', await page.$$eval(`${davSelector} li`, nodes => nodes.length), 0)
  await click('上传迁移包并校验', davSelector)
  await waitDav('尚未通过回读校验')
  check('未校验上传不能报告成功', await page.$eval(davSelector, node => !node.textContent.includes('上传完成并通过')))
  uploadVerified = true
  await click('上传迁移包并校验', davSelector)
  await waitDav('上传完成并通过远端回读校验')
  check('校验成功后要求重新刷新远端列表', await page.$$eval(`${davSelector} li`, nodes => nodes.length), 0)
  await click('刷新远端列表', davSelector)
  await waitDav('目录已刷新')
  const beforePull = await state()
  const confirmationsBefore = requests.filter(request => request.path === '/api/backup/import').length
  await preview(() => click('拉取并预览', davSelector))
  await waitDav('已拉取并提交预览')
  check('WebDAV 拉取通过真实后端只读预览 未恢复', await state(), beforePull)
  check('WebDAV 拉取没有发出确认导入请求', requests.filter(request => request.path === '/api/backup/import').length, confirmationsBefore)
  check('WebDAV 凭据未进入浏览器持久存储', await page.evaluate(() =>
    ![...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => /dav-ui-fixture/.test(value))))
  await page.setViewport({ width: 390, height: 844 })
  await page.$eval(davSelector, node => node.scrollIntoView())
  const mobileBounds = await page.evaluate(selector => {
    const panel = document.querySelector(selector)
    return [panel, panel.closest('.backup-page'), panel.closest('.page-dialog-body'), panel.closest('.dialog-shell')]
      .map(node => {
        const box = node.getBoundingClientRect()
        return { className: node.className, left: box.left, right: box.right, width: box.width,
          client: node.clientWidth, scroll: node.scrollWidth, minWidth: getComputedStyle(node).minWidth }
      })
  }, davSelector)
  console.log('窄屏几何', JSON.stringify(mobileBounds))
  if (mobileBounds.some(box => box.scroll > box.client + 1)) {
    console.log('窄屏越界元素', JSON.stringify(await page.$$eval('.backup-page *', nodes => nodes
      .map(node => ({ tag: node.tagName, className: node.className,
        left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
        client: node.clientWidth, scroll: node.scrollWidth }))
      .filter(box => box.client > 0 && (box.right > 383 || box.left < 16 || box.scroll > box.client + 1)).slice(0, 30))))
  }
  check('390px 备份弹层内容不横向溢出', mobileBounds.every(box => box.left >= 0 && box.right <= 390 && box.scroll <= box.client + 1))
  check('390px WebDAV 长文件名不溢出面板', await page.$eval(davSelector, node => node.scrollWidth <= node.clientWidth + 1))
  const davPanel = await page.$(davSelector)
  await davPanel.screenshot({ path: path.join(output, 'webdav-mobile.png') })
  await davPanel.dispose()
  await click('清空连接信息', davSelector)
  check('清空 WebDAV 连接信息同时清掉凭据及旧列表', await page.$eval(davSelector, node =>
    [...node.querySelectorAll('input')].every(input => input.value === '') && node.querySelectorAll('li').length === 0))
  check('WebDAV 模拟交互覆盖三条接口', [...new Set(davRequests)].sort(),
    ['/api/backup/webdav/list', '/api/backup/webdav/pull', '/api/backup/webdav/upload'])
  check('WebDAV 请求拦截无错误', interceptionErrors, [])
  await page.setViewport({ width: 1280, height: 960 })
  check('真实页面没有未捕获脚本错误', pageErrors, [])
  await page.screenshot({ path: path.join(output, 'completed.png'), fullPage: true })
} catch (error) {
  process.exitCode = 1
  console.error(`FAIL ${error.stack ?? error}`)
  if (page) console.error('备份动作状态', JSON.stringify(await page.$$eval('.backup-page button', nodes =>
    nodes.map(node => ({ text: node.textContent.trim(), disabled: node.disabled }))).catch(() => [])))
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  try {
    if (browser) await browser.close()
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      assert.ok(child.kill(), '无法停止本脚本创建的临时服务')
      let timer
      try {
        await Promise.race([serviceClosed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('临时服务关闭超时；保留临时目录供排障')), 15_000)
        })])
      } finally { clearTimeout(timer) }
    }
    fs.writeFileSync(path.join(output, 'service.log'), serviceLog)
    // 只删除本脚本 mkdtemp 返回的已核实绝对目录，禁止从环境变量拼出递归删除目标。
    assert.equal(path.dirname(path.resolve(tmpRoot)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(tmpRoot).startsWith('legado-backup-preview-ui-'))
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
      success: !process.exitCode, checks, requests, pageErrors, jar, base, health,
      generatedFixture: true, webDavUiResponsesMocked: true, temporaryDirectoryRemoved: !fs.existsSync(tmpRoot), date: new Date().toISOString(),
    }, null, 2))
    console.log(`结果：${checks.length} 项通过；${process.exitCode ? '失败' : '成功'}；记录 ${output}`)
  }
}
