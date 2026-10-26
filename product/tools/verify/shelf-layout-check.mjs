// 书架交付前自检（阶段 1 重写：密度档已删，只剩一档小封面 + 分组）。
//
// 断言的是"界面在说什么"而不是"代码写了什么"：
// ① 密度控件必须消失，且老用户 localStorage 里的 `grid:md` 还能读成网格（不许变成空布局）；
// ② 网格封面宽度落在小档区间、窄屏固定 3 列，桌面不许出现超大封面；
// ③ 分组：建组 → 给一本书归组 → 计数与筛选都对 → 删组后书回到未分组（书本身不许消失）；
// ④ 全程只用一条自建探针书，收尾按主键删掉并复查，绝不动用户书架里的真书。
//
// 跑法：node tools/verify/shelf-layout-check.mjs   （默认打部署中的 1234，共用 env.mjs 的 BASE）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const KEY = 'legado-shelf-layout-v2'
const LEGACY_KEY = 'legado-shelf-layout-v1'
const GROUP_NAME = `探针分组-${STAMP}`
const PROBE = {
  sourceId: 'https://shelf-probe.example/',
  bookUrl: `https://shelf-probe.example/book/${STAMP}`,
  name: `探针书 ${STAMP}`,
  tocUrl: `https://shelf-probe.example/book/${STAMP}/toc`,
}
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function openShelf(page, view, stored) {
  await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: 1 })
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(({ key, legacyKey, value }) => {
      localStorage.removeItem(key)
      localStorage.removeItem(legacyKey)
      if (value) localStorage.setItem(key, value)
    }, { key: KEY, legacyKey: LEGACY_KEY, value: stored })
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await page.waitForFunction(() => !!document.querySelector('.shelf-page'), { timeout: 20000 })
      await sleep(1500)
      return true
    } catch {
      if (attempt === 3) return false
      await sleep(2500)
    }
  }
  return false
}

async function measureGrid(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.shelf-grid.shelf-mode-grid')
    if (!grid) return null
    const card = grid.querySelector('.shelf-card')
    const cover = grid.querySelector('.shelf-card-cover')
    const styles = getComputedStyle(grid)
    return {
      cards: grid.querySelectorAll('.shelf-card').length,
      columns: styles.gridTemplateColumns.split(' ').filter(Boolean).length,
      coverWidth: Math.round(cover?.getBoundingClientRect().width ?? 0),
      coverHeight: Math.round(cover?.getBoundingClientRect().height ?? 0),
      densityControl: !!document.querySelector('.shelf-density'),
      modeButtons: [...document.querySelectorAll('.shelf-layout-picker button')].map(b => b.getAttribute('aria-label')),
      // 占位封面必须是"文字书封"：以前退化成两字书脊，用户一眼就说"书名作者哪里去了"
      fallbacks: [...grid.querySelectorAll('.shelf-card-cover .cover-fallback')].map(node => ({
        compact: node.classList.contains('cover-fallback-compact'),
        title: node.querySelector('.cover-fallback-title')?.textContent?.trim() ?? '',
        author: node.querySelector('.cover-fallback-author')?.textContent?.trim() ?? '',
      })),
    }
  })
}

async function api(page, method, url, body) {
  return page.evaluate(async ({ m, u, b }) => {
    const csrf = ''
    const res = await fetch(u, {
      method: m,
      headers: b === undefined ? { 'X-CSRF-Token': csrf } : { 'content-type': 'application/json', 'X-CSRF-Token': csrf },
      body: b === undefined ? undefined : JSON.stringify(b),
      credentials: 'same-origin',
    })
    return { status: res.status, text: await res.text() }
  }, { m: method, u: url, b: body })
}

let browser
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  // fetch 用的是相对地址，页面必须先落在站点上（about:blank 解析不出 /api/…）
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const errors = []
  page.on('pageerror', event => errors.push(event.message))

  const added = await api(page, 'POST', '/api/bookshelf', PROBE)
  check('探针书已上架（否则后面的断言都是空的）', [200, 201].includes(added.status), `${added.status} ${added.text.slice(0, 60)}`)

  // ① 密度档没了，老值还读得懂
  const legacy = await openShelf(page, VIEWS[0], 'grid:md')
  check('载入书架', legacy)
  const fromLegacy = await measureGrid(page)
  check('老用户存的 grid:md 仍读成网格（不是空布局）', fromLegacy?.cards > 0 && fromLegacy.densityControl === false,
    JSON.stringify(fromLegacy && { cards: fromLegacy.cards, densityControl: fromLegacy.densityControl }))
  const stored = await page.evaluate(key => localStorage.getItem(key), KEY)
  check('只读不写盘：没点过布局就不落新值', stored === 'grid:md', `localStorage=${stored}`)

  // ② 尺寸：桌面一档小封面，窄屏 3 列
  const desktop = fromLegacy
  check('桌面封面宽度落在小档（120–200px）', desktop.coverWidth >= 120 && desktop.coverWidth <= 200, `${desktop.coverWidth}px`)
  check('桌面列数随宽度自动排布（≥5 列）', desktop.columns >= 5, `${desktop.columns} 列`)
  check('布局选择器只剩三个视图档、都带可访问名字',
    desktop.modeButtons.length === 3 && desktop.modeButtons.every(name => !!name), desktop.modeButtons.join(' / '))

  // 占位封面 = 文字书封（用户 2026-09-29：「默认封面你做差了，书名作者哪里去了？」）
  const probeCard = (desktop.fallbacks ?? []).find(item => item.title.startsWith('探针书'))
  check('没有封面的卡走占位封面', !!probeCard, `占位卡 ${(desktop.fallbacks ?? []).length} / ${desktop.cards}`)
  check('占位封面写完整书名而不是两字书脊', !!probeCard && probeCard.title.length > 4 && !probeCard.compact,
    probeCard ? `「${probeCard.title}」` : '没找到探针卡')
  check('占位封面带作者行（无作者也要写佚名）', !!probeCard && probeCard.author.length > 0, probeCard?.author ?? '')
  check('网格卡里不出现 compact 小封面样式',
    (desktop.fallbacks ?? []).every(item => !item.compact), `${(desktop.fallbacks ?? []).filter(i => i.compact).length} 个 compact`)
  const resumeCompact = await page.evaluate(() => {
    const node = document.querySelector('.shelf-resume-cover .cover-fallback')
    return node ? { compact: node.classList.contains('cover-fallback-compact'), text: node.textContent.trim() } : null
  })
  check('继续阅读那条 44px 小封面仍走两字（旁边就有书名作者）',
    !!resumeCompact && resumeCompact.compact && resumeCompact.text.length <= 2, JSON.stringify(resumeCompact))

  // 占位封面：用户 2026-10-03 明确要回 10-01 那一版（浅绿斜纹 + 左侧书脊），
  // 并且**封面下沿不再画阅读进度条**。所以这里判的是两件事：色纹在不在、进度条有没有长回来。
  const coverPaint = await page.evaluate(() => {
    // 计算样式里的颜色是 `rgb(234, 244, 238)` 这种，永远不等于样式表里写的 `#eaf4ee`。
    // 所以先把每个令牌**落到一个探针元素上量出它的计算值**再拿去比对 ——
    // 直接比十六进制会得到一个恒假的判据（上一版"不许掺强调色"就是这么一直绿着的）。
    const resolve = value => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.appendChild(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      return rgb
    }
    const root = getComputedStyle(document.documentElement)
    const tints = [...new Set(['--accent', '--accent-solid', '--accent-soft']
      .map(name => resolve(root.getPropertyValue(name).trim())).filter(Boolean))]
    const fallbacks = [...document.querySelectorAll('.shelf-grid.shelf-mode-grid .cover-fallback')]
    const painted = fallbacks.map(node => {
      const cs = getComputedStyle(node)
      const raw = `${cs.backgroundImage} ${cs.backgroundColor} ${cs.boxShadow}`
      return { raw, tinted: tints.some(color => raw.includes(color)) }
    })
    const tracks = [...document.querySelectorAll('.shelf-grid.shelf-mode-grid .shelf-card-read-track')]
      .map(track => {
        const fill = track.querySelector('.shelf-card-read-fill')
        return { px: fill ? +fill.getBoundingClientRect().width.toFixed(1) : 0 }
      })
    return {
      tints,
      tintedFallbacks: painted.filter(f => f.tinted).length, fallbackCount: fallbacks.length,
      sample: painted[0]?.raw.slice(0, 110) ?? '',
      // 紧凑小封面（≤46px，比如「继续阅读」那条）仍然不该带色纹：旁边就写着书名作者
      compactTinted: [...document.querySelectorAll('.cover-fallback-compact')].filter(node => {
        const raw = `${getComputedStyle(node).backgroundImage} ${getComputedStyle(node).backgroundColor}`
        return tints.some(color => raw.includes(color))
      }).length,
      tracks: tracks.length,
      nubs: tracks.filter(t => t.px > 0 && t.px < 8).length,
    }
  })
  check('占位封面用回那版带浅绿斜纹与书脊的（用户 2026-10-03 点名要回来）',
    coverPaint.fallbackCount > 0 && coverPaint.tintedFallbacks === coverPaint.fallbackCount,
    `${coverPaint.tintedFallbacks}/${coverPaint.fallbackCount} 张带强调色 · 比对的计算值 ${coverPaint.tints.join(' ')}`)
  check('小封面（≤46px 那种两字书脊）仍然不掺强调色', coverPaint.compactTinted === 0, `${coverPaint.compactTinted} 张染了`)
  check('网格卡上不画阅读进度条（用户：「不用在下面显示绿色的书籍阅读进度条」）',
    coverPaint.tracks === 0 && coverPaint.nubs === 0, `画了 ${coverPaint.tracks} 条（其中 ${coverPaint.nubs} 条是残块）`)

  const phone = await (async () => { await openShelf(page, VIEWS[1], null); return measureGrid(page) })()
  check('窄屏固定 3 列小封面（不是 1 列大封面）', phone.columns === 3, `${phone.columns} 列 / ${phone.coverWidth}px`)
  await page.setViewport({ width: VIEWS[0].width, height: VIEWS[0].height, deviceScaleFactor: 1 })

  // ③ 分组：建组 → 归组 → 计数与筛选 → 删组
  const created = await api(page, 'POST', '/api/bookshelf/groups', { name: GROUP_NAME })
  const group = JSON.parse(created.text || '{}')
  check('建组成功并带回 id', created.status === 200 && typeof group.id === 'number', `${created.status} ${created.text.slice(0, 60)}`)
  const again = await api(page, 'POST', '/api/bookshelf/groups', { name: `  ${GROUP_NAME}  ` })
  check('同名（含首尾空格）不堆第二个组', JSON.parse(again.text).id === group.id, again.text.slice(0, 60))
  const bad = await api(page, 'POST', '/api/bookshelf/groups', { name: '   ' })
  check('空组名被拒而不是建出一条幽灵组', bad.status === 400, `${bad.status} ${bad.text.slice(0, 60)}`)

  await openShelf(page, VIEWS[0], null)
  const pills = await page.$$eval('.shelf-group-bar button', nodes => nodes.map(n => n.textContent.trim()))
  check('分组条出现在书架上', pills.some(text => text.startsWith(GROUP_NAME)), pills.join(' | '))

  const assigned = await api(page, 'PUT', '/api/bookshelf/group', { ...PROBE, groupId: group.id })
  check('给探针书归组后书架记录带回 groupId', assigned.status === 200 && JSON.parse(assigned.text).groupId === group.id,
    `${assigned.status} ${assigned.text.slice(0, 70)}`)
  const ghost = await api(page, 'PUT', '/api/bookshelf/group', { ...PROBE, groupId: 987654 })
  check('归到不存在的组必须失败（不许把书挂到空气上）', ghost.status === 404, `${ghost.status} ${ghost.text.slice(0, 60)}`)

  await openShelf(page, VIEWS[0], null)
  await page.evaluate(name => {
    const pill = [...document.querySelectorAll('.shelf-group-bar button')].find(b => b.textContent.includes(name))
    pill?.click()
  }, GROUP_NAME)
  await sleep(900)
  const filtered = await page.$$eval('.shelf-grid .shelf-card .shelf-card-name', nodes => nodes.map(n => n.textContent.trim()))
  check('按分组筛选只剩这一本', filtered.length === 1 && filtered[0].startsWith('探针书'), filtered.join(' | '))
  await page.screenshot({ path: path.join(SHOTS, `shelf-group-${STAMP}.png`) })

  // 删组前先把整架的归属拍下来：这条断言要证的是"只有探针书被退回未分组，
  // 别人一本都不许动"，写成 `shelf.every(b => !b.groupId)` 等于假设用户没有真分组，
  // 用户一旦在界面上建组归书（本机就有一个真组），它必然假红。
  const beforeDelete = await api(page, 'GET', '/api/bookshelf')
  const snapshot = new Map((JSON.parse(beforeDelete.text || '[]')).map(item => [`${item.sourceId}::${item.bookUrl}`, item.groupId ?? 0]))
  const removed = await api(page, 'DELETE', `/api/bookshelf/groups/${group.id}`)
  const afterDelete = await api(page, 'GET', '/api/bookshelf')
  const shelf = JSON.parse(afterDelete.text)
  const after = new Map(shelf.map(item => [`${item.sourceId}::${item.bookUrl}`, item.groupId ?? 0]))
  const moved = [...snapshot].filter(([key, value]) => after.get(key) !== value && !key.includes(PROBE.bookUrl))
  const probeBack = after.get(`${PROBE.sourceId}::${PROBE.bookUrl}`)
  check('删组只把探针书退回未分组',
    removed.status === 204 && (probeBack === undefined || probeBack === 0),
    `DELETE=${removed.status} 探针书 groupId=${probeBack}`)
  check('删组不牵连别人的分组（逐本比对删组前后）',
    shelf.length === snapshot.size && moved.length === 0,
    `书架=${shelf.length}/${snapshot.size} 被改动的其他书=${moved.length ? moved.map(([key, value]) => `${value}→${after.get(key)}`).join(',') : '无'}`)
  const deleteZero = await api(page, 'DELETE', '/api/bookshelf/groups/0')
  check('「未分组」这一档删不掉（0 不是一条组记录）', deleteZero.status === 404, `${deleteZero.status}`)

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await openShelf(page, VIEWS[0], null)
  await page.screenshot({ path: path.join(SHOTS, `shelf-grid-${STAMP}.png`) })
} catch (error) {
  results.push({ name: '探针脚本自身异常', ok: false, detail: error.message })
} finally {
  if (browser) {
    const page = await browser.newPage().catch(() => null)
    if (page) {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
      await api(page, 'DELETE', `/api/bookshelf?sourceId=${encodeURIComponent(PROBE.sourceId)}&bookUrl=${encodeURIComponent(PROBE.bookUrl)}`).catch(() => null)
      const left = await api(page, 'GET', '/api/bookshelf')
      const stillThere = (JSON.parse(left.text || '[]')).some(b => b.bookUrl === PROBE.bookUrl)
      check('探针书已从用户书架删除并复查', !stillThere, `复查=${stillThere ? '还在' : '已清'}`)
      const groups = await api(page, 'GET', '/api/bookshelf/groups')
      const stray = (JSON.parse(groups.text || '[]')).filter(g => g.name.includes('探针分组'))
      check('探针分组已回收', stray.length === 0, stray.map(g => g.name).join(',') || '无')
    }
    await browser.close()
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `shelf-layout-${STAMP}.json`), JSON.stringify({ stamp: STAMP, results }, null, 2))
  const failed = results.filter(r => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}
