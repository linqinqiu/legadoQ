/**
 * 搜索关键词的切分（搜索结果里的片段高亮、正文里跳过去后的临时高亮共用）。
 *
 * 切成「命中 / 非命中」两种片段交给调用方画 `<mark>`，而不是让调用方自己算下标：
 * 大小写不敏感这种细节以后要加，也只会改这一处。
 */
export type TextChunk = { text: string; hit: boolean }

export function splitByTerm(text: string, term: string): TextChunk[] {
  const needle = term.trim()
  if (!needle) return [{ text, hit: false }]
  const chunks: TextChunk[] = []
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    if (at > from) chunks.push({ text: text.slice(from, at), hit: false })
    chunks.push({ text: needle, hit: true })
    from = at + needle.length
  }
  if (from < text.length) chunks.push({ text: text.slice(from), hit: false })
  return chunks.length ? chunks : [{ text, hit: false }]
}
