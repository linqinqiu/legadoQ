import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 整合包门禁 —— 检查"要交给用户的那个 zip"本身。
 *
 * 为什么要有它：整合包是这一轮真正的交付物，而它的坏法全都是**静默**的：
 * 把跑出来的 `data/`（含用户书架）或 `logs/` 一起打进去、`start.bat` 里写死本机绝对路径、
 * 打包用的 jar 不是刚验过的那一份、`next/` 是旧构建。这些没有一条会让服务报错，
 * 只会在用户机器上变成"包里怎么有别人的东西 / 双击没反应 / 界面还是旧的"。
 *
 * 不依赖任何第三方库（本机 npm registry 走不通代理），zip 中央目录自己解析。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')
/**
 * 默认包名从 `app/build.gradle` 的 version 推出来 —— 原来这里写死 `qingyue-0.6.0.zip`，
 * 于是下一次发版若忘了带 `LEGADO_PACKAGE`，这条门禁会**去验上一版的包**并且照样全绿
 * （version-check 当年就是靠"build/libs 里留着旧号包"逮到人挑错包的，同一个入口）。
 */
const PACKAGE_VERSION = (fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8').match(/^version = '([\d.]+)'/m) ?? [])[1] ?? ''
const ZIP = process.env.LEGADO_PACKAGE || path.join(ROOT, `dist/qingyue-${PACKAGE_VERSION}.zip`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 解析 zip 中央目录：返回 [{ name, method, compSize, uncompSize, offset }]。 */
function readEntries(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error(`${ZIP} 里没找到 zip 中央目录结束标记，这不是一个 zip`)
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`中央目录第 ${index} 条签名不对，解析器该修了`)
    const method = buffer.readUInt16LE(cursor + 10)
    const compSize = buffer.readUInt32LE(cursor + 20)
    const uncompSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compSize, uncompSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 取出一个条目的字节（deflate 的当场解开）。 */
function entryBytes(buffer, entry) {
  const local = entry.localOffset
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${entry.name} 的本地头签名不对`)
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compSize)
  return entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
}

/**
 * 前置产物不存在时判 **NOTE（前置不满足）** 而不是 FAIL。
 *
 * 为什么改：CI 的 full job 只跑 `./gradlew :app:fatJar`，不产 `dist/qingyue-*.zip`
 * （组装脚本 `scripts/package.mjs` 是 Windows 专属的：它要求包里有 `runtime/bin/java.exe`，
 * 见 scripts/package.mjs:66,127，在 ubuntu-latest 上必然 fail）。于是这条门禁在 CI 里
 * **每次必红** —— "全量门禁"永远不是全绿，绿/红信号本身就失去意义了。
 *
 * 这与 `stalled-client-check.mjs:105-109` 是同一条口径：前置不满足不是产品坏了，
 * 让"没测到"与"测了但坏了"分开。产物真存在、但内容不对时，下面的断言照样判 FAIL。
 */
if (!fs.existsSync(ZIP)) {
  console.log(`NOTE  前置不满足：整合包不存在（${ZIP}）`)
  console.log('      这条门禁判的是**产物**，不是源码：先 node scripts/package.mjs 组装 dist/ 再跑。')
  console.log('      CI 的 full job 不产整合包（package.mjs 要求 runtime/bin/java.exe，仅 Windows），')
  console.log('      所以这里判 NOTE 而不是 FAIL —— 详见本文件开头的前置说明。')
  console.log('\npackage-check: NOTE 前置不满足（没有整合包），不做任何断言')
  process.exit(0)
}
const buffer = fs.readFileSync(ZIP)
const entries = readEntries(buffer)
const names = entries.map(entry => entry.name.replace(/\\/g, '/'))
const byName = new Map(entries.map(entry => [entry.name.replace(/\\/g, '/'), entry]))
const topDir = [...new Set(names.map(name => name.split('/')[0]))]
console.log(`包 ${ZIP} · ${(buffer.length / 1024 / 1024).toFixed(1)} MB · ${entries.length} 条 · 顶层 ${topDir.join(', ')}`)

const gradleVersion = (fs.readFileSync(path.join(ROOT, 'app/build.gradle'), 'utf8').match(/^version = '([\d.]+)'/m) ?? [])[1] ?? ''
const liveVersion = await fetch(`${BASE}/healthz`).then(response => response.json()).then(info => info.version).catch(() => '')
// 只看包根上的 jar：runtime/lib/jrt-fs.jar 也是 .jar，把它算进来这条就永远在报"两个 jar"
const jarEntries = names.filter(name => name.split('/').length === 2 && name.endsWith('.jar'))

// /next/ 新骨架自 0.6.23 起不再随包分发（其源仓已弃，主界面早已全覆盖）；包里有没有就按有没有验
const hasNext = names.some(name => name.startsWith(`${topDir[0]}/next/`))
check('包顶层就那几样：启动脚本、说明、jar、runtime/（+ 可选 next/）',
  topDir.length === 1 && names.every(name => name.startsWith(topDir[0] + '/')) &&
    ['start.bat', 'README.txt'].every(file => names.includes(`${topDir[0]}/${file}`)) &&
    names.some(name => name.startsWith(`${topDir[0]}/runtime/`)) &&
    (hasNext || !names.some(name => name.includes('/next/'))),
  topDir.join(','))
check(`jar 在包里且版本号就是 gradle 的那一个（${gradleVersion}）`,
  jarEntries.length === 1 && jarEntries[0].includes(`-${gradleVersion}-all.jar`), jarEntries.join(','))
check('包里的 jar 与刚验过的那一份字节数一致（不是上一次的旧包）',
  jarEntries.length === 1 && byName.get(jarEntries[0]).uncompSize ===
    fs.statSync(path.join(ROOT, `app/build/libs/legado-${gradleVersion}-all.jar`)).size,
  `${byName.get(jarEntries[0])?.uncompSize} vs ${fs.statSync(path.join(ROOT, `app/build/libs/legado-${gradleVersion}-all.jar`)).size}`)
check('运行时的 java.exe 在包里（没有它，双击就是一闪而过）',
  names.some(name => /\/runtime\/bin\/java\.exe$/.test(name)))
check('服务在跑的端口号与包里的 gradle 同号（部署与交付是同一版）',
  liveVersion !== '' && liveVersion === gradleVersion, `gradle ${gradleVersion} · /healthz ${liveVersion || '(没应答)'}`)

/** 交付物里不许有用户数据与运行痕迹。 */
const FORBIDDEN = [/\/data\//, /\/logs?\//, /\.sqlite(-wal|-shm)?$/i, /\.log$/, /\/\.env$/, /\/tmp\//, /\/node_modules\//]
const dirty = names.filter(name => FORBIDDEN.some(pattern => pattern.test(name)))
check('包里没有 data/、logs/、*.sqlite、*.log、.env（程序与数据必须分开）', dirty.length === 0, dirty.slice(0, 4).join(' '))

const readText = file => {
  const entry = entries.find(item => item.name.replace(/\\/g, '/') === file)
  return entry ? entryBytes(buffer, entry).toString('utf8') : ''
}
const startBat = readText(`${topDir[0]}/start.bat`)
const readme = readText(`${topDir[0]}/README.txt`)
check('start.bat 与 README.txt 都取得出来且非空', startBat.length > 40 && readme.length > 40)
// 个人绝对路径：盘符 + 某个用户目录。交付物里出现它，别人解开就是死链
const absolutePath = /[A-Za-z]:[\\/](?:Users|Projects|Apps|Documents)[\\/]/
check('交付文件里不写任何人的本机绝对路径',
  !absolutePath.test(startBat) && !absolutePath.test(readme),
  [startBat.match(absolutePath)?.[0], readme.match(absolutePath)?.[0]].filter(Boolean).join(' '))
check('start.bat 是 CRLF 且只用 ASCII（cmd 按 GBK 读，中文注释会变乱码）',
  /\r\n/.test(startBat) && !/[^\x00-\x7F]/.test(startBat))
check('start.bat 里端口与数据目录都显式给了（不依赖工作目录）',
  /LEGADO_PORT=1234/.test(startBat) && /LEGADO_DATA_DIR=data/.test(startBat))

/** 包里若带 next/，那份 index.html 必须就是服务正在返回的那一份。 */
if (hasNext) {
  const packedIndex = readText(`${topDir[0]}/next/index.html`)
  const liveIndex = await fetch(`${BASE}/next/`).then(response => response.text()).catch(() => '')
  const bundleOf = html => (html.match(/\/next\/assets\/[\w.-]+\.js/) ?? ['(没找到)'])[0]
  check('包里的 next/index.html 与线上 /next/ 是同一份构建',
    packedIndex.length > 0 && bundleOf(packedIndex) === bundleOf(liveIndex),
    `包 ${bundleOf(packedIndex)} · 线上 ${bundleOf(liveIndex)}`)
}

/**
 * 反向对照：把"包里混进用户数据 / 写了本机绝对路径"这两种坏法当场演一遍，
 * 判据必须变红。没有这一段，上面那些"干净"可能只是根本没在扫。
 */
if (process.argv.includes('--self-test')) {
  console.log('\n反向对照：注入两类脏包，判据必须变红')
  const polluted = [...names, `${topDir[0]}/data/legado.sqlite`, `${topDir[0]}/logs/legado-20261004.log`]
  const caught = polluted.filter(name => FORBIDDEN.some(pattern => pattern.test(name)))
  check('注入 data/ 与 logs/ → 脏条目判据必须抓到', caught.length === 2, caught.join(' '))
  const leaked = `set LEGADO_DATA_DIR=E:\\Users\\someone\\reader\\data`
  check('注入本机绝对路径 → 路径判据必须抓到', absolutePath.test(leaked), leaked)
  const missed = names.filter(name => FORBIDDEN.some(pattern => pattern.test(name)))
  check('正向对照：真包里的脏条目数就是 0（不是判据没跑）', missed.length === 0, `扫了 ${names.length} 条`)
}

const failed = results.filter(row => !row.ok).length
console.log(`\n${results.length - failed}/${results.length} PASS`)
process.exitCode = failed > 0 ? 1 : 0
