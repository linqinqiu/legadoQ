// 自定义 HTTP 朗读源的端到端判据（用户 2026-09-30：「朗读引擎具体功能你做好了吗」）。
//
// 为什么需要它：三种引擎里只有 Edge 那条被日常用着。自定义源在服务端支持
// `customHeader`（第三方 TTS 基本都要一个 key）与 `{{speakVoice}}/{{speakSpeed}}` 占位，
// 但界面上没有入口，`voice` 又固定回退成微软的音色 id —— 也就是"能配、发不出去"。
// 现在把入口补上，就用这条门禁按**真实上游收到的请求**核对，而不是核对字符串拼接：
// ① 占位符真的换进了 URL 与 POST 体；② 发音人用的是自定义那一栏；
// ③ 附加头能带上去，而 `Host` / `Content-Length` 与含换行的值会被丢掉（那是请求走私的原料）；
// ④ 会话流式路径（界面实际走的那条）与非流式 /speak 两条都过一遍 —— 它们在服务端是两份代码，
//    只测一份等于另一半没测。
//
// 上游不打外网：本门禁自己在 127.0.0.1 起一个 echo 服务，把它的地址作为 customUrl 交给服务端。
// 跑法：node tools/verify/tts-custom-engine-check.mjs   （默认打 1234）
import http from 'node:http'
import path from 'node:path'
import { BASE, OUT } from './env.mjs'

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
/**
 * 服务地址里的 host，不再写死 '127.0.0.1'。
 *
 * 原来 `request()` 只有 port 取自 BASE、host 是字面量，于是
 * `LEGADO_BASE_URL=http://192.168.1.9:1235` 这种"对着隔离实例/别的机器跑"的场景，
 * 端口对了、地址错了 —— 门禁静默打到本机，报出来的红是假的。
 */
const HOST = new URL(BASE).hostname
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function request(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const h = { ...headers }
    if (payload) {
      h['content-type'] = h['content-type'] || 'application/json'
      h['content-length'] = String(payload.length)
    }
    const req = http.request({ host: HOST, port, path: pathName, method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) }))
    })
    req.setTimeout(20000, () => req.destroy(new Error('客户端超时')))
    req.on('error', reject)
    req.end(payload)
  })
}

const api = (method, p, body) => request(+(new URL(BASE)).port || 80, method, p, body, { Origin: BASE })

/** 长连接音频流：边收边计数，不等问题结束（它本来就不会自己结束）。 */
function openStream(urlPath) {
  const target = /^https?:/i.test(urlPath) ? new URL(urlPath) : new URL(BASE + urlPath)
  return new Promise((resolve, reject) => {
    const state = { bytes: 0, status: 0, close: () => {} }
    const req = http.request({ host: target.hostname, port: target.port || 80, path: target.pathname, method: 'GET' }, res => {
      state.status = res.statusCode
      state.close = () => req.destroy()
      res.on('data', chunk => { state.bytes += chunk.length })
      resolve(state)
    })
    req.on('error', err => { if (state.close) resolve(Object.assign(state, { error: err.message })); else reject(err) })
    req.end()
  })
}

// —— 假 TTS 上游：把收到什么原样记下来，回一段"音频"字节 ——
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 7)])
let last = null
const echo = http.createServer((req, res) => {
  const bits = []
  req.on('data', c => bits.push(c))
  req.on('end', () => {
    last = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(bits).toString('utf8'),
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
    res.end(AUDIO)
  })
})
await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve))
const echoPort = echo.address().port
const echoBase = `http://127.0.0.1:${echoPort}`

try {
  const header = JSON.stringify({
    Authorization: 'Bearer probe-key',
    Host: 'evil.example',
    'Content-Length': '999',
    'X-Newline': 'a\r\nb',
    'X-Empty': '   ',
  })

  // —— 1) 非流式 /api/tts/speak ——
  const speakUrl = `${echoBase}/tts?text={{speakText}}&voice={{speakVoice}}&rate={{speakSpeed}}&pitch={{speakPitch}}`
  const speak = await api('POST', '/api/tts/speak', {
    text: '  这是探针句子。  ',
    engine: 'custom',
    voice: 'my-piper-zh',
    rate: 25,
    pitch: -3,
    customUrl: speakUrl,
    customHeader: header,
    customMethod: 'GET',
  })
  check('/api/tts/speak 走自定义源能拿到音频', speak.status === 200 && speak.bytes.length === AUDIO.length,
    `HTTP ${speak.status} 字节 ${speak.bytes.length}/${AUDIO.length}`)
  check('上游收到的正是它自己（没被 Host 冒充）', !!last && last.url?.startsWith('/tts?'), last?.url || '上游没被调用')

  const q = new URL(last?.url ? echoBase + last.url : echoBase)
  check('{{speakText}} 换成了去空白的正文', q.searchParams.get('text') === '这是探针句子。', `text=${q.searchParams.get('text')}`)
  check('{{speakVoice}} 用的是请求里的发音人，不是微软音色 id', q.searchParams.get('voice') === 'my-piper-zh', `voice=${q.searchParams.get('voice')}`)
  check('{{speakSpeed}} 是倍速而不是百分数', q.searchParams.get('rate') === '1.25', `rate=${q.searchParams.get('rate')}`)
  check('{{speakPitch}} 有值可填（此前界面里语调对自定义源完全不起作用）', q.searchParams.get('pitch') === '-3', `pitch=${q.searchParams.get('pitch')}`)
  check('附加头 Authorization 带上去了', last?.headers?.authorization === 'Bearer probe-key', String(last?.headers?.authorization))
  check('Host 不被用户输入覆盖', last?.headers?.host === `127.0.0.1:${echoPort}`, String(last?.headers?.host))
  check('Content-Length 由客户端自己管，用户填的被丢掉', last?.headers['content-length'] === undefined, String(last?.headers['content-length']))
  check('含换行的头不原样上传（请求走私的原料）', !('x-newline' in (last?.headers || {})), JSON.stringify(last?.headers?.['x-newline'] ?? null))
  check('空值头不上传', !('x-empty' in (last?.headers || {})), '缺席即通过')

  // 坏 JSON 的附加头不该把整次合成打成 500
  const badHeader = await api('POST', '/api/tts/speak', {
    text: '坏头也要能读。', engine: 'custom', voice: 'v', customUrl: `${echoBase}/bad?text={{speakText}}`, customHeader: 'not-json',
  })
  check('附加头不是合法 JSON 时只是不带，不牵连合成', badHeader.status === 200 && badHeader.bytes.length === AUDIO.length,
    `HTTP ${badHeader.status}`)

  // POST + 请求体模板
  last = null
  await api('POST', '/api/tts/speak', {
    text: 'POST 体的句子。', engine: 'custom', voice: 'pv', rate: 0, pitch: 0,
    customUrl: `${echoBase}/post?voice={{speakVoice}}`,
    customMethod: 'POST',
    customBody: JSON.stringify({ input: '{{speakText}}', speaker: '{{speakVoice}}' }),
  })
  check('POST 模板里的占位符也换过', last?.method === 'POST' && last.body === JSON.stringify({ input: 'POST 体的句子。', speaker: 'pv' }),
    `body=${last?.body}`)

  // —— 2) 会话流式路径（界面实际走这条，服务端是另一份代码） ——
  const session = await api('POST', '/api/tts/session', {})
  const info = JSON.parse(session.text)
  check('能建朗读会话', !!info.sessionId && !!info.audioUrl, session.text.slice(0, 120))

  const stream = await openStream(info.audioUrl)
  await sleep(400)
  last = null
  const appended = await api('POST', `/api/tts/session/${info.sessionId}/chunks`, {
    chunkId: 'probe-1', text: '会话流式的一句。', engine: 'custom', voice: 'stream-voice', rate: -10, pitch: 2,
    customUrl: `${echoBase}/stream?text={{speakText}}&voice={{speakVoice}}&pitch={{speakPitch}}`,
    customHeader: JSON.stringify({ Authorization: 'Bearer stream-key' }),
    customMethod: 'GET',
  })
  // 等服务端真去敲上游：音频流一开就回 144 字节静音垫底，所以**不能**拿"有没有字节"当等待条件
  // （第一版就是这么写的，循环立刻退出、把"上游还没被调用"误判成解析不一致）。
  let waited = 0
  while (waited < 8000 && !(last && stream.bytes > 144)) { await sleep(250); waited += 250 }
  const streamQ = new URL(last?.url ? echoBase + last.url : echoBase)
  check('会话分片被接受', appended.status === 200, `${appended.status} ${appended.text.slice(0, 80)}`)
  check('流式路径的占位符与非流式一致（两份代码不许漂移）',
    streamQ.searchParams.get('text') === '会话流式的一句。' && streamQ.searchParams.get('voice') === 'stream-voice' && streamQ.searchParams.get('pitch') === '2',
    `text=${streamQ.searchParams.get('text')} voice=${streamQ.searchParams.get('voice')} pitch=${streamQ.searchParams.get('pitch')}`)
  check('流式路径也带得上附加头', last?.headers?.authorization === 'Bearer stream-key', String(last?.headers?.authorization))
  check('音频流在首帧静音垫底之后回了合成音频', stream.status === 200 && stream.bytes > 144,
    `HTTP ${stream.status} 收到 ${stream.bytes} 字节${stream.error ? ' ' + stream.error : ''}`)

  const stopped = await api('POST', `/api/tts/session/${info.sessionId}/control`, { action: 'stop' })
  check('收尾停掉自建会话', stopped.status === 200, `${stopped.status}`)
  stream.close?.()
} catch (error) {
  check('门禁自身没崩', false, error.message)
} finally {
  echo.close()
  const fs = await import('node:fs')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `tts-custom-engine-${STAMP}.json`), JSON.stringify({ stamp: STAMP, results }, null, 2))
  const failed = results.filter(r => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
  process.exit(process.exitCode || 0)
}
