#!/usr/bin/env node
/**
 * 更新日志自动化（用户 2026-10-24：「当更新修改内容自动更新更新日志」）。
 *
 * 三条命令：
 *   node scripts/changelog.mjs              # 把没进日志的 feat/fix 提交写进 CHANGELOG
 *   node scripts/changelog.mjs --dry-run    # 只看会写什么，不动文件
 *   node scripts/changelog.mjs --check      # 有该记而没记的就退出码 1（门禁，CI 与 npm test 用）
 *
 * 水位线**不另存文件**，而是取"最后一次改动 CHANGELOG.md 的那个提交"：
 * 写日志这件事本身就是边界，再存一份 sha 只会多一处会漂移的状态（本项目栽过
 * "两处各存一份然后互相不一致"太多次：版本号、端点数、体检基线）。
 * 由此得到一条隐含规矩，`--check` 会把它说清楚：改完代码把日志一并提交，
 * 下一轮的边界就是那一笔。
 *
 * 只认约定式提交的 feat / fix / perf / revert；docs / test / chore / ci / build / style /
 * refactor 一律不进 —— 读者关心"这版对我有什么变化"，不关心仓库内部动作。
 * 单条提交想手动排除，标题或正文写 `[no-changelog]`；想换掉自动文案，
 * 正文加 trailer `Changelog: 一句人话`（或 `Changelog: none` 表示不进）。
 *
 * `--from <ref>` 覆盖边界（只读演练或从更早处补写用）：
 *   node scripts/changelog.mjs --from HEAD~8 --dry-run
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classify, mergeEntries, overLong, renderEntry, summarize, SECTION_ORDER } from './changelog-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)                       // legado/
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dryRun = args.includes('--dry-run') || asJson
const checkOnly = args.includes('--check')
// `--from <ref>` / `--from=<ref>`：覆盖默认边界，用于只读演练或从更早处补写。
const fromIndex = args.findIndex(a => a === '--from' || a.startsWith('--from='))
const fromRef = fromIndex < 0 ? ''
  : (args[fromIndex] === '--from' ? args[fromIndex + 1] : args[fromIndex].slice('--from='.length)) || ''
const known = new Set(['--dry-run', '--check', '--json', '--from'])
if (args.some((a, i) => a.startsWith('-') && !known.has(a) && !a.startsWith('--from='))
  || (fromIndex >= 0 && args[fromIndex] === '--from' && (i => i < 0 || known.has(args[i]))(fromIndex + 1))) {
  console.error('用法：node scripts/changelog.mjs [--dry-run | --check | --json] [--from <ref>]')
  process.exit(2)
}

const git = (gitArgs, { allowFail = false } = {}) => {
  try {
    return execFileSync('git', gitArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (allowFail) return ''
    const why = String(error.stderr ?? error.message).trim()
    throw new Error(`git ${gitArgs.join(' ')} 失败：${why || '退出码 ' + error.status}`)
  }
}

/** git 不在这个目录 / 仓库还没有提交时给个明确说法，别抛裸栈。 */
function requireRepo() {
  const inside = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }).trim()
  if (inside !== 'true') {
    console.error('[changelog] 这里不是 git 仓库，没法从提交派生日志。')
    process.exit(1)
  }
  const head = git(['rev-parse', '--verify', 'HEAD'], { allowFail: true }).trim()
  if (!head) {
    console.error('[changelog] 仓库还没有任何提交，无日志可派生。')
    process.exit(1)
  }
  return head
}

/**
 * 边界 = 最后一次改动 CHANGELOG.md 的提交（含未提交的工作区改动在内时，
 * 工作区那份日志就是"已经记过"的证据，见 alreadyRecorded 的文案比对）。
 * `--from <ref>` 显式覆盖它，用于演练或从更早处补写。
 */
function watermark() {
  if (fromRef) {
    const resolved = git(['rev-parse', '--verify', '--quiet', `${fromRef}^{commit}`], { allowFail: true }).trim()
    if (!resolved) throw new Error(`--from 指向的引用不存在：${fromRef}`)
    return resolved
  }
  const out = git(['log', '-n', '1', '--format=%H', '--', 'CHANGELOG.md'], { allowFail: true }).trim()
  return out || ''
}

/**
 * CHANGELOG.md 在工作区有没有未提交的改动。
 * 有的话说明"正在补日志"，门禁此刻不该拦 —— 拦了只会逼人先提交一次代码再提交一次日志。
 * 用 `git status --porcelain -- <path>`：它比 `diff --quiet` 好在读的是暂存 + 工作区两处，
 * 而且 `--` 后面是显式路径，不会把同名目录/通配也算进来。未跟踪的新文件不算改动，
 * 但 CHANGELOG.md 本来就在版本库里，不可能是未跟踪。
 */
function changelogDirty() {
  return git(['status', '--porcelain', '--', 'CHANGELOG.md'], { allowFail: true }).trim() !== ''
}

function commitsSince(since) {
  const range = since ? `${since}..HEAD` : 'HEAD'
  // 用 %x1f / %x1e 做字段与记录分隔：标题里出现制表符或换行的空间比 `,` 小得多，
  // 而 body 本来就是多行，必须靠显式记录分隔符才能切对。
  const raw = git(['log', range, '--reverse', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e'])
  return raw.split('\x1e').map(chunk => chunk.replace(/^\n+/, '')).filter(Boolean).map(chunk => {
    const [sha, header, ...rest] = chunk.split('\x1f')
    return { sha: (sha ?? '').trim(), header: (header ?? '').trim(), body: rest.join('\x1f') }
  }).filter(entry => entry.sha && entry.header)
}

/** 日志里已有的条目正文（含历史版本），用来判"这条是不是已经写过了"。 */
function existingEntryBodies(markdown) {
  const bodies = new Set()
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim())
    if (bullet) bodies.add(bullet[1].trim())
  }
  return bodies
}

/**
 * 幂等判据要宽松：脚本写的是「**subject（scope）**」，人手写的版本可能没有粗体、
 * 没带 scope、或多两个字。所以只比"归一化后的 subject 是否作为子串出现"。
 * 太严会让 `--check` 天天误报，太松又会漏 —— subject 是提交作者写的那句话，
 * 出现在任意条目里就算记过，这是人实际会做的事。
 */
function normalize(text) {
  return String(text).replace(/[*`_\s]/g, '').replace(/[（(）)：:，,。.]*/g, '').toLowerCase()
}

function alreadyRecorded(candidate, bodies) {
  const needle = normalize(candidate.scope ? `${candidate.text}（${candidate.scope}）` : candidate.text)
  if (needle.length < 4) return false           // 短到没有区分度，宁可重提让人删
  for (const body of bodies) if (normalize(body).includes(needle)) return true
  return false
}

const main = () => {
  requireRepo()
  if (!fs.existsSync(CHANGELOG)) {
    console.error(`[changelog] 找不到 ${CHANGELOG}`)
    process.exit(1)
  }
  const markdown = fs.readFileSync(CHANGELOG, 'utf8')
  const since = watermark()
  const all = commitsSince(since)
  const bodies = existingEntryBodies(markdown)

  const pending = []
  const ignored = []
  const dups = []
  for (const commit of all) {
    const verdict = classify(commit.header, commit.body)
    if (!verdict.include) { ignored.push({ ...commit, reason: verdict.reason }); continue }
    const candidate = { ...verdict, sha: commit.sha, header: commit.header }
    if (alreadyRecorded(candidate, bodies)) { dups.push(candidate); continue }
    pending.push(candidate)
  }
  const tooLong = pending.map(entry => ({ entry, warning: overLong(entry) })).filter(x => x.warning)

  if (checkOnly) {
    // 门禁用的判据与生成不同，这里**不做文案匹配**：人按本项目规矩会把提交标题改写成
    // 一句人话（「AI 悬浮球能拖到顺手的位置了」），subject 就不是日志条目的子串了，
    // 拿文本匹配当门禁会把这种正常写法误报成"漏记"。
    // 门禁只问一件事：**最后一笔动过 CHANGELOG 的提交之后，还有没有 feat/fix 提交**。
    // 有 → 说明代码往前走了、日志没跟着走。想带着日志一起提交的人：日志未提交也算数
    // （工作区有改动就说明你正在写它，`npm test` 不该为此拦住你）。
    const unlogged = all
      .map(commit => ({ commit, verdict: classify(commit.header, commit.body) }))
      .filter(x => x.verdict.include)
    if (unlogged.length === 0) {
      console.log(`[changelog] 没有待记录的改动（自查 ${all.length} 条提交，边界 ${since ? since.slice(0, 7) : '仓库起点'}）`)
      process.exit(0)
    }
    if (changelogDirty()) {
      console.log(`[changelog] 有 ${unlogged.length} 条用户可见改动在最后一笔日志提交之后，`
        + `但 CHANGELOG.md 已有未提交改动 —— 视为正在补写（提交时把日志一并带上即可）`)
      process.exit(0)
    }
    console.error(`[changelog] 有 ${unlogged.length} 条用户可见改动没进更新日志。跑一次：node scripts/changelog.mjs`)
    for (const { commit, verdict } of unlogged) {
      console.error(`  ${verdict.section}：${renderEntry(verdict)}   ← ${commit.sha.slice(0, 7)} ${commit.header}`)
    }
    console.error('  不想记录的提交：标题或正文写 [no-changelog]；要换文案就在正文写 Changelog: 一句人话')
    process.exit(1)
  }

  if (asJson) {
    console.log(JSON.stringify({
      since, scanned: all.length, pending: pending.map(p => ({ ...p, rendered: renderEntry(p) })),
      alreadyRecorded: dups.length, ignored: ignored.length,
    }, null, 2))
    process.exit(0)
  }

  if (pending.length === 0) {
    console.log(`[changelog] 没有待记录的改动（自查 ${all.length} 条提交；已记录 ${dups.length} 条，按类型跳过 ${ignored.length} 条）`)
    if (dryRun) console.log('[]')
    process.exit(0)
  }

  const { text, version, inserted, skippedAsDuplicate, eol } = mergeEntries(markdown, pending)
  const groups = summarize(inserted)
  console.log(`[changelog] 写入 ${version} 共 ${inserted.length} 条${dryRun ? '（--dry-run，未落盘）' : ''}：`)
  for (const g of groups) {
    console.log(`  ${g.section}（${g.entries.length}）`)
    for (const e of g.entries) console.log(`    ${renderEntry(e)}`)
  }
  if (skippedAsDuplicate.length) console.log(`  跳过 ${skippedAsDuplicate.length} 条：日志里已有同样的话`)
  if (ignored.length) console.log(`  按类型不记 ${ignored.length} 条（docs/test/chore/ci/build/style/refactor）`)
  for (const { entry, warning } of tooLong) {
    console.log(`  注意 ${entry.sha.slice(0, 7)}：条目 ${warning.length} 字，建议收成一句人话（上限约 120）`)
  }
  if (!dryRun) {
    fs.writeFileSync(CHANGELOG, text, { encoding: 'utf8' })
    // 行尾：mergeEntries 按原文件判的 eol，这里不再动 —— 仓库 .gitattributes 定的是 LF。
    if (eol === '\r\n') console.log('  提示：原文件是 CRLF 行尾，已按原样写回')
    console.log(`[changelog] 已更新 ${path.relative(process.cwd(), CHANGELOG) || CHANGELOG}，请把日志与代码一并提交（下一笔提交就是新的边界）`)
  }
  process.exit(0)
}

try {
  main()
} catch (error) {
  console.error(`[changelog] 失败：${error.message}`)
  console.error(`可用小节：${SECTION_ORDER.join('、')}`)
  process.exit(1)
}
