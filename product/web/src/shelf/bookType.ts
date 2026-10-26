/**
 * 书源 `bookSourceType` 的展示口径（Legado 定义）：
 * 0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频。
 *
 * 服务端把 `sourceType` 带进 `SearchResult` / `BookDetails` / `BookshelfItem`，
 * 界面据此加类型徽标、阅读器据此选渲染方式。
 */
export type BookTypeMeta = { label: string }

const META: Record<number, BookTypeMeta> = {
  1: { label: '音频' },
  2: { label: '漫画' },
  3: { label: '文件' },
  4: { label: '视频' },
}

/** 文本（0）与未知类型返回 null —— 不给普通文本挂徽标，避免列表全是噪声。 */
export function bookTypeMeta(type: number | null | undefined): BookTypeMeta | null {
  if (type == null || type === 0) return null
  return META[type] ?? null
}

/** 需要媒体播放器（而不是当正文排字）的类型：音频 / 视频 / 文件下载。 */
export function isMediaType(type: number | null | undefined): boolean {
  return type === 1 || type === 3 || type === 4
}

/**
 * 同一本书、多个书源的 `bookSourceType`：**全部一致**时返回该值，否则 null。
 * 搜索结果按书聚合，混着不同类型时挂一个"音频"会误导，宁可不挂。
 */
export function commonBookType(types: Array<number | null | undefined>): number | null {
  if (!types.length) return null
  const first = types[0] ?? 0
  return types.every(t => (t ?? 0) === first) ? first : null
}
