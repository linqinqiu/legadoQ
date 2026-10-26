/**
 * 外部真浏览器登录端到端探针。
 *
 * 证明的是这条链真的通：服务端拉起真 Chromium → 打开一个会下 HttpOnly Cookie 的本机页面 →
 * 经 CDP 回读 → 按注册域折进全局凭据表 → 该书源后续请求能带上。
 * 用自建的本机页面而不是真站点：不碰用户真实登录态、不依赖外部网站，且能确定性地断言
 * "HttpOnly 的那份 Cookie 被读到了"（书签方案在这一步必然失败）。
 * 会真的弹出一个浏览器窗口，这是这个功能本来的样子；探针收尾会关掉它。
 */
import http from 'node:http'
import { BASE, requireService } from './env.mjs'

const PORT = Number(new URL(BASE).port || 80)
/**
 * 服务地址里的 host，不再写死 '127.0.0.1'。
 *
 * 原来只有 port 取自 BASE、host 是字面量 `'127.0.0.1'`，于是
 * `LEGADO_BASE_URL=http://192.168.1.9:1235` 这种"对着隔离实例/别的机器跑"的场景，
 * 端口对了、地址错了 —— 门禁会静默打到本机 127.0.0.1:1235 上，报出来的红是假的。
 */
const HOST = new URL(BASE).hostname
const STAMP = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const TOKEN = 'ext-' + STAMP

// 前置：服务必须在跑。原来这里直接发请求，服务没起就是
// `connect ECONNREFUSED` + 栈（而且是在打出几条 FAIL 之后才炸，看着像产品坏了）。
// 范式同 stalled-client-check.mjs:105-109。
await requireService('external-login-check')

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

let CK = ''
let CSRF = ''

function request(host, port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    const h = { ...headers }
    if (CK) h.cookie = CK
    if (CSRF) h['x-csrf-token'] = CSRF
    if (payload) {
      h['content-type'] = h['content-type'] ?? 'application/json'
      h['content-length'] = String(payload.length)
    }
    const req = http.request({ host, port, path, method: h.method ?? 'GET', headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

const api = (method, path, body) => request(HOST, PORT, path, body, { method })

// 本机探针页：Set-Cookie 带 HttpOnly —— 这正是 document.cookie 读不到、只有 CDP 拿得到的那类。
function startCookieSite() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [`pb_login=${TOKEN}; Path=/; HttpOnly`, `pb_public=${TOKEN}-x; Path=/`],
      })
      res.end(`<!doctype html><title>legado 外部登录探针</title><body>ok ${TOKEN}</body>`)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SOURCE_HOST = '127.0.0.1'

let site = null
let sourceId = ''

async function main() {
  console.log(`外部真浏览器登录探针  目标 ${BASE}  戳 ${STAMP}`)
  // 这台服务自 2026-09-29 起没有会话也没有 CSRF（能力波 v26 把整套认证删了），
  // 写操作只过同源闸门：不带 Origin 的非浏览器客户端按放行处理。
  // 原来这里读 `set-cookie` 与 `csrfToken`，认证删掉之后永远拿不到 → 整条门禁成了死门禁
  // （每次都在这一步 throw，后面"外部真浏览器 → CDP 回读 HttpOnly Cookie"那段真判据从没跑到过）。
  const sess = await api('GET', '/healthz')
  if (sess.status !== 200) throw new Error(`/healthz 不通：${sess.status} ${sess.text.slice(0, 80)}`)
  CK = (sess.headers['set-cookie']?.[0] ?? '').split(';')[0]

  site = await startCookieSite()
  sourceId = `http://${SOURCE_HOST}:${site.port}/`

  const imported = await api('POST', '/api/sources/import', {
    sources: [JSON.stringify({
      bookSourceUrl: sourceId,
      bookSourceName: `外部登录探针 ${STAMP}`,
      bookSourceGroup: '探针',
      bookSourceType: 0,
      enabled: false,
      loginUrl: sourceId,
      ruleSearch: { bookList: '.book' },
    })],
  })
  ok('一次性探针源已入库', imported.status === 200 && JSON.parse(imported.text).imported === 1, `${imported.status} ${imported.text.slice(0, 80)}`)

  const idle = await api('POST', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login/capture`, {})
  ok('浏览器没开时抓取只回空，不炸', idle.status === 200 && JSON.parse(idle.text).stored.length === 0 && JSON.parse(idle.text).opened === false,
    `${idle.status} ${idle.text.slice(0, 120)}`)

  const started = await api('POST', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, { url: sourceId })
  const startBody = JSON.parse(started.text)
  ok('服务端拉起了真浏览器', started.status === 200 && startBody.opened === true && startBody.pid > 0,
    `${started.status} ${started.text.slice(0, 160)}`)
  ok('回包列出了这本书源会带凭据去的域', Array.isArray(startBody.hosts) && startBody.hosts.some(h => h.includes(SOURCE_HOST)),
    (startBody.hosts ?? []).join(','))

  let seen = []
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    const status = JSON.parse((await api('GET', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`)).text)
    seen = status.seen ?? []
    if (seen.length > 0) break
  }
  ok('页面落下 Cookie 后被自动识别到（无需粘贴）', seen.includes(SOURCE_HOST), `seen=${seen.join(',') || '(空)'}`)

  const captured = JSON.parse((await api('POST', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login/capture`, {})).text)
  ok('抓取入库：stored 里有该域', captured.stored?.includes(SOURCE_HOST) === true, JSON.stringify(captured.stored))

  const jar = JSON.parse((await api('GET', `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`)).text)
  const storedValue = JSON.stringify(jar.cookies ?? {})
  ok('HttpOnly 那份凭据确实被读回来了（书签方案做不到）', storedValue.includes(TOKEN) && storedValue.includes('pb_login'),
    `键=${Object.keys(jar.cookies ?? {}).join(',')} 含 pb_login=${storedValue.includes('pb_login')}`)

  const second = JSON.parse((await api('POST', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login/capture`, {})).text)
  const jar2 = JSON.parse((await api('GET', `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`)).text)
  const pairs = String(Object.values(jar2.cookies ?? {})[0] ?? '').split(';').filter(Boolean).length
  ok('重复抓取按键合并，不堆串', second.stored?.includes(SOURCE_HOST) === true && pairs === 2, `键数=${pairs}`)
}

await main().catch(error => {
  fail++
  console.error('  FAIL 探针异常：', error.message)
})

// 收尾：关浏览器、删探针源、清桶、关本站点。每一项都复查，别留残留。
if (sourceId) {
  await api('DELETE', `/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, {}).catch(() => {})
}
const gone = sourceId ? await api('DELETE', `/api/sources/${encodeURIComponent(sourceId)}`, {}).catch(() => null) : null
const recheck = sourceId ? await api('GET', `/api/sources/${encodeURIComponent(sourceId)}`) : null
ok('探针源已删除（逐条复查 404）', gone?.status === 204 && recheck?.status === 404, `DELETE=${gone?.status} 复查=${recheck?.status}`)
const cleaned = await api('DELETE', `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies?u=${encodeURIComponent(sourceId)}`, {})
const bucketLeft = JSON.parse((await api('GET', `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`)).text)
ok('Cookie 桶已回收', (bucketLeft.count ?? 0) === 0, `status=${cleaned.status} count=${bucketLeft.count}`)
site?.server?.close()
await sleep(500)
const strays = JSON.parse((await api('GET', '/api/sources?q=' + encodeURIComponent('外部登录探针'))).text)
ok('库里没有探针残留', strays.length === 0, `${strays.length} 条`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
