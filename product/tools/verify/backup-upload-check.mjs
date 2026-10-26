/**
 * 浏览器直传备份包的门禁（打部署中的服务）。
 *
 * 钉三件事：
 * ① 选一个 zip 就能恢复（POST /api/backup/import，multipart），不经过任何网络服务；
 * ② **已存在的书源保留本机启用/停用选择** —— 这台库里「4,876 源只启用 2 个」是用户的策展，
 *    手机备份里几乎全是 enabled=true，覆盖一次就是批量启用事故（用户口径「到时候我自行决定」）；
 * ③ `bookGroup.json` 里手机那侧的 groupId 必须换成本机号，同名组不重复建。
 *
 * 全程只用带戳的探针数据，收尾逐条复查删除；绝不碰用户真源、真书架与真凭据。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeZip } from './zip-make.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const BASE = (process.env.LEGADO_BASE_URL ?? 'http://127.0.0.1:1234').replace(/\/$/, '')
const PORT = Number(new URL(BASE).port || 80)
const HOST = new URL(BASE).hostname
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()

const KEEP_HOST = `probe-up-keep-${STAMP}.test`
const FRESH_HOST = `probe-up-fresh-${STAMP}.test`
const KEEP_ID = `https://${KEEP_HOST}`
const FRESH_ID = `https://${FRESH_HOST}`
const RSS_HOST = `probe-up-rss-${STAMP}.test`
const GROUP_A = `探针上传组甲-${STAMP}`
const GROUP_B = `探针上传组乙-${STAMP}`
const BOOK_1 = `${KEEP_ID}/book/1`
const BOOK_2 = `${KEEP_ID}/book/2`

let cookie = ''
let csrf = ''
let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}

function raw(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { cookie, 'X-CSRF-Token': csrf, ...headers }
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
    if (payload && !h['content-type'] && !h['Content-Type']) h['content-type'] = 'application/json'
    if (payload) h['content-length'] = String(payload.length)
    const req = http.request({ host: HOST, port: PORT, path, method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(buf.toString('utf8')) } catch { /* 非 JSON 响应照常返回 text */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json })
      })
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 只带一个文件字段 + 可选 password 的 multipart/form-data。 */
function multipart(filename, bytes, password) {
  const boundary = `----legado${STAMP}`
  const head = (name, extra = '') =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`
  const parts = []
  if (password) parts.push(Buffer.from(head('password') + password + '\r\n', 'utf8'))
  parts.push(Buffer.from(head('file', `; filename="${filename}"`) + '\r\n', 'utf8'))
  parts.push(bytes)
  parts.push(Buffer.from('\r\n' + `--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` }
}

/** 返回对象而不是字符串：`JSON.stringify` 会把整个数组序列化，这里再 stringify 一次就变成"数组里套 JSON 字符串"，服务端只会当成非法源。 */
const sourceJson = (url, name, enabled, group) => ({
  bookSourceUrl: url, bookSourceName: name, bookSourceGroup: group, enabled, bookSourceType: 0, ruleSearch: { bookList: '.book' },
})

async function sources() {
  const res = await raw('GET', '/api/sources?q=probe-up-')
  return res.json ?? []
}
async function shelf() { return (await raw('GET', '/api/bookshelf')).json ?? [] }
async function groups() { return (await raw('GET', '/api/bookshelf/groups')).json ?? [] }
async function rss() { return (await raw('GET', '/api/rss/sources')).json ?? [] }

async function main() {
  console.log(`备份包直传门禁  目标 ${BASE}  戳 ${STAMP}`)
  // 不设身份：只要服务在就能测（写操作只看 Origin，脚本不带 Origin）
  const alive = await raw('GET', '/healthz')
  if (alive.status !== 200) throw new Error('服务没在跑：' + alive.status)

  // 本机先有一条"已被用户停用"的源：备份里同址的源是 enabled=true，导入后必须仍是停用
  const seed = await raw('POST', '/api/sources/import', { sources: [JSON.stringify(sourceJson(KEEP_ID, `探针上传原-${STAMP}`, false, '本机筛过'))] })
  ok('预置一条本机已停用的探针源', seed.status === 200 && seed.json?.imported === 1, `${seed.status} ${seed.text.slice(0, 60)}`)
  const beforeFlags = (await sources()).filter(s => s.id.includes('probe-up-'))
  ok('预置的源确实是停用状态（否则"保留启用位"这条断言是空的）',
    beforeFlags.length === 1 && beforeFlags[0].enabled === false, JSON.stringify(beforeFlags.map(s => [s.id, s.enabled])))

  const zip = makeZip([
    {
      name: 'bookSource.json',
      data: JSON.stringify([
        sourceJson(KEEP_ID, `探针上传改-${STAMP}`, true, '手机分组'),
        sourceJson(FRESH_ID, `探针上传新-${STAMP}`, true, '手机分组'),
      ]),
    },
    { name: 'bookGroup.json', data: JSON.stringify([{ groupId: 77, groupName: GROUP_A }, { groupId: 88, groupName: GROUP_B }, { groupId: 0, groupName: '默认分组' }]) },
    {
      name: 'bookshelf.json',
      data: JSON.stringify([
        { name: '探针上传书甲', author: '某作者', bookUrl: BOOK_1, origin: KEEP_ID, tocUrl: `${BOOK_1}/toc`, groupId: 77, durChapterIndex: 3, durChapterTime: Date.now() },
        { name: '探针上传书乙', bookUrl: BOOK_2, origin: KEEP_ID, tocUrl: `${BOOK_2}/toc` },
      ]),
    },
    { name: 'rssSources.json', data: JSON.stringify([{ sourceUrl: `https://${RSS_HOST}/`, sourceName: `探针上传RSS-${STAMP}`, ruleArticles: 'div.item', ruleTitle: 'a@text' }]) },
    // 反向对照用的『不承接』条目：readRecord 现在已被服务端原样收下（#66），
    // 所以改拿明确不收录的键位辅助配置来验 skippedSections 仍然会报东西。
    { name: 'keyboardAssists.json', data: JSON.stringify([{ name: '探针按键-' + STAMP, value: 'x' }]) },
  ])

  const notZip = multipart('probe.txt', Buffer.from('not a zip'))
  const rejected = await raw('POST', '/api/backup/import', notZip.body, { 'content-type': notZip.type })
  ok('非 zip 直接拒（不进入解析）', rejected.status === 400, `${rejected.status} ${rejected.text.slice(0, 70)}`)
  const empty = await raw('POST', '/api/backup/import', Buffer.alloc(0), { 'content-type': 'multipart/form-data; boundary=nope' })
  ok('没有文件时报 4xx 而不是 500', empty.status >= 400 && empty.status < 500, `${empty.status}`)

  const upload = multipart(`probe-backup-${STAMP}.zip`, zip)
  const imported = await raw('POST', '/api/backup/import', upload.body, { 'content-type': upload.type })
  ok('浏览器直传 zip 即完成导入', imported.status === 200 && imported.json?.sources === 1 && imported.json?.sourcesUpdated === 1,
    `${imported.status} ${JSON.stringify(imported.json ?? imported.text).slice(0, 420)}`)
  ok('包内 RSS 源与分组一并恢复', (imported.json?.rssSources ?? 0) === 1 && (imported.json?.bookGroups ?? 0) === 2,
    `rss=${imported.json?.rssSources} groups=${imported.json?.bookGroups}`)
  ok('不承接的条目照实上报（keyboardAssists 既没有界面也不收文件）', (imported.json?.skippedSections ?? []).includes('keyboardassists.json'), (imported.json?.skippedSections ?? []).join(','))
  ok('这个包没有把探针条目塞进用户的 data/backup_kept/', (imported.json?.keptSections ?? []).length === 0, (imported.json?.keptSections ?? []).map(k => k.name).join(','))

  const after = await sources()
  const keep = after.find(s => s.id === KEEP_ID) ?? {}
  const fresh = after.find(s => s.id === FRESH_ID) ?? {}
  ok('已存在的书源保留本机停用选择（内容仍更新）',
    keep.enabled === false && keep.name === `探针上传改-${STAMP}` && keep.group === '手机分组',
    `enabled=${keep.enabled} name=${keep.name} group=${keep.group}`)
  ok('备份带来的新源按包内启用位入库', fresh.enabled === true, `enabled=${fresh.enabled}`)

  const groupList = await groups()
  const groupA = groupList.find(g => g.name === GROUP_A)
  ok('手机号 77 换成本机号，且没有占掉本机已有的号段',
    !!groupA && groupA.id > 0 && groupList.filter(g => g.name === GROUP_A).length === 1,
    `A=${groupA?.id} 组数=${groupList.length}`)
  ok('groupId=0 的「默认分组」不会被建成组', (await groups()).every(g => g.name !== '默认分组'))

  const shelfList = await shelf()
  const book1 = shelfList.find(b => b.bookUrl === BOOK_1) ?? {}
  const book2 = shelfList.find(b => b.bookUrl === BOOK_2) ?? {}
  ok('带手机号的书落到映射后的组', book1.groupId === groupA?.id, `groupId=${book1.groupId} 期望=${groupA?.id}`)
  ok('反向对照：没带 groupId 的书落在未分组', book2.groupId === 0, `groupId=${book2.groupId}`)

  // WebDAV 文件服务已删除：直传到底落没落盘，直接看磁盘比问接口更硬。
  const gone = await raw('GET', '/api/webdav/info?path=')
  const storageDir = path.join(ROOT, 'data', 'webdav')
  const onDisk = fs.existsSync(storageDir)
    ? fs.readdirSync(storageDir).filter(name => name.includes(STAMP) || /^probe-.*\.zip$/.test(name))
    : []
  ok('WebDAV 路由确实不在了（404，不是被鉴权挡住）', gone.status === 404, `${gone.status}`)
  ok('直传不落盘到数据目录（临时副本用完即删）', onDisk.length === 0, onDisk.join(',') || '无')
}

main()
  .catch(error => { fail++; console.error('  FAIL 门禁异常：', error.message) })
  .finally(async () => {
    // 收尾必须无条件跑：上一版 `raw()` 没返回 headers，cookie 恒为空 → 直接 return，
    // 结果把探针的源/书/组/RSS 全留在了用户库里（这次就是被这条咬的）。清理优先于断言。
    // 不设身份：收尾无条件跑，不需要任何会话
        // 清理按前缀扫，不只清自己这一批：上一版收尾被跳过时留下的历史探针数据也要一并带走
    for (const stray of (await sources()).filter(s => s.id.includes('probe-up-'))) if (![KEEP_ID, FRESH_ID].includes(stray.id)) await raw('DELETE', `/api/sources/${encodeURIComponent(stray.id)}`)
    for (const id of [KEEP_ID, FRESH_ID]) {
      await raw('DELETE', `/api/sources/${encodeURIComponent(id)}`)
      const gone = await raw('GET', `/api/sources/${encodeURIComponent(id)}`)
      ok(`删掉探针源 ${id}`, gone.status === 404, `复查=${gone.status}`)
    }
    for (const url of [BOOK_1, BOOK_2]) {
      await raw('DELETE', `/api/bookshelf?sourceId=${encodeURIComponent(KEEP_ID)}&bookUrl=${encodeURIComponent(url)}`)
    }
    // 按前缀扫一遍再清：历史某次收尾被跳过时留下的探针书架/RSS 也要一并带走，不能只清自己这一批
    for (const stray of (await shelf()).filter(b => b.name.includes('探针上传书') || b.bookUrl.includes('probe-up-keep'))) {
      await raw('DELETE', `/api/bookshelf?sourceId=${encodeURIComponent(stray.sourceId)}&bookUrl=${encodeURIComponent(stray.bookUrl)}`)
    }
    for (const stray of (await rss()).filter(r => r.sourceUrl.includes('probe-up-rss-'))) {
      await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(stray.sourceUrl)}`)
    }
    const shelfLeft = (await shelf()).filter(b => b.bookUrl.includes('probe-up-keep'))
    ok('探针书架条目已回收', shelfLeft.length === 0, shelfLeft.map(b => b.bookUrl).join(',') || '无')
    for (const group of await groups()) {
      if (group.name.includes('探针上传组')) await raw('DELETE', `/api/bookshelf/groups/${group.id}`)
    }
    const groupLeft = (await groups()).filter(g => g.name.includes('探针上传组'))
    ok('探针分组已回收', groupLeft.length === 0, groupLeft.map(g => g.name).join(',') || '无')
    await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(`https://${RSS_HOST}/`)}`)
    const rssLeft = (await rss()).filter(r => r.sourceUrl.includes('probe-up-rss-'))
    ok('探针 RSS 源已回收', rssLeft.length === 0, rssLeft.map(r => r.sourceUrl).join(',') || '无')
    const strays = (await shelf()).filter(b => b.name.includes('探针上传书'))
    ok('没有留下别的垃圾', strays.length === 0, strays.map(b => b.name).join(',') || '无')
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    if (fail > 0) process.exitCode = 1
  })
