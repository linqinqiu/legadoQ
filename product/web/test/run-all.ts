/**
 * 前端判据的总入口：**扫目录，不手抄清单**。
 *
 * 规则本身在 `discover.ts`（纯函数，能被判据反过来核）。`node:test` 的 `test()` 在文件被
 * import 时就登记，进程退出时自动跑，所以这里只要把每份文件载进来即可 —— 不需要 `run()` / `spec`。
 *
 * 为什么不让加测试的人手动加一行 import：这条链上已经出过三次"文件在、名字像测试、跑起来一片绿，
 * 其实一条都没执行"（`HeaderMenu.test.ts` 被顺手摘掉、`LocalBookImport.test.ts` 从来没被引过、
 * 0.7.0 rebase 只取走文档提交而连代码带判据一起丢）。清单式的失效方式不是报错，是少跑。
 */
import process from 'node:process'
import { testFiles } from './discover.ts'

const dir = import.meta.dirname
const files = testFiles(dir)

// 扫出来空表 / 只剩几条，一律当失败：否则"过滤器写错"会表现成套件全绿而实际什么都没跑。
if (files.length < 60) {
  console.error(`只发现 ${files.length} 份 *.test.ts（磁盘上应当远多于此）—— 扫描规则坏了，拒绝当成通过`)
  process.exit(1)
}

console.log(`Running ${files.length} frontend test files (web/test/**, sorted by path)\n`)

for (const name of files) {
  await import(`./${name}`)
}
