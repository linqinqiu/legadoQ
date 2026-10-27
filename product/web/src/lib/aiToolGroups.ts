/**
 * AI 工具组开关的本地存储。
 *
 * 存在浏览器 localStorage：这是"这台机器上我想让 AI 用哪些能力"的偏好，
 * 不上传服务端、不进备份包。`null` 表示没限制（按对话关键词自动选组）。
 */
const KEY = 'legado-ai-tool-groups'

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
