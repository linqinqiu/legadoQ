// 本地书目录规则的端到端门禁（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
//
// 判的不是"接口在不在"，而是**换规则到底改变了什么**，所以造了一本带陷阱的合成书：
// 正文里有一行「第一节课程结束后…」——服务端原来那条内置规则里有 `第X节`，
// 会把它当成一章（九章）；上游规则用 `节(?!课)` 这种负向排除把它挡掉（八章）。
// 于是"规则库比内置强"这件事变成一个可数的数字差，而不是一句形容词。
//
// 跑完自己把探针书从书架删掉（含服务端那份原始文件），不给用户留垃圾。
// 跑法：node tools/verify/toc-rule-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { OUT, BASE, ROOT } from './env.mjs'
import { makeZip } from './zip-make.mjs'

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

/** 前言 + 八章（每章约 1200 字，超过打分口径里的 1000 字间隔线）+ 一行「第一节课程」陷阱。 */
function syntheticBook() {
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八']
  const parts = ['这是开篇散稿，没有章节标记，用来看前言会不会被吞掉。\n']
  for (let index = 0; index < 8; index += 1) {
    parts.push(`第${chinese[index]}章 第${index + 1}回标题\n`)
    if (index === 2) parts.push('第一节课程结束后，先生把讲义收进袖子里。\n')
    for (let line = 0; line < 26; line += 1) parts.push(`这是第${index + 1}章的正文内容，讲一些情节推进与人物对话，够长才不算噪声。\n`)
  }
  parts.push('全书完\n')
  return parts.join('')
}

const api = async (pathname, options = {}) => {
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, body }
}

const upload = async (bookName, text, ruleKey) => {
  const form = new FormData()
  form.append('file', new Blob([text], { type: 'text/plain; charset=utf-8' }), bookName)
  const query = ruleKey && ruleKey !== 'auto' ? `?tocRule=${encodeURIComponent(ruleKey)}` : ''
  const response = await fetch(`${BASE}/api/bookshelf/import-local${query}`, { method: 'POST', body: form })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

let probeBookUrl = ''
try {
  // ─────────────────────── ① 规则清单 ───────────────────────
  const rules = await api('/api/books/toc-rules')
  const options = rules.body?.options ?? []
  check('①规则接口回的是 auto + builtin + 启用且编译得出来的规则',
    rules.status === 200 && options.length >= 10,
    `${options.length} 项 · ${options.slice(0, 4).map(item => item.key).join(',')}`)
  check('①清单里每条都有能读的名字（不把裸 id 甩给用户）',
    options.every(item => item.label && item.label.length > 1 && !/^[-0-9]+$/.test(item.label)),
    options.slice(0, 3).map(item => `${item.key}=${item.label}`).join(' | '))

  const upstream = options.find(item => item.key === '-1' || item.key === '-2')
  check('①上游那几条确实在清单里（不是只有 auto/builtin 两个摆设）', !!upstream, upstream ? `${upstream.key}=${upstream.label}` : '(没找到)')

  // ─────────────────────── ② 自动打分 vs 内置 ───────────────────────
  const bookText = syntheticBook()
  const imported = await upload(`目录规则探针-${STAMP}.txt`, bookText, 'auto')
  const first = imported.body?.results?.[0]
  probeBookUrl = first?.bookUrl ?? ''
  check('②合成书导入成功（自动选规则这一路走得通）', imported.status === 200 && first?.success && !!probeBookUrl,
    `HTTP ${imported.status} · ${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)

  const shelfAfterAuto = (await api('/api/bookshelf')).body?.find(item => item.bookUrl === probeBookUrl)
  const autoRule = shelfAfterAuto?.tocRule ?? ''
  check('②自动选出来的是上游某条规则，不是内置那条',
    /^[0-9-]+$/.test(autoRule) && autoRule !== 'builtin',
    `实际用的规则 = ${autoRule || '(空)'}（${options.find(item => item.key === autoRule)?.label ?? '未知'}）`)

  // 目录里「前言」也是一章，所以自动规则切出来是 前言 + 八章 = 9；
  // 内置那条含 `第X节`，会把「第一节课程…」也算成一章 → 10。这一章之差就是规则库的价值。
  const chaptersUnderAuto = (await api('/api/books/chapters', { method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl }) })).body
  const autoTitles = Array.isArray(chaptersUnderAuto) ? chaptersUnderAuto.map(chapter => chapter.title) : []
  check('②自动规则没把「第一节课程」当成一章（前言 + 八章 = 9 章，陷阱句被负向排除挡住）',
    autoTitles.length === 9 && autoTitles.every(title => !title.includes('课程')),
    `${autoTitles.length} 章：${autoTitles.slice(0, 3).join(' / ')}`)

  const toBuiltin = await api('/api/books/reparse-local', {
    method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl, ruleKey: 'builtin' }),
  })
  const builtinChapters = (await api('/api/books/chapters', { method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl }) })).body
  const builtinTitles = Array.isArray(builtinChapters) ? builtinChapters.map(chapter => chapter.title) : []
  check('②换到内置规则后目录真的变了：多切出一章，且多出来的正是那句「第一节课程」',
    toBuiltin.status === 200 && toBuiltin.body?.tocRuleUsed === 'builtin'
      && builtinTitles.length === autoTitles.length + 1
      && builtinTitles.some(title => title.includes('课程')),
    `内置 ${builtinTitles.length} 章 vs 自动 ${autoTitles.length} 章 · 回的是「${toBuiltin.body?.ruleLabel ?? ''}」`)
  check('②书架记录跟着改了（界面上"这本书现在用哪条"说的是实话）',
    ((await api('/api/bookshelf')).body?.find(item => item.bookUrl === probeBookUrl)?.tocRule ?? '') === 'builtin',
    `现在记的是 ${toBuiltin.body?.tocRuleUsed}`)

  // ─────────────────────── ③ 切不出章时必须拒绝而不是硬写 ───────────────────────
  // 挑一条"这本书注定切不出来"的：合成书全是中文章题，英文 Chapter/Section 那条一条都不命中。
  const picky = options.find(item => item.label.includes('Chapter'))
    ?? options.find(item => item.key !== 'auto' && item.key !== 'builtin')
  const refused = picky
    ? await api('/api/books/reparse-local', {
      method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl, ruleKey: picky.key }),
    })
    : { status: 0, body: null }
  const keptChapters = (await api('/api/books/chapters', { method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl }) })).body
  if (refused.status === 200) {
    // 这条规则真的切出了 ≥2 章 —— 那就不是"拒绝"路径，如实记一笔而不是硬判红
    note(`③「${picky.label}」在这本书上真切出了章节，没走到拒绝分支`, `${Array.isArray(keptChapters) ? keptChapters.length : 0} 章`)
  } else {
    check('③切不出第二个章节时拒绝写入并保留原目录（不把整本书变成一章）',
      refused.status >= 400 && refused.body?.code === 'rule_carved_nothing',
      `规则「${picky?.label}」· HTTP ${refused.status} · ${refused.body?.message ?? refused.body?.code ?? ''}`)
    check('③拒绝之后目录没被动坏（还是内置那次切出来的十章）',
      Array.isArray(keptChapters) && keptChapters.length === 10, `${Array.isArray(keptChapters) ? keptChapters.length : 0} 章`)
  }

  // ─────────────────────── ④ 非法输入不崩 ───────────────────────
  const bogus = await api('/api/books/reparse-local', {
    method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl, ruleKey: '999999' }),
  })
  check('④不存在的规则 id 不会把服务打崩（要么拒绝要么回落并说实话）',
    bogus.status >= 200 && bogus.status < 600, `HTTP ${bogus.status}`)
  const online = await api('/api/bookshelf').then(list => list.body?.find(item => item.sourceId !== 'loc_book'))
  if (online) {
    const wrongKind = await api('/api/books/reparse-local', {
      method: 'POST', body: JSON.stringify({ sourceId: online.sourceId, bookUrl: online.bookUrl, ruleKey: 'builtin' }),
    })
    check('④在线书没有目录规则可换，服务端要说清楚而不是假装成功',
      wrongKind.status >= 400 && wrongKind.body?.code === 'not_local_book', `HTTP ${wrongKind.status} · ${wrongKind.body?.code}`)
  } else {
    note('④在线书这一路（本机书架上暂时没有在线书）', '跳过')
  }
  // ─────────── 手机备份里那份 txtTocRule.json 要真的能套用 ───────────
  // 上游备份包带的是整张表（含手机上勾的启用/停用与自己加的规则）。
  // 之前我们只是"原样收下"，界面上看得见、用不上 —— 用户说的就是这件事。
  const packagedRules = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'app/src/main/resources/assets/txtTocRule.json'), 'utf8'))
  const target = packagedRules.find(rule => rule.enable && rule.rule && rule.name)
  const backupPayload = JSON.stringify([
    // 同一条规则、手机上取消勾选：服务端要按 rule 字面匹配（备份里的 id 与本机对不上号）
    { ...target, id: 9001, enable: false },
    // 用户在手机上自己加的一条：随包没有，应当作为新规则收下并能选
    { id: 9002, name: `门禁自造规则${STAMP}`, rule: '^第[0-9]+[章节].*$', replacement: '', example: null, serialNumber: 9002, enable: true },
    // 编不出来的正则：不许入库，但要报数
    { id: 9003, name: '门禁坏正则', rule: '([unclosed', replacement: '', example: null, serialNumber: 9003, enable: true },
  ])
  const keptFile = path.join(ROOT, 'data', 'backup_kept', 'txtTocRule.json')
  // 这一节会往**真数据目录**里写一份收下条目，所以先把用户原来那份记下来，收尾原样放回去
  const keptBefore = fs.existsSync(keptFile) ? fs.readFileSync(keptFile) : null
  const zip = makeZip([{ name: 'txtTocRule.json', data: Buffer.from(backupPayload, 'utf8') }])
  // 导入接口收的是 multipart 里的一个文件字段，直接把 zip 当请求体发进去是没用的
  const zipForm = new FormData()
  zipForm.append('file', new Blob([zip], { type: 'application/zip' }), `门禁备份包-${STAMP}.zip`)
  const zipImported = await fetch(`${BASE}/api/backup/import`, { method: 'POST', body: zipForm })
  check('⑤带 txtTocRule.json 的备份包能导入', zipImported.status < 400, `HTTP ${zipImported.status}`)
  const kept = (await api('/api/backup/kept')).body ?? []
  const keptEntry = kept.find(item => item.name.toLowerCase() === 'txttocrule.json')
  check('⑤收下条目里能看到这条，并且标成"可套用"（界面上的按钮按它出现）',
    !!keptEntry && keptEntry.appliable === true && keptEntry.items === 3,
    keptEntry ? `${keptEntry.items} 条 · appliable=${keptEntry.appliable}` : '没有这条')
  const applied = await api('/api/books/toc-rules/apply-backup', { method: 'POST' })
  const report = applied.body ?? {}
  check('⑤套用回报说得清：匹配 / 改动 / 新收 / 坏正则各几条',
    applied.status < 400 && report.matched === 1 && report.flipped === 1 && report.added === 1 && report.unusable === 1,
    JSON.stringify(report))
  const afterApply = (await api('/api/books/toc-rules')).body ?? {}
  const keysAfter = (afterApply.options ?? []).map(option => option.key)
  const optionsAfter = afterApply.options ?? []
  const targetOption = optionsAfter.find(option => option.key === String(target.id))
  // 这条以前判的是"取消勾选的那条从清单里消失"—— 那正是用户 2026-10-03 报的 bug 本身：
  // 26 条规则里有 12 条因为默认停用而在界面上根本选不到，而解析层一直支持它们。
  // 门禁把错误行为当成契约钉住了，所以它一直没被发现。现在的契约是两件事分开。
  check('⑤手机上取消勾选的那条：退出「自动」打分，但仍然手动选得到',
    afterApply.overridden === true && !!targetOption && targetOption.enable === false
      && optionsAfter.length >= (afterApply.total ?? 0) + 2,
    `overridden=${afterApply.overridden} · 「${target.name}」enable=${targetOption?.enable} · 清单 ${optionsAfter.length} 条 / 全表 ${afterApply.total} 条`)
  check('⑤每条规则都带回正则原文（不写出来没人判断得了它适不适合这本书）',
    optionsAfter.filter(option => option.key !== 'auto' && !option.builtIn).every(option => (option.rule ?? '').length > 0 || option.broken === true),
    `带原文 ${optionsAfter.filter(option => (option.rule ?? '').length > 0).length} / ${optionsAfter.length}`)
  const toggled = await api('/api/books/toc-rules/toggle', { method: 'POST', body: JSON.stringify({ key: String(target.id), enable: true }) })
  const afterToggle = (await api('/api/books/toc-rules')).body ?? {}
  check('⑤界面上的开关能把这条放回「自动」候选（POST /books/toc-rules/toggle）',
    toggled.status === 200 && toggled.body?.enable === true
      && (afterToggle.options ?? []).find(option => option.key === String(target.id))?.enable === true
      && afterToggle.enabled === (afterApply.enabled ?? 0) + 1,
    `${toggled.status} · 参与自动 ${afterApply.enabled} → ${afterToggle.enabled}`)
  const customKey = (afterApply.options ?? []).find(option => option.label === `门禁自造规则${STAMP}`)?.key ?? ''
  check('⑤备份里自带的自定义规则被收下并且能选', !!customKey && afterApply.fromBackup === 1,
    `key=${customKey} · fromBackup=${afterApply.fromBackup}`)
  const reapplied = await api('/api/books/toc-rules/apply-backup', { method: 'POST' })
  const afterReapply = (await api('/api/books/toc-rules')).body ?? {}
  check('⑥重复套用不会把同一条规则收两遍（按规则字面匹配，不看 id）',
    reapplied.status < 400 && afterReapply.fromBackup === 1 && afterReapply.total === afterApply.total,
    `第二次套用 ${JSON.stringify(reapplied.body)} · fromBackup=${afterReapply.fromBackup} · 共 ${afterReapply.total} 条`)
  const restored = await api('/api/books/toc-rules/reset', { method: 'POST' })
  const afterReset = (await api('/api/books/toc-rules')).body ?? {}
  const keysRestored = (afterReset.options ?? []).map(option => option.key)
  check('⑥「恢复随包那份」把规则表还原（用户的表不能被门禁留在改过的状态）',
    restored.status < 400 && afterReset.overridden === false
      && keysRestored.includes(String(target.id)) && !keysRestored.includes(customKey),
    `overridden=${afterReset.overridden} · 原规则回来了=${keysRestored.includes(String(target.id))} · 自造规则已清=${!keysRestored.includes(customKey)}`)
  // ─────────── ⑦ 新建 / 编辑 / 删除自建（用户 2026-10-03：「txt目录规则可新建可编辑」）───────────
  // 这一段跑在 ⑥ 的"恢复随包那份"之后，所以起点是干净的默认表；收尾再还原一次。
  const created = await api('/api/books/toc-rules/save', {
    method: 'POST',
    body: JSON.stringify({ name: `门禁自造-${STAMP}`, rule: '^\\s*第[0-9]+话', example: '第1话 起', enable: true }),
  })
  const newKey = String(created.body?.id ?? '')
  const withNew = (await api('/api/books/toc-rules')).body ?? {}
  const newOption = (withNew.options ?? []).find(option => option.key === newKey)
  check('⑦新建一条：id 落在自建段（不撞随包那 26 条）、马上出现在清单里、并且标成可删',
    created.status === 200 && Number(newKey) >= 10000 && !!newOption && newOption.removable === true
      && withNew.total === (afterReset.total ?? 0) + 1,
    `${created.status} id=${newKey} · 表里 ${withNew.total} 条`)

  const broken = await api('/api/books/toc-rules/save', {
    method: 'POST', body: JSON.stringify({ name: '门禁坏括号', rule: '^(\\d+' }),
  })
  const afterBroken = (await api('/api/books/toc-rules')).body ?? {}
  check('⑦编不出来的正则进不了表：400 + 说清原因，表大小不变（不是存进去再让解析层静默跳过）',
    broken.status === 400 && broken.body?.code === 'rule_uncompilable' && afterBroken.total === withNew.total,
    `${broken.status} ${JSON.stringify(broken.body)}`)

  const edited = await api('/api/books/toc-rules/save', {
    method: 'POST',
    body: JSON.stringify({ key: newKey, name: `门禁改过-${STAMP}`, rule: '^\\s*第[0-9]+话.*', enable: false }),
  })
  const afterEdit = (await api('/api/books/toc-rules')).body ?? {}
  const editedOption = (afterEdit.options ?? []).find(option => option.key === newKey)
  check('⑦改一条：只多这一条改动，取消勾选后它退出「自动」但仍手动选得到',
    edited.status === 200 && editedOption?.label === `门禁改过-${STAMP}` && editedOption.enable === false
      && afterEdit.total === withNew.total && afterEdit.enabled < withNew.enabled + 1,
    `名字="${editedOption?.label}" enable=${editedOption?.enable} · 共 ${afterEdit.total} 条`)

  const packagedTarget = (afterEdit.options ?? []).find(option => option.builtIn !== true && option.key !== 'auto' && Number(option.key) < 10000)
  const deletePackaged = await api('/api/books/toc-rules/delete', {
    method: 'POST', body: JSON.stringify({ key: packagedTarget.key, enable: true }),
  })
  check('⑦随包那条删不掉：回一句"可以取消勾选"，而不是静默成功',
    deletePackaged.status === 400 && deletePackaged.body?.code === 'packaged_rule'
      && (await api('/api/books/toc-rules')).body?.total === afterEdit.total,
    `${deletePackaged.status} ${JSON.stringify(deletePackaged.body)}`)

  const deleted = await api('/api/books/toc-rules/delete', { method: 'POST', body: JSON.stringify({ key: newKey, enable: true }) })
  const afterDelete = (await api('/api/books/toc-rules')).body ?? {}
  check('⑦自建的这条删得掉，表回到删之前的条数',
    deleted.status === 200 && deleted.body?.removed === true && afterDelete.total === afterEdit.total - 1
      && !(afterDelete.options ?? []).some(option => option.key === newKey),
    `${JSON.stringify(deleted.body)}`)

  const editedPackaged = await api('/api/books/toc-rules/save', {
    method: 'POST',
    body: JSON.stringify({ key: packagedTarget.key, name: `门禁临时改名-${STAMP}`, rule: packagedTarget.rule, enable: packagedTarget.enable !== false }),
  })
  const afterPackagedEdit = (await api('/api/books/toc-rules')).body ?? {}
  const restoredAgain = await api('/api/books/toc-rules/reset', { method: 'POST' })
  const finalList = (await api('/api/books/toc-rules')).body ?? {}
  check('⑦随包那条也能改（改的是本机这份），「恢复随包那份」把名字与整张表一起还原',
    editedPackaged.status === 200
      && (afterPackagedEdit.options ?? []).some(option => option.key === packagedTarget.key && option.label.startsWith('门禁临时改名'))
      && restoredAgain.status === 200 && finalList.overridden === false
      && (finalList.options ?? []).some(option => option.key === packagedTarget.key && option.label === packagedTarget.label),
    `改过=${(afterPackagedEdit.options ?? []).find(o => o.key === packagedTarget.key)?.label} · 还原后="${(finalList.options ?? []).find(o => o.key === packagedTarget.key)?.label}"`)

  // ─────────── ⑧ 标题带前导空白时，正文里不许混进标题的字 ───────────
  // 上游把 `matcher.group()` **原样**当标题，并按**原样长度**把标题从正文里切掉
  // （TextFile.kt:212 / :278 / :305）。我们显示的是 trim 过的标题 —— 那没问题，
  // 但正文起点也必须按命中的**原始末尾**算：差几个前导空白字符，就有几个字从标题漏进正文。
  // 随包那条 `-2 目录` 明写允许 `^[ \t　]{0,4}`，所以这不是刁钻输入，是默认规则的正常路径
  // （2026-10-04 实测：三章正文开头各多出一个「甲/乙/丙」）。
  const bodyLine = '这一段正文应当一个字都不少地落在自己那一章里。'
  const indentedText = ['　　第一章 甲', bodyLine.repeat(4), '　　第二章 乙', bodyLine.repeat(4),
    '　　第三章 丙', bodyLine.repeat(4)].join('\n')
  const indentedForm = new FormData()
  indentedForm.append('file', new Blob([indentedText], { type: 'text/plain; charset=utf-8' }), `标题前导空白-${STAMP}.txt`)
  const indentedUpload = await fetch(`${BASE}/api/bookshelf/import-local?tocRule=-2`, { method: 'POST', body: indentedForm })
  const indentedBook = (await indentedUpload.json())?.results?.[0] ?? {}
  const indentedUrl = indentedBook.bookUrl ?? ''
  try {
    const indentedChapters = (await api('/api/books/chapters', {
      method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', bookUrl: indentedUrl }),
    })).body ?? []
    const residue = []
    for (const chapter of indentedChapters) {
      const content = (await api('/api/books/content', {
        method: 'POST', body: JSON.stringify({ sourceId: 'loc_book', chapterUrl: chapter.url, bookUrl: indentedUrl }),
      })).body?.content ?? ''
      const lastChar = (chapter.title ?? '').slice(-1)
      if (lastChar && content.startsWith(lastChar)) residue.push(`「${chapter.title}」开头混进「${content.slice(0, 3)}」`)
      if (content && !content.startsWith('这一段正文')) residue.push(`「${chapter.title}」开头不是正文首字：${content.slice(0, 6)}`)
    }
    check('⑧标题带前导全角空格时，切出来的章数与标题都对（trim 只作用在显示上）',
      indentedChapters.length === 3 && indentedChapters.every(chapter => /^第[一二三]章 /.test(chapter.title ?? '')),
      `${indentedChapters.length} 章：${indentedChapters.map(chapter => chapter.title).join(' / ')}`)
    check('⑧正文一个字都不许从标题里漏过来（偏移按命中的原始末尾算，不是 trim 后的长度）',
      residue.length === 0, residue.join(' ｜ ') || '三章开头都是正文首字')
  } finally {
    if (indentedUrl) {
      await api(`/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(indentedUrl)}`, { method: 'DELETE' })
    }
  }

  if (keptBefore) fs.writeFileSync(keptFile, keptBefore)
  else fs.rmSync(keptFile, { force: true })
  check('收尾把 data/backup_kept 恢复原样（探针不在用户数据目录里留文件）',
    keptBefore ? fs.existsSync(keptFile) && fs.readFileSync(keptFile).equals(keptBefore) : !fs.existsSync(keptFile),
    keptBefore ? `放回 ${keptBefore.length} 字节` : '删掉探针那份（用户原本没有这条）')
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (probeBookUrl) {
    // DELETE /api/bookshelf 认的是查询参数（不是请求体），写错就删不掉、库里留一本探针书
    const removed = await api(`/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const left = (await api('/api/bookshelf')).body?.some(item => item.bookUrl === probeBookUrl)
    check('收尾删掉探针书（原始文件也一起清）', removed.status < 400 && !left, `HTTP ${removed.status} · 还在=${left}`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => row.ok === false)
  const skipped = results.filter(row => row.ok === null)
  fs.writeFileSync(path.join(OUT, `toc-rule-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) {
    const flag = row.ok === true ? 'PASS' : row.ok === false ? 'FAIL' : 'NOTE'
    console.log(`${flag}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  }
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} PASS`
    + `${skipped.length ? ` · ${skipped.length} NOTE` : ''}${failed.length ? ` · ${failed.length} FAIL` : ''}`
    + ` · 详情 tools/verify/out/toc-rule-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
