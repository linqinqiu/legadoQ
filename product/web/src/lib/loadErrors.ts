/**
 * 把出站失败的原因翻成一句"用户能照着做"的话 —— 正文/搜索这类**不是订阅**的路径用。
 *
 * 为什么另起一份而不是复用 `syncErrors`：那个文件是**订阅同步**的翻译层，
 * 它的文案里写着"订阅地址""立即同步""粘贴导入"，直接搬到阅读器上会说错话
 * （用户是在读书，不是在同步订阅）。但它真正有价值的判断是按**异常签名**分类，
 * 那部分与场景无关，所以这里抽的是同一批签名、换成阅读器的口气。
 *
 * 借 `HapeLee/legado-with-MD3` 的 `LocalNetworkBlockedNotifier`：
 * 内网/本机被拦是**配置问题**（书源里写了 127.0.0.1 或 192.168.x.x），
 * 不该跟"站点挂了"长得一模一样 —— 前者用户能自己改，后者只能等。
 */

export type LoadErrorInfo = {
  /** 一行结论，直接显示在正文错误位。 */
  headline: string
  /** 能照着做的下一步；没把握给建议时留空，不编。 */
  hint: string
  /** 是否命中已知签名。false 时 headline 就是原文，不假装我们懂它。 */
  recognized: boolean
}

/**
 * 后端 `classifyRuleFailure` 给这一类的固定前缀：
 * `书源指向被拒绝的地址（内网或本机）：…`。
 */
const BLOCKED_PREFIX = '书源指向被拒绝的地址'

export function describeLoadError(raw: string): LoadErrorInfo {
  const text = (raw ?? '').trim()
  if (!text) return { headline: '读取失败', hint: '', recognized: false }
  const lower = text.toLowerCase()

  // 1) 出站闸门拒绝：这是**书源配置**问题，说清是"被拦下"，别让人去查网络。
  if (text.includes(BLOCKED_PREFIX) || text.includes('拒绝访问内网或本机地址')) {
    return {
      headline: '这本书的书源指向了内网或本机地址，已被拦下',
      hint: '公共书源不该访问 127.0.0.1、192.168.x.x 这类地址；去书源里把地址改成站点自己的域名，或换一个源。',
      recognized: true,
    }
  }

  // 2) 服务端内部错误：`classifyRuleFailure` 兜底时给的就是这句固定文案。
  if (text.includes('书源执行时服务内部出错')) {
    return {
      headline: '服务内部出错，这本书这次没取到正文',
      hint: '详情已经写进服务端日志。先点「重新加载」；一直不行就换一个源。',
      recognized: true,
    }
  }

  // 3) HTTP 状态：401/403 要登录，404/410 地址失效，5xx 是对方的问题。
  const httpStatus = /HTTP\s+(\d{3})/i.exec(text)
  if (httpStatus) {
    const code = Number(httpStatus[1])
    if (code === 401 || code === 403) {
      return { headline: `这个源要登录才能看正文（HTTP ${code}）`, hint: '去「书源」里给这个源登录一次，或换一个源。', recognized: true }
    }
    if (code === 404 || code === 410) {
      return { headline: `章节地址不存在（HTTP ${code}）`, hint: '目录可能已经改版，先「刷新目录」再重试。', recognized: true }
    }
    if (code >= 500) {
      return { headline: `站点自己出错了（HTTP ${code}）`, hint: '对方服务的问题，过一会儿再点「重新加载」。', recognized: true }
    }
    return { headline: `站点返回 HTTP ${code}`, hint: '', recognized: true }
  }

  // 4) 域名/连接类：与订阅那边同一批签名，只是这里不用"同步"的口气。
  if (text.includes('无法解析') || lower.includes('unknownhost') || text.includes('Name or service not known')) {
    return { headline: '站点域名解析不到', hint: '这个源可能已经停掉，或者书源地址写错了；换一个源试试。', recognized: true }
  }
  if (lower.includes('failed to connect') || lower.includes('connectexception') || lower.includes('connection refused')) {
    return { headline: '连不上这个站点', hint: '站点可能已经关停；换一个源试试。', recognized: true }
  }
  if (lower.includes('connection reset') || lower.includes('connection aborted') || lower.includes('broken pipe')
    || lower.includes('现有连接') || lower.includes('强迫关闭')) {
    return { headline: '连上了但被站点中途掐断', hint: '常见于反爬或限流；过一会儿再点「重新加载」。', recognized: true }
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { headline: '站点响应超时', hint: '站点可能限流或已无人维护；过一会儿再试。', recognized: true }
  }
  if (lower.includes('ssl') || lower.includes('certificate') || lower.includes('handshake')) {
    return { headline: 'HTTPS 证书握手失败', hint: '对方证书不受信任；换一个 https 正常的源。', recognized: true }
  }

  // 兜底：仍然按错误排版，但把原文当结论，不假装我们懂它。
  return { headline: text.split(/\r?\n/)[0].slice(0, 90), hint: '', recognized: false }
}