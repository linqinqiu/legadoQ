#!/usr/bin/env node
/**
 * 启用仓库自带的 git 钩子：`git config core.hooksPath .githooks`（用户 2026-10-24
 * 「当更新修改内容自动更新更新日志」的落点之一）。
 *
 * 为什么要一条命令而不是文档里写一句"自己拷到 .git/hooks/"：拷进去的副本会与仓库里那份
 * 静默分叉（本项目在"两处各存一份然后互相不一致"上栽过太多次：版本号、端点数、体检基线）。
 * `core.hooksPath` 是**本地配置、进不了版本库**，所以每个克隆都要跑一次 ——
 * 于是再配一条 `prepare`（npm install 后自动执行），新克隆的人不必知道这件事。
 *
 * 只在这确实是 git 工作区、且 .githooks/ 存在时才动手；任何一步不满足就安静退出码 0，
 * 不许把 `npm install` 弄失败（装依赖失败与钩子没启用是两件不相干的事）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HOOKS_DIR = path.join(ROOT, '.githooks')

const quiet = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

if (!fs.existsSync(HOOKS_DIR)) process.exit(0)
if (quiet(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0)

// 统一仓后 product 是仓库子目录：hooksPath 必须相对**仓库根**，否则 git 会去
// <repo>/.githooks 找（那里没有），钩子永远不跑 —— 这就是「每次都不能自动更新日志」的根因。
const repoRoot = quiet(['rev-parse', '--show-toplevel'])
const hooksPath = repoRoot ? path.relative(repoRoot, HOOKS_DIR).split(path.sep).join('/') : '.githooks'
const current = quiet(['config', '--local', '--get', 'core.hooksPath'])
if (current === hooksPath) {
  console.log(`[hooks] 已启用（core.hooksPath = ${hooksPath}）`)
  process.exit(0)
}

quiet(['config', '--local', 'core.hooksPath', hooksPath])
console.log(`[hooks] core.hooksPath → ${hooksPath}（提交后会自动补更新日志）`)

// 可执行位只做**检查并说一句话**，不去动它：
// 从前这里跑 `git update-index --chmod=+x`，后果是 `npm install` 顺手把一个文件 stage 进索引 ——
// 装依赖与"暂存区里多了东西"是两件不相干的事，而且用户下一步 `git commit` 会带上没打算提交的改动。
// （Windows 上没有可执行位这件事；Linux/macOS 的钩子从版本库检出时会带上记录的模式，
//  真丢了就让人显式 `chmod +x` 或提交时带上 100755，而不是由装依赖偷偷代劳。）
for (const name of fs.readdirSync(HOOKS_DIR)) {
  const file = path.join(HOOKS_DIR, name)
  if (!fs.statSync(file).isFile()) continue
  const mode = fs.statSync(file).mode
  if (process.platform !== 'win32' && (mode & 0o111) === 0) {
    console.warn(`[hooks] .githooks/${name} 没有可执行位，钩子不会跑：chmod +x .githooks/${name}`)
  }
}
