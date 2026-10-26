/**
 * 备份包「个性化条目收下」端到端探针（#66）。
 *
 * 用户 2026-09-30：「备份包里的 TTS、字典、阅读样式、书签、书架分组以外的个性化条目，这个如果可以的话试着做一下」。
 * 实现是 `BackupStore`：把服务端没有原生归宿的那些条目**原样收进数据目录**（七类配置按用户口径禁止建表，
 * 其余没有消费界面，建表等于制造"导入成功但其实没地方用"的假支持），界面能列、能下载、
 * 其中阅读样式与朗读引擎能一键套到本机设置。
 *
 * 这条探针**故意不打 1234 那台**：keep 存储按条目名落文件，探针一包就会盖掉用户真导过的
 * readConfig.json / bookMemo.json。所以这里用 `LEGADO_DATA_DIR` + `LEGADO_PORT` 起一个
 * 只活几十秒的独立实例（同一个 fatJar），跑完杀进程、删临时目录，用户的 data/ 一个字节都不动
 * —— 收尾还专门复查一遍真数据目录没被碰。
 *
 * 跑法：node tools/verify/backup-kept-check.mjs   （需要已有 app/build/libs/*-all.jar）
 */
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT } from './env.mjs'
import { multipartUpload } from './multipart.mjs'
import { makeZip } from './zip-make.mjs'

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()
let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}

const jars = fs.existsSync(path.join(ROOT, 'app/build/libs'))
  ? fs.readdirSync(path.join(ROOT, 'app/build/libs')).filter(name => name.endsWith('-all.jar')).sort()
  : []
if (!jars.length) { console.error('没有 app/build/libs/*-all.jar：先跑 gradle :app:fatJar'); process.exit(1) }
const jar = path.join(ROOT, 'app/build/libs', jars[jars.length - 1])

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-kept-'))
const dataDir = path.join(tmpRoot, 'data')
const userBackupKept = path.join(ROOT, 'data', 'backup_kept')
/** 用户真数据目录的"名字+大小+修改时间"指纹，收尾要比对 —— 探针不该碰它。 */
const fingerprint = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir).map(name => {
      const stat = fs.statSync(path.join(dir, name))
      return `${name}:${stat.size}:${Math.round(stat.mtimeMs)}`
    }).sort().join('|')
  : '(目录不存在)'
const userBefore = fingerprint(userBackupKept)

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
}

const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'

const child = spawn(java, [
  '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
  `-Djava.io.tmpdir=${tmpRoot}`,
  '-jar', jar,
], {
  env: {
    ...process.env,
    LEGADO_HOST: '127.0.0.1',
    LEGADO_PORT: String(PORT),
    LEGADO_DATA_DIR: dataDir,
    LEGADO_DATABASE: path.join(dataDir, 'legado.sqlite'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
const childLog = []
child.stdout.on('data', chunk => childLog.push(String(chunk)))
child.stderr.on('data', chunk => childLog.push(String(chunk)))

const get = async urlPath => {
  const response = await fetch(BASE + urlPath)
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 原文才是这里的断言对象，解析失败留给调用方判 */ }
  return { status: response.status, text, json }
}

/** 包里放什么由这里逐项列出来：既是对实现的说明，也是失败时唯一能读的现场。 */
const READ_STYLE = JSON.stringify([
  { name: '探针样式甲', fontSize: 20, fontFamily: '思源宋体', lineSpacing: 10, isDefault: true },
  { name: '探针样式乙', fontSize: 24, fontFamily: '黑体' },
])
const TTS = JSON.stringify([
  { name: '探针引擎', url: 'https://tts.example.test/say?text={{text}}', enable: true },
  { name: '另一个', url: 'https://tts2.example.test/{{text}}' },
])
const BOOK_MEMOS = JSON.stringify([
  { bookUrl: 'https://probe.test/b/1', content: '甲' },
  { bookUrl: 'https://probe.test/b/2', content: '乙' },
  { bookUrl: 'https://probe.test/b/3', content: '丙' },
])
const DICT = JSON.stringify([{ name: '探针字典', url: 'https://dict.example.test/?q={{key}}' }])
const SEARCH_HISTORY = JSON.stringify(['探针词甲', '探针词乙'])
const READ_CONFIG_V1 = READ_STYLE
const READ_CONFIG_V2 = JSON.stringify([{ name: '第二次导入的样式', fontSize: 18, isDefault: true }])

async function importZip(entries, password) {
  const zip = makeZip(entries)
  const upload = multipartUpload(STAMP, `probe-kept-${STAMP}.zip`, zip, password)
  const response = await fetch(`${BASE}/api/backup/import`, { method: 'POST', body: upload.body, headers: upload.headers })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 500 时把原文交出去 */ }
  return { status: response.status, json, text, bytes: zip.length }
}

let childStopped = false
async function stopChild() {
  if (childStopped) return
  childStopped = true
  child.kill()
  await new Promise(resolve => { child.on('close', resolve); setTimeout(resolve, 5000) })
}

try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  // 独立实例必须真起来，而且数据目录真是临时那一份 —— 否则后面的断言可能打在 1234 上
  let health = null
  for (let tick = 0; tick < 60 && !health; tick++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    health = await get('/healthz').catch(() => null)
    if (health && health.status !== 200) health = null
  }
  ok('独立实例起来了（同一个 jar，数据目录在临时盘）', health?.status === 200,
    health ? `${BASE} ${health.text.slice(0, 60)}` : `60 秒内没起来：${childLog.join('').slice(-200)}`)
  ok('探针确实用的是临时数据目录（没有写到仓库的 data/ 上）', fs.existsSync(path.join(dataDir, 'legado.sqlite')),
    path.join(dataDir, 'legado.sqlite'))

  const first = await importZip([
    // 至少要有一条真能承接的内容，否则导入器按"不是可识别的 Legado 备份"整体拒绝
    { name: 'bookSource.json', data: JSON.stringify([{ bookSourceUrl: `https://probe-kept-${STAMP}.test/`, bookSourceName: `探针收下源 ${STAMP}`, bookSourceGroup: '探针', bookSourceType: 0, enabled: false, enabledExplore: false, lastUpdateTime: 1, customOrder: 99997, ruleSearch: { bookList: '.book' } }]) },
    { name: 'readConfig.json', data: READ_CONFIG_V1 },
    { name: 'httpTTS.json', data: TTS },
    { name: 'bookMemo.json', data: BOOK_MEMOS },
    { name: 'dictRule.json', data: DICT },
    { name: 'searchHistory.json', data: SEARCH_HISTORY },
    { name: 'themeConfig.json', data: JSON.stringify({ currentTheme: 'dark' }) },
    { name: 'readRecord.json', data: JSON.stringify([{ bookUrl: 'x', readTime: 1 }]) },
    // 这几类是"配置"而不是"内容"，按用户口径不建表也不收文件，界面上不该冒出来
    { name: 'config.xml', data: '<config><theme>0</theme></config>' },
    { name: 'videoConfig.xml', data: '<videos><video name="测试" url="https://v.test/{{tab}}"/></videos>' },
    { name: 'autoTask.json', data: JSON.stringify([{ enable: false }]) },
  ])
  ok('带个性化条目的包导入成功', first.status === 200 && first.json?.sources >= 1, `${first.status} ${first.text.slice(0, 120)}`)

  const kept = first.json?.keptSections ?? []
  const names = kept.map(item => item.name)
  const byName = Object.fromEntries(kept.map(item => [String(item.name).toLowerCase(), item]))
  for (const expected of ['readconfig.json', 'httptts.json', 'bookmemo.json', 'dictrule.json', 'searchhistory.json', 'themeconfig.json', 'readrecord.json']) {
    ok(`导入结果里报了收到的 ${expected}`, expected in byName, names.join(', '))
  }
  for (const rejected of ['config.xml', 'videoconfig.xml', 'autotask.json']) {
    ok(`${rejected} 是配置不是内容，原样都不收`, !(rejected in byName) && !names.includes(rejected), names.join(', '))
  }
  ok('中文标签由服务端给，不是前端写死的表', Object.values(byName).every(item => typeof item.label === 'string' && item.label.length > 0 && !/[A-Za-z]/.test(item.label.slice(0, 2))),
    kept.map(item => `${item.name}=${item.label}`).join(' '))
  ok('只有阅读样式与朗读引擎标成"可套用"',
    byName['readconfig.json']?.appliable === true && byName['httptts.json']?.appliable === true
      && byName['bookmemo.json']?.appliable === false && byName['dictrule.json']?.appliable === false,
    kept.map(item => `${item.label}:${item.appliable}`).join(' '))
  ok('条数按顶层元素数出来了（界面上能说"3 条"而不是只报文件名）',
    byName['bookmemo.json']?.items === 3 && byName['searchhistory.json']?.items === 2 && byName['readconfig.json']?.items === 2,
    kept.map(item => `${item.label}:${item.items}`).join(' '))
  ok('收下的条目不再出现在 skippedSections 里',
    !(first.json?.skippedSections ?? []).some(item => names.some(name => item.toLowerCase() === String(name).toLowerCase())),
    `kept=${names.join(',')} · skipped=${(first.json?.skippedSections ?? []).join(',')}`)
  ok('字节数是真的（不为 0，且小于整包）',
    Object.values(byName).every(item => item.bytes > 0) && Object.values(byName).reduce((sum, item) => sum + item.bytes, 0) < first.bytes,
    kept.map(item => `${item.name}:${item.bytes}`).join(' '))

  const list = await get('/api/backup/kept')
  const listed = list.json ?? []
  ok('列表接口列得出这些条目，条数与导入结果一致',
    listed.length === kept.length && listed.every(item => names.some(name => String(name).toLowerCase() === String(item.name).toLowerCase())),
    `列表 ${listed.length} / 导入 ${kept.length}：${listed.map(item => item.name).join(',')}`)
  ok('列表按名字排序，界面不会每次刷新换个顺序',
    listed.map(item => item.name.toLowerCase()).join(',') === listed.map(item => item.name.toLowerCase()).sort().join(','),
    listed.map(item => item.name).join(','))

  const raw = await get(`/api/backup/kept/${encodeURIComponent(byName['readconfig.json']?.name ?? 'readConfig.json')}`)
  ok('读回来的内容与包里逐字相同（不是解析后再序列化糊出来的）',
    raw.status === 200 && raw.text === READ_CONFIG_V1,
    `${raw.status} · 长度 ${raw.text.length} vs ${READ_CONFIG_V1.length}`)
  const ttsRaw = await get(`/api/backup/kept/${encodeURIComponent(byName['httptts.json']?.name ?? 'httpTTS.json')}`)
  ok('朗读引擎原文也在，前端映射才有得可映射', ttsRaw.status === 200 && ttsRaw.text === TTS, `${ttsRaw.status} ${ttsRaw.text.slice(0, 60)}`)
  const memoRaw = await get('/api/backup/kept/bookMemo.json')
  ok('书籍笔记原文逐字保真（含包里的字段名大小写）',
    memoRaw.text === BOOK_MEMOS && memoRaw.json?.[0]?.content === '甲', memoRaw.text.slice(0, 80))

  const missing = await get('/api/backup/kept/config.xml')
  ok('没收的配置文件读不出来，且给的是可读的 404 而不是堆栈',
    missing.status === 404 && /没有这个条目/.test(missing.text), `${missing.status} ${missing.text.slice(0, 90)}`)
  const bogus = await get(`/api/backup/kept/${encodeURIComponent('..\\..\\legado.sqlite')}`)
  ok('条目名里的路径成分不会摸到目录外（sanitize 后只是个不存在的文件）',
    bogus.status === 404 && !bogus.text.includes('CREATE') && !bogus.text.includes('bookSourceUrl'),
    `${bogus.status} ${bogus.text.slice(0, 80)}`)

  // 再导一次不同内容的包：同一个条目名应当覆盖，而不是堆出第二个文件或追加成坏 JSON
  const second = await importZip([
    { name: 'bookSource.json', data: JSON.stringify([{ bookSourceUrl: `https://probe-kept-${STAMP}.test/`, bookSourceName: `探针收下源 ${STAMP}`, bookSourceGroup: '探针', bookSourceType: 0, enabled: false, enabledExplore: false, lastUpdateTime: 2, customOrder: 99997, ruleSearch: { bookList: '.book' } }]) },
    { name: 'readConfig.json', data: READ_CONFIG_V2 },
  ])
  const relisted = (await get('/api/backup/kept')).json ?? []
  ok('重复导入按条目名覆盖，不堆第二个文件',
    second.status === 200 && relisted.length === listed.length,
    `第一次 ${listed.length} 条 → 第二次 ${relisted.length} 条`)
  const overwritten = await get('/api/backup/kept/readConfig.json')
  ok('覆盖后读到的是新内容（旧的不会留着混淆）',
    overwritten.text === READ_CONFIG_V2, overwritten.text.slice(0, 80))
  const untouched = await get('/api/backup/kept/bookMemo.json')
  ok('第二个包里没有的条目不受影响', untouched.text === BOOK_MEMOS, `${untouched.status} ${untouched.text.slice(0, 60)}`)

  ok('界面上"能套用"的判定与前端读的路径一致（GET 的原文可直接 JSON.parse）',
    (() => { try { return JSON.parse(overwritten.text)[0].name === '第二次导入的样式' } catch { return false } })(), overwritten.text.slice(0, 60))

  const storeFiles = fs.existsSync(path.join(dataDir, 'backup_kept')) ? fs.readdirSync(path.join(dataDir, 'backup_kept')) : []
  ok('数据目录里就是这些条目，没有别的东西（临时文件也已收掉）',
    storeFiles.length === kept.length && storeFiles.every(name => !name.startsWith('.')),
    storeFiles.join(','))
  ok('keep 目录没有逃逸到 backup_kept 之外（数据目录根下不该多出裸 json 文件）',
    fs.readdirSync(dataDir).filter(name => name.endsWith('.json')).length === 0,
    fs.readdirSync(dataDir).join(','))
} catch (error) {
  fail++
  console.error('  FAIL 探针异常：', error.message)
} finally {
  await stopChild()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  ok('临时实例的临时目录已删干净', !fs.existsSync(tmpRoot), tmpRoot)
  ok('用户真数据目录 data/backup_kept 一个字节都没被碰',
    fingerprint(userBackupKept) === userBefore, `前后指纹 ${userBefore} → ${fingerprint(userBackupKept)}`)
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}
