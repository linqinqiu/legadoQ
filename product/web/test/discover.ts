import fs from 'node:fs'

/**
 * `run-all.ts` 用什么规则找判据文件 —— 单独一个纯函数，是为了让判据能反过来核它。
 *
 * 为什么要"扫"而不是手抄一份清单：这个仓库已经栽过三次同一条 ——
 * ① `HeaderMenu.test.ts` 在删 AppHeader 那次被顺手从清单里摘掉；② `LocalBookImport.test.ts`
 * 从来没被引过；③ 0.7.0 那条线 rebase 只取走文档提交，连代码带判据一起丢，套件照样全绿。
 * 手抄清单的失效方式不是报错，是"少跑了几份而没人知道"。
 *
 * 递归是必需的：`web/src` 在 C 档拆成了子目录，判据将来落到 `web/test/<组>/` 时，
 * 只扫一层的版本既看不见、也无法注册（AGENTS「非递归的扫描会静默变瞎」）。
 */
export function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.test.ts'))
    // Windows 的递归 readdir 给的是 `reader\Deep.test.ts`，而 import 说明符要 `/`；
    // 归一化放在这里（唯一出处），调用方与判据都按 `/` 谈。
    .map(name => name.replaceAll('\\', '/'))
    .sort()
}
