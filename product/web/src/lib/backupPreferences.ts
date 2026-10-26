import type { ReaderSettings, ReaderFont } from '../reader/readerSettings'
import { defaultReaderSettings } from '../reader/readerSettings'
import { clampFontSize } from '../reader/fontSizeControl'

/**
 * 把备份包里"阅读样式 / 朗读引擎"两条映射到本机 `ReaderSettings`。
 *
 * 用户 2026-09-30：「备份包里的 TTS、字典、阅读样式、书签、书架分组以外的个性化条目，试着做一下」。
 * 这两条是唯一真的有本地归宿的（其余像书签/字典/阅读记录在本服务里没有消费界面，
 * 只能原样收在 `data/backup_kept/` 里，见服务端 BackupStore）。
 *
 * 映射刻意保守：
 * ① 上游 `lineSpacing` / `paragraphSpacing` 是 **dp 绝对值**，我们是**字号倍数**，
 *    所以换算后一律夹进各自的合法区间，并把换算式写进 `notes`，不假装两边同量纲；
 * ② 认不出来的字体名不改本机当前字体；
 * ③ 没映射上的字段名原样列出来 —— "套用了但悄悄丢了一半"比"只套一半但说清楚"更糟。
 */
export type PreferencePatch = { patch: Partial<ReaderSettings>; applied: string[]; notes: string[] }

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** 上游字体名 → 我们这五档。认不出返回 null，让调用方保留当前字体并说明原因。 */
function mapFont(raw: string | null): ReaderFont | null {
  if (!raw) return null
  const name = raw.toLowerCase()
  if (/kaiti|kai|楷体/.test(name)) return 'kai'
  if (/fangsong|仿宋/.test(name)) return 'fangsong'
  if (/yahei|pingfang|hei|黑体|sans/.test(name)) return 'hei'
  if (/song|serif|宋体/.test(name)) return 'song'
  if (/system|-apple-system|segoe/.test(name)) return 'system'
  return null
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 上游 `readConfig.json` 是一个 ReadStyle 数组，激活那条由 `config.xml` 的 readStyleIndex 指；
 *  我们拿不到那个索引，所以取 `isDefault`/`selected` 为真的一条，再退到第一条，并把这条写进 notes。 */
function pickActive(rows: Record<string, unknown>[]): { style: Record<string, unknown>; note: string } | null {
  if (!rows.length) return null
  const flagged = rows.find(row => row.isDefault === true || row.isDefault === 1 || row.selected === true)
  if (flagged) return { style: flagged, note: '用的是包里标记为默认的那条样式' }
  return { style: rows[0], note: '包里没标出默认样式，取了第一条' }
}

export function mapReadStyle(raw: string, current: ReaderSettings): PreferencePatch {
  const applied: string[] = []
  const notes: string[] = []
  const patch: Partial<ReaderSettings> = {}
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { return { patch, applied, notes: ['readConfig.json 不是合法 JSON，没套用'] } }
  const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : rows && typeof rows === 'object' ? [rows as Record<string, unknown>] : []
  const picked = pickActive(list)
  if (!picked) return { patch, applied, notes: ['readConfig.json 里没有可读的样式'] }
  const style = picked.style
  notes.push(picked.note)

  const fontSize = asNumber(style.fontSize)
  if (fontSize && fontSize >= 10 && fontSize <= 40) {
    patch.fontSize = clampFontSize(Math.round(fontSize))
    applied.push(`字号 ${patch.fontSize}`)
  }

  const family = mapFont(typeof style.fontFamily === 'string' ? style.fontFamily : null)
  if (family) {
    patch.font = family
    applied.push(`字体 ${family}`)
  } else if (style.fontFamily) {
    notes.push(`字体「${String(style.fontFamily)}」在这台服务上没有对应档，保留当前的「${current.font}」`)
  }

  const lineSpacing = asNumber(style.lineSpacing)
  // 换算分母要用**我们认下来的**字号：包里 fontSize 是 900 这种废值时，
  // 拿它当分母会把 900dp 的行距折算成 2.0 倍，看起来"合理"其实是巧合。
  const size = patch.fontSize ?? current.fontSize
  if (lineSpacing !== null && lineSpacing >= 0) {
    // 上游是"行与行之间额外留多少 dp"，我们是倍数：倍数 = 1 + 行距 / 字号
    patch.lineHeight = clamp(Number((1 + lineSpacing / size).toFixed(2)), 1.45, 2.4)
    applied.push(`行间距 ${patch.lineHeight}（包里 lineSpacing ${lineSpacing}dp 换算）`)
  }
  const paragraphSpacing = asNumber(style.paragraphSpacing)
  if (paragraphSpacing !== null && paragraphSpacing >= 0) {
    patch.paragraphSpacing = clamp(Number((paragraphSpacing / Math.max(1, size)).toFixed(2)), 0.7, 2)
    applied.push(`段间距 ${patch.paragraphSpacing}（包里 ${paragraphSpacing}dp 换算）`)
  }
  const charSpacing = asNumber(style.charSpacing)
  if (charSpacing !== null) {
    patch.letterSpacing = clamp(charSpacing, -0.25, 1.5)
    applied.push(`字间距 ${patch.letterSpacing}`)
  }
  const padding = asNumber(style.padding) ?? asNumber(style.margin)
  if (padding !== null && padding > 0) {
    patch.contentPadding = clamp(Math.round(padding), 20, 120)
    applied.push(`左右边距 ${patch.contentPadding}`)
  }
  const doubleColumn = asNumber(style.doubleColumn)
  if (doubleColumn !== null) {
    patch.columnMode = doubleColumn >= 2 ? 'double' : doubleColumn === 1 ? 'auto' : 'single'
    applied.push(`分栏 ${patch.columnMode}`)
  }
  const textIndent = asNumber(style.firstLineIndent ?? style.textIndent ?? style.indent)
  if (textIndent !== null) {
    patch.textIndent = clamp(Math.round(textIndent / Math.max(1, size)) || (textIndent > 0 ? 2 : 0), 0, 2)
    applied.push(`首行缩进 ${patch.textIndent} 字`)
  }

  const consumed = new Set(['fontSize', 'fontFamily', 'lineSpacing', 'paragraphSpacing', 'charSpacing', 'padding', 'margin', 'doubleColumn', 'firstLineIndent', 'textIndent', 'indent', 'isDefault', 'selected', 'name', 'id', 'createTime'])
  const skipped = Object.keys(style).filter(key => !consumed.has(key))
  if (skipped.length) notes.push(`包里还有 ${skipped.length} 个字段这边没有对应设置（${skipped.slice(0, 6).join('、')}${skipped.length > 6 ? '…' : ''}），未套用`)
  if (!applied.length) notes.unshift('这条样式里没有一个字段能映射到本机阅读设置，未做任何修改')
  return { patch, applied, notes }
}

/**
 * 上游 `httpTTS.json` 是自定义朗读引擎列表（`{name, url, enable}`）。
 * 我们只有一个"自定义引擎"槽位，所以取启用中的第一条，并明确说清其余的被忽略。
 */
export function mapTtsEngine(raw: string): PreferencePatch {
  const applied: string[] = []
  const notes: string[] = []
  const patch: Partial<ReaderSettings> = {}
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { return { patch, applied, notes: ['httpTTS.json 不是合法 JSON，没套用'] } }
  const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[]
  const usable = list.filter(row => typeof row.url === 'string' && /\{\{(text|content)\}\}/.test(String(row.url)))
  if (!usable.length) return { patch, applied, notes: ['包里的朗读引擎没有带 {{text}} 占位的 URL，套上也不会出声，未修改'] }
  const chosen = usable.find(row => row.enable === true || row.enable === 1) ?? usable[0]
  patch.ttsEngine = 'custom'
  patch.ttsCustomUrl = String(chosen.url)
  patch.ttsCustomMethod = /{{method}}|POST/i.test(String(chosen.url)) ? 'POST' : 'GET'
  applied.push(`自定义朗读「${String(chosen.name ?? '未命名')}」`)
  if (usable.length > 1) notes.push(`包里有 ${usable.length} 个可用引擎，这台服务只有一个自定义槽位，只取了启用的那一个`)
  const ignored = list.length - usable.length
  if (ignored > 0) notes.push(`另有 ${ignored} 个引擎的 URL 里没有 {{text}} 占位，无法套用`)
  return { patch, applied, notes }
}

/** 套用以后的完整设置：只覆盖映射到的字段，其余保持本机当前值。 */
export function applyPreferencePatch(current: ReaderSettings, patch: Partial<ReaderSettings>): ReaderSettings {
  return { ...defaultReaderSettings, ...current, ...patch }
}
