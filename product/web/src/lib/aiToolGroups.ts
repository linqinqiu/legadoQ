/**
 * AI 工具组开关的本地存储。
 *
 * 存在浏览器 localStorage：这是"这台机器上我想让 AI 用哪些能力"的偏好，
 * 不上传服务端、不进备份包。`null` 表示没限制（按对话关键词自动选组）。
 */
const KEY = 'legado-ai-tool-groups'

/**
 * 工具组的中文名与一句人话。
 *
 * 服务端清单里只有 `group` 的英文 id（`bookshelf` / `replace-rules`…），直接摆给用户等于
 * 让他先猜这组管什么。这里给每组一个名字 + 一句"开了它 AI 能做什么"，界面上不再出现裸 id。
 */
export type AiToolGroupInfo = { title: string; hint: string }

export const AI_TOOL_GROUP_INFO: Record<string, AiToolGroupInfo> = {
  program: { title: '程序目录与工具搜索', hint: '始终启用：模型先查"有哪些工具"，再按需调用。' },
  bookshelf: { title: '书架', hint: '查书架、加书移书、分组、改阅读进度。' },
  sources: { title: '书源', hint: '查看与启停书源、导入、逐阶段调试、体检。' },
  search: { title: '搜索与目录', hint: '搜书、取书籍详情、拉目录与正文。' },
  explore: { title: '发现', hint: '按书源探索页翻分类。' },
  reading: { title: '阅读与批注', hint: '选中文本高亮、记笔记、净化、改写润色。' },
  notes: { title: '笔记', hint: '查、改、删笔记与划线。' },
  'replace-rules': { title: '净化规则', hint: '增删改替换规则（去广告、去乱码）。' },
  tts: { title: '朗读', hint: '建朗读会话、取朗读音频。' },
  rss: { title: 'RSS', hint: '读订阅源与文章。' },
  subscriptions: { title: '书源订阅', hint: '查看与管理书源订阅。' },
  backup: { title: '备份', hint: '列出并读取备份区里的条目。' },
  health: { title: '书源体检', hint: '看书源体检的结论与失败原因。' },
  debug: { title: '规则调试', hint: '逐阶段跑书源规则，看每一步的中间结果。' },
}

/** 组的显示名；不认识的组回落成 id 本身（新加组时不至于变成空白）。 */
export function aiToolGroupTitle(group: string): string {
  return AI_TOOL_GROUP_INFO[group]?.title ?? group
}

/** 组的一句话说明；不认识的组给一句通用解释。 */
export function aiToolGroupHint(group: string): string {
  return AI_TOOL_GROUP_INFO[group]?.hint ?? '这一组下的工具会下发给 AI。'
}

/**
 * 工具 id → 组。悬浮窗拿到的只有 `工具id:结果`，要显示"用了哪些能力"就得反查这一层。
 * 由 `rememberToolIndex` 在读到能力清单时填一次。
 */
let toolGroupById = new Map<string, string>()

/** 记住清单里的 id→组映射（重复调用以最后一次为准）。 */
export function rememberToolIndex(tools: ReadonlyArray<{ id: string; group?: string }>): void {
  toolGroupById = new Map(tools.filter(tool => tool.group).map(tool => [tool.id, tool.group as string]))
}

/** 工具 id 属于哪一组；清单还没读到 / 不认识的工具返回 null。 */
export function aiToolGroupOf(toolId: string): string | null {
  return toolGroupById.get(toolId) ?? null
}

/**
 * 把服务端回的 `工具id:结果` 折成"能力组"。
 *
 * 直接摆 `ai.textRewrite · ok` 只有写代码的人看得懂；折成「阅读与批注」之后，
 * 用户才知道刚才那一下动了哪儿。同一组调多次只显示一次，具体 id 挂在 title 上备查。
 */
export function toolRoundGroups(rounds: string[]): { label: string; ids: string }[] {
  const byLabel = new Map<string, string[]>()
  for (const round of rounds) {
    const id = round.split(':')[0]
    const group = aiToolGroupOf(id)
    const label = group ? aiToolGroupTitle(group) : id
    byLabel.set(label, [...(byLabel.get(label) ?? []), id])
  }
  return [...byLabel.entries()].map(([label, ids]) => ({ label, ids: ids.join('、') }))
}

/**
 * 读用户启用的工具组。
 *
 * @returns 组名数组；`null` 表示不限制
 */
export function loadAiToolGroups(): string[] | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const groups = parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return groups.length > 0 ? groups : null
  } catch {
    return null
  }
}

/**
 * 保存用户启用的工具组。
 *
 * @param groups 组名数组；传 `null` 表示不限制（清掉这条偏好）
 */
export function saveAiToolGroups(groups: string[] | null): void {
  try {
    if (groups === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(groups))
  } catch {
    // 隐私模式 / 配额满：本次会话内仍然按界面上的选择走，只是下次打开会回到默认
  }
}
