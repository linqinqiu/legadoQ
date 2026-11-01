/**
 * 绑定地址的两个纯函数：界面里显示「当前绑在哪」并判断要不要给出局域网暴露警告。
 *
 * 判断必须覆盖 IPv6 的多写法（`::1` / `0:0:0:0:0:0:0:1` / `[::1]`）：
 * 只认字符串 `127.0.0.1` 会把 IPv6 回环误报成「已暴露到局域网」，
 * 那种假警告比没有警告更坏 —— 用户会学会忽略它。
 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1' || value === 'localhost'
}

/** 浏览器访问自己时用的地址：绑 0.0.0.0 / :: 时不能用它们本身打开页面。 */
export function browseHost(host: string): string {
  const value = host.trim()
  return value === '0.0.0.0' || value === '::' ? '127.0.0.1' : value
}

/** 给人看的绑定地址（IPv6 补方括号，端口拼在后面）。 */
export function bindAddressLabel(host: string, port: number | null): string {
  const value = host.trim()
  if (!value) return port === null ? '…' : `…:${port}`
  const shown = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
  return port === null ? shown : `${shown}:${port}`
}
