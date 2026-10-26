/**
 * 备份包登录态端到端探针（打真服务，验证部署后的 `POST /api/backup/import`）。
 *
 * 单测只证明解压器能读；这条证明**线上这条路径**通：WebDAV 放包 → 导入 → 凭据落到对的书源、
 * 不落到蹭域名的书源 → 缺密码/错密码只跳过不牵连别的 section → 探针自己收尾（删源即清罐、删包）。
 * 一次性源用完必删，绝不动用户真实书源与凭据。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { multipartUpload } from './multipart.mjs'
import crypto from 'node:crypto'
import { makeZip } from './zip-make.mjs'

const BASE = (process.env.LEGADO_BASE_URL ?? 'http://127.0.0.1:1234').replace(/\/$/, '')
const PORT = Number(new URL(BASE).port || 80)
const HOST = new URL(BASE).hostname
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()

// 每个假源都要占**自己的注册域**：凭据按 eTLD+1 归桶之后，五个主机全写在
// `*.example.com` 下面会折成同一个桶，"蹭凭据的源拿不到"那条断言就从语义上失效了
// （上一轮 4 个红就是这么来的，不是产品问题）。`.test` 两标签即自身注册域。
const OWNER_HOST = `probe-owner-${STAMP}.test`
const TARGET_HOST = `probe-target-${STAMP}.test`
const FREELoader_HOST = `probe-freeloader-${STAMP}.test`
const LEGACY_HOST = `probe-legacy-${STAMP}.test`
const ORPHAN_HOST = `probe-orphan-${STAMP}.test`
// 书源主键就是 bookSourceUrl 整串（含协议与尾斜杠），不是裸域名：
// 拿裸域名去请求只会 404，而 /browser/cookies 对不存在的源回空罐，断言会假绿。
const OWNER_ID = `https://${OWNER_HOST}/`
const FREELoader_ID = `https://${FREELoader_HOST}/`
const PASSWORD = '探针备份密码-' + STAMP
const TOKEN_VALUE = 'pb_owner_token_' + STAMP
const ZIP_NAME = `probe-backup-cookie-${STAMP}.zip`

let pass = 0
let fail = 0
function ok(label, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`)
  }
}

function raw(method, urlPath, body, cookie, csrf, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    if (csrf) h['X-CSRF-Token'] = csrf
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json'
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
    if (payload) h['content-length'] = String(payload.length)
    const req = http.request({ host: HOST, port: PORT, path: urlPath, method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json: safeJson(buf) })
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/** 上游 BackupAES：密钥 = 密码 MD5 十六进制串的前 16 个字符的 ASCII 字节，AES/ECB/PKCS5，密文 base64。 */
function encryptLikeLegado(plainText, password) {
  const key = crypto.createHash('md5').update(password, 'utf8').digest('hex').slice(0, 16)
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'ascii'), null)
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('base64')
}

function probeSource(host, extra = {}) {
  return {
    bookSourceUrl: `https://${host}/`,
    bookSourceName: `探针备份 Cookie ${host}`,
    bookSourceGroup: '探针',
    bookSourceType: 0,
    enabled: false,
    enabledExplore: false,
    lastUpdateTime: 1,
    customOrder: 99998,
    ruleSearch: { bookList: '.book' },
    ...extra,
  }
}

async function jarOf(sourceId) {
  const res = await raw('GET', `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`, undefined, cookie, csrf)
  return res.json ?? { count: -1, domains: [], cookies: {} }
}

async function main() {
  console.log(`备份包登录态端到端探针  目标 ${BASE}  戳 ${STAMP}`)
  // 不设身份：只要服务在就能测（写操作只看 Origin，脚本不带 Origin）
  const alive = await raw('GET', '/healthz')
  if (alive.status !== 200) throw new Error('服务没在跑：' + alive.status)

  const zip = makeZip([
    {
      name: 'bookSource.json',
      data: JSON.stringify([
        probeSource(OWNER_HOST, { ruleSearch: { bookList: '.book', searchUrl: `https://${TARGET_HOST}/search?kw={{key}}` } }),
        probeSource(FREELoader_HOST, { bookSourceComment: `顺带提一句 ${TARGET_HOST} 而已` }),
      ]),
    },
    {
      name: 'cookies.json',
      data: encryptLikeLegado(
        JSON.stringify([
          { url: TARGET_HOST, cookie: `pb_token=${TOKEN_VALUE}; st=abc` },
          { url: `${LEGACY_HOST}|/`, cookie: 'legacy=1' },
          { url: ORPHAN_HOST, cookie: 'orphan=1' },
        ]),
        PASSWORD,
      ),
    },
  ])

  const upload = multipartUpload(STAMP, ZIP_NAME, zip)
  const noPassword = await raw('POST', '/api/backup/import', upload.body, cookie, csrf, upload.headers)
  ok('不填密码：导入照常完成，书源落了库', noPassword.status === 200 && noPassword.json?.sources >= 2,
    `status=${noPassword.status} sources=${noPassword.json?.sources}`)
  ok('不填密码：如实说明要密码而不是静默跳过', noPassword.json?.cookies === 0 && /密码/.test(noPassword.json?.cookiesNote ?? ''),
    noPassword.json?.cookiesNote ?? '(空)')

  const wrongPassword = await raw('POST', '/api/backup/import', multipartUpload(STAMP, ZIP_NAME, zip, PASSWORD + '-不对').body, cookie, csrf, upload.headers)
  ok('错密码：只报"密码不对"，不牵连书源与书架', wrongPassword.status === 200 && wrongPassword.json?.cookies === 0
    && /密码不对/.test(wrongPassword.json?.cookiesNote ?? ''), `${wrongPassword.status} ${wrongPassword.text.slice(0, 160)}`)

  const imported = await raw('POST', '/api/backup/import', multipartUpload(STAMP, ZIP_NAME, zip, PASSWORD).body, cookie, csrf, upload.headers)
  // 全局语义下，恢复是"包内每个域各写一桶"（上游 Restore 也是直接进全局 cookies 表），
  // 所以这里应当是 2 条：目标域 + 没人访问的 orphan 域。老格式（带 |）那条仍然跳过。
  ok('给密码：按域写入包内凭据（目标域 + orphan 域各一桶）', imported.status === 200 && imported.json?.cookies === 2,
    `${imported.status} cookies=${imported.json?.cookies} note=${imported.json?.cookiesNote}`)
  ok('老格式主键（带 |）跳过并说明条数', /跳过 1 条老格式/.test(imported.json?.cookiesNote ?? ''), imported.json?.cookiesNote ?? '(无)')

  const ownerExists = await raw('GET', `/api/sources/${encodeURIComponent(OWNER_ID)}`, undefined, cookie, csrf)
  ok('探针源确实在库（否则"罐是空的"这句没有意义）', ownerExists.status === 200, `status=${ownerExists.status}`)
  const ownerJar = await jarOf(OWNER_ID)
  const ownerEntry = JSON.stringify(ownerJar.cookies ?? {})
  ok('凭据落到"自己会访问该域"的书源', ownerJar.domains?.includes(TARGET_HOST) === true,
    `domains=${(ownerJar.domains ?? []).join(',')}`)
  ok('Cookie 值逐字保真', ownerEntry.includes(TOKEN_VALUE) && ownerEntry.includes('st=abc'), ownerEntry.slice(0, 90))
  ok('老格式主键与无人认领的域都不落进罐里', ownerJar.domains?.length === 1 && ownerJar.count === 1,
    `count=${ownerJar.count} domains=${(ownerJar.domains ?? []).join(',')}`)

  const freeJar = await jarOf(FREELoader_ID)
  ok('蹭域名的探针源本身也可达（不是查了个不存在的源）',
    (await raw('GET', `/api/sources/${encodeURIComponent(FREELoader_ID)}`, undefined, cookie, csrf)).status === 200)
  ok('只在注释里提了一句该域的书源拿不到凭据',
    !freeJar.domains?.includes(TARGET_HOST) && !JSON.stringify(freeJar.cookies ?? {}).includes(TOKEN_VALUE),
    `domains=${(freeJar.domains ?? []).join(',') || '(空)'}`)

  // 罐里每个主机存的是**合并后的 Cookie 串**，不是数组 —— 要比键集，别拿 .length 当条数。
  const pairsOf = value => String(value ?? '').split(';').map(item => item.trim()).filter(Boolean).sort()
  const beforeMerge = pairsOf((await jarOf(OWNER_ID)).cookies?.[TARGET_HOST])
  const again = await raw('POST', '/api/backup/import', multipartUpload(STAMP, ZIP_NAME, zip, PASSWORD).body, cookie, csrf, upload.headers)
  const afterMerge = pairsOf((await jarOf(OWNER_ID)).cookies?.[TARGET_HOST])
  ok('重复恢复按键合并，不堆串', again.json?.cookies === 2
    && afterMerge.length === beforeMerge.length && afterMerge.join('&') === beforeMerge.join('&'),
    `恢复前=${beforeMerge.join('|')} 恢复后=${afterMerge.join('|')}`)

  const ui = await raw('GET', `/api/sources/${encodeURIComponent(OWNER_ID)}/login-ui`, undefined, cookie, csrf)
  ok('登录弹窗把恢复来的域列为凭据域', ui.json?.cookieDomains?.includes(TARGET_HOST) === true,
    `${ui.status} ${(ui.json?.cookieDomains ?? []).join(',')}`)
}

let cookie = ''
let csrf = ''

main()
  .catch(error => {
    fail++
    console.error('  FAIL 探针异常：', error.message)
  })
  .finally(async () => {
    for (const id of [OWNER_ID, FREELoader_ID]) {
      const del = await raw('DELETE', `/api/sources/${encodeURIComponent(id)}`, undefined, cookie, csrf).catch(() => null)
      const goneSource = await raw('GET', `/api/sources/${encodeURIComponent(id)}`, undefined, cookie, csrf)
      ok(`删掉探针源 ${id}`, [200, 204].includes(del?.status ?? 0) && goneSource.status === 404,
        `DELETE=${del?.status} 复查=${goneSource.status}`)
    }
    const storageDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'data', 'webdav')
    const gone = { status: fs.existsSync(storageDir) && fs.readdirSync(storageDir).some(name => name.includes(STAMP)) ? 200 : 404 }
    ok('探针备份包没有落盘（直传读完即删）', gone.status === 404, `status=${gone.status}`)
    // 域级共享罐之后，删书源**不再**连带清桶（这是有意的：桶是跨源共用的），
    // 所以探针必须自己把写进去的桶撤掉，否则每次跑都在用户库里堆一层垃圾。
    const purged = []
    for (const host of [TARGET_HOST, ORPHAN_HOST]) {
      const del = await raw('DELETE', `/api/cookies?u=${encodeURIComponent(host)}`, undefined, cookie, csrf)
      purged.push(del.status)
    }
    const leftBuckets = JSON.parse((await raw('GET', '/api/cookies', undefined, cookie, csrf)).text)
    // 只认自己这个戳写下的桶：别的探针（source-login-check）有它自己的收尾，不替它喊冤
    const strays = (leftBuckets.cookies ?? []).filter(c => c.domain.includes(STAMP))
    ok('探针写下的凭据桶已自行回收', strays.length === 0, `DELETE=${purged.join(',')} 残留=${strays.map(c => c.domain).join(',') || '无'}`)
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    if (fail > 0) process.exitCode = 1
  })
