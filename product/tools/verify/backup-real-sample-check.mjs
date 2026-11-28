/**
 * 用户提供的真实备份：隔离 HTTP 导入 → 第二空库原生恢复 → 第三空库含留档迁移。
 * node tools/verify/backup-real-sample-check.mjs <backup.zip>
 * 不请求远程书源，不输出书名/地址/配置值，不把样本或导出包留在仓库。
 * 成功仅代表当前承接字段通过；明确报告标识合并和未承接域，不能替代手机端恢复。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
assert.ok(process.argv[2], '用法：node tools/verify/backup-real-sample-check.mjs <backup.zip>')
const input = path.resolve(process.argv[2])
const bytes = fs.readFileSync(input)
assert.ok(bytes.length <= 64 * 1024 * 1024, '样本压缩文件超过 64 MiB')
const fingerprint = crypto.createHash('sha256').update(bytes).digest('hex')
const out = path.join(process.env.LEGADO_VERIFY_OUT || path.join(root, 'tools/verify/out'), 'backup-real-sample')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ success: false, phase: 'started', fingerprint }))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-real-backup-'))
const checks = []
const services = []
const report = { fingerprint, checks, limitations: [
  '只验当前原生承接字段；个性化文件只检查原样留档，不代表已应用。',
  '未启动真实书源规则、远程请求、手机恢复或 WebDAV；不代表完整 Legado 备份无损往返。',
  'all 仅六个原生域；recovery 另带全部已收下的个性化文件/源版本证据，仍不含图片、本地书或完整数据库。',
] }
let phase = 'inspect'
const libs = path.join(root, 'app/build/libs')
const jars = fs.readdirSync(libs).filter(name => name.endsWith('-all.jar'))
assert.equal(jars.length, 1, '先构建 fatJar，目录中应只有一个 *-all.jar')
const jar = path.join(libs, jars[0])
const archiveTool = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip'

function archiveEntry(file, name) {
  const args = process.platform === 'win32' ? ['-xOf', file, name] : ['-p', file, name]
  return execFileSync(archiveTool, args, { windowsHide: true, maxBuffer: 65 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
const entryJson = (file, name) => JSON.parse(archiveEntry(file, name).toString('utf8').replace(/^\uFEFF/, ''))
const normalizeId = value => String(value).split('#')[0].trim() || String(value)
const keyOfBook = book => JSON.stringify([normalizeId(book.origin), book.bookUrl])
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function check(name, actual, expected = true) {
  // 不让 assert 的默认深比较把整份私人数据打印到失败日志。
  try { assert.deepEqual(actual, expected) } catch { throw new Error(`${name}：不一致（内容不输出）`) }
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function request(base, route, options = {}) {
  phase = `${options.method || 'GET'} ${route.split('?')[0]}`
  const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(180_000) })
  assert.ok(response.ok, `${route.split('?')[0]}: HTTP ${response.status}（响应内容不输出）`)
  return response
}
const json = async (base, route, options) => (await request(base, route, options)).json()
async function start(label) {
  const dir = path.join(tmp, label)
  fs.mkdirSync(dir)
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const base = `http://127.0.0.1:${port}`
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
  const child = spawn(java, ['-Xmx768m', '-Dfile.encoding=UTF-8', `-Djava.io.tmpdir=${dir}`, '-jar', jar], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LEGADO_HOST: '127.0.0.1', LEGADO_PORT: String(port),
      LEGADO_DATA_DIR: path.join(dir, 'data'), LEGADO_DATABASE: path.join(dir, 'data/library.sqlite'),
      LEGADO_HOME: dir, LEGADO_NEXT_DIR: path.join(dir, 'next'), LEGADO_ACCESS_TOKEN: '' },
  })
  let startupError
  let logs = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString('utf8')).slice(-40_000) })
  child.on('error', error => { startupError = error })
  const closed = new Promise(resolve => child.once('close', resolve))
  services.push({ child, closed, exceptions: () => [...new Set(logs.match(/\b(?:[A-Za-z]+\.)+[A-Za-z]*(?:Exception|Error)\b/g) || [])],
    exceptionFrames: () => [...new Set(logs.split(/\r?\n/).filter(line => /^\s+at [\w.$]+\([^)]*\)\s*$/.test(line)).map(line => line.trim()))].slice(0, 24) })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    assert.equal(child.exitCode, null, '隔离服务意外退出')
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) { report.health = await response.json(); return base }
    } catch { /* 等待当前临时服务 */ }
    await delay(500)
  }
  throw new Error('隔离服务启动超时')
}
const policy = { metadata: 'keep_local', progress: 'newer' }
async function upload(base, file, preview, token, sections) {
  const form = new FormData()
  form.append('libraryPolicy', JSON.stringify(policy))
  if (token) form.append('previewToken', token)
  if (sections) form.append('sections', JSON.stringify(sections))
  form.append('file', new Blob([fs.readFileSync(file)]), 'sample.zip')
  console.log(`请求：${preview ? '预览' : '确认'}（${fs.statSync(file).size} bytes）`)
  return json(base, `/api/backup/import${preview ? '?preview=true' : ''}`, { method: 'POST', body: form })
}
async function exportAll(base, name, domain = 'all') {
  const response = await request(base, `/api/backup/export?domain=${domain}`)
  const file = path.join(tmp, name)
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
  return file
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const sortJson = values => values.map(value => JSON.stringify(canonical(value))).sort()
function shelfProjection(books, groups) {
  const names = new Map(groups.filter(g => g.groupId > 0).map(g => [g.groupId, g.groupName]))
  return books.map(book => ({ key: keyOfBook(book), name: book.name, author: book.author || null,
    toc: book.tocUrl || book.bookUrl, cover: book.coverUrl || book.customCoverUrl || null,
    chapter: book.durChapterIndex || 0, position: Math.max(0, book.durChapterPos || 0),
    time: book.durChapterTime || 0, group: names.get(book.group || 0) || null,
    completed: (book.kind || '').includes('完结') }))
}

try {
  const source = entryJson(input, 'bookSource.json')
  const shelf = entryJson(input, 'bookshelf.json')
  const groups = entryJson(input, 'bookGroup.json')
  const rss = entryJson(input, 'rssSources.json')
  const validRss = rss.filter(row => typeof row.sourceUrl === 'string' && row.sourceUrl.trim())
  const expectedRss = [...new Map(validRss.map(row => [row.sourceUrl.startsWith('//') ? `https:${row.sourceUrl}` : row.sourceUrl, row])).values()]
  const invalidRss = rss.length - validRss.length
  const rules = entryJson(input, 'replaceRule.json')
  const latestSources = new Map(source.map(row => {
    const raw = String(row.bookSourceUrl).trim()
    return [normalizeId(raw.startsWith('//') ? `https:${raw}` : raw), row]
  }))
  report.sample = { bytes: bytes.length, sources: source.length, normalizedSourceIds: latestSources.size,
    sourceIdCollisions: source.length - latestSources.size, books: shelf.length, rss: rss.length,
    rules: rules.length, groups: groups.length, customGroups: groups.filter(g => g.groupId > 0).length,
    validRss: expectedRss.length, invalidRss }
  if (invalidRss) report.limitations.push(`${invalidRss} 条 RSS 地址为空，明确报错并跳过；有效条目另行核对。`)
  console.log(`样本：${source.length} 书源 → ${latestSources.size} 本机标识，${shelf.length} 书架；仅输出数量`)
  if (source.length !== latestSources.size) report.limitations.push(`当前标识归一化合并 ${source.length - latestSources.size} 个书源版本；原始 URL 唯一不代表本机标识唯一。`)
  const base = await start('first')
  const empty = await exportAll(base, 'before.zip')
  const initial = archiveEntry(empty, 'bookshelf.json').toString()
  check('真实样本验收从空库开始', JSON.parse(initial).length, 0)
  const preview = await upload(base, input, true)
  const counts = Object.fromEntries(preview.sections.map(section => [section.id, section.items]))
  report.previewCounts = counts
  report.previewHasCollisionWarning = preview.warnings.some(w => /标识.*合并|合并.*标识/.test(w))
  check('确认前明确提示书源标识合并', source.length === latestSources.size || report.previewHasCollisionWarning)
  check('预览识别真实书源、书架、RSS 与净化规则',
    [counts.sources, counts.shelf, counts.rss, counts.rules], [source.length, shelf.length, rss.length, rules.length])
  const afterPreview = await exportAll(base, 'after-preview.zip')
  check('预览后原生六域仍为空', ['bookSource.json','bookshelf.json','bookGroup.json','rssSources.json','replaceRule.json','sourceSub.json']
    .map(name => entryJson(afterPreview, name).length), [0, 0, 0, 0, 0, 0])
  check('预览后没有个性化留档', await json(base, '/api/backup/kept'), [])
  const selected = preview.sections.filter(s => s.id !== 'cookies').map(s => s.id)
  const imported = await upload(base, input, false, preview.previewToken, selected)
  report.import = { sources: imported.sources, sourcesUpdated: imported.sourcesUpdated, books: imported.books,
    progress: imported.progress, rules: imported.rules, rssSources: imported.rssSources, bookGroups: imported.bookGroups,
    errorCount: imported.errors.length, skippedSections: imported.skippedSections,
    kept: imported.keptSections.map(k => ({ name: k.name, bytes: k.bytes, items: k.items })) }
  check('实际导入量符合当前标识规则', [imported.sources, imported.books, imported.rules, imported.rssSources],
    [latestSources.size, shelf.length, rules.length, expectedRss.length])
  check('无地址 RSS 明确报告错误，其余条目正常导入', imported.errors.length, invalidRss)
  check('单项错误仅来自已知无地址 RSS', imported.errors.every(error => /sourceUrl.*不能为空|缺少 sourceUrl/.test(error)))
  check('书架与进度预测等于确认结果', imported.libraryDiff, preview.libraryDiff)
  check('真实书架进度全部恢复', imported.progress, shelf.length)
  for (const kept of imported.keptSections) {
    if (/^source-variants-[a-f0-9]{64}\.json$/.test(kept.name)) continue
    const downloaded = await request(base, `/api/backup/kept/${encodeURIComponent(kept.name)}`)
    check(`留档字节一致：${kept.name}`, hash(Buffer.from(await downloaded.arrayBuffer())), hash(archiveEntry(input, kept.name)))
  }
  const variantFiles = imported.keptSections.filter(k => /^source-variants-[a-f0-9]{64}\.json$/.test(k.name))
  check('冲突书源生成一份可下载的恢复留档', variantFiles.length, 1)
  const variantResponse = await request(base, `/api/backup/kept/${encodeURIComponent(variantFiles[0].name)}`)
  const variantBytes = Buffer.from(await variantResponse.arrayBuffer())
  const variantBody = JSON.parse(variantBytes.toString())
  check('留档文件名由完整内容 SHA-256 定址', variantFiles[0].name, `source-variants-${hash(variantBytes)}.json`)
  check('冲突留档原始书源字段和版本顺序与真实包一致', variantBody.bookSource, source)
  check('冲突留档全部书架原始 origin 与字段一致', variantBody.bookshelf, shelf)
  check('冲突留档绑定原备份哈希', variantBody.backupSha256, hash(bytes))
  check('冲突留档记录准确的合并数量', variantBody.mergedVersions, source.length - latestSources.size)
  check('冲突留档索引涵盖所有同标识版本且标明胜出项', variantBody.conflicts.every(group =>
    group.sourceIndexes.length > 1 && group.winnerIndex === group.sourceIndexes.at(-1) &&
    group.sourceIndexes.every(index => normalizeId(String(source[index].bookSourceUrl).trim().replace(/^\/\//, 'https://')) === group.normalizedId)))
  report.sourceArchive = { sources: variantBody.bookSource.length, books: variantBody.bookshelf.length,
    conflictGroups: variantBody.conflicts.length, bytes: variantBytes.length, sha256: hash(variantBytes) }
  const exported = await exportAll(base, 'first-export.zip')
  const exportSources = entryJson(exported, 'bookSource.json')
  check('导出保留当前胜出版本的规则 JSON（标识按本机规则归一化）', sortJson(exportSources),
    sortJson([...latestSources.entries()].map(([id, row]) => ({ ...row, bookSourceUrl: id, bookSourceName: row.bookSourceName.trim() || id }))))
  check('导出保留有效 RSS 原始 JSON', sortJson(entryJson(exported, 'rssSources.json')), sortJson(expectedRss))
  check('导出书架身份、元数据、进度、分组与样本一致',
    sortJson(shelfProjection(entryJson(exported, 'bookshelf.json'), entryJson(exported, 'bookGroup.json'))),
    sortJson(shelfProjection(shelf, groups)))
  const againPreview = await upload(base, input, true)
  const again = await upload(base, input, false, againPreview.previewToken, selected)
  check('同一真实样本重复导入不新增书架或书源', [again.sources, again.books], [0, 0])
  check('重复导入不采用同时间进度', again.progress, 0)
  check('重复导入复用同一冲突留档', again.keptSections.filter(k => /^source-variants-/.test(k.name)).map(k => k.name), variantFiles.map(k => k.name))
  check('重复导入没有多生成留档', (await json(base, '/api/backup/kept')).length, imported.keptSections.length)
  const second = await start('second')
  const secondPreview = await upload(second, exported, true)
  await upload(second, exported, false, secondPreview.previewToken,
    secondPreview.sections.filter(s => s.id !== 'cookies').map(s => s.id))
  const secondExport = await exportAll(second, 'second-export.zip')
  for (const name of ['bookSource.json', 'bookshelf.json', 'bookGroup.json', 'rssSources.json', 'replaceRule.json', 'sourceSub.json']) {
    check(`第二空库原生域往返一致：${name}`, sortJson(entryJson(secondExport, name)), sortJson(entryJson(exported, name)))
  }
  // Ordinary imports intentionally keep the root sourceSub JSON as well as importing its native rows.
  check('普通六域恢复只留存本次原生订阅文件，不携带历史留档',
    (await json(second, '/api/backup/kept')).map(k => k.name), ['sourceSub.json'])
  check('普通恢复的订阅留档来自本次原生域',
    hash(Buffer.from(await (await request(second, '/api/backup/kept/sourceSub.json')).arrayBuffer())),
    hash(archiveEntry(exported, 'sourceSub.json')))
  const migration = await exportAll(base, 'migration.zip', 'recovery')
  const migrationManifest = entryJson(migration, 'legadoq-migration.json')
  check('显式迁移格式标记正确', migrationManifest.format, 'legadoq-migration-v1')
  const expectedKeeps = (await json(base, '/api/backup/kept')).map(k => k.name).sort()
  check('迁移清单包含全部个性化文件和源版本证据', migrationManifest.files.map(f => f.name).sort(), expectedKeeps.map(name => `kept/${name}`))
  const migrated = await start('migration-empty')
  const migrationPreview = await upload(migrated, migration, true)
  check('迁移预览保持留档只读', (await json(migrated, '/api/backup/kept')).length, 0)
  check('迁移预览保持空库无源', (await json(migrated, '/api/sources')).length, 0)
  await upload(migrated, migration, false, migrationPreview.previewToken,
    migrationPreview.sections.filter(s => s.id !== 'cookies').map(s => s.id))
  check('迁移恢复留档文件名完整一致', (await json(migrated, '/api/backup/kept')).map(k => k.name).sort(), expectedKeeps)
  for (const name of expectedKeeps) {
    const a = Buffer.from(await (await request(base, `/api/backup/kept/${encodeURIComponent(name)}`)).arrayBuffer())
    const b = Buffer.from(await (await request(migrated, `/api/backup/kept/${encodeURIComponent(name)}`)).arrayBuffer())
    check(`迁移留档逐字节校验：${name}`, hash(b), hash(a))
    const record = migrationManifest.files.find(f => f.name === `kept/${name}`)
    check(`迁移清单大小和哈希：${name}`, [record.bytes, record.sha256], [a.length, hash(a)])
  }
  const migratedExport = await exportAll(migrated, 'migrated-native.zip')
  for (const name of ['bookSource.json', 'bookshelf.json', 'bookGroup.json', 'rssSources.json', 'replaceRule.json', 'sourceSub.json']) {
    check(`迁移原生域保持一致且未激活历史源：${name}`, sortJson(entryJson(migratedExport, name)), sortJson(entryJson(exported, name)))
  }
  const repeatMigration = await upload(migrated, migration, true)
  await upload(migrated, migration, false, repeatMigration.previewToken,
    repeatMigration.sections.filter(s => s.id !== 'cookies').map(s => s.id))
  check('重复迁移复用源证据且不增加留档', (await json(migrated, '/api/backup/kept')).map(k => k.name).sort(), expectedKeeps)
  report.migration = { bytes: fs.statSync(migration).size, sha256: hash(fs.readFileSync(migration)), keptFiles: expectedKeeps.length }
  // 流式响应已发送完仍可能在路由收尾时报错，不能只凭 HTTP 200 判定成功。
  await delay(200)
  check('隔离服务无未处理异常', services.map(service => service.exceptions()), [[], [], []])
  report.success = true
} catch (error) {
  process.exitCode = 1
  report.success = false
  report.failure = error.message
  report.failurePhase = phase
  console.error(`FAIL ${error.message}`)
} finally {
  try {
    report.serviceExceptions = services.map(service => service.exceptions())
    report.serviceExceptionFrames = services.map(service => service.exceptionFrames())
    for (const { child, closed } of services.reverse()) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        assert.ok(child.kill(), '无法停止隔离服务')
        let timer
        try { await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('隔离服务关闭超时，保留临时目录')), 15_000)
        })]) } finally { clearTimeout(timer) }
      }
    }
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(tmp).startsWith('legado-real-backup-'))
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    report.temporaryDirectoryRemoved = !fs.existsSync(tmp)
    check('原始备份文件未改变', hash(fs.readFileSync(input)), fingerprint)
  } catch (error) {
    process.exitCode = 1
    report.success = false
    report.cleanupFailure = error.message
  }
  report.date = new Date().toISOString()
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`结果：${checks.length} 项通过；${report.success ? '成功（承接范围内）' : '失败'}；${out}`)
}
