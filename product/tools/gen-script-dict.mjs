/**
 * 生成 `web/src/reader/dict/openccData.ts` —— 简繁转换要用的字表与词组表。
 *
 * 为什么要生成、不手写：简繁不是一一对应（发→發/髮、干→乾/幹、里→裡/里），
 * 靠人列几百个常用字一定会漏，漏掉的那几个字就变成"整页一半繁体一半简体"。
 * 所以数据取 OpenCC 的字典（Apache-2.0），本脚本只做**裁剪**：
 *
 *   1. 字表（STCharacters / TSCharacters）全要 —— 这是覆盖面的底。
 *   2. 词组表（STPhrases / TSPhrases）**只留字表处理不对的**：
 *      对每条 `原文 译文`，先按字表逐字转一遍，结果已经等于译文就丢掉。
 *      留下来的才是真正需要词组上下文的（干净→乾淨、头发→頭髮、里面→裡面）。
 *   3. 简体→繁体的词组再按长度 ≤ `MAX_PHRASE_LEN` 截一刀：
 *      4 字以内的够覆盖常用词与成语，更长的（多为专业术语）出现概率极低，
 *      不匹配时字表仍然兜底，不会比不带词组更差。
 *
 * 裁剪效果（opencc-js 1.4.2 实测）：简体→繁体 193KB→174KB、繁体→简体 1MB→7KB；
 * 不裁的话直接用 opencc-js 的 cn2t 打包产物是 ~1MB。
 *
 * 跑法：node tools/gen-script-dict.mjs
 * 产物**要提交**（跑起来不依赖这个脚本，也不依赖网络）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'web/src/reader/dict/openccData.ts')
const PKG = 'opencc-js'
const MAX_PHRASE_LEN = 4
/** 每行放多少条，纯粹为了文件别长成一行 17 万字符。 */
const CHUNK = 200

/** `export default "a b|c d|…"` → Map（同键取第一条候选；多条候选是"也通"的异体，取默认那条）。 */
function parseDict(file) {
  const text = fs.readFileSync(file, 'utf8')
  const body = text.slice(text.indexOf('"') + 1, text.lastIndexOf('"'))
  const map = new Map()
  for (const entry of body.split('|')) {
    const gap = entry.indexOf(' ')
    if (gap < 0) continue
    const key = entry.slice(0, gap)
    const value = entry.slice(gap + 1).split(' ')[0]
    if (key && value) map.set(key, value)
  }
  return map
}

/** 按字表逐字转（词组表还没上场）。 */
const byChars = (chars, text) => [...text].map(c => chars.get(c) ?? c).join('')

/** 只留"字表转不对"的词组 —— 剩下的都是字表本来就能处理的，留着白占体积。 */
function keepUsefulPhrases(chars, phrases, maxLen = Infinity) {
  const kept = []
  for (const [key, value] of phrases) {
    if ([...key].length > maxLen) continue
    if (byChars(chars, key) !== value) kept.push([key, value])
  }
  return kept
}

/** 长词组先匹配，短的让位（`一干二净` 必须赢过 `一干`）。 */
const sortPhrases = list => list.slice().sort((a, b) => [...b[0]].length - [...a[0]].length)

const encode = list => {
  const lines = []
  for (let i = 0; i < list.length; i += CHUNK) {
    lines.push(`  ${JSON.stringify(list.slice(i, i + CHUNK).map(([k, v]) => `${k} ${v}`).join('|'))},`)
  }
  return lines.join('\n')
}

const emit = (name, list) => `/** ${name} */\nexport const ${name} = [\n${encode(list)}\n].join('|')\n`

/**
 * 把包取到临时目录 —— 只依赖 npm，不依赖本机能连 GitHub。
 *
 * 用 `npm install --prefix` 而不是 `npm pack` + 解包：Windows 上带盘符的绝对路径
 * 会被 tar 当成"远端主机 E"，加 `--force-local` 又只有 GNU tar 认、bsdtar 不认。
 * 让 npm 自己落地就没有这一步。
 *
 * 走 `execSync` 而非 `execFileSync`：Windows 上 `npm` 是 `npm.cmd`，Node ≥20 不许
 * 直接 spawn 批处理（EINVAL），必须过 shell；而 `execFileSync(..., {shell:true})`
 * 在 Node 24 会报 DEP0190。`dir` 是本脚本自己 mkdtemp 出来的路径，加引号即可。
 */
function fetchPackage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-script-dict-'))
  execSync(`npm install ${PKG} --prefix "${dir}" --no-save --no-audit --no-fund --silent`, { stdio: ['ignore', 'ignore', 'inherit'] })
  const pkgDir = path.join(dir, 'node_modules', PKG)
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
  return { dir: path.join(pkgDir, 'dist/esm-lib/dict'), version }
}

const { dir, version } = fetchPackage()

const stChars = parseDict(path.join(dir, 'STCharacters.js'))
const stPhrases = keepUsefulPhrases(stChars, parseDict(path.join(dir, 'STPhrases.js')), MAX_PHRASE_LEN)
const tsChars = parseDict(path.join(dir, 'TSCharacters.js'))
const tsPhrases = keepUsefulPhrases(tsChars, parseDict(path.join(dir, 'TSPhrases.js')))
/**
 * 台湾正体的字形表（爲→為、僞→偽、裏→裡、着→著、衆→眾…），只有 39 条。
 *
 * OpenCC 的 s2t 走的是"通用繁体"，用的是《康熙》那一路字形：因为→因爲、伪→僞。
 * 但读者心里的"繁体"基本是台港排版的样子（因為、偽、裡），所以简→繁最后再过一遍这张表。
 * 只用**字形表**、不用 TWPhrases（那张是词汇本地化：软件→軟體、出租车→計程車，
 * 换掉的是词不是字，读小说时只会觉得"这译者不是我认识的"）。
 */
const twChars = parseDict(path.join(dir, 'TWVariants.js'))

const charList = chars => sortPhrases([...chars.entries()].map(([k, v]) => [k, v]))
const s2tChars = charList(stChars)
const t2sChars = charList(tsChars)
const twList = charList(twChars)

const size = list => Buffer.byteLength(list.map(([k, v]) => `${k} ${v}`).join('|'), 'utf8')
const gz = list => zlib.gzipSync(Buffer.from(list.map(([k, v]) => `${k} ${v}`).join('|'))).length
const kb = n => `${Math.round(n / 1024)}KB`

const header = `/**
 * 简繁转换的字表与词组表 —— **自动生成，别手改**。
 *
 * 数据源：OpenCC 的字典（Apache-2.0），经 ${PKG}@${version} 打包分发；
 * 生成脚本：\`tools/gen-script-dict.mjs\`（那里写着裁剪口径与实测体积）。
 * 用法见 \`../scriptConvert.ts\` —— 这个文件只放数据，不放逻辑。
 *
 * 体积：简→繁 字 ${s2tChars.length} + 词 ${stPhrases.length} + 台港字形 ${twList.length}（${kb(size(s2tChars) + size(stPhrases))}，gzip ${kb(gz(s2tChars) + gz(stPhrases))}）；
 * 繁→简 字 ${t2sChars.length} + 词 ${tsPhrases.length}（${kb(size(t2sChars) + size(tsPhrases))}）。
 * 这个模块**只在用户开了简繁转换时才被动态载入**，默认不进首屏。
 */

`

const body = [
  emit('S2T_CHARS', s2tChars),
  emit('S2T_PHRASES', sortPhrases(stPhrases)),
  emit('S2T_TW_CHARS', twList),
  emit('T2S_CHARS', t2sChars),
  emit('T2S_PHRASES', sortPhrases(tsPhrases)),
].join('\n')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, header + body, 'utf8')

console.log(`写出 ${path.relative(ROOT, OUT)}`)
console.log(`  简→繁  字 ${s2tChars.length}  词 ${stPhrases.length}  台港字形 ${twList.length}   ${kb(size(s2tChars) + size(stPhrases))} (gzip ${kb(gz(s2tChars) + gz(stPhrases))})`)
console.log(`  繁→简  字 ${t2sChars.length}  词 ${tsPhrases.length}   ${kb(size(t2sChars) + size(tsPhrases))} (gzip ${kb(gz(t2sChars) + gz(tsPhrases))})`)
console.log(`  文件   ${kb(fs.statSync(OUT).size)}`)
