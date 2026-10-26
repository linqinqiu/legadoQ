/**
 * 把服务端/HTTP 层的原始报错翻译成人能照着做的一句话。
 *
 * 报错文案的来源是确定的（`SubscriptionService` 与 `NetworkSecurity` 抛的中文消息，
 * 加上 JDK HttpClient 的英文异常），所以按这些签名分类，而不是笼统一句「同步失败」。
 * 原始文案不丢：界面上收在「查看原始报错」里，开源后别人报 bug 也拿得到。
 */
export type SyncErrorInfo = {
  headline: string
  hint: string
  /** 是否命中了已知的错误签名；false 表示这条更像普通提示，不该按错误排版。 */
  recognized: boolean
}

const DNS_HINT = '地址里的域名解析不到：检查订阅地址是否写错，或该站点是否已经停掉。'

export function describeSyncError(raw: string): SyncErrorInfo {
  const text = (raw ?? '').trim()
  if (!text) return { headline: '同步失败', hint: '', recognized: false }
  const lower = text.toLowerCase()

  const httpStatus = /HTTP\s+(\d{3})/i.exec(text)
  if (httpStatus) {
    const code = Number(httpStatus[1])
    const byCode = code === 401 || code === 403
      ? { headline: `上游拒绝访问（HTTP ${code}）`, hint: '这类地址通常要登录态或防盗链白名单；换一个可直链访问的 JSON 地址。' }
      : code === 404 || code === 410
        ? { headline: `订阅地址不存在（HTTP ${code}）`, hint: '地址多半已经改版或失效，去原站重新复制一次订阅链接。' }
        : code >= 500
          ? { headline: `站点侧出错（HTTP ${code}）`, hint: '这是对方服务的问题，稍后再点「立即同步」试试。' }
          : { headline: `上游返回 HTTP ${code}`, hint: '' }
    return { ...byCode, recognized: true }
  }

  if (text.includes('不是有效 JSON')) {
    return { headline: '返回的内容不是书源 JSON', hint: '常见原因是这个地址打开的是一个网页（下载页/预览页）而不是 JSON 直链。', recognized: true }
  }
  if (text.includes('重定向次数超过限制') || text.includes('重定向缺少地址')) {
    return { headline: '订阅地址一直重定向', hint: '换成重定向之后的最终地址试试。', recognized: true }
  }
  if (text.includes('拒绝访问内网或本机地址')) {
    return { headline: '服务端不抓取内网地址', hint: '订阅必须指向外部可访问的 http(s) 地址；本机文件请走「书源」页的粘贴导入。', recognized: true }
  }
  if (text.includes('仅允许 HTTP(S)')) {
    return { headline: '地址协议不支持', hint: '只接受 http:// 或 https:// 开头的订阅地址。', recognized: true }
  }
  if (text.includes('无法解析') || lower.includes('unknownhost') || text.includes('Name or service not known') || text.includes('Try again')) {
    return { headline: '域名解析不到', hint: DNS_HINT, recognized: true }
  }
  if (lower.includes('failed to connect') || lower.includes('connectexception') || lower.includes('connection refused')) {
    return { headline: '连不上这台站点', hint: '端口不通或对方拒绝连接：确认地址能在本机浏览器直接打开。', recognized: true }
  }
  /*
    「连接刚建立就被掐断」与"连不上"是两件事：这条通常已经握上了手，是对方（或本机代理/防火墙）
    中途把它撕掉。Windows 与 JDK 的说法都不止一种，英文原文糊在页面上用户读不出下一步，
    所以按签名收进同一句结论，原文照旧留在「原始报错」里。
    （2026-10-01 本机订阅探针实测到的就是 `Connection reset`：判据要求"说清原因"，
    而这一类当时确实没人翻译 —— 补的是产品，不是判据。）
  */
  if (lower.includes('connection reset') || lower.includes('connection aborted') || lower.includes('broken pipe')
    || lower.includes('现有连接') || lower.includes('强迫关闭') || lower.includes('software caused connections')) {
    return { headline: '连不上：连接被对方中途断开', hint: '握手成功但请求被掐断，常见原因是站点反爬、本机代理或防火墙切了这条连接；换个时间再点「立即同步」，或换一个直链。', recognized: true }
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { headline: '请求超时', hint: '30 秒内没有响应，站点可能限流或已经没人维护。', recognized: true }
  }
  if (lower.includes('ssl') || lower.includes('certificate') || lower.includes('handshake')) {
    return { headline: 'HTTPS 证书握手失败', hint: '站点证书不受信任或需要 SNI/旧协议兼容；换一个 https 正常的地址。', recognized: true }
  }
  if (text.includes('订阅不存在')) {
    return { headline: '这条订阅已经不在了', hint: '刷新页面即可。', recognized: true }
  }
  // 兜底：仍然按错误排版，但把原文当结论显示，不假装我们懂它。
  return { headline: text.split(/\r?\n/)[0].slice(0, 90), hint: '', recognized: false }
}

/** 这条文案看起来是失败还是普通提示（同步完成、删除成功之类）。 */
export function looksLikeFailure(raw: string): boolean {
  const text = (raw ?? '').trim()
  if (!text) return false
  if (/失败|错误|无法|拒绝|不存在|超时/.test(text)) return true
  return describeSyncError(text).recognized
}

/** 一行结论 + 可展开的原始报错。 */
export function errorLine(raw: string): { headline: string; hint: string; detail: string } {
  const info = describeSyncError(raw)
  return { headline: info.headline, hint: info.hint, detail: raw }
}
