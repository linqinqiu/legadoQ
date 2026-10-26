// 「随包产物」那批用例必须真跑过，不许被 assume 跳过。
//
// StaticAssetsHttpTest / BrandStoreTest 判的是 jar 里那份前端：index.html 的缓存头、
// 带哈希 bundle 的 gzip/ETag/HEAD、随包 manifest 的改写。前端没构建时它们的前置条件不成立，
// 会 assumeTrue 跳过 —— 在只跑后端的 ci.yml 里那是诚实的（那条流水线本来就不出产物），
// 但在**这条已经建过前端**的流水线里，跳过就等于"产物没人验，灯还是绿的"。
// 哪天构建顺序被挪到测试之后、dist 目录名改了、或 processResources 少拷一层，
// 这一步立刻红，而不是静默少跑十几条。
//
// 只读，不写任何文件。跑法：node tools/verify/ui-tests-ran-check.mjs（在 :app:test 之后）
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.mjs'

const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'app/build/test-results/test')
// 这两个类每一条都读包内 static/：不是"可能依赖"，是全部依赖。
const WATCHED = ['io.legado.StaticAssetsHttpTest', 'io.legado.BrandStoreTest']

const results = []
const record = (name, state, detail = '') => results.push({ name, state, detail })

if (!fs.existsSync(DIR)) {
  console.log(`ui-tests-ran-check: 找不到 ${DIR} —— :app:test 没跑过，无从判起`)
  process.exit(1)
}

for (const cls of WATCHED) {
  const file = path.join(DIR, `TEST-${cls}.xml`)
  if (!fs.existsSync(file)) {
    record(cls, false, '没有测试结果文件：:app:test 没跑，或这个类被改名/删掉了（改名要同步这里）')
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  const head = /<testsuite\b[^>]*>/.exec(text)?.[0] ?? ''
  const num = (attr) => Number(new RegExp(`${attr}="(\\d+)"`).exec(head)?.[1] ?? -1)
  const tests = num('tests')
  const skipped = num('skipped')
  const broken = num('failures') + num('errors')
  if (tests <= 0) {
    record(cls, false, `tests=${tests}：这个类一条用例都不剩了`)
  } else if (skipped > 0) {
    const names = [...text.matchAll(/<testcase name="([^"]*)"[^>]*>\s*<skipped/g)].map((m) => m[1])
    record(cls, false,
      `${skipped}/${tests} 条被跳过（${names.join('、') || '名字没解析出来'}）` +
      ' —— 跑测试时包内没有前端，先 npm --prefix web run build 再 :app:test')
  } else if (broken > 0) {
    // 断言真红由 :app:test 自己报；这里只负责"有没有跑"，不重复判一遍。
    record(cls, 'skip', `${broken} 条失败 —— 归 :app:test 报，这里只看有没有跑`)
  } else {
    record(cls, true, `${tests} 条全部真跑过`)
  }
}

let failed = 0
for (const r of results) {
  const mark = r.state === true ? 'PASS' : r.state === 'skip' ? 'SKIP' : 'FAIL'
  if (mark === 'FAIL') failed++
  console.log(`${mark}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
if (failed) {
  console.log(`\n${failed} 个类的随包产物用例没真跑 —— 这条流水线建了前端，它们不该被跳过。修复（顺序不能反）：`)
  console.log('  npm --prefix web run build && ./gradlew :app:test')
}
console.log(`\n${results.length - failed} 项通过 / ${failed} 项失败`)
process.exit(failed ? 1 : 0)
