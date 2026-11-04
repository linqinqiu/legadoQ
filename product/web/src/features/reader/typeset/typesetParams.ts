/**
 * 排版参数与分页结果的纯数据类型 + 轻量工具。
 *
 * 这一层刻意不碰任何 DOM / Canvas：字符宽度用纯数学估算（见 layoutEngine 的
 * charWidth），所以 layout 在 Worker、主线程、Node 测试里跑出来的结果完全一致。
 */

export type TypesetParams = {
  fontFamily: string
  fontSize: number           // px
  lineHeight: number         // 倍数，行高 = fontSize * lineHeight
  paragraphSpacing: number   // px，段间距
  marginX: number            // px，左右边距
  marginTop: number
  marginBottom: number
  viewportWidth: number      // px
  viewportHeight: number     // px
  columnMode: 'single' | 'double'
  imagePlaceholderRatio: number   // 图片占位高度 = 单栏宽 * ratio
}

export type LayoutResult = {
  /** 该章每一「栏(=页)」首字符在章节文本中的绝对字符偏移（单调递增，length===columnCount） */
  startOffsets: number[]
  /** = startOffsets.length */
  columnCount: number
  /** 该章总行数（含图片占位行） */
  lineCount: number
}

/**
 * FNV-1a 32 位哈希 → base36 字符串，用作缓存失效的「内容指纹」。
 * 只要求「内容变了指纹就变、且便宜」，不要求密码学强度。
 */
export function hashContent(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    // Math.imul 保证 32 位有符号乘法溢出行为正确
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 拼出唯一的分页缓存键。用 '|' 连接，顺序固定：
 * bookId|chapterUrl|contentHash|fontFamily|fontSize|lineHeight|marginX|
 * marginTop|marginBottom|viewportWidth|viewportHeight|columnMode|imagePlaceholderRatio
 * （不含 paragraphSpacing / imagePlaceholderRatio 之外的细节——这些不参与换页几何。）
 */
export function serializePaginationKey(
  bookId: string,
  chapterUrl: string,
  contentHash: string,
  params: TypesetParams,
): string {
  return [
    bookId,
    chapterUrl,
    contentHash,
    params.fontFamily,
    params.fontSize,
    params.lineHeight,
    params.marginX,
    params.marginTop,
    params.marginBottom,
    params.viewportWidth,
    params.viewportHeight,
    params.columnMode,
    params.imagePlaceholderRatio,
  ].join('|')
}
