// 前端预览：把 vite 产物建到 out/web-preview 并用本机静态服务器 + /api 反代接上跑着的 1234 服务。
// 为什么不直接刷 jar：界面截图要反复改反复看，一次 fatJar 要几十秒，而且会覆盖仓库里被跟踪的 web/dist。
// 用法：node tools/verify/preview.mjs [--port 4399] [--no-build]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, OUT } from './env.mjs'

const DIST = path.join(OUT, 'web-preview')
const API = process.env.LEGADO_API || 'http://127.0.0.1:1234'

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const port = Number(argument('port', process.env.LEGADO_PREVIEW_PORT || 4399))

if (!process.argv.includes('--no-build')) {
  fs.rmSync(DIST, { recursive: true, force: true })
  const build = spawnSync('npm', ['--prefix', 'web', 'run', 'build', '--', '--outDir', DIST, '--emptyOutDir'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (build.status !== 0) {
    console.error(`vite 构建失败（退出码 ${build.status}）`)
    process.exit(build.status || 1)
  }
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`预览产物不存在：${DIST}（去掉 --no-build 让它先构建）`)
  process.exit(1)
}

if (process.argv.includes('--build-only')) {
  console.log(`built ${DIST}`)
  process.exit(0)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const target = path.resolve(DIST, '.' + (decoded.startsWith('/') ? decoded : `/${decoded}`))
  return target === DIST || target.startsWith(DIST + path.sep) ? target : null
}

/** /api 与 /auth 走反代：界面上的 fetch 全是相对路径，所以只要这两个前缀转对就能跑真数据。 */
function proxy(req, res) {
  const upstream = new URL(req.url, API)
  const headers = { ...req.headers }
  delete headers.connection
  // Host 要原样转：服务端有些判据是「Origin 与 Host 同源」，改成上游的 1234 会让预览里的
  // 同源请求被当成跨站，界面里那些写操作在预览下全变 403，验出来的东西就不是真的了。
  if (!headers.host) headers.host = upstream.host
  const client = http.request(
    { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search, method: req.method, headers },
    remote => {
      const forwarded = { ...remote.headers }
      delete forwarded['set-cookie']
      // Service Worker 一旦被注册，它会接管后续请求并回落到 1234 的旧产物；预览必须让它根本装不上。
      delete forwarded['service-worker-allowed']
      res.writeHead(remote.statusCode || 502, { ...forwarded, 'cache-control': 'no-store' })
      remote.pipe(res)
      // 浏览器换页会掐掉这一侧。必须同时掐掉上游：否则服务端往一个没人读的套接字里写大包，
      // 写线程会一直阻塞在 SocketDispatcher.write0，攒几次就把 1234 整个拖死。
      res.on('close', () => { if (!res.writableEnded) client.destroy() })
    },
  )
  client.setTimeout(30000, () => client.destroy(new Error('反代上游超时')))
  client.on('error', error => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `预览反代失败：${error.message}（后端是否在 ${API} 运行）` }))
  })
  req.on('close', () => { if (!req.readableEnded) client.destroy() })
  req.pipe(client)
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url === '/healthz') return proxy(req, res)
  const file = safeResolve(req.url)
  if (!file) {
    res.writeHead(403).end('forbidden')
    return
  }
  const candidate = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file
  if (!fs.existsSync(candidate)) {
    // SPA 路由：/reader、/sources 直接刷新时要回落到 index.html
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    fs.createReadStream(path.join(DIST, 'index.html')).pipe(res)
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(candidate)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(candidate).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`preview http://127.0.0.1:${port} -> api ${API}`)
  if (process.argv.includes('--daemon')) {
    const log = fs.openSync(path.join(OUT, 'preview.log'), 'a')
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--port', String(port), '--no-build'], { detached: true, stdio: ['ignore', log, log], cwd: ROOT })
    process.exit(0)
  }
})
