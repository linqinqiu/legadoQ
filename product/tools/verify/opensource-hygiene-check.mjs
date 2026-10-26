/**
 * 开源口径门禁（任务 #49 / #70）。
 *
 * 这个项目要开源，而它是从一台私人机器上长出来的。两类东西最容易跟着仓库溜出去：
 * ① **个人标识**：私人盘符路径、用户名、GitHub 账号、个人镜像仓库地址、真机型号与真实书架条目；
 * ② **说谎的文档**：功能已经整删（认证、WebDAV、插件系统、精简版客户端），README / 部署模板 /
 *   示例脚本里还在教用户填密码、调 `/api/auth/login`。用户照着做只会得到"文档骗人"。
 *
 * 所以这里只判**可分发面**（git 跟踪的文件，排除 `docs/` 归档与 `tools/verify/out/`），
 * 归档里保留历史叙述是有意的（那里写着"当初为什么这么做"），但必须带废弃抬头。
 *
 * 跑法：node tools/verify/opensource-hygiene-check.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.mjs'

const results = []
// note=true 的行**只报不计红**：那是"等人拍板"的口径问题，不是代码坏了；
// 但必须打印出来，否则下次没人记得它存在。
const check = (name, ok, detail = '', note = false) => results.push({ name, ok: note ? null : !!ok, detail })

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
  .toString('utf8').split('\0').filter(Boolean)
  // 只看在盘的：删掉但还没 `git rm` 暂存的文件不该让扫描崩掉（那种"已删待提交"由下面单独一条断言管）
  .filter(file => fs.existsSync(path.join(ROOT, file)))

/** 归档目录允许写历史，其余可分发面一律不许带这些形状。 */
const ARCHIVE = /^(docs\/(sessions|acceptance|proposals|decisions)\/|CHANGELOG\.md$|AGENTS\.md$)/
const isArchive = file => ARCHIVE.test(file)
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

const rules = [
  {
    name: '没有个人盘符路径（C:\\Users\\张三、E:\\Backup 这类真目录）',
    // `<用户>` / `%USERPROFILE%` 这种占位写法是**该用的**（解释 Windows 行为时绕不开），不算残留
    pattern: /[A-Za-z]:[\\/](Users|Backup|Projects|Apps|Downloads)[\\/](?![<%])[^\s"'`、）)]/,
    exempt: ['scripts/runtime.mjs', 'start.mjs', 'stop.mjs'],
    why: '示例位置要写成 `<数据目录>` 这类占位；别人的机器上没有你的目录树',
  },
  {
    // 指向**本项目自己的** GitHub（CI 徽章、镜像仓库）与指向上游 `gedoor/legado` 都是正常归属；
    // 要挡的是"这台开发机的私人身份"混进可分发面：Windows 用户名、个人 fork 账号，
    // 以及 LICENSE 把本项目的版权写成上游作者。
    name: '没有私人身份残留（Windows 用户名、个人 fork 账号、LICENSE 错标上游作者）',
    /**
     * 2026-10-11 收窄：原来连 `linqinqiu` 一起挡，但那是**本项目自己的仓库 owner** ——
     * package.json 的 repository、SECURITY 的私密报告地址、CODEOWNERS 的 `@linqinqiu`、
     * 「关于」页默认的 `LEGADO_REPO` 都得写它，写成占位符只会让检查更新直接失灵。
     * 项目对外唯一的地址不是"私人身份残留"。
     *
     * 所以名单只剩真正属于**这台机器/这个人的旧身份**：`qinqiu`（本机 Windows 用户名，
     * 会以「盘符 + Users + 用户名」那种形状溜进文档，上面那条规则也管它）
     * 与 `wfanan`（项目迁过来之前那个 fork 账号）。
     * 两边都带 `\b`，所以 `linqinqiu` 里的 `qinqiu` 不会误伤（前面是 `n`，没有词边界）。
     */
    pattern: /\b(qinqiu|wfanan)\b/i,
    // 这份检测名单就写在门禁自己里，扫描时不跳过自身会自匹配成假红
    exempt: ['tools/verify/opensource-hygiene-check.mjs'],
  },
  {
    name: 'LICENSE 的版权持有者不许写成上游作者',
    pattern: /Copyright \(C\).*gedoor/,
    only: /^LICENSE$/,
  },
  {
    name: '没有个人镜像仓库 / 私有服务 ID 形状的字符串',
    pattern: /crpi-[a-z0-9]+\.personal\.cr\.aliyuncs\.com|ServiceId=service-[0-9a-f]{8,}/i,
    note: true,
  },
  {
    name: '可分发的"教程式"面不许提已删的认证（README / 配置 / 部署模板 / 脚本）',
    pattern: /ADMIN_PASSWORD|adminPassword|reset-password|LEGADO_SECURE_COOKIES|\/api\/auth|legado_session|X-CSRF-Token/i,
    only: /^(README\.md|\.env\.example|compose\.yml|Dockerfile|\.github\/|computenest\/|scripts\/)/,
  },
  {
    name: '代码与配置里没有 WebDAV 残留（`/webdav`、`WebDav`、`webdav`）',
    pattern: /\/webdav|WebDav|webdav/,
    // 归档文档与"已删除"的说明允许提到它；这里只扫代码/配置/部署面
    only: /(\.kt|\.ts|\.tsx|\.mjs|\.py|\.yml|\.yaml|\.json|Dockerfile.*|\.env.*)$/,
    // 门禁自己的匹配串 + 四个"负向测试"（正是用字符串断言 webdav 端点/页面已不存在）按设计就该出现该词，跳过它们。
    // backup-page.test.ts 是 2026-10-01 这轮进来的：它断言的是"页面上不许再出现 WebDAV 字样"，
    // 于是它自己命中了这条扫描 —— 判据扫到的是**守卫的文本**，不是残留的功能（AGENTS §3：先问是判据旧了还是产品坏了）。
    exempt: [
      'tools/verify/opensource-hygiene-check.mjs',
      'tools/verify/backup-upload-check.mjs',
      'tools/verify/backup-cookie-import-check.mjs',
      'tools/verify/rss-check.mjs',
      'tools/verify/source-editor-check.mjs',
      'web/test/backup-page.test.ts',
      // 这条判据的职责就是"断言验收手册里不再出现已删功能的形状"，所以它的正则与注释里必须出现那些字面串。
      // 与上面几份负向测试同理（AGENTS：门禁扫到的是守卫的文本，那要进 exempt，不是把测试删掉）。
      'web/test/AcceptanceFresh.test.ts',
    ],
  },
  {
    name: '根目录不散落 PLAN / TODO / 委托件，也不放外来整份文档',
    pattern: null,
    custom: () => {
      const stray = tracked.filter(file => !file.includes('/') && /^(PLAN|TODO|NOTES|ORIGINAL_REQUEST|TEST_INFRA|PROJECT|api)\.md$/i.test(file))
      return stray.length ? { ok: false, detail: '根目录这些文件该进 docs/ 或删除：' + stray.join('、') } : { ok: true, detail: '根目录只有 README/CHANGELOG/LICENSE/AGENTS' }
    },
  },
  {
    name: '根目录文档不引用 Android 端 `io.legado.app` 包路径（那是上游 App 的 API 文档形状）',
    pattern: /io\.legado\.app/,
    only: /^[^/]+\.md$/,
  },
]

for (const rule of rules) {
  if (rule.custom) {
    const verdict = rule.custom()
    check(rule.name, verdict.ok, verdict.detail)
    continue
  }
  const hits = []
  for (const file of tracked) {
    if (isArchive(file)) continue
    if (rule.only && !rule.only.test(file)) continue
    if (rule.exempt?.includes(file)) continue
    const lines = read(file).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) hits.push(`${file}:${index + 1}  ${line.trim().slice(0, 70)}`)
    })
  }
  check(rule.name, hits.length === 0, hits.slice(0, 6).join(' ⏎ ') || '干净' + (hits.length > 6 ? `（另有 ${hits.length - 6} 处）` : ''), rule.note)
}

// ── README 承诺的端点必须真的存在（文档说谎最常见的形态就是这个）──────────
// 路由是嵌在 `route("/api") { get("/backup/import") … }` 里的，所以拿"去掉 /api 前缀的尾巴"去源码里找，
// 而不是要求整串出现 —— 否则 `/api/backup/import` 这种明明存在的端点会被判成悬空。
//
// 2026-10-11 修：这里原来是 `readdirSync` **只读一层**，而后端在 e982890 拆过包
// （`Routes.kt` 从 `io/legado/` 挪进了 `io/legado/http/`），
// 于是这个函数读到的一串全是目录名、`read()` 全抛、拼出来基本是空串 ——
// 端点这条断言从那次重构起就**一直是瞎的**，它现在报"悬空"纯粹是因为看不清。
// 改成递归走整棵 kotlin 树。
const kotlinRoot = path.join(ROOT, 'app/src/main/kotlin')
const walkKotlin = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walkKotlin(full) : [full]
})
const appSource = walkKotlin(kotlinRoot)
  .map(file => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }).join('\n')
const readme = read('README.md')
const declared = [...new Set([...readme.matchAll(/\/api\/[a-z0-9\-_/{}]+\w/gi)].map(m => m[0].replace(/\/$/, '')))]
// 嵌套路由是**分段**写的：`route("agent") { get("/manifest") }` —— 源码里根本没有
// 字符串 `"/agent/manifest"`。只找整串会把这些全判成悬空，等于让文档不敢写嵌套端点。
// 所以另外按段拼一次：收集每层 route(...) 的段与每条 get/post/... 的路径，组合出真实端点。
const routeSegs = []
const verbPaths = []
for (const m of appSource.matchAll(/\b(route|get|post|put|delete|patch|webSocket)\s*\(\s*"([^"]*)"/g)) {
  if (m[1] === 'route') routeSegs.push(m[2])
  else verbPaths.push(m[2])
}
const composed = new Set()
for (const seg of routeSegs) {
  const s = seg.replace(/^\//, '')
  if (!s) continue
  composed.add('/' + s)
  for (const v of verbPaths) composed.add('/' + s + (v.startsWith('/') ? v : '/' + v))
}
const missing = declared.filter(entry => {
  const tail = entry.replace(/^\/api/, '')
  if (appSource.includes('"' + entry + '"') || appSource.includes('"' + tail + '"')) return false
  return !composed.has(tail)
})
check('README 里写到的每个 `/api/...` 都能在源码路由里找到（端点清单不许悬空）',
  missing.length === 0,
  `声明 ${declared.length} 条，悬空 ${missing.join('、') || '0'}`)
if (!declared.length) console.log('  NOTE README 里一条 /api/... 都没写 —— 端点这条断言现在是空的，README 补端点清单时它会开始起作用')


// ── 许可证：文件要在，且不许把本项目版权记到别人名下 ──────────
const licensePath = path.join(ROOT, 'LICENSE')
check('仓库根有 LICENSE', fs.existsSync(licensePath))
const license = fs.existsSync(licensePath) ? read('LICENSE') : ''
// （版权持有者那条规则在上面按文件扫过，这里不再重复计一条）
const pkg = JSON.parse(read('package.json'))
check('package.json 的 license 与 LICENSE 一致',
  /GPL-3/.test(String(pkg.license)) && /GNU GENERAL PUBLIC LICENSE/.test(license),
  `package.json=${pkg.license} · LICENSE 头=${license.split('\n')[0] ?? ''}`)

// ── 版本号单一来源不许在部署面写死（Dockerfile 里钉死旧 jar 名会让构建直接坏）──
const dockerfile = fs.existsSync(path.join(ROOT, 'Dockerfile')) ? read('Dockerfile') : ''
check('Dockerfile 不写死带版本号的 jar 名', !/legado-\d+\.\d+\.\d+[^"]*\.jar/.test(dockerfile),
  (dockerfile.match(/legado-[^"\s]*jar/g) ?? []).join(' ') || '没有硬编码 jar 名')

let pass = 0
let fail = 0
let notes = 0
for (const item of results) {
  if (item.ok === true) { pass++; console.log(`  PASS ${item.name}  — ${item.detail}`) }
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { notes++; console.log(`  NOTE ${item.name}  — ${item.detail}`) }
}
console.log(`\nopensource-hygiene-check: PASS ${pass} / FAIL ${fail} / NOTE ${notes}`)
process.exit(fail > 0 ? 1 : 0)
