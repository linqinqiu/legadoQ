/**
 * 更新日志自动化的纯逻辑（无 IO、无 git、无 Node 专属 API）—— 判据在
 * `web/test/ChangelogAuto.test.ts` 里直接喂数据测，不碰真仓库也不起浏览器。
 *
 * 用户 2026-10-24：「当更新修改内容自动更新更新日志」。
 *
 * "自动"能做到什么、做不到什么，这里先说死，免得留下一句做不到的承诺：
 * 日志的**事实来源是提交**，所以没有任何机制能在"代码改了但还没提交"时知道改了什么。
 * 能自动化的是这两件，它们合起来才等于"不会漏"：
 *   ① 派生 —— 把约定式提交（feat / fix / perf …）翻成用户可读的一条，插进当前版本条目的
 *      正确小节（顺序 新增→变更→修复→移除 是这一版刚立的规则，见 CHANGELOG 顶部）；
 *   ② 拦截 —— 有 feat/fix 提交却没进日志时，门禁直接红。
 * 只做 ① 会漏"人绕过去"，只做 ② 会逼人抄写；两条都要有。
 */

/** 小节固定顺序。加一档要同时改 CHANGELOG 顶部那条说明与 Changelog.test.ts 的判据。 */
export const SECTION_ORDER = ['新增', '变更', '修复', '移除']

/**
 * 提交类型 → 小节。
 *
 * 只列**用户能察觉**的类型：`test` / `chore` / `build` / `ci` / `style` / `docs` 一律不进 ——
 * 「加了 12 条判据」对读日志的人不是变化，混进来就会把"这版对我有什么变化"淹掉
 * （CHANGELOG 顶部那条"只写用户可见变化"的规矩）。
 * 反过来 `docs(CHANGELOG)` 这类本来就是在写日志，更不该再生成一条。
 */
const TYPE_TO_SECTION = {
  feat: '新增',
  fix: '修复',
  perf: '变更',
  revert: '修复',
}

/** 明确不进日志的类型（列出来是为了报错时能说出理由，而不是静默丢弃）。 */
export const SILENT_TYPES = new Set(['docs', 'test', 'chore', 'build', 'ci', 'style', 'refactor'])

/**
 * 这些 scope 下的 fix / perf / revert 仍是工程内部变化，对读者不是"修好了什么"。
 *
 * 起因：0.1.8 发版后补了两笔 `fix(verify)` / `fix(ci)`，门禁把 main 判红，要求把它们
 * 写进用户日志 —— 而日志的规矩是"只写用户能看见的变化"。类型表只挡住了 `ci:` 开头的
 * 提交，没挡住 `fix(ci):`，同一个判断得看 scope 才准。
 */
export const ENGINEERING_SCOPES = new Set(['ci', 'build', 'docs', 'test', 'verify', 'tooling', 'changelog'])

/** 一条日志建议的上限（超了说明提交标题在写工程细节，该人话重写）。 */
export const MAX_ENTRY_CHARS = 120

/**
 * 解析一条约定式提交标题。返回 null = 不是约定式的（`wip`、`Merge branch …`、随手写的一串）。
 * 形状照社区惯例：`type(scope)!?: subject`，`!` 表示破坏性变更。
 */
export function parseCommitHeader(header) {
  const text = String(header ?? '').trim()
  const m = /^(feat|fix|perf|revert|docs|test|chore|build|ci|style|refactor)(\(([^)]*)\))?(!)?:\s*(.+)$/i.exec(text)
  if (!m) return null
  return {
    type: m[1].toLowerCase(),
    scope: (m[3] ?? '').trim(),
    breaking: Boolean(m[4]),
    subject: m[5].trim(),
  }
}

/**
 * 这条提交该不该进日志、进哪一节、写成什么样。
 * 返回 null = 不进（并给出**为什么**，`--check` 与人看的清单都要用这句话）。
 *
 * 显式覆盖（比类型表优先，因为它是人的判断）：
 * - 标题或正文含 `[no-changelog]`、或 trailer `Changelog: none` → 不进；
 * - trailer `Changelog: 一句人话` → 用这句作为条目文案（scope 仍按括号带上）。
 */
export function classify(header, body = '') {
  const parsed = parseCommitHeader(header)
  const full = `${String(header ?? '')}\n${String(body ?? '')}`
  const explicit = /^\s*Changelog:\s*(.+)$/im.exec(body ?? '')

  if (/\[no-changelog\]/i.test(full) || /^\s*Changelog:\s*none\s*$/im.test(body ?? '')) {
    return { include: false, reason: '提交里显式标了 no-changelog' }
  }
  if (!parsed) {
    return { include: false, reason: '标题不是约定式的（type(scope)!: 一句话），无法判断该进哪一节' }
  }
  const section = TYPE_TO_SECTION[parsed.type]
  if (!section) {
    return { include: false, reason: `${parsed.type} 是工程内部变化，读者不关心` }
  }
  // 在改 CHANGELOG 本身的提交（docs(CHANGELOG)）不派生条目：它就是在写日志。
  if (parsed.type === 'docs' && /changelog/i.test(parsed.scope)) {
    return { include: false, reason: '这条改的就是更新日志本身' }
  }
  // fix(ci) / fix(verify) 这类：类型是 fix，但改的是流水线与判据，读者看不到。
  if (ENGINEERING_SCOPES.has(parsed.scope.toLowerCase())) {
    return { include: false, reason: `${parsed.scope} 是工程内部变化，读者不关心` }
  }
  const text = (explicit?.[1] ?? '').trim() || parsed.subject
  return {
    include: true,
    section,
    text,
    scope: parsed.scope,
    breaking: parsed.breaking,
    /** 有 `!` 却没写 BREAKING CHANGE 提示：档位可能要进，脚本不擅自改版本号，只说一声。 */
    needsVersionBump: parsed.breaking || /BREAKING CHANGE/i.test(body ?? ''),
  }
}

/** 渲染成 markdown 的一条：与手写条目同形（粗体一句话），不写 sha —— 日志不是 blame。 */
export function renderEntry({ text, scope = '' }) {
  const clean = String(text).replace(/\s*\r?\n\s*/g, ' ').trim()
  const body = scope ? `${clean}（${scope}）` : clean
  return `- **${body}**`
}

/**
 * 把提交列表按小节归并进 CHANGELOG 文本，返回新文本与实际插入的条目。
 *
 * 三条要紧的口径：
 * - **只写进当前版本那一条**（顶部第一个 `## [x.y.z]`）。历史条目不回头改：
 *   往已发布的版本里补条目等于伪造历史。
 * - **幂等靠调用方给的水位线**（脚本只在推进水位线时写文件），这里再叠一层
 *   "文案完全相同就不重复插"：人手写过一遍的，脚本不会再插一条一模一样的。
 * - 小节不存在时按 SECTION_ORDER 的位置插入，保证顺序仍是 新增→变更→修复→移除
 *   （这一版刚立的规矩，不能被自动生成第一个破坏掉）。
 */
export function mergeEntries(markdown, entries) {
  const text = String(markdown ?? '')
  const eol = /\r\n/.test(text.split('\n').slice(0, 30).join('\n')) ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  const headAt = lines.findIndex(line => /^## \[/.test(line))
  if (headAt < 0) throw new Error('CHANGELOG 里找不到 `## [版本号]` 条目，先开一条再录入')
  const version = /^## \[(.+?)\]/.exec(lines[headAt])?.[1]?.trim() ?? ''
  const nextHeadAt = (() => {
    for (let i = headAt + 1; i < lines.length; i += 1) if (/^## \[/.test(lines[i])) return i
    return lines.length
  })()

  // 当前版本条目内的小节：{ 小节名 → {start,end} }（行区间，不含下一个小节）
  const sections = []
  let current = null
  for (let i = headAt + 1; i < nextHeadAt; i += 1) {
    const m = /^### (.+)$/.exec(lines[i].trim())
    if (m) {
      if (current) current.end = i
      current = { title: m[1].trim(), start: i + 1, end: nextHeadAt }
      sections.push(current)
    }
  }
  if (current) current.end = nextHeadAt

  const existingItems = new Set()
  for (const s of sections) {
    for (let i = s.start; i < s.end; i += 1) {
      const bullet = /^[-*]\s+(.*)$/.exec(lines[i]?.trim() ?? '')
      if (bullet) existingItems.add(bullet[1].trim())
    }
  }

  const bySection = new Map()
  const inserted = []
  const skippedAsDuplicate = []
  for (const entry of entries) {
    const rendered = renderEntry(entry)
    const body = /^[-*]\s+(.*)$/.exec(rendered)?.[1] ?? rendered
    if (existingItems.has(body.trim())) {
      skippedAsDuplicate.push(entry)
      continue
    }
    if (!SECTION_ORDER.includes(entry.section)) {
      throw new Error(`未知小节「${entry.section}」；可用：${SECTION_ORDER.join('、')}`)
    }
    existingItems.add(body.trim())
    if (!bySection.has(entry.section)) bySection.set(entry.section, [])
    bySection.get(entry.section).push(rendered)
    inserted.push(entry)
  }

  if (inserted.length === 0) {
    return { text, version, inserted, skippedAsDuplicate, eol, changed: false }
  }

  // 从后往前插：前面的插入不动后面的行号。
  for (const section of [...SECTION_ORDER].reverse()) {
    const rows = bySection.get(section)
    if (!rows?.length) continue
    const found = sections.find(s => s.title === section)
    if (found) {
      // 追加到该小节末尾（跳过尾部空行，保持"条目之间不空行、小节之间空一行"的现状形状）
      let at = found.end
      while (at - 1 > found.start && lines[at - 1].trim() === '') at -= 1
      lines.splice(at, 0, ...rows)
      continue
    }
    const wantIndex = SECTION_ORDER.indexOf(section)
    const anchorIndex = sections.findIndex(s => SECTION_ORDER.indexOf(s.title) > wantIndex)
    let insertAt
    if (anchorIndex >= 0) {
      const anchor = sections[anchorIndex]
      insertAt = lines.findIndex((line, i) => i >= anchor.start - 1 && /^### /.test(line.trim()))
      if (insertAt < 0) insertAt = anchor.start - 1
    } else {
      insertAt = nextHeadAt
      while (lines[insertAt - 1]?.trim() === '' && insertAt > headAt + 1) insertAt -= 1
    }
    lines.splice(insertAt, 0, `### ${section}`, ...rows, '')
    sections.push({ title: section, start: insertAt + 1, end: insertAt + 1 + rows.length })
  }

  return { text: lines.join(eol), version, inserted, skippedAsDuplicate, eol, changed: true }
}

/** 供人看的分组清单（`--dry-run` 与门禁失败提示共用）。 */
export function summarize(entries) {
  const groups = new Map()
  for (const e of entries) {
    if (!groups.has(e.section)) groups.set(e.section, [])
    groups.get(e.section).push(e)
  }
  return SECTION_ORDER
    .filter(section => groups.has(section))
    .map(section => ({ section, entries: groups.get(section) }))
}

/** 条目文案过长时给出警告位（不阻断：标题谁都可能写长，静默截断才是问题）。 */
export function overLong(entry) {
  const rendered = renderEntry(entry)
  return rendered.length > MAX_ENTRY_CHARS ? rendered : null
}
