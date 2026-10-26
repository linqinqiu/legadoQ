import type { ExploreTab } from './api'

/**
 * 书源自带的分栏名大量带装饰字形：本机 5,574 个源里，静态 `exploreUrl` 的分栏名去重后有
 * 7,321 个，其中 1,550 个混着 emoji 与花饰（`💮 穿越文`、`~»最近更新«~`、`【完结】`、`🔸连载`）。
 * 直接画出来是一串方框 —— 全站界面本来就不出现装饰字形，这一页也不例外。
 *
 * **只改显示**：地址、请求、选中判定都按原样走，不动书源数据 —— 那是别人写的规则文本，
 * 我们没资格替它改。清洗后什么都不剩的（整条就是个 emoji）退回原文，宁可难看也不给一个空按钮。
 */
const KEEP = /[々\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9０-９Ａ-Ｚａ-ｚ\s（）()·、,，.。:：/+&-]/
const EDGE = /^[\s·、,，.。:：/+&-]+|[\s·、,，.。:：/+&-]+$/g

export function exploreLabel(title: string): string {
  const cleaned = [...title]
    .filter(char => KEEP.test(char))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(EDGE, '')
  return cleaned === '' ? title.trim() : cleaned
}

/**
 * 清洗 + 重名编号：聚合书源常挂 40+ 栏，而且每个分类都叫「推荐」「完结」，
 * 重名的补上序号，否则点了之后根本看不出当前选的是哪一个。
 */
export function labelExploreTabs(tabs: ExploreTab[]): (ExploreTab & { label: string })[] {
  const named = tabs.map(item => ({ ...item, label: exploreLabel(item.title) }))
  const totals = new Map<string, number>()
  for (const item of named) totals.set(item.label, (totals.get(item.label) ?? 0) + 1)
  const seen = new Map<string, number>()
  return named.map(item => {
    if ((totals.get(item.label) ?? 0) < 2) return item
    const nth = (seen.get(item.label) ?? 0) + 1
    seen.set(item.label, nth)
    return { ...item, label: `${item.label} ·${nth}` }
  })
}
