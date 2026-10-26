/**
 * 停读客户端门禁（任务 #36 / #69）。
 *
 * 要挡的事故很具体：**一个客户端把连接挂着不读，服务端不许被它拖住**。
 * 历史上真出过一次（见 `reference-false-green-mechanisms`）：一个反代把上游→客户端的流
 * 接上但不转发客户端取消，服务端往一个没人读的 socket 里写 927 KB，
 * `jstack` 里所有 `DefaultDispatcher-worker-*` 都 `RUNNABLE` 卡在 `SocketDispatcher.write0`，
 * 整个服务对其它请求不再响应 —— 表现是"服务死了"，而端口还在 LISTENING。
 *
 * 这条门禁把那个形状做成可重跑的实测：
 * ① 开 N 个"读几个字节就停"的客户端去拉一个大响应（把 SO_RCVBUF 压到最小，窗口几 KB 就关死，
 *    不靠运气）；
 * ② 期间量两个**与它们无关**的轻请求（`/healthz` 与 `/api/sources`）还能不能在合理时间内答完；
 * ③ 抓一次 `jstack`，数有多少工作线程正卡在 socket 写上。
 * 全程只读，不写任何用户数据；结束时自己把挂着的连接关掉。
 *
 * 跑法：node tools/verify/stalled-client-check.mjs
 *      LEGADO_BASE_URL / LEGADO_PORT 可指到别的实例；JSTACK 可显式给 jstack 路径。
 */
import net from 'node:net'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { BASE } from './env.mjs'

const url = new URL(BASE)
const HOST = url.hostname
const PORT = Number(url.port || 80)
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 找一个正在 LISTEN 这个端口的 pid：netstat 在中文 Windows 上是 GBK，但 ASCII 部分不受影响。 */
function listenerPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'buffer' }).toString('latin1')
  const line = out.split(/\r?\n/).find(row => row.includes(`:${PORT}`) && /LISTENING/i.test(row))
  return line ? Number(line.trim().split(/\s+/).pop()) : 0
}

function jstackOf(pid) {
  const binary = process.env.JSTACK || (process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/jstack` : 'jstack')
  try {
    return execFileSync(binary, [String(pid)], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }).toString('utf8')
  } catch (error) {
    return `__FAILED__ ${error.message}`
  }
}

/** 计时一次轻请求（走 http 模块，绕开浏览器与 keep-alive 复用）。 */
function timed(path, timeoutMs = 15000) {
  return new Promise(resolve => {
    const started = Date.now()
    const request = http.get({ host: HOST, port: PORT, path, timeout: timeoutMs }, response => {
      response.resume()
      response.on('end', () => resolve({ ms: Date.now() - started, status: response.statusCode }))
    })
    request.on('error', error => resolve({ ms: Date.now() - started, status: 0, error: String(error.message) }))
    request.on('timeout', () => { request.destroy(new Error('超时')); })
  })
}

/** 服务端下发的前端 bundle —— 一个稳定存在、体积够大、又不碰用户数据的响应。 */
async function bigAssetPath() {
  const html = await new Promise(resolve => {
    http.get({ host: HOST, port: PORT, path: '/' }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve(body))
    }).on('error', () => resolve(''))
  })
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? '/healthz'
}

/**
 * 开一个"读几 KB 就停手"的客户端。
 * 把 SO_RCVBUF 压到最小，窗口几 KB 就关死 —— 不这样大响应会被操作系统缓冲吃掉，测不出真行为。
 */
function stalledClient(path) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port: PORT })
    let read = 0
    let parked = false
    socket.setNoDelay(true)
    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUser-Agent: stalled-client-check\r\nAccept: */*\r\nConnection: keep-alive\r\n\r\n`)
    })
    socket.on('data', chunk => {
      read += chunk.length
      if (!parked && read > 2048) {
        parked = true
        socket.pause()
        try { socket.setBufferSize(256) } catch { /* 平台不支持就靠 pause 收窗 */ }
      }
    })
    socket.on('error', () => { /* 服务端先断开也是结论的一部分 */ })
    resolve({
      get read() { return read },
      get parked() { return parked },
      close: () => { socket.destroy() },
    })
  })
}

const pid = listenerPid()
check('能定位到在跑的这台服务', pid > 0, `${BASE} → PID ${pid || '未找到监听者'}`)
if (pid <= 0) {
  console.log('\nstalled-client-check: 前置不满足（服务没在跑），不做任何断言')
  process.exit(1)
}

const asset = await bigAssetPath()
const baselineHealth = await timed('/healthz')
const baselineSources = await timed('/api/sources')
check('基线：轻请求本身是快的', baselineHealth.ms < 1500 && baselineSources.ms < 4000,
  `/healthz ${baselineHealth.ms}ms · /api/sources ${baselineSources.ms}ms`)

const clients = []
// 默认 24 个挂着的连接（比 4C/8T 那档机器的线程池小一个量级）；STALLED_CLIENTS 可放大看趋势
const STALLED = Number(process.env.STALLED_CLIENTS ?? 24)
for (let index = 0; index < STALLED; index++) clients.push(await stalledClient(asset))
await sleep(1500)
const parkedCount = clients.filter(client => client.parked).length
check(`确实造出了 ${parkedCount} 个"读完开头就停手"的连接（共开 ${STALLED} 个）`, parkedCount >= Math.ceil(STALLED / 2),
  `每个只读了约 ${clients[0]?.read ?? 0}B，窗口关死`)

const underLoadHealth = await timed('/healthz')
const underLoadSources = await timed('/api/sources')
const dump = jstackOf(pid)
/**
 * 数"有多少**线程**卡在 socket 写上"，不是数命中行数：一条栈里 `write0` 与
 * `CIOWriterKt` 会各占几行，按行数算会把 12 个线程读成 96 个（第一版就栽在这儿）。
 */
const stuckThreads = dump.split(/\n\n/).filter(block =>
  /^"/.test(block) && /RUNNABLE/.test(block) && /SocketDispatcher\.write0|CIOWriterKt|IOWriterKt/.test(block))
const workerCount = (dump.match(/"DefaultDispatcher-worker-\d+"/g) ?? []).length

check('停读客户端不许把轻请求拖慢到不可用（/healthz 仍在 2 秒内）',
  underLoadHealth.status === 200 && underLoadHealth.ms <= 2000,
  `${underLoadHealth.ms}ms（基线 ${baselineHealth.ms}ms）`)
check('停读客户端不许让数据库读接口饿死（/api/sources 仍在 5 秒内答完）',
  underLoadSources.status === 200 && underLoadSources.ms <= 5000,
  `${underLoadSources.ms}ms（基线 ${baselineSources.ms}ms）`)
/**
 * "有多少线程卡在 socket 写上"是**归因**，不是契约：CIO 的设计就是一个卡住的写占一条线程，
 * 这条数永远不会归零。真正对用户负责的是上面那两条延迟判据（无关请求还得答得上来），
 * 所以这里只把它打印出来 —— 哪天延迟红了，这行数字告诉你原因是不是"写被占满"。
 */
console.log(`  NOTE 归因：${stuckThreads.length} / ${workerCount} 条工作线程此刻卡在 socket 写上（${parkedCount} 个对端停读）`)

/**
 * 60 个停读对端那一档**只报数，不判红绿**：CIO 是"一个卡住的 socket 写占一条线程"，
 * `callGroupSize` 只能抬高天花板、抬不到无限，根治要在引擎侧给写加超时（任务 #36 剩下的就是它）。
 * 但"不判红"不等于"不记"——这一档的延迟原样打印，退化了看得见。
 */
const extra = []
for (let index = 0; index < 36; index++) extra.push(await stalledClient(asset))
await sleep(1200)
const heavyHealth = await timed('/healthz')
const heavySources = await timed('/api/sources')
const heavyDump = jstackOf(pid)
const heavyStuck = heavyDump.split(/\n\n/).filter(block =>
  /^"/.test(block) && /RUNNABLE/.test(block) && /SocketDispatcher\.write0|CIOWriterKt|IOWriterKt/.test(block)).length
const heavyWorkers = (heavyDump.match(/"DefaultDispatcher-worker-\d+"/g) ?? []).length
console.log(`  NOTE 60 个停读对端（超出今天能保证的范围，只记数不判红）：/healthz ${heavyHealth.ms}ms · /api/sources ${heavySources.ms}ms · 卡在写上的线程 ${heavyStuck} / ${heavyWorkers}`)
console.log('  NOTE 今天保证的是上面那档（默认 24 个对端，STALLED_CLIENTS 可调）；这一档要根治见任务 #36')
for (const client of extra) client.close()

for (const client of clients) client.close()
await sleep(800)
const afterClose = await timed('/healthz')
check('客户端全部撤掉之后服务立刻恢复正常', afterClose.status === 200 && afterClose.ms <= 1500,
  `${afterClose.ms}ms（24 个对端压着时 ${underLoadHealth.ms}ms）`)

let pass = 0
let fail = 0
for (const item of results) {
  if (item.ok) { pass++; console.log(`  PASS ${item.name}  — ${item.detail}`) }
  else { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
}

console.log(`\nstalled-client-check: PASS ${pass} / FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
