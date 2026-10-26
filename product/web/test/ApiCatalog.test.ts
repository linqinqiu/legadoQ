import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 端点目录（`app/src/main/resources/agent-api.json`，对外经 `GET /api/catalog`）不许漂。
 *
 * 这份契约是给外部程序（脚本 / AI）用的：它照着调，不会先读 Routes.kt。
 * 所以"手抄一份清单"在这里是坏形状 —— 加一条接口而忘了同步，清单会一直绿着骗人
 * （这条仓库栽过两回：README 承诺的端点悬空、门禁只读一层目录于是静默变瞎）。
 * 判据因此是**双向**的：目录里不许有代码中没有的端点，代码里的书源端点也不许从目录里漏掉。
 */
const ROOT = path.resolve(import.meta.dirname, '../..')
const HTTP_DIR = path.join(ROOT, 'app', 'src', 'main', 'kotlin', 'io', 'legado', 'http')
const CATALOG = path.join(ROOT, 'app', 'src', 'main', 'resources', 'agent-api.json')
const DOC = path.join(ROOT, 'AGENTS.md')

/**
 * 0.8.2 结构重排：`Routes.kt` 拆成了装配点 + 13 个 `<组>Routes.kt`。
 * 判据跟着扫本目录的全部路由文件——各文件都视作挂在 `route("/api")` 之下：
 * 装配点里 `route("/api") {` 的那一行在所有文件中**不许出现**（它只在 `Routes.kt`），
 * 于是每个文件的解析栈天然从 `/api` 起算，路径拼装与拆前逐字等价。
 * `ApiRoutesHttpTest` 起的是真服务器，它才是不漂的最终锚——文件怎么拆都骗得过解析器、骗不过 404。
 */
function routeFiles(): string[] {
  return fs.readdirSync(HTTP_DIR)
    .filter(f => (f === 'Routes.kt' || f.endsWith('Routes.kt')) && f.endsWith('.kt'))
    .sort()
    .map(f => path.join(HTTP_DIR, f))
}

/**
 * 从 `route("…")` 的嵌套里把端点表还原出来（与运行时那份是同一棵树，只是不用反射）。
 *
 * 两件事别做错：
 * ① 嵌套按**缩进**还原，不按大括号数 —— 处理器里到处是 `"{id}"`、字符串模板与 lambda，
 *    数括号一定会把栈弹错（第一版就是这么把 `/api/explore` 那几条弄丢的）。
 * ② `write` 不是按 HTTP 方法猜的，而是看处理器**自己那几行**有没有写门：
 *    `requireSameOriginWrite()`（只认同源）或 `sameOriginCall(`（粘贴 Cookie 那条：同源或该书源自己的域）。
 *    `POST /api/search`、`POST /api/explore`、`POST /api/sources/{id}/validate` 都是 POST 却不写库；
 *    而"往下扫几行"会把隔壁处理器的门算到这条头上（也栽过），所以撞到下一条注册语句就停。
 * ③ 注册语句不只 `get("…")` 这一种：`webSocket("…")` 是一条（方法记 WS），
 *    `for (verb in listOf(HttpMethod.Get, …)) { method(verb) { … } }` 一次注册五条同路径不同方法。
 *    漏掉后者的话，内置浏览器的子资源代理在目录里就完全不存在 —— 判据看不见它，也就不会报"漏了"。
 */
function parseRoutes(text: string): { method: string; path: string; write: boolean }[] {
  const lines = text.split(/\r?\n/)
  const stack: { seg: string; indent: number }[] = []
  const found: { method: string; path: string; write: boolean }[] = []
  let dynamicVerbs: string[] = []
  lines.forEach((line, index) => {
    // `for (verb in listOf(HttpMethod.Get, …)) { method(verb) { … } }`：五种方法注册在同一条路径上
    // （内置浏览器的子资源代理正是这一处）。不认它就等于目录里凭空少五条，而代码明明在跑。
    const listed = /for\s*\(\s*verb\s+in\s+listOf\(([^)]*)\)\s*\)/.exec(line)
    if (listed) {
      dynamicVerbs = [...listed[1].matchAll(/HttpMethod\.(\w+)/g)].map(m => m[1].toUpperCase())
      return
    }
    const dyn = /^(\s*)method\(verb\)\s*\{/.exec(line)
    if (dyn && dynamicVerbs.length) {
      const path = pathAt(stack, dyn[1].length, '')
      const write = gateOf(lines, index)
      dynamicVerbs.forEach(v => found.push({ method: v, path, write }))
      return
    }
    const route = /^(\s*)route\("([^"]+)"\)\s*\{/.exec(line)
    if (route) {
      const indent = route[1].length
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ seg: route[2], indent })
      return
    }
    const ws = /^(\s*)webSocket\("([^"]*)"\)\s*\{/.exec(line)
    if (ws) { found.push({ method: 'WS', path: pathAt(stack, ws[1].length, ws[2]), write: gateOf(lines, index) }); return }
    const verb = /^(\s*)(get|post|put|delete|patch)\b(?:\("([^"]*)"\))?\s*\{/.exec(line)
    if (!verb) return
    const path = pathAt(stack, verb[1].length, verb[3] ?? '')
    found.push({ method: verb[2].toUpperCase(), path, write: gateOf(lines, index) })
  })
  const unique = new Map<string, { method: string; path: string; write: boolean }>()
  found.forEach(entry => unique.set(`${entry.method} ${entry.path}`, entry))
  return [...unique.values()]
}

/** 处理器自己那几行里有没有写门；撞到下一条注册语句就停，免得把隔壁处理器的门算到这条头上。 */
function gateOf(lines: string[], index: number): boolean {
  const own: string[] = []
  for (let i = index + 1; i < lines.length && own.length < 40; i++) {
    if (/^\s*(route|get|post|put|delete|patch|method|webSocket)\b[^{]*\{/.test(lines[i])) break
    own.push(lines[i])
  }
  return /requireSameOriginWrite|sameOriginCall\(/.test(own.join('\n'))
}

/** 按缩进还原嵌套，再拼出这条的路径（弹栈到比自己浅的那层）。 */
function pathAt(stack: { seg: string; indent: number }[], indent: number, seg: string): string {
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
  return '/' + [...stack.map(s => s.seg), seg].map(s => s.replace(/^\/+/, '')).filter(Boolean).join('/')
}

/** 目录与代码对得上吗：返回"哪几条对不上"，空数组就是没问题。抽成纯函数是为了能喂假数据反扫。 */
function auditCatalog(routes: { method: string; path: string; write: boolean }[], catalog: { endpoints?: { method: string; path: string; write: boolean; purpose?: string; response?: string; group?: string }[] }) {
  const problems: string[] = []
  const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r]))
  const listed = new Set((catalog.endpoints ?? []).map(e => `${e.method} ${e.path}`))
  for (const entry of catalog.endpoints ?? []) {
    const key = `${entry.method} ${entry.path}`
    const real = byKey.get(key)
    if (!real) { problems.push(`目录里有代码中不存在的端点：${key}`); continue }
    if (entry.write !== real.write) problems.push(`${key} 的 write 与代码不符：代码里${real.write ? '有' : '没有'}同源写门，目录写的是 ${entry.write}`)
    if (!entry.purpose || entry.purpose.trim().length < 8) problems.push(`${key} 缺一句说得清的用途`)
    // 接入方拿到 200 之后要看懂回包。少了这一栏，它只能去猜顶层键（`/api/sources/{id}` 那条就猜到过对象，实际是信封）。
    if (!entry.response || entry.response.trim().length < 8) problems.push(`${key} 没写回包长什么样`)
    // 130 条平铺着没人翻得动，分组是这份目录能被按面找用的前提。
    if (!entry.group || entry.group.trim().length < 2) problems.push(`${key} 没归到任何一个面（缺 group）`)
  }
  // **全量**要求：代码里注册的每一条都必须在目录里。以前只盯 `/api/sources…` 那几面前缀，
  // 后果是加在别的面上的端点（阅读、书架、朗读……）永远不会被这条判据看见，目录又变成半份地图。
  for (const route of routes) {
    const key = `${route.method} ${route.path}`
    if (!listed.has(key)) problems.push(`代码里有、目录里漏了：${key}`)
  }
  return problems
}

/** 逐文件解析后合并。组文件（装配点之外的那些）没有 `route("/api") {` 这一行，
 *  解析栈从空起会丢掉 `/api` 前缀，所以给每个文件垫一条同缩进的合成锚行 ——
 *  装配点自己那条真锚在 `while (top.indent >= indent) pop` 之下会顶掉合成锚，不会重复。
 *  去重口径与单文件时代逐字一致：同一 `方法 + 路径` 以**后**出现的为准。 */
function parseAllRoutes(): { method: string; path: string; write: boolean }[] {
  const found: { method: string; path: string; write: boolean }[] = []
  for (const file of routeFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    const seeded = text.includes('route("/api") {') ? text : `    route("/api") {\n${text}\n    }\n`
    found.push(...parseRoutes(seeded))
  }
  const unique = new Map<string, { method: string; path: string; write: boolean }>()
  found.forEach(entry => unique.set(`${entry.method} ${entry.path}`, entry))
  return [...unique.values()]
}

test('目录里每一条都真存在，代码里的端点一条不漏', () => {
  const routes = parseAllRoutes()
  assert.ok(routes.length >= 120, `只从 http/ 路由文件解析到 ${routes.length} 条端点，解析方式没对上，这条判据在演空戏`)
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
  assert.ok(Array.isArray(catalog.endpoints) && catalog.endpoints.length === routes.length,
    `目录有 ${catalog.endpoints?.length ?? 0} 条，代码里注册了 ${routes.length} 条 —— 这两个数必须相等，全量覆盖是这份契约的全部意义`)
  assert.deepEqual(auditCatalog(routes, catalog), [], '端点目录与代码对不上')
  // 绝对计数钉死：141 条 / 19 组 / 系统组 7 条是当前 legadoQ 的权威契约（见 docs/RESEARCH-NOTES §7）。
  // 双向相等只防「漂移」，不防「两边一起错」——重排架构时若这两个数真要变，
  // 必须同步改这里并说明，而不是让漂移悄悄发生。
  // 2026-10：新增「搜索本书」GET /api/book-search（进度与笔记组，只读）→ 139 → 140；
  // 同月新增「AI 闭环」POST/DELETE /api/books/content-process（阅读组，写，book_content_process 覆盖正文）→ 140 → 142。
  // 2026-10：移除前端/后端插件架构，删掉 GET /api/plugins（系统组）→ 142 → 141，系统组 8 → 7。
  assert.equal(catalog.endpoints.length, 141, `端点总数必须为 141，现在是 ${catalog.endpoints.length}（重排时同步改此断言并说明）`)
  assert.equal(new Set(catalog.endpoints.map((e: { group: string }) => e.group)).size, 19, '分组数应为 19')
  const systemGroup = catalog.endpoints.filter((e: { group: string }) => e.group === '系统')
  assert.equal(systemGroup.length, 7, `系统组必须为 7 条（插件架构已移除），现在是 ${systemGroup.length}`)
  const keys = catalog.endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`)
  for (const must of ['POST /api/search', 'PUT /api/sources/{id}', 'GET /api/sources/{id}/debug',
    'GET /api/sources/{id}/browser/res', 'WS /api/search/stream', 'POST /api/books/content',
    'GET /api/bookshelf', 'POST /api/tts/speak', 'GET /api/replace-rules', 'POST /api/backup/import']) {
    assert.ok(keys.includes(must), `AI 要接进来必须能看见 ${must}`)
  }
  // 随包那份 JSON 里的 version 只是给人翻仓库时看的（运行时由 RouteCatalog 盖成当前构建号），
  // 但它一旦停在旧号就没人会再去看 —— 所以让它跟 gradle 的版本号钉在一起，每次 bump 自动跟着走。
  const gradle = /^\s*version\s*=\s*'([^']+)'/m.exec(fs.readFileSync(path.join(ROOT, 'app', 'build.gradle'), 'utf8'))
  assert.ok(gradle, '没从 app/build.gradle 读到版本号')
  assert.equal(catalog.version, gradle![1], `目录里写的版本是 ${catalog.version}，构建却是 ${gradle![1]}`)
})

test('反向对照：假端点、漏端点、write 说谎、缺回包或缺分组都必须被逮住', () => {
  const routes = [
    { method: 'GET', path: '/api/sources', write: false },
    { method: 'PUT', path: '/api/sources/{id}', write: true },
    { method: 'GET', path: '/api/bookshelf', write: false },
  ]
  const fake = { endpoints: [{ method: 'GET', path: '/api/ghost', write: false, purpose: '代码里根本没有这一条，必须被逮住', response: '{whatever}', group: '书源' }] }
  const problems = auditCatalog(routes, fake)
  assert.ok(problems.some(p => p.includes('/api/ghost')), '幻影端点没被逮住')
  assert.ok(problems.some(p => p.includes('PUT /api/sources/{id}')), '代码里有、目录漏了却没报')
  // 全量要求新加的那一半：不在书源前缀里的端点（书架）漏了也得报
  assert.ok(problems.some(p => p.includes('GET /api/bookshelf')), '非书源面的端点漏了却没报，全量覆盖没生效')
  // write 说谎：GET 却标成要同源写门（或反过来），必须报
  const lying = { endpoints: [
    { method: 'GET', path: '/api/sources', write: true, purpose: '书源列表（投影，不载完整规则 JSON）', response: '[{id,name,url}]', group: '书源' },
    { method: 'PUT', path: '/api/sources/{id}', write: true, purpose: '新建或覆盖一份书源，带 version 防并发改写', response: '{id,json,version}', group: '书源' },
    { method: 'GET', path: '/api/bookshelf', write: false, purpose: '书架清单（按最后阅读时间倒序）', response: '[{sourceId,bookUrl,name}]', group: '书架' },
  ] }
  assert.ok(auditCatalog(routes, lying).some(p => p.includes('write 与代码不符')), 'write 说谎没被逮住')
  // 只说"怎么调"不说"回什么"或不说归哪一面：接入方会读不懂、也找不到，必须报
  const noResponse = { endpoints: [
    { method: 'GET', path: '/api/sources', write: false, purpose: '书源列表（投影，不载完整规则 JSON）', group: '书源' },
    { method: 'PUT', path: '/api/sources/{id}', write: true, purpose: '新建或覆盖一份书源', response: '  ', group: '书源' },
    { method: 'GET', path: '/api/bookshelf', write: false, purpose: '书架清单（按最后阅读时间倒序）', response: '[{sourceId,bookUrl,name}]' },
  ] }
  const silent = auditCatalog(routes, noResponse)
  assert.equal(silent.filter(p => p.includes('回包')).length, 2, '缺回包形状没被逮住（含只有空格的情况）')
  assert.ok(silent.some(p => p.includes('group')), '缺分组没被逮住')
  // 同一条判据在正确输入上不许出声（write 与上面那三条的门一致）
  const good = { endpoints: [
    { method: 'GET', path: '/api/sources', write: false, purpose: '书源列表（投影，不载完整规则 JSON）', response: '[{id,name,url,version}]', group: '书源' },
    { method: 'PUT', path: '/api/sources/{id}', write: true, purpose: '新建或覆盖一份书源，带 version 防并发改写', response: '{id,json,version,updatedAt}', group: '书源' },
    { method: 'GET', path: '/api/bookshelf', write: false, purpose: '书架清单（按最后阅读时间倒序）', response: '[{sourceId,bookUrl,name}]', group: '书架' },
  ] }
  assert.deepEqual(auditCatalog(routes, good), [], '干净输入被判红了，判据本身有问题')
})

test('接入说明在，且指向这份目录而不是另一份手抄清单', () => {
  assert.ok(fs.existsSync(DOC), `缺 ${path.relative(ROOT, DOC)}：外部程序接进来没有说明书`)
  const doc = fs.readFileSync(DOC, 'utf8')
  assert.ok(doc.includes('/api/catalog'), '说明要把人指到机器可读的那份目录')
  assert.ok(/同源|Origin/.test(doc), '说明必须写清写操作的门（同源闸门）与"本服务不设身份"这件事')
  assert.ok(/0\.0\.0\.0/.test(doc), '说明必须点破：把绑定地址放开等于把整库写权限交给局域网')
})
