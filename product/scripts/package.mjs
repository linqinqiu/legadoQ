import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 组装整合包：`dist/qingyue-<版本>/` + 同名 zip。
 *
 * 借鉴 workbuddy-switch 的发版做法：**产物布局只有一处定义**（他那边是 CI 里
 * `select-matrix` 生成的那张平台表，构建、发包、更新器都读它），所以名字不会各写一套。
 * 我们原来就是各写一套：包名写死在 `package-check.mjs` 里、jar 名写死在 Dockerfile 里、
 * 打包靠人手工 `cp` + `Compress-Archive` —— 手工那一次就同时踩中了两个坑：
 * ① PowerShell 压出的 zip 条目用反斜杠且不带顶层目录，包门禁认不出 `next/index.html`；
 * ② `sed` 改 start.bat 会把它从 CRLF 变成 LF，cmd 读起来行为就变了。
 * 这两条现在都写进脚本并当场自证，不再靠记性。
 *
 * 用法：node scripts/package.mjs [--runtime <已有 runtime 目录>] [--jlink]
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = message => { console.error(`FAIL  ${message}`); process.exit(1) }

const version = (fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8').match(/^version = '([\d.]+)'/m) ?? [])[1]
if (!version) fail('app/build.gradle 里找不到 version —— 版本号只有一个来源，别在脚本里补默认值')

const jarName = `legado-${version}-all.jar`
const jar = path.join(ROOT, 'app/build/libs', jarName)
if (!fs.existsSync(jar)) fail(`没有 ${path.relative(ROOT, jar)}，先跑 ./gradlew :app:fatJar`)

const nextDir = path.join(ROOT, 'next')
const nextIndex = path.join(nextDir, 'index.html')
/** 0.6.23 起 next/ 可选：新骨架源仓已弃、主界面全覆盖，包里不再强带。 */
const hasNext = fs.existsSync(nextIndex)
if (hasNext && !/\/next\/assets\//.test(fs.readFileSync(nextIndex, 'utf8'))) fail('next/index.html 不带 /next/ 前缀，解开就是空白页')
if (!hasNext) console.log('NOTE  没有 next/（新骨架产物）—— 出不含 /next/ 的包')

const NAME = `qingyue-${version}`
const outDir = path.join(ROOT, 'dist', NAME)
const zipPath = path.join(ROOT, 'dist', `${NAME}.zip`)

/** 运行时：默认复用上一次的 jlink 产物；`--jlink` 才重裁。 */
const JAVA_HOME = process.env.JAVA_HOME || ''
const arg = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null }
const MODULES = 'java.base,java.datatransfer,java.xml,java.prefs,java.desktop,java.logging,java.management,' +
  'java.security.sasl,java.naming,java.net.http,java.scripting,java.transaction.xa,java.sql,' +
  'jdk.crypto.ec,jdk.dynalink,jdk.unsupported'
function resolveRuntime(target) {
  const given = arg('--runtime')
  if (given && fs.existsSync(path.join(given, 'bin', 'java.exe'))) {
    fs.cpSync(given, target, { recursive: true })
    return `复用 ${path.relative(ROOT, given)}`
  }
  if (!process.argv.includes('--jlink')) {
    const prev = fs.readdirSync(path.join(ROOT, 'dist')).filter(n => /^qingyue-\d+\.\d+\.\d+$/.test(n) && n !== NAME)
      .sort().reverse().find(n => fs.existsSync(path.join(ROOT, 'dist', n, 'runtime', 'bin', 'java.exe')))
    if (prev) {
      fs.cpSync(path.join(ROOT, 'dist', prev, 'runtime'), target, { recursive: true })
      return `复用 dist/${prev}/runtime（要重裁就加 --jlink）`
    }
  }
  const jlink = path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink')
  if (!fs.existsSync(jlink)) fail(`找不到 jlink（设 JAVA_HOME 或用 --runtime 指一个现成运行时）`)
  const ran = spawnSync(jlink, ['--add-modules', MODULES, '--strip-debug', '--no-header-files', '--no-man-pages',
    '--output', target], { stdio: 'inherit' })
  if (ran.status !== 0 || !fs.existsSync(path.join(target, 'bin', 'java.exe'))) fail('jlink 没产出可用的运行时')
  return 'jlink 新裁'
}

/**
 * 启动脚本：cmd 按 GBK 读，所以这里只许 ASCII；行尾必须是 CRLF。
 *
 * 编码统一（2026-10-12）：便携包裸起 JVM 时，JDK 17 的控制台/管道编码落回系统 ANSI（GBK），
 * 中文日志（LogService 的 [SYSTEM] 行等）在 UTF-8 终端/管道里全是乱码 —— 修法是两端一起统一成 UTF-8：
 * 控制台 `chcp 65001` 负责把字节**渲染**成 UTF-8，五个 `-D` 旗标负责让 JVM **写出** UTF-8
 * （`file.encoding` 管重定向到文件的输出；`sun.stdout/stderr.encoding` JDK 17 认，
 * 无前缀的 `stdout/stderr.encoding` JDK 18+ 认，两套都带，CI 的 21 也能吃）。
 * start.mjs 早就带这套旗标（那里 server.log 已是 UTF-8），start.bat 是当时漏掉的口子。
 *
 * 端口可自定义（学 workbuddy-switch 的 `--port`）：`start.bat 1235` 优先，其次包内的
 * `port.txt`，都没有才是 1234。服务冷启动要几十秒，所以另起一个后台 PowerShell **等端口
 * 真的能连上再开浏览器** —— 一上来就开会只看到"无法访问此页面"。
 */
const psOpenWhenReady = 'for($i=0;$i -lt 240;$i++){try{$c=New-Object Net.Sockets.TcpClient;'
  + "$c.Connect('127.0.0.1',%LEGADO_PORT%);$c.Close();"
  + "Start-Process 'http://127.0.0.1:%LEGADO_PORT%/';break}catch{Start-Sleep -Milliseconds 500}}"
const startBat = [
  '@echo off', 'setlocal', 'cd /d "%~dp0"',
  'chcp 65001 >nul',
  'set LEGADO_PORT=1234',
  'if not "%~1"=="" set LEGADO_PORT=%~1',
  'if exist "%~dp0port.txt" for /f "usebackq delims=" %%p in ("%~dp0port.txt") do set LEGADO_PORT=%%p',
  'set LEGADO_DATA_DIR=data',
  'if not exist "%~dp0tmp" mkdir "%~dp0tmp"', 'echo.',
  `echo  QingYue ${version}  (bundled runtime, no JDK needed)`,
  'echo  UI        http://127.0.0.1:%LEGADO_PORT%/',
  ...(hasNext ? ['echo  New shell http://127.0.0.1:%LEGADO_PORT%/next/'] : []),
  'echo  Stop with Ctrl+C.  Data stays in .\\data',
  'echo  Change port:  start.bat 1235   (or write a number into port.txt)',
  'echo.',
  'start "" /b powershell -NoProfile -WindowStyle Hidden -Command "' + psOpenWhenReady + '"',
  `"${'%~dp0'}runtime\\bin\\java.exe" -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Djava.io.tmpdir="${'%~dp0'}tmp" -jar "${'%~dp0'}${jarName}"`,
  '', '',
].join('\r\n')
if (/[^\x00-\x7F]/.test(startBat)) fail('start.bat 混进了非 ASCII 字符，cmd 会按 GBK 读成乱码')

/**
 * 说明文件从仓库里的模板派生（`scripts/package-readme.txt`，带 {version} / {jar} 占位）。
 * 原来这里是"读上一个包的 README 再 sed 版本号" —— 而 `dist/` 不进版本库，
 * 那样等于让模板一次比一次旧，两版之后没人知道原文长什么样。
 * 模板本身留 LF（与仓库其余部分一致），发出去的包内一律 CRLF（记事本读起来才不挤成一行）。
 */
const template = path.join(ROOT, 'scripts', 'package-readme.txt')
if (!fs.existsSync(template)) fail('缺少 scripts/package-readme.txt（整合包说明的模板）')
const readme = fs.readFileSync(template, 'utf8')
  .replaceAll('{version}', version)
  .replaceAll('{jar}', jarName)
  .replace(/\r?\n/g, '\r\n')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(jar, path.join(outDir, jarName))
if (hasNext) fs.cpSync(nextDir, path.join(outDir, 'next'), { recursive: true })
fs.writeFileSync(path.join(outDir, 'start.bat'), startBat, { mode: 0o644 })
fs.writeFileSync(path.join(outDir, 'README.txt'), readme)
const runtimeNote = resolveRuntime(path.join(outDir, 'runtime'))
if (!fs.existsSync(path.join(outDir, 'runtime', 'bin', 'java.exe'))) fail('包里没有 runtime/bin/java.exe，双击就是一闪而过')

/** 数据与运行痕迹一律不许进包（程序与数据分开，包才小、才不会把别人的库带走）。 */
const FORBIDDEN = /(^|\/)(data|logs?|tmp|node_modules)(\/|$)|\.sqlite(-wal|-shm)?$|\.log$|(^|\/)\.env$/
const dirty = []
const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (FORBIDDEN.test(path.relative(outDir, p).split(path.sep).join('/'))) dirty.push(path.relative(outDir, p)) } }
walk(outDir)
if (dirty.length) fail(`包里混进了数据或运行痕迹：${dirty.slice(0, 4).join(', ')}`)

/** zip：条目名一律正斜杠 + 一个顶层目录（包门禁按 `qingyue-x.y.z/next/index.html` 找东西）。 */
const table = new Int32Array(256)
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[i] = c }
const crc32 = buf => { let c = -1; for (const b of buf) c = (c >>> 8) ^ table[(c ^ b) & 0xff]; return (c ^ -1) >>> 0 }
const now = new Date()
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

const files = []
const collect = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) collect(p); else files.push(p) } }
collect(outDir)
const chunks = [], central = []
let offset = 0
for (const file of files) {
  const name = `${NAME}/${path.relative(outDir, file).split(path.sep).join('/')}`
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
console.log(`OK  dist/${NAME}.zip · ${(bytes.size / 1024 / 1024).toFixed(1)} MB · ${files.length} 条 · 顶层 ${NAME}/`)
console.log(`    运行时：${runtimeNote}`)
console.log(`    sha256 ${crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').slice(0, 16).toUpperCase()}…`)
console.log('    验它：LEGADO_PACKAGE 不必设，package-check 的默认包名跟着 gradle 的版本号走')
