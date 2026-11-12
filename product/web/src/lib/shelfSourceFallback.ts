import type { BookshelfItem, SearchResult, SourceSummary } from './api'

/**
 * 「这本书的书源没了，界面该给哪个动作」——抽成纯函数，书架页与书籍详情共用一份口径。
 *
 * 用户原话（2026-11-12）：「当一本书的书源不存在时候，直接标出来书源不存在，却不是在拥有的
 * 书源寻找适配的书源」。所以这里的分工是：
 * 1. 先用**已有数据**判断，不做任何网络请求：书还在架、源已经不在书源表里（或已停用）；
 * 2. 书架条目里的 `alternateSources` 是搜索/换源时留下的候选：里面有指向**现存且启用**书源的
 *    就直接给「改用某书源继续读」，一键换源，不重新全网搜；
 * 3. 没有可用候选才退回「在已拥有的书源里找这本书」，交给现成的换源弹窗（SourceSwitchModal）
 *    —— 不新造一套搜索。
 *
 * 空书源表（启动还没拉到 / 用户一个源都没有）一律 `unknown`：**不能**因为表还没到就把整个
 * 书架标成「书源不存在」，那是误报。
 */

/** 本地书（TXT/EPUB 导入）不用书源，永远按可用处理。 */
export const LOCAL_BOOK_SOURCE_ID = 'loc_book'

export type ShelfFallbackReason = 'missing' | 'disabled'

export type ShelfSourceFallback =
  /** 书源在，且是启用状态 —— 什么都不用提示。 */
  | { kind: 'available' }
  /** 书源表还没到手（或本机根本没书源），现在下结论就是误报。 */
  | { kind: 'unknown' }
  /** 有指向现存启用书源的备选：一键改用。 */
  | { kind: 'switch-alternate'; reason: ShelfFallbackReason; candidate: SearchResult; sourceName: string }
  /** 没有可用备选：在已拥有的书源里找（复用换源弹窗）。 */
  | { kind: 'search-owned'; reason: ShelfFallbackReason }

export type ShelfFallbackTarget = Pick<BookshelfItem, 'sourceId' | 'bookUrl' | 'alternateSources'>

const isSelf = (candidate: SearchResult, item: ShelfFallbackTarget): boolean =>
  candidate.sourceId === item.sourceId && candidate.bookUrl === item.bookUrl

export function resolveShelfSourceFallback(
  item: ShelfFallbackTarget,
  sources: SourceSummary[],
): ShelfSourceFallback {
  if (item.sourceId === LOCAL_BOOK_SOURCE_ID) return { kind: 'available' }
  if (sources.length === 0) return { kind: 'unknown' }

  const byId = new Map(sources.map(source => [source.id, source]))
  const primary = byId.get(item.sourceId)
  if (primary?.enabled) return { kind: 'available' }
  const reason: ShelfFallbackReason = primary ? 'disabled' : 'missing'
  if (!primary && !item.sourceId) return { kind: 'unknown' }

  // 备选按书架里保存的顺序试：第一个「书源存在 + 启用 + 不是自己」的就是最小代价的换法。
  const candidate = (item.alternateSources ?? []).find(alt => {
    if (!alt.bookUrl?.trim()) return false
    if (isSelf(alt, item)) return false
    const source = byId.get(alt.sourceId)
    return !!source && source.enabled
  })

  return candidate
    ? { kind: 'switch-alternate', reason, candidate, sourceName: byId.get(candidate.sourceId)!.name }
    : { kind: 'search-owned', reason }
}

/** 书架卡片/详情上那句「为什么读不了」。available / unknown 不提示。 */
export function shelfFallbackTitle(fallback: ShelfSourceFallback): string | null {
  if (fallback.kind === 'switch-alternate' || fallback.kind === 'search-owned') {
    return fallback.reason === 'missing' ? '书源不存在' : '书源已停用'
  }
  return null
}

/** 一键动作的按钮文案；available / unknown 没有动作。 */
export function shelfFallbackActionLabel(fallback: ShelfSourceFallback): string | null {
  if (fallback.kind === 'switch-alternate') return `改用「${fallback.sourceName}」继续读`
  if (fallback.kind === 'search-owned') return '在已拥有的书源里找这本书'
  return null
}
/**
 * 正文读不出来时该给的动作（2026-11-12 用户：「书籍加载正文失败没有书源」）。
 *
 * 与 [resolveShelfSourceFallback] 的关键区别：**那个回答"这本书的书源还在不在"，
 * 这个回答"读不出来的时候往哪走"**。所以这里没有 available / unknown 两种结局 ——
 * 正文已经失败了，无论如何都要给出一个可点的出路，不能只说"重新加载"：
 * 源站临时抽风、这本书在这个源被下架、章节地址变了，都表现为同一条报错，
 * 而"换个源"是用户唯一能自己动手的那条路。
 *
 * `sources` 为空（启动竞态／本机一个源都没有）时只会落到 `search-owned`：
 * 换源弹窗会自己去拉书源表，所以这条出路在那种情况下仍然成立。
 */
export type ContentRecovery =
  /** 已有指向现存启用书源的备选：一键改用，不用重新全网搜。 */
  | { kind: 'switch-alternate'; candidate: SearchResult; sourceName: string }
  /** 没有可用备选：打开换源弹窗（它自己会列已拥有的书源与已知备选）。 */
  | { kind: 'search-owned' }

export function resolveContentRecovery(
  target: ShelfFallbackTarget,
  sources: SourceSummary[],
): ContentRecovery {
  const byId = new Map(sources.map(source => [source.id, source]))
  const candidate = (target.alternateSources ?? []).find(alt => {
    if (!alt.bookUrl?.trim()) return false
    if (isSelf(alt, target)) return false
    const source = byId.get(alt.sourceId)
    return !!source && source.enabled
  })
  return candidate
    ? { kind: 'switch-alternate', candidate, sourceName: byId.get(candidate.sourceId)!.name }
    : { kind: 'search-owned' }
}

/** 正文失败/长时间拉不回来时，那个出路按钮上的字。 */
export function contentRecoveryLabel(recovery: ContentRecovery): string {
  return recovery.kind === 'switch-alternate'
    ? `改用「${recovery.sourceName}」继续读`
    : '在已拥有的书源里找这本书'
}
