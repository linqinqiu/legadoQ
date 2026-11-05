/**
 * 「提交建议」把用户写的内容拼成 GitHub「新建 Issue」的链接。
 *
 * 为什么不在后端建 Issue：这个功能是给**使用者**用的，而后端 PAT 只可能配在
 * 部署者自己的机器上 —— 用户实例没有 token，功能等于不存在；把 token 打进包里，
 * 则是把仓库的 Issues 写权限发给每一个下载者。链接方案不需要任何凭据：用户在
 * GitHub 页面用自己的账号提交，身份与限流都由 GitHub 负责。
 *
 * 模板必须是 markdown（`04-feedback.md`）：issue forms（.yml）的表单字段不接受
 * `body` 预填，只有 markdown 模板会读这个参数。
 */
export const FEEDBACK_TEMPLATE = '04-feedback.md'
export const FEEDBACK_TITLE_MAX = 80
/**
 * 描述上限按**编码后**长度算过：一个汉字 `encodeURIComponent` 后是 9 个字符，
 * 600 字约 5.4 KB；加上标题与模板参数仍在 8 KB 以内（浏览器与桌面 WebView 的安全线）。
 */
export const FEEDBACK_BODY_MAX = 600

/** 仓库 slug 只接受 `owner/repo`，不接受任何能改变目标主机的写法。 */
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/

export type FeedbackDraft = {
  repository: string
  title: string
  description: string
  version?: string | null
  build?: string | null
}

/** 按字符（不是 UTF-16 码元）截断，避免把 emoji 劈成两半。 */
export function clampText(value: string, max: number): string {
  const chars = Array.from(value.trim())
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('')
}

/**
 * 生成新建 Issue 的地址。标题或描述为空时抛错 —— 调用方据此把按钮置灰，
 * 而不是打开一个空白的 Issue 页面让用户自己重填。
 */
export function buildFeedbackUrl(draft: FeedbackDraft): string {
  const repository = draft.repository.trim()
  if (!REPOSITORY.test(repository)) throw new Error('服务端没有给出可用的仓库地址')

  const title = clampText(draft.title, FEEDBACK_TITLE_MAX)
  const description = clampText(draft.description, FEEDBACK_BODY_MAX)
  if (!title) throw new Error('标题不能为空')
  if (!description) throw new Error('描述不能为空')

  const meta = [
    draft.version ? `版本：${draft.version}` : '',
    draft.build && draft.build !== '0' ? `构建：#${draft.build}` : '',
  ].filter(Boolean)
  const body = [
    description,
    '---',
    '这条建议由 legadoQ「关于 → 提交建议」生成。',
    ...meta,
  ].join('\n\n')

  // 手拼而不是 URLSearchParams：后者把空格编成 `+`，GitHub 的表单解析不一定当空格。
  const query = [
    `template=${encodeURIComponent(FEEDBACK_TEMPLATE)}`,
    `title=${encodeURIComponent(title)}`,
    `body=${encodeURIComponent(body)}`,
  ].join('&')
  return `https://github.com/${repository}/issues/new?${query}`
}
