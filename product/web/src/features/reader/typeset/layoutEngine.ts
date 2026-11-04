/**
 * 无 DOM 文本布局引擎。
 *
 * 全部用纯数学估算字符宽度（charWidth），不测量、不排版 DOM，因此可在 Worker /
 * 主线程 / Node 测试里得到完全一致的分页结果。本文件只做算术，渲染归 ReaderScreen。
 *
 * 关键约定：
 *  - 「栏」与「页」在本引擎里是同一个东西：startOffsets 每一项对应一栏（一页）的首字符偏移。
 *  - 图片占位行是「整块」，不逐字符排版；图片非文本，故不推进字符偏移——分页的字符偏移
 *    只统计正文文字，图片段在原始 text 里的字符区间不会被任何一栏的 startOffsets 指向
 *    （详见 layout 里图片分支的注释）。
 */

import type { TypesetParams, LayoutResult } from './typesetParams'

// 图片占位行：形如 ![说明](url)，url 为 http(s):// 或 /api/ 开头
const IMAGE_RE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)$/

// 行首禁则：这些标点不应出现在一行开头（行尾禁则天然由「换行把字推到下一行首」满足）
const HEAD_FORBIDDEN = '，。、！？：；」』》）'

/** 半角可打印区间（空格到 ~），用于区分 ASCII 与 CJK */
const ASCII_RE = /[ -~]/
/** CJK 与全角字符区间（含中文、全角标点、全角空格、全角形式） */
const CJK_RE = /[一-鿿　-〿＀-￯]/

/**
 * 单字符宽度估算（纯数学，不测量）。
 *  - CJK / 全角：一个字宽 = fontSize
 *  - ASCII 字母数字常见半角符号：fontSize * 0.6
 *  - ASCII 空格：fontSize * 0.5
 *  - 其它（半角标点等）：fontSize * 0.5
 */
export function charWidth(ch: string, params: TypesetParams): number {
  if (ASCII_RE.test(ch)) {
    return ch === ' ' ? params.fontSize * 0.5 : params.fontSize * 0.6
  }
  if (CJK_RE.test(ch)) {
    return params.fontSize
  }
  return params.fontSize * 0.5
}

export function layout(text: string, params: TypesetParams): LayoutResult {
  // 整章空：固定返回一栏、零行，避免任何副作用
  if (text.length === 0) {
    return { startOffsets: [0], columnCount: 1, lineCount: 0 }
  }

  // 单栏可用宽度；双栏在中央留固定 40px 间隙，左右各一半
  const colWidth = params.columnMode === 'double'
    ? Math.floor((params.viewportWidth - 2 * params.marginX - 40) / 2)
    : (params.viewportWidth - 2 * params.marginX)

  const colHeight = params.viewportHeight - params.marginTop - params.marginBottom
  const lineH = params.lineHeight > 0 ? params.fontSize * params.lineHeight : params.fontSize
  // 图片只占一栏宽，所以占位高度按单栏宽折算（双栏时图片不会跨两栏）
  const imgH = colWidth * params.imagePlaceholderRatio

  // 每栏能放多少文本行：至少 1 行，防止视口极小除成 0
  const maxLines = Math.max(1, Math.floor(colHeight / lineH))
  // 图片占位折算成多少「行」：至少占 1 行
  const imgLines = Math.max(1, Math.round(imgH / lineH))
  // 段间距折算成额外行数
  const spacingLines = Math.max(0, Math.ceil(params.paragraphSpacing / lineH))

  const startOffsets: number[] = [0]   // 第一栏首字符偏移恒为 0
  let lineCount = 0

  let colLines = 0          // 当前栏已放的行数（文本行 / 图片行都算）
  let curLineWidth = 0      // 当前行已用宽度
  let curLineStart = 0      // 当前行首字符索引（仅文本行有意义）

  // 把 text 按 '\n' 切成段落，同时记下每段在 text 中的真实起止索引
  // （split 会丢掉分隔符，这里手动扫描以保留真实偏移）
  const paras: { start: number; end: number }[] = []
  let p = 0
  while (p < text.length) {
    let q = text.indexOf('\n', p)
    if (q === -1) q = text.length
    paras.push({ start: p, end: q })
    p = q + 1
  }

  for (const { start, end } of paras) {
    const para = text.slice(start, end)

    // —— 图片占位块：整块处理，不逐字符排版 ——
    if (IMAGE_RE.test(para)) {
      const needBreak = colLines + imgLines > maxLines
      if (needBreak && colLines > 0) {
        // 当前栏放不下：换到新栏。图片非文本，新栏首字符取「图片段之后」的真实偏移，
        // 这样没有一栏的 startOffset 会落在图片段的字符区间内。
        const idx = end
        if (idx > startOffsets[startOffsets.length - 1]) startOffsets.push(idx)
        colLines = 0
        curLineWidth = 0
      }
      // 放入图片：占 imgLines 行，但不推进字符偏移（字符偏移已停在 end）
      colLines += imgLines
      lineCount += imgLines
      continue
    }

    // —— 文本段：逐字符排版 ——
    for (let k = start; k < end; k++) {
      const ch = text[k]
      const w = charWidth(ch, params)

      if (curLineWidth + w > colWidth) {
        // 当前行放不下 ch，需要换行
        if (HEAD_FORBIDDEN.includes(ch) && (colWidth - curLineWidth) >= w) {
          // 行首禁则：上一行还有富余宽度，把禁则字留在上一行末尾，避免它成为行首
          curLineWidth += w
        } else {
          // 正常换行：提交本行，cursor 下移一行
          lineCount += 1
          colLines += 1
          if (colLines >= maxLines) {
            // 当前栏已放满 → 换栏（=新页），新栏首字符就是当前字符 k
            const idx = k
            if (idx > startOffsets[startOffsets.length - 1]) startOffsets.push(idx)
            colLines = 0
            curLineStart = k
            curLineWidth = w
          } else {
            curLineStart = k
            curLineWidth = w
          }
        }
      } else {
        curLineWidth += w
      }
    }

    // 段落结束：段间加段落间距（折算成额外行数），不推进字符偏移
    if (spacingLines > 0) {
      colLines += spacingLines
      lineCount += spacingLines
    }
  }

  // 收尾：当前行若还有未提交的字符，记为一行
  if (curLineWidth > 0) lineCount += 1

  // 清理：若有「尾部空栏」（startOffset 等于文本末尾，没有可排文字），剔除之，
  // 避免图片恰好在章末换行时留下一个没有正文的空页
  while (startOffsets.length > 1 && startOffsets[startOffsets.length - 1] >= text.length) {
    startOffsets.pop()
  }

  return {
    startOffsets,
    columnCount: startOffsets.length,
    lineCount,
  }
}
