/** 界面偏好（服务端持久化）：`/ui-prefs` 系列端点。
 *
 * 为什么需要它：壁纸、阅读设置、首启免责声明的标记原本**只在 localStorage**，
 * 而 localStorage 按 **origin**（协议+主机+端口）隔离 —— 用户把端口从 1234 改成
 * 1299，整个界面就像第一次打开：壁纸回默认、免责声明又弹一次。
 * 把这几份小 JSON 存到服务端，换端口/换浏览器/清站点数据都还能赎回。
 *
 * 约定：PUT 的 body 是**该 key 的裸 JSON 值**（不是 `{value: …}` 包装），DELETE 走 204。
 */
import { request } from '../client'

export const uiPrefs = {
  all: () => request<{ prefs: Record<string, unknown> }>('/ui-prefs'),
  set: (key: string, value: unknown) =>
    request<void>(`/ui-prefs/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(value) }),
  remove: (key: string) =>
    request<void>(`/ui-prefs/${encodeURIComponent(key)}`, { method: 'DELETE' }),
}
