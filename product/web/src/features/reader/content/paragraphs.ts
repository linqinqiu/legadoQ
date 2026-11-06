// 正文段落切分（0.8.2 结构重排从 ReaderScreen.tsx 逐字拆出）。
/**
 * 正文按行切成段落。单独抽出来是因为"屏幕上显示的"与"正在朗读的"两件事在切章过渡期间
 * 不是一回事：前者可以继续挂着上一章，后者必须等新章到位，否则朗读会一路读进旧章剩下的段落。
 */
export function splitParagraphs(content: string): string[] {
  const rawLines = content.split('\n')
  const result: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    // 这里的 trim 会连源站自带的 U+3000 全角空格缩进一起剥掉，是故意的：
    // 首行缩进现在由 `--reader-text-indent` 统一控制，留着源站的空格会变成"缩进 + 缩进"，
    // 而且用户把缩进调到 0 时反而还有一截甩尾。
    const trimmed = rawLines[i].trim()
    if (trimmed) {
      result.push(trimmed)
    }
  }
  return result
}
