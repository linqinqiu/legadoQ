/**
 * 简繁转换。表在 `./dict/openccData.ts`（OpenCC 数据、自动生成），这里只放逻辑。
 *
 * 四个定死的决定：
 * 1. **字典动态载入** —— 表约 200 KB 而多数人不用这项，`loadScriptConverter()` 首次用到才拉 chunk。
 * 2. **词组优先、长的先试** —— 简繁不是一一对应（发→發/髮、里→裡/里），只查字表会出
 *    "头发→頭發"这类读得出来但错的转换。
 * 3. **简→繁最后过一遍台港字形表**（爲→為、裏→裡）—— OpenCC 的 s2t 给的是"通用繁体"，
 *    读者心里的繁体是台港排版那一路。
 * 4. 只过**字形**表，不过 TWPhrases 那种词汇本地化（软件→軟體）—— 换掉的是词，读起来像换了译者。
 */

export type ScriptMode = 'off' | 's2t' | 't2s'
export type ScriptConverter = (text: string) => string

/** 设置面板里的三档，顺序即显示顺序。 */
export const SCRIPT_MODE_OPTIONS: ReadonlyArray<{ id: ScriptMode; label: string }> = [
  { id: 'off', label: '原文' },
  { id: 's2t', label: '简 → 繁' },
  { id: 't2s', label: '繁 → 简' },
]

/** 关掉时用的那个 —— 调用方不必到处写 `mode === 'off' ? x : convert(x)`。 */
export const IDENTITY_CONVERTER: ScriptConverter = text => text

export function parseScriptMode(value: unknown): ScriptMode {
  return value === 's2t' || value === 't2s' ? value : 'off'
}

/** `openccData.ts` 的形状。写成类型是为了让单测能塞一份小表进来，不必去拉真表。 */
export type ScriptDict = {
  S2T_CHARS: string
  S2T_PHRASES: string
  S2T_TW_CHARS: string
  T2S_CHARS: string
  T2S_PHRASES: string
}

type CharMap = Map<string, string>
/** 首字 → 该字开头的词组，按长度**从长到短**排好（最长匹配）。 */
type PhraseMap = Map<string, ReadonlyArray<readonly [string, string]>>

/**
 * 紧凑串 `"甲 乙|丙 丁"` → 条目表。
 * 生成端保证每条恰好一个分隔空格、且值里没有空格；这里仍然按"第一个空格"切，
 * 免得哪天源数据里混进一个多空格的条目就把整条丢掉。
 */
function splitEntries(packed: string): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const entry of packed.split('|')) {
    const gap = entry.indexOf(' ')
    if (gap < 0) continue
    const key = entry.slice(0, gap)
    const value = entry.slice(gap + 1).split(' ')[0]
    if (key && value) entries.push([key, value])
  }
  return entries
}

function buildChars(packed: string): CharMap {
  const map: CharMap = new Map()
  for (const [key, value] of splitEntries(packed)) map.set(key, value)
  return map
}

function buildPhrases(packed: string): PhraseMap {
  const map = new Map<string, Array<readonly [string, string]>>()
  for (const [key, value] of splitEntries(packed)) {
    const first = key[0]
    const bucket = map.get(first)
    if (bucket) bucket.push([key, value])
    else map.set(first, [[key, value]])
  }
  for (const bucket of map.values()) bucket.sort((a, b) => b[0].length - a[0].length)
  return map
}

/**
 * 逐字查表。按**码点**走而不是按 UTF-16 码元：扩展 B 区那些字（𠗣、𡞵）在 JS 里
 * 是两个码元，按码元切会把一个字劈成两半，两半都查不到表、原样拼回去 —— 结果看着对，
 * 但只要表里真收了那个字就永远命中不了。
 */
function applyChars(text: string, chars: CharMap): string {
  if (!chars.size) return text
  let out = ''
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i) as number)
    out += chars.get(char) ?? char
    i += char.length
  }
  return out
}

/** 词组最长匹配 → 落空则逐字查表。 */
function convert(text: string, chars: CharMap, phrases: PhraseMap): string {
  if (!text) return text
  let out = ''
  for (let i = 0; i < text.length;) {
    const bucket = phrases.get(text[i])
    let matched = false
    if (bucket) {
      for (const [key, value] of bucket) {
        if (text.startsWith(key, i)) {
          out += value
          i += key.length
          matched = true
          break
        }
      }
    }
    if (matched) continue
    const char = String.fromCodePoint(text.codePointAt(i) as number)
    out += chars.get(char) ?? char
    i += char.length
  }
  return out
}

/** 用一份表造转换器（同步）。单测走这条，产品走下面的 `loadScriptConverter`。 */
export function createConverter(mode: ScriptMode, dict: ScriptDict): ScriptConverter {
  if (mode === 'off') return IDENTITY_CONVERTER
  if (mode === 's2t') {
    const chars = buildChars(dict.S2T_CHARS)
    const phrases = buildPhrases(dict.S2T_PHRASES)
    const tw = buildChars(dict.S2T_TW_CHARS)
    return text => applyChars(convert(text, chars, phrases), tw)
  }
  const chars = buildChars(dict.T2S_CHARS)
  const phrases = buildPhrases(dict.T2S_PHRASES)
  return text => convert(text, chars, phrases)
}

const cache = new Map<ScriptMode, ScriptConverter>()

/**
 * 拿一个转换器，需要时才去拉字典 chunk。造表有成本（一万多条要切词建桶），
 * 所以按 mode 缓存 —— 同一个会话里来回切设置不会重复建。
 */
export async function loadScriptConverter(mode: ScriptMode): Promise<ScriptConverter> {
  if (mode === 'off') return IDENTITY_CONVERTER
  const ready = cache.get(mode)
  if (ready) return ready
  const dict = await import('./dict/openccData')
  const converter = createConverter(mode, dict)
  cache.set(mode, converter)
  return converter
}
