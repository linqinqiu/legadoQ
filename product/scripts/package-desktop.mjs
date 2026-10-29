import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * PROPOSAL-017 / ADR-017 一期：把 legadoQ 打成能双击的 Windows 程序（`legadoq.exe`）。
 *
 * 形态：jlink 裁过的运行时 + 我们的 fat jar，由 jpackage 包成 app-image；`legadoq.exe` 起来后
 * 由 `DesktopLauncher` 探端口、开浏览器、挂托盘、退出时优雅关服务。壳只当进程管家 + 窗口，
 * 界面永远开在 `http://127.0.0.1:<port>`（同源闸门一行不改）。
 *
 * 用法：
 *   node scripts/package-desktop.mjs [--data-dir <路径>] [--jlink] [--no-zip]
 *     --data-dir <路径>  在镜像根写一份 .env，把数据目录指向它（本机首次打包用，复用现有书架）；
 *                        不传则默认 <镜像>/data（便携）。
 *     --jlink            强制重裁 jlink 运行时（默认复用上一次）。
 *     --no-zip           只出 app-image 目录，不打 zip。
 *
 * 前置：JAVA_HOME 指向带 jpackage/jlink 的 JDK（本机 Temurin 17）。fat jar 与 web/dist 缺失时自动补构建。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = message => { console.error(`FAIL  ${message}`); process.exit(1) }
const arg = (flag, def = null) => { const i = process.argv.indexOf(flag); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def }
const hasFlag = flag => process.argv.includes(flag)

const version = (fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8').match(/^version = '([\d.]+)'/m) ?? [])[1]
if (!version) fail('app/build.gradle 里找不到 version —— 版本号只有一个来源，别在脚本里补默认值')

const JAVA_HOME = process.env.JAVA_HOME || ''
const jbin = p => path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? `${p}.exe` : p)
if (!fs.existsSync(jbin('jpackage'))) fail('找不到 jpackage（设 JAVA_HOME 指向带 jpackage 的 JDK）')

// 1) 前端必须已经烤进 jar（processResources 把 web/dist 拷进 static/）。web/dist 不存在就先 build。
const webDist = path.join(ROOT, 'web/dist', 'index.html')
if (!fs.existsSync(webDist)) {
  console.log('NOTE  web/dist 不存在，先 npm 构建前端…')
  const ran = spawnSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (ran.status !== 0) fail('npm run build 失败')
}

// 2) fat jar：缺失就补构建（内存吃紧时给 gradle 限一下，避免 mmap 撞 errno=1455）。
const jarName = `legado-${version}-all.jar`
const jar = path.join(ROOT, 'app/build/libs', jarName)
if (!fs.existsSync(jar)) fail(`没有 ${path.relative(ROOT, jar)}，先跑 ./gradlew :app:fatJar`)

// 3) jlink 运行时（复用上一次，--jlink 才重裁）。
const MODULES = 'java.base,java.datatransfer,java.xml,java.prefs,java.desktop,java.logging,java.management,' +
  'java.security.sasl,java.naming,java.net.http,java.scripting,java.transaction.xa,java.sql,' +
  'jdk.crypto.ec,jdk.dynalink,jdk.unsupported'
function resolveRuntime(target) {
  if (!hasFlag('--jlink')) {
    const prev = fs.readdirSync(path.join(ROOT, 'dist')).filter(n => /^legadoq-\d+\.\d+\.\d+$/.test(n))
      .sort().reverse().find(n => fs.existsSync(path.join(ROOT, 'dist', n, 'runtime', 'bin', 'java.exe')))
    if (prev) { fs.cpSync(path.join(ROOT, 'dist', prev, 'runtime'), target, { recursive: true }); return `复用 dist/${prev}/runtime` }
  }
  const jlink = jbin('jlink')
  const ran = spawnSync(jlink, ['--add-modules', MODULES, '--strip-debug', '--no-header-files', '--no-man-pages', '--output', target], { stdio: 'inherit' })
  if (ran.status !== 0 || !fs.existsSync(path.join(target, 'bin', 'java.exe'))) fail('jlink 没产出可用的运行时')
  return 'jlink 新裁'
}

// 4) jpackage app-image。
const staging = path.join(ROOT, 'dist', '_desktop-staging')
fs.rmSync(staging, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })
fs.copyFileSync(jar, path.join(staging, jarName))

const runtimeDir = path.join(ROOT, 'dist', '_desktop-runtime')
fs.rmSync(runtimeDir, { recursive: true, force: true })
const runtimeNote = resolveRuntime(runtimeDir)

const destDir = path.join(ROOT, 'dist', 'desktop')
fs.rmSync(destDir, { recursive: true, force: true })
fs.mkdirSync(destDir, { recursive: true })

const icon = path.join(ROOT, 'assets', 'app.ico')
// app.ico 是生成物（assets/ 不入库）。缺了就现场按 web/public 里各档 PNG 拼一份，
// 否则新克隆的机器打出来的包会静默退回 jpackage 的默认图标 —— 图标没了也不报错。
if (!fs.existsSync(icon)) {
  const made = spawnSync(process.execPath, [path.join(ROOT, 'tools/verify/make-ico.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (made.status !== 0) fail('生成 app.ico 失败')
}
const jpkgArgs = [
  '--type', 'app-image',
  '--name', 'legadoq',
  '--app-version', version,
  '--input', staging,
  '--main-jar', jarName,
  '--main-class', 'io.legado.DesktopLauncherKt',
  '--runtime-image', runtimeDir,
  '--dest', destDir,
  // 编码统一（2026-10-12）：只给 file.encoding 的话，JDK 17 的控制台输出仍落回系统 ANSI（GBK）。
  // sun.stdout/stderr 是 17 认的，无前缀两个是 18+（CI 的 21）认的，两套都带。
  '--java-options', '-Dfile.encoding=UTF-8',
  '--java-options', '-Dsun.stdout.encoding=UTF-8',
  '--java-options', '-Dsun.stderr.encoding=UTF-8',
  '--java-options', '-Dstdout.encoding=UTF-8',
  '--java-options', '-Dstderr.encoding=UTF-8',
]
if (fs.existsSync(icon)) jpkgArgs.push('--icon', icon)
const ran = spawnSync(jbin('jpackage'), jpkgArgs, { cwd: ROOT, stdio: 'inherit' })
if (ran.status !== 0) fail('jpackage 失败')
const imageRoot = path.join(destDir, 'legadoq')
if (!fs.existsSync(path.join(imageRoot, 'legadoq.exe'))) fail('没生成 legadoq.exe')

// 5) 把图标也放进镜像根：app.ico 给 exe/快捷方式，app.png 给托盘与启动画面。
//    托盘必须用 PNG —— Java ImageIO 没有 ICO 解码器，读 app.ico 只会得到 1×1 透明图。
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(imageRoot, 'app.ico'))
const trayIcon = path.join(ROOT, 'web/public/brand-logo-96.png')
if (fs.existsSync(trayIcon)) fs.copyFileSync(trayIcon, path.join(imageRoot, 'app.png'))

// 6) 可选：把数据目录指向现有书架（本机首次打包用，不静默迁移）。
const dataDir = arg('--data-dir')
if (dataDir) {
  fs.writeFileSync(path.join(imageRoot, '.env'), `LEGADO_DATA_DIR=${dataDir}\n`, 'utf8')
  console.log(`NOTE  数据目录指向 ${dataDir}（镜像根 .env）`)
}

// 7) 校验产物布局（ADR-017 §5）：legadoq.exe / app/legado-*-all.jar / runtime/bin/java.exe。
const appJar = fs.readdirSync(path.join(imageRoot, 'app')).find(n => n.endsWith('-all.jar'))
if (!appJar) fail('app/ 里没有 fat jar —— stop.mjs 的 CommandLine 匹配会静默跳过它')
if (!fs.existsSync(path.join(imageRoot, 'runtime', 'bin', 'java.exe'))) fail('runtime/bin/java.exe 缺失')
console.log(`OK  ${path.relative(ROOT, imageRoot)}/legadoq.exe`)
console.log(`    运行时：${runtimeNote}；数据默认 ${dataDir ? dataDir : '<镜像>/data'}`)

// 8) zip（顶层目录 = legadoQ）。
if (!hasFlag('--no-zip')) {
  const zipName = `legadoq-desktop-${version}.zip`
  const zipPath = path.join(ROOT, 'dist', zipName)
  const files = []
  const collect = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) collect(p); else files.push(p) } }
  collect(imageRoot)
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[i] = c }
  const crc32 = buf => { let c = -1; for (const b of buf) c = (c >>> 8) ^ table[(c ^ b) & 0xff]; return (c ^ -1) >>> 0 }
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const chunks = [], central = []
  let offset = 0
  for (const file of files) {
    const name = `legadoq/${path.relative(imageRoot, file).split(path.sep).join('/')}`
    const data = fs.readFileSync(file)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const crc = crc32(data), head = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(head.length, 26)
    chunks.push(local, head, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10); entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14)
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(head.length, 28); entry.writeUInt32LE(offset, 42)
    central.push(entry, head)
    offset += 30 + head.length + body.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cd, eocd]))
  const bytes = fs.statSync(zipPath)
  console.log(`OK  dist/${zipName} · ${(bytes.size / 1024 / 1024).toFixed(1)} MB · ${files.length} 条 · 顶层 legadoq/`)
  console.log(`    sha256 ${crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').slice(0, 16).toUpperCase()}…`)
}

fs.rmSync(staging, { recursive: true, force: true })
console.log('下一步：双击 dist/desktop/legadoq/legadoq.exe（或在干净 PATH 下跑 tools/verify/desktop-check.mjs 验）')
