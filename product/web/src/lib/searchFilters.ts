import { SearchResult } from './api'

export type SortMode = 'smart' | 'sources' | 'exact' | 'name'

/**
 * 列表档右侧那一栏写什么：一条搜索结果可能来自好几个书源，
 * 取第一条真正写了简介的；没配 `ruleSearch.intro` 的源很常见（服务端不猜），
 * 就退成「最新：某章」。**两个都没有就返回空串，让那一栏整栏不渲染** ——
 * 在列表里给每本书挂一句"暂无简介"，是把数据的缺口变成界面的噪声。
 */
export function pickBlurb(group: SearchGroup): string {
  const intro = group.sources.map(source => source.intro?.trim()).find(Boolean)
  if (intro) return intro
  const latest = group.sources.map(source => source.lastChapter?.trim()).find(Boolean)
  return latest ? `最新：${latest}` : ''
}

/**
 * 书源简介常带 HTML 片段：`<br>` 是断行、其余标签是排版。
 *
 * 我们按纯文本渲染（`<p>{intro}</p>`），不处理就会把 `<br>` 当字面量显示出来 ——
 * 00小说网的简介规则正是往句末插 `<br>`（`##(^|[。！？……；]+…)##$1<br>`），
 * 于是简介里排着一串 `<br>`（用户 2026-10-09：「怎么这么显示，不大好」）。
 *
 * 这里只做两件事：`<br>` → 换行、去掉已知的排版标签；换行由 `.book-intro p` 的
 * `white-space: pre-line` 保留。**不剥任意 `<…>`** —— 简介里出现 `3<5` 这种写法时，
 * 按"尖括号"剥会把正常文字吃掉。
 */
export function formatIntro(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|span|b|i|u|strong|em|font|h[1-6]|li|ul|ol|blockquote)\b[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

export type SearchGroup = {
  key: string
  name: string
  author?: string
  sources: SearchResult[]
}

/**
 * 搜索页只有两个真有用的控件：按书名/作者筛一句话、换排序。
 * 以前的「最少几个书源 / 有简介 / 有封面」在 2026-09-29 被用户判掉 ——
 * 结果本来就不多时它们只会把列表越勾越空，勾完也看不出差别。
 */
export type SearchFilters = {
  query: string
  sortMode: SortMode
}

export const defaultSearchFilters: SearchFilters = {
  query: '',
  sortMode: 'smart',
}

export function cleanTitle(raw: string): string {
  if (!raw) return ''
  let cleaned = raw.trim()

  // 1. Remove leading category tags if there is remaining title, e.g. 【都市】重生之大玩家 -> 重生之大玩家
  cleaned = cleaned.replace(/^(\[[^\]]{1,10}\]|【[^】]{1,10}】|《[^》]{1,10}》|（[^）]{1,10}）|\([^)\s]{1,10}\)|「[^」]{1,10}」|『[^』]{1,10}』)(?=\S)/u, (match) => {
    const rest = cleaned.slice(match.length).trim()
    return rest.length >= 2 ? '' : match
  }).trim()

  // 2. Strip surrounding punctuation and brackets
  cleaned = cleaned.replace(/^[\s\p{P}\[\]【】《》""''“”‘’（）()「」『』〈〉]+/gu, '')
                   .replace(/[\s\p{P}\[\]【】《》""''“”‘’（）()「」『』〈〉]+$/gu, '')
                   .trim()

  return cleaned || raw.trim()
}

export function cleanAuthor(raw?: string): string | undefined {
  if (!raw) return undefined
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^[\s\p{P}\[\]【】《》""''“”‘’（）()「」『』〈〉]+/gu, '')
                   .replace(/[\s\p{P}\[\]【】《》""''“”‘’（）()「」『』〈〉]+$/gu, '')
                   .trim()
  if (!cleaned || cleaned === '未知' || cleaned === '未知作者' || cleaned === 'null' || cleaned === 'undefined') {
    return undefined
  }
  return cleaned
}

export function calculateRelevanceScore(group: SearchGroup, keyword: string): number {
  const q = cleanTitle(keyword).trim().toLowerCase()
  if (!q) {
    return (group.sources.length * 10) +
      (group.sources.some(s => Boolean(s.coverUrl)) ? 5 : 0) +
      (group.sources.some(s => Boolean(s.intro?.trim())) ? 5 : 0)
  }

  const title = cleanTitle(group.name).toLowerCase()
  const author = (cleanAuthor(group.author) || '').toLowerCase()

  let score = 0

  // 1. Title matching bonuses
  if (title === q) {
    score += 1200
  } else if (title.startsWith(q)) {
    score += 600
  } else if (title.includes(q)) {
    score += 300
  } else if (q.includes(title) && title.length >= 2) {
    score += 200
  } else {
    let matchedChars = 0
    for (const char of q) {
      if (title.includes(char)) matchedChars++
    }
    const ratio = matchedChars / Math.max(q.length, 1)
    if (ratio >= 0.5) {
      score += Math.round(ratio * 150)
    }
  }

  // 2. Author matching bonuses
  if (author) {
    if (author === q) {
      score += 500
    } else if (author.includes(q)) {
      score += 250
    } else if (q.includes(author) && author.length >= 2) {
      score += 200
    }
  }

  // 3. Multi-source popularity bonus
  const sourceCount = group.sources.length
  score += Math.min(sourceCount, 50) * 15
  if (sourceCount >= 3) score += 50
  if (sourceCount >= 5) score += 50

  // 4. Metadata richness bonus
  if (group.sources.some(s => Boolean(s.intro?.trim()))) score += 20
  if (group.sources.some(s => Boolean(s.coverUrl))) score += 20
  if (group.author && cleanAuthor(group.author)) score += 30

  // 5. Title length noise penalty for non-exact matches
  if (title !== q && title.length > q.length) {
    score -= Math.min(60, (title.length - q.length) * 2)
  }

  return score
}

export function sortSearchGroups(groups: SearchGroup[], sortMode: SortMode, keyword: string): SearchGroup[] {
  const result = [...groups]
  switch (sortMode) {
    case 'smart': {
      const scoreCache = new Map<string, number>()
      const getScore = (g: SearchGroup) => {
        let sc = scoreCache.get(g.key)
        if (sc === undefined) {
          sc = calculateRelevanceScore(g, keyword)
          scoreCache.set(g.key, sc)
        }
        return sc
      }
      return result.sort((a, b) => {
        const diff = getScore(b) - getScore(a)
        if (diff !== 0) return diff
        if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
    }
    case 'sources': {
      // 与 'smart' 档同一套缓存：comparator 里现算 relevance 的话，筛选框每敲一键就全量重排 × 2 次打分
      const scoreCache = new Map<string, number>()
      const getScore = (g: SearchGroup) => {
        let sc = scoreCache.get(g.key)
        if (sc === undefined) {
          sc = calculateRelevanceScore(g, keyword)
          scoreCache.set(g.key, sc)
        }
        return sc
      }
      return result.sort((a, b) => {
        if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
        return getScore(b) - getScore(a)
      })
    }
    case 'exact': {
      const q = cleanTitle(keyword).trim().toLowerCase()
      const getExactRank = (g: SearchGroup) => {
        const t = cleanTitle(g.name).toLowerCase()
        if (t === q) return 0
        if (t.startsWith(q)) return 1
        if (t.includes(q)) return 2 + Math.min(50, t.length - q.length)
        return 100 + Math.min(50, t.length - q.length)
      }
      return result.sort((a, b) => {
        const rankA = getExactRank(a)
        const rankB = getExactRank(b)
        if (rankA !== rankB) return rankA - rankB
        return b.sources.length - a.sources.length
      })
    }
    case 'name':
      return result.sort((a, b) => cleanTitle(a.name).localeCompare(cleanTitle(b.name), 'zh-Hans-CN'))
    default:
      return result
  }
}

export function filterSearchGroups(groups: SearchGroup[], filters: SearchFilters, keyword: string = ''): SearchGroup[] {
  const query = filters.query.trim().toLocaleLowerCase()
  const filtered = groups.filter(group => {
    const searchable = `${group.name} ${group.author ?? ''}`.toLocaleLowerCase()
    return !query || searchable.includes(query)
  })
  return sortSearchGroups(filtered, filters.sortMode, keyword)
}

export function isExactMatch(group: SearchGroup, keyword: string): boolean {
  const q = cleanTitle(keyword).trim().toLowerCase()
  if (!q) return false
  const t = cleanTitle(group.name).toLowerCase()
  return t === q
}

export function isPopularMatch(group: SearchGroup): boolean {
  return group.sources.length >= 3
}

/**
 * 流式搜索的判重键：同源 + 同地址才算同一条。
 * 跨书源的同一本书要都留着 —— 用户就是在这排结果里挑源，去掉会变成搜索结果少了一半源。
 */
export const streamDedupeKey = (item: { sourceId: string; bookUrl: string }): string =>
  `${item.sourceId}\u0000${item.bookUrl}`

/**
 * 把一条流式封包并进已有结果：只增不减，判重靠调用方长期持有的 seen 表。
 *
 * 为什么是传表进来而不是当场 new Set：原来每条封包都重建一次已知集合，成本是
 * O(已收条数 x 封包数)。服务端每完成一个源就发一条 results，整库搜索五千个源就是
 * 五千次重建，而这段正好发生在结果一边往屏上长的时候 —— 界面最卡的那一段。
 */
export function mergeStreamedResults(seen: Set<string>, additions: SearchResult[]): SearchResult[] {
  const fresh: SearchResult[] = []
  for (const item of additions) {
    const key = streamDedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(item)
  }
  return fresh
}

/** progress 封包的合并窗口：服务端每个源完成都发一条，直连 setState 会把一次搜索打成几千次重渲染。 */
export const PROGRESS_FLUSH_MS = 250

/** 只有 progress 可以攒到下一批再放；start/done/error 必须立刻落 state（它们各带终态语义，攒了就等于状态行说谎）。 */
export function progressCanCoalesce(type: string): boolean {
  return type === 'progress'
}
