// 留存完整性校验：归档里的每个文件都要与工作树逐字节相同（只容忍行尾差异）。
// 用法：node tools/verify/archive-verify.mjs <tar.gz> <清单>
// 清单必须是 `git ls-files -z` 的输出：默认的 git ls-files 会把非 ASCII 文件名转义成
// "docs/\345\256\236…"，那种字面量喂给 tar 只会报"Not found in archive" —— 看着像留存缺文件，
// 其实是校验读不出中文名（本仓库有中文文档名，必须用 -z）。
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const [archive, list] = process.argv.slice(2)
if (!archive || !list) { console.log('用法: node tools/verify/archive-verify.mjs <归档> <清单(.z，NUL 分隔)>'); process.exit(1) }
const files = fs.readFileSync(list, 'utf8').split('\0').filter(Boolean)
const norm = s => s.replace(/\r\n/g, '\n')
let checked = 0, mismatch = 0, missing = 0
for (const f of files) {
  let fromArchive
  try {
    fromArchive = execSync(`tar --force-local -xzO -f "${archive}" "${f}"`, { maxBuffer: 1 << 28 }).toString()
  } catch {
    missing += 1
    console.log('归档里取不出:', f)
    continue
  }
  checked += 1
  if (!fs.existsSync(f)) { mismatch += 1; console.log('工作树里没有:', f); continue }
  if (norm(fromArchive) !== norm(fs.readFileSync(f, 'utf8'))) { mismatch += 1; console.log('内容不同:', f) }
}
console.log(`\n清单 ${files.length} · 比对 ${checked} · 归档缺 ${missing} · 不一致 ${mismatch}`)
console.log(missing === 0 && mismatch === 0 ? '结论：归档与工作树逐文件一致（只容忍行尾差异）' : '结论：留存不完整，不许删任何东西')
process.exit(missing === 0 && mismatch === 0 ? 0 : 1)
