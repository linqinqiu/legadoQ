/**
 * 选源控件的排序与筛选。
 *
 * 用户 2026-09-30：「指定书源-选择书源功能不能正常使用」。真实原因不是点不动，
 * 而是这台库里 5,574 个源只有 690 个启用，下拉却按名字把停用的也全塞进来 ——
 * 选到一个停用源后搜索必然空，看上去就像"功能坏了"。
 * 所以默认只给启用中的，并且把分组当副标题带上；要挑停用的源再显式勾选。
 */
export type PickableSource = { id: string; name: string; enabled: boolean; group?: string | null }
export type SourcePickerOption = { value: string; label: string; hint?: string }

const byName = (a: PickableSource, b: PickableSource) => a.name.localeCompare(b.name, 'zh-Hans-CN')

export function sourcePickerOptions(sources: PickableSource[], includeDisabled = false): SourcePickerOption[] {
  const enabled = sources.filter(source => source.enabled).sort(byName)
  const disabled = includeDisabled ? sources.filter(source => !source.enabled).sort(byName) : []
  return [...enabled, ...disabled].map(source => ({
    value: source.id,
    label: source.name,
    hint: source.enabled ? (source.group?.trim() || undefined) : '已停用，搜不到',
  }))
}

/**
 * 手上只有书源 id（一个域名串）、拿不到书源表时给人看的写法。
 *
 * `sourceId` 直接上屏是 6 处的老毛病：换源弹窗的候选行、"当前："那一行、
 * 封面来源提示、离线缓存列表的第三段……用户看到的是
 * `https://00xiaoshuo.net` 这种带协议的地址串，而不是「00小说网」。
 * 能拿到书源表的地方一律用表里的名字；这里只负责退而求其次——至少让它像个网站名。
 */
export const sourceLabel = (id?: string | null, name?: string | null) => {
  const trimmed = name?.trim()
  if (trimmed) return trimmed
  const raw = id?.trim()
  if (!raw) return '未知书源'
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^@:/, '')
  const host = withoutScheme.split(/[/?#]/)[0]
  return host || raw
}
