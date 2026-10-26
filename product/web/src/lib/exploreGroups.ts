import type { SourceSummary } from './api'

/** 「未分组」这一档的键，与「书源」页用的是同一个字面值。 */
export const UNGROUPED = '__none__'

/**
 * 发现页的分组统计。书源的 `group` 在 Legado 里是自由文本，可以带空白、可以缺失，
 * 所以"有没有分组"只能按 trim 之后判 —— 否则 `'  '` 会冒出一个看不见名字的分组。
 */
export function sourceGroups(sources: SourceSummary[]) {
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const item of sources) {
    const name = item.group?.trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    else ungrouped += 1
  }
  return { groups: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')), ungrouped }
}

export function filterByGroup(sources: SourceSummary[], group: string) {
  if (!group) return sources
  if (group === UNGROUPED) return sources.filter(item => !item.group?.trim())
  return sources.filter(item => item.group?.trim() === group)
}
