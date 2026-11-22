// 前端产物完整性门禁：`web/dist` 必须真的是一份能打开的界面，而不是"构建到一半"的残骸。
//
// 来历（2026-11-22）：本机 vite 在 `rendering chunks` 阶段失败（esbuild 处理 >1 MiB 的
// transform 输入时会写临时文件，删除被拒），但此时 `dist/` 里已经落下了 `sw.js`、
// `workbox-*.js` 等文件。`processResources` 只看 `web/dist` 目录在不在，于是这种
// "有目录、没 index.html" 的 dist 会被静默烤进 jar；`bundled-ui-check` 遇到缺
// index.html 又直接 exit 0（当成"还没构建"），整条链全绿，产物却没有界面。
//
// 所以把「构建命令退出码为 0」与「产物完整」拆成两条判据：本脚本只读 dist，
// 由 `scripts/tasks.mjs build` 在打包前调用。跑法：node tools/verify/dist-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.join(ROOT, 'web/dist')
const INDEX = path.join(DIST, 'index.html')

const failures = []
const passes = []
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`
  console.log(line)
  if (ok) passes.push(name)
  else failures.push(name)
}

check('web/dist 目录存在', fs.existsSync(DIST), DIST)
if (!fs.existsSync(INDEX)) {
  check('web/dist/index.html 存在', false, '构建没产出入口 HTML —— 先跑 npm --prefix web run build')
} else {
  const html = fs.readFileSync(INDEX, 'utf8')
  check('web/dist/index.html 非空', html.trim().length > 0, `${Buffer.byteLength(html)} B`)

  // index.html 里引用的是绝对路径（`/assets/...`、`/manifest.webmanifest`），
  // 转成 dist 下的相对路径逐个核对：名字对上但文件缺失一样是白屏。
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith('//'))
  // 引用可能带缓存查询串（`/favicon-32.png?v=5`），落盘路径只看 `?` / `#` 之前那段。
  const local = [...new Set(refs)].map((ref) => {
    const pathname = ref.split(/[?#]/)[0]
    return { ref, pathname, abs: path.join(DIST, pathname.slice(1)) }
  }).filter(({ pathname }) => !pathname.startsWith('/api/'))

  check('index.html 至少引用一个本地资源', local.length > 0, local.map(({ ref }) => ref).join(', ') || '一个都没找到')
  for (const { ref, abs } of local) {
    const exists = fs.existsSync(abs)
    const size = exists ? fs.statSync(abs).size : 0
    check(`引用资源可取到 ${ref}`, exists && size > 0, exists ? `${size} B` : '文件不存在')
  }

  const js = local.filter(({ pathname }) => pathname.endsWith('.js'))
  check('index.html 引用了至少一个 JS bundle', js.length > 0, js.map(({ ref }) => ref).join(', ') || '没有 .js')

  const manifestRef = local.find(({ pathname }) => pathname.endsWith('manifest.webmanifest'))
  if (manifestRef) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestRef.abs, 'utf8'))
      check('manifest.webmanifest 可解析', typeof manifest === 'object' && manifest !== null)
    } catch (error) {
      check('manifest.webmanifest 可解析', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
    }
  }
}

console.log(`\n${passes.length} 项通过 / ${failures.length} 项失败`)
if (failures.length) {
  console.log('web/dist 不是一份完整界面 —— 不要继续打包。先修构建（见 product/CONTRIBUTING.md 的兜底构建说明），再重跑。')
  process.exitCode = 1
}
