import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { exploreMeta } from '../src/features/explore/ExplorePage'/**
 * 390×844 窄屏收口（2026-11-06 实机截屏审查）。
 *
 * 这一轮盯的都是"看起来像坏了"的版面事实，不是审美偏好：
 *
 *  1. 顶栏六个入口在 390px 一屏放不下，横滑条被藏掉，最后那个「设置」只露出「设」。
 *  2. 书架卡片三列时一张只有 ~109px，`.shelf-card-meta` 里的徽章与章节被压成竖排
 *     （实测徽章 37×39、章节 34×32，两个字上下叠着）。
 *  3. 发现页卡片副标题把源站返回的占位符「•」原样拼进去，每张卡下面挂一行孤零零的圆点。
 *  4. 书架分组条横滑时「新建分组」用 sticky 钉在右端，直接压住最后一颗分组 chip 的计数
 *     （滑轨 clientW 354 / scrollW 539，按钮 294–372 盖在「本地 0」321–386 上）。
 *  5. 首启协议正文在手机上装不下（可视 471px / 内容 715px），底部那行被硬切一半。
 *
 * 判据只认**结构事实**：谁跟谁是兄弟、溢出时加不加类、有没有 nowrap —— 不锁具体文案。
 */
const here = import.meta.dirname
const read = (...parts: string[]) => fs.readFileSync(path.resolve(here, ...parts), 'utf8')
const cssRaw = read('../src/styles.css')
/** 注释里也有选择器字面量，先剥掉再找规则。 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
/**
 * 按选择器取声明块。不用 indexOf 是因为同一个选择器在文件里出现多次（`styles.css`
 * 本来就分层：基础一条、窄屏/网格再覆盖一条），而且 `.shelf-grid .shelf-card-meta`
 * 里也含有 `.shelf-card-meta` 这串字 —— 子串查找会取到错的那条。
 */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(match => ({ selectors: match[1].split(',').map(s => s.trim()), body: match[2] }))
/** 生效的是**最后**一条同选择器规则（层叠顺序），所以默认取最后。 */
const ruleBody = (selector: string) => {
  const hits = rules.filter(rule => rule.selectors.includes(selector))
  assert.ok(hits.length > 0, `styles.css 里找不到规则：${selector}`)
  return hits[hits.length - 1].body
}

test('发现卡片副标题：占位符「•」不进界面，真有的字段才拼', () => {
  // 00小说网实测 lastChapter 就是一个「•」，以前每张卡下面都挂一行孤零零的圆点
  assert.equal(exploreMeta('言情', undefined, '•'), '言情')
  assert.equal(exploreMeta(undefined, undefined, '•'), '')
  assert.equal(exploreMeta('', '  ', null), '')
  assert.equal(exploreMeta('玄幻', 120000, '第 12 章'), '玄幻 · 120000 · 第 12 章')
  assert.equal(exploreMeta('都市', undefined, '第 3 章'), '都市 · 第 3 章', '缺的那一项不留空档')
  assert.equal(exploreMeta('·'), '', '纯间隔号也是占位')
  assert.equal(exploreMeta('...'), '', '纯省略号也是占位')
  assert.equal(exploreMeta('第 1 章'), '第 1 章', '正常的章节名不能被当成标点吃掉')
})

test('顶栏：溢出时选中项滚进视野，并且只在真溢出时挂渐隐', () => {
  const tsx = read('../src/app/AppHeader.tsx')
  assert.match(tsx, /scrollIntoView\(\{\s*block: 'nearest',\s*inline: 'center'\s*\}\)/, '切页要把当前项滚进视野中心')
  assert.match(tsx, /classList\.toggle\('is-overflowing'/, '溢出类按 scrollWidth 实测加，不靠猜断点')
  assert.match(tsx, /scrollWidth - nav\.clientWidth > 1/, '差 1px 以内不算溢出（亚像素舍入）')
  const rule = ruleBody('.app-page-header nav.is-overflowing')
  assert.match(rule, /mask-image/, '溢出时要有一道右侧渐隐，否则被裁的字看不出是"还能滑"')
})

test('书架卡片副标题：窄屏换行，不许把两个字压成竖排', () => {
  const meta = ruleBody('.shelf-card-meta')
  assert.match(meta, /flex-wrap: wrap/, '装不下要换行')
  const kids = ruleBody('.shelf-card-meta > *')
  assert.match(kids, /white-space: nowrap/, '子项自身不许折行 —— 折了就是竖排')
})

test('书架分组条：横滑与「新建分组」分两层，按钮不再盖住分组计数', () => {
  const tsx = read('../src/features/bookshelf/ShelfPage.tsx')
  const bar = tsx.slice(tsx.indexOf('className="shelf-group-bar"'))
  const scrollAt = bar.indexOf('shelf-group-scroll')
  const newAt = bar.indexOf('shelf-group-new')
  assert.ok(scrollAt > 0, '分组 chip 要有自己的横滑容器')
  assert.ok(newAt > scrollAt, '「新建分组」必须排在横滑容器之后（兄弟，不是被它包住）')
  assert.equal(
    (bar.slice(0, newAt).match(/<\/div>/g) || []).length >= 1,
    true,
    '横滑容器在按钮之前就闭合 —— 否则按钮又跟着分组一起滑走了',
  )
  const rule = ruleBody('.shelf-group-bar')
  assert.doesNotMatch(rule, /overflow-x/, '外层不再负责滚动')
  const scroll = ruleBody('.shelf-group-scroll')
  assert.match(scroll, /overflow-x: auto/)
  assert.match(scroll, /min-width: 0/, 'flex 子项不给 min-width:0 就撑不回去，横滑会失效')
  assert.doesNotMatch(ruleBody('.shelf-group-bar .shelf-group-new'), /position: sticky/, 'sticky 正是盖住计数的那一下')
})

test('首启协议：还有下文时底边渐隐，滚到底摘掉', () => {
  const tsx = read('../src/components/FirstRunAgreement.tsx')
  assert.match(tsx, /scrollHeight - el\.scrollTop - el\.clientHeight > 2/, '按"还剩多少没读"判，不按断点判')
  assert.match(tsx, /'agreement-body is-more'/, '溢出时挂类')
  const rule = ruleBody('.agreement-body.is-more')
  assert.match(rule, /mask-image: linear-gradient\(to bottom/, '底边渐隐')
})
