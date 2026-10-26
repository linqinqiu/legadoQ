/**
 * 写操作同源闸门的门禁（打部署中的服务）。
 *
 * 这台服务不设身份：没有密码、没有登录页、没有会话，也没有 CSRF 令牌
 * （用户 2026-09-29：「怎么还有这个功能，删掉；咱们这个是开源的，不要那么多条条框框」）。
 * 剩下唯一一道防线必须能被验证 —— 浏览器发出的跨站写请求要被判掉，
 * 否则用户访问的任何一个网页都能驱动他的浏览器改这个库。
 *
 * 跑法：node tools/verify/authfixes.mjs
 */
import http from 'node:http'

const BASE = (process.env.LEGADO_BASE_URL ?? 'http://127.0.0.1:1234').replace(/\/$/, '')
const { port, hostname } = new URL(BASE)
const HOST = `${hostname}:${port}`
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()
const SRC = `https://probe-origin-${STAMP}.test/`

const rows = []
const check = (label, condition, detail = '') => {
  rows.push([condition, label])
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `   [${detail}]` : ''}`)
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const request = http.request({
      host: hostname,
      port: Number(port || 80),
      path,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.setTimeout(60000, () => request.destroy(new Error('timeout')))
    if (payload) request.write(payload)
    request.end()
  })
}

// 1) 读接口不需要任何凭据
const read = await req('GET', '/api/sources')
check('读接口不设凭据（本机界面打开即用）', read.status === 200, String(read.status))
const health = await req('GET', '/healthz')
check('探活端点在（前端用它判断服务是否就绪）', health.status === 200, String(health.status))

// 2) 不带 Origin 的写请求：命令行与本机脚本
const noOrigin = await req('POST', '/api/replace-rules', { name: `同源门禁探针-${STAMP}`, pattern: 'aaa', replacement: 'bbb', scope: 'probe-origin' })
check('不带 Origin 的写请求放行（curl / 本机脚本）', noOrigin.status === 200 || noOrigin.status === 201, `${noOrigin.status} ${noOrigin.text.slice(0, 50)}`)
if (noOrigin.status === 200 || noOrigin.status === 201) {
  const cleanup = await req('DELETE', `/api/replace-rules/${encodeURIComponent(`同源门禁探针-${STAMP}`)}`)
  check('门禁自己造的规则已清掉', [200, 204, 404].includes(cleanup.status), String(cleanup.status))
}

// 3) 本站 Origin 的写请求：浏览器里的本机界面
const sameOrigin = await req('POST', '/api/replace-rules', { name: `同源门禁本站探针-${STAMP}`, pattern: 'ccc', replacement: 'ddd', scope: 'probe-origin' }, { Origin: `http://${HOST}` })
check('Origin 与本站一致时放行', sameOrigin.status === 200 || sameOrigin.status === 201, `${sameOrigin.status} ${sameOrigin.text.slice(0, 50)}`)
if (sameOrigin.status === 200 || sameOrigin.status === 201) {
  const cleanup = await req('DELETE', `/api/replace-rules/${encodeURIComponent(`同源门禁本站探针-${STAMP}`)}`, undefined, { Origin: `http://${HOST}` })
  check('同源写请求造出来的规则已清掉', [200, 204, 404].includes(cleanup.status), String(cleanup.status))
}

// 4) 外站 Origin 驱动写：必须判掉
const crossSite = await req('POST', '/api/replace-rules', { name: '跨站注入', pattern: 'eee', replacement: 'fff', scope: 'probe-origin' }, { Origin: 'http://evil.example' })
check('外站页面驱动浏览器写本机被拒（403 且说明原因）', crossSite.status === 403 && /cross_origin/.test(crossSite.text), `${crossSite.status} ${crossSite.text.slice(0, 60)}`)

// 5) 端口冒名：Origin 写着本站主机但端口不对
const wrongPort = await req('POST', '/api/replace-rules', { name: '端口冒名', pattern: 'ggg', replacement: 'hhh', scope: 'probe-origin' }, { Origin: `http://${hostname}:9999` })
check('Origin 端口不一致也算跨站', wrongPort.status === 403, `${wrongPort.status} ${wrongPort.text.slice(0, 60)}`)

// 6) Host 被改写（走反代或 DNS 重绑时才会出现）：不能算同源
const hostSpoof = await req('POST', '/api/replace-rules', { name: 'Host 冒名', pattern: 'iii', replacement: 'jjj', scope: 'probe-origin' }, { Origin: `http://${HOST}`, Host: 'attacker.example' })
check('Origin 与 Host 不一致不算同源', hostSpoof.status === 403, `${hostSpoof.status} ${hostSpoof.text.slice(0, 60)}`)

// 7) 两个"能被驱动去发外呼/抓内网"的接口同样受闸门管着
const probe = await req('POST', '/api/sources/health-check', { ids: [SRC], timeoutMs: 1000 }, { Origin: 'http://evil.example' })
check('体检接口不能被外站页面触发（外呼风暴防护仍在）', probe.status === 403, `${probe.status} ${probe.text.slice(0, 60)}`)
const speak = await req('POST', '/api/tts/speak', { text: 'x', engine: 'custom', customUrl: 'http://169.254.169.254/' }, { Origin: 'http://evil.example' })
check('自定义朗读不能被外站页面借去打野地址', speak.status === 403, `${speak.status} ${speak.text.slice(0, 60)}`)

// 8) 界面粘贴 Cookie 那条同源路径：不带 Origin 或带本站 Origin 都要通
const cookieSync = await req('POST', `/api/sources/${encodeURIComponent(SRC)}/login-cookie`, { cookie: 'ui_probe=1', url: SRC })
check('本机界面粘贴 Cookie 的路径仍然通（不要求任何令牌）', cookieSync.status === 200 && /"ok":true/.test(cookieSync.text), `${cookieSync.status} ${cookieSync.text.slice(0, 60)}`)

const failed = rows.filter(([passed]) => !passed).length
console.log(`\n${rows.length - failed}/${rows.length} 通过`)
process.exit(failed ? 1 : 0)
