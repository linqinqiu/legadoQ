#!/usr/bin/env node
/**
 * 组装「免安装」便携版：自带精简 JRE（jlink）+ 打好的 fatJar + 双击启动脚本。
 *
 * 目标：把整个目录拷到任何一台装了同架构系统的电脑上，双击 start.bat（或 ./start.sh）
 * 就能跑，**不需要对方预装 Java、不需要 npm、不需要任何依赖**。
 *
 * 用法：
 *   node scripts/build-portable.mjs
 *   （前置：先跑 `npm run build`，它会打 fatJar；本脚本只负责打包，不重新编译）
 *
 * 产物（按「产物出库」规则放仓库外，与仓库并列）：
 *   <repo>/legado-releases/qingyue-portable-<version>/
 *     ├─ start.bat / start.sh
 *     ├─ runtime/            ← jlink 精简 JRE 17（不依赖本机 Java）
 *     ├─ app/legado-<version>-all.jar
 *     ├─ home/               ← agent-profiles.json 等（首次运行可留空）
 *     └─ data/               ← 书源库（首次运行自动建）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(ROOT, '..')

function appVersion() {
  const gradle = fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8')
  return /^\s*version\s*=\s*'([^']+)'/m.exec(gradle)?.[1] ?? '0.0.0'
}

const version = appVersion()
const jarName = `legado-${version}-all.jar`
const jar = path.join(ROOT, 'app/build/libs', jarName)
if (!fs.existsSync(jar)) {
  console.error(`找不到 ${jar}\n先跑 \`npm run build\`（会打 fatJar）再执行本脚本。`)
  process.exit(1)
}

const outDir = path.join(REPO, 'legado-releases', `qingyue-portable-${version}`)
fs.rmSync(outDir, { recursive: true, force: true })
for (const sub of ['app', 'home', 'data', 'tmp']) fs.mkdirSync(path.join(outDir, sub), { recursive: true })

// 1) fatJar（自带全部依赖 + web/dist + CHANGELOG）
fs.copyFileSync(jar, path.join(outDir, 'app', jarName))
console.log(`✓ 已复制 ${jarName}`)

// 2) jlink 精简 JRE。模块清单覆盖：HTTP 客户端 / SQLite(java.sql) / TLS / 日志 / 桌面托盘等。
const modules = [
  'java.base', 'java.logging', 'java.net.http', 'java.sql', 'java.naming', 'java.management',
  'java.security.jgss', 'java.desktop', 'java.xml', 'jdk.crypto.ec', 'jdk.unsupported',
  'jdk.zipfs', 'jdk.localedata', 'java.instrument', 'jdk.management',
].join(',')
console.log('… 正在用 jlink 生成精简 JRE（首次约 10–30 秒）')
execFileSync('jlink', [
  '--add-modules', modules,
  '--strip-debug', '--no-header-files', '--no-man-pages',
  '--compress=2', '--include-locales=en,zh',
  '--output', path.join(outDir, 'runtime'),
], { stdio: 'inherit' })
console.log('✓ 精简 JRE 完成')

// 3) start.bat（Windows：双击即用，后台起服务并自动打开浏览器）
fs.writeFileSync(path.join(outDir, 'start.bat'), [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'set LEGADO_HOST=127.0.0.1',
  'set LEGADO_PORT=1234',
  'set LEGADO_DATA_DIR=%~dp0data',
  'set LEGADO_HOME=%~dp0home',
  'rem 关键：sqlite-jdbc 会把原生库解压到 java.io.tmpdir。系统临时目录里若有别的 JVM 锁住的旧 DLL，',
  'rem 解压会失败并 UnsatisfiedLinkError。指到便携目录自己的 tmp/，干净且随目录可拷。',
  'set TMP=%~dp0tmp',
  'set TEMP=%~dp0tmp',
  `start "" "%~dp0runtime\\bin\\javaw.exe" -Dfile.encoding=UTF-8 -Djava.io.tmpdir="%~dp0tmp" -jar "%~dp0app\\${jarName}"`,
  'timeout /t 3 /nobreak >nul',
  'start "" http://127.0.0.1:1234/',
  '',
].join('\r\n'), 'utf8')

// 4) start.sh（macOS / Linux：chmod +x 后运行）
fs.writeFileSync(path.join(outDir, 'start.sh'), [
  '#!/usr/bin/env sh',
  'cd "$(dirname "$0")"',
  'export LEGADO_HOST=127.0.0.1',
  'export LEGADO_PORT=1234',
  'export LEGADO_DATA_DIR="$PWD/data"',
  'export LEGADO_HOME="$PWD/home"',
  '# sqlite-jdbc 原生库解压到 java.io.tmpdir；指到便携目录自己的 tmp/，避免系统临时目录里的锁冲突。',
  'export TMPDIR="$PWD/tmp"',
  'exec "$PWD/runtime/bin/java" -Dfile.encoding=UTF-8 -Djava.io.tmpdir="$PWD/tmp" -jar "$PWD/app/' + jarName + '"',
  '',
].join('\n'), 'utf8')
try { fs.chmodSync(path.join(outDir, 'start.sh'), 0o755) } catch { /* Windows 上可能不支持 */ }

console.log(`\n✓ 便携版已生成：${outDir}`)
console.log('  拷贝整个目录到目标机器，双击 start.bat（Windows）或 ./start.sh（macOS/Linux）即可，无需安装任何依赖。')
