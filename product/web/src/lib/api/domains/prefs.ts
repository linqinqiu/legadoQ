/** 界面偏好（服务端持久化）：`/api/ui-prefs` 系列端点。
 *
 * 为什么需要它：壁纸、阅读设置、首启免责声明的标记原本**只在 localStorage**，
 * 而 localStorage 按 **origin**（协议+主机+端口）隔离 —— 用户把端口从 1234 改成
 * 1299，整个界面就像第一次打开：壁纸回默认、免责声明又弹一次。
 * 把这几份小 JSON 存到服务端，换端口/换浏览器/清站点数据都还能赎回。
 *
 * **路径必须带 `/api` 前缀**：本文件最初照 `domains/brand.ts` 写成 `/ui-prefs`，
 * 而品牌那几个端点是 `StaticWeb` 挂在**根路径**上的特例；绝大多数域端点都在
 * `route("/api")` 之下。写错不会报错，只会静默 404，然后「设置还是丢了」。
 * 这条是发版后真浏览器验收抓出来的，判据见 `UiPrefs.test.ts` 的路径断言。
 *
 * 约定：PUT 的 body 是**该 key 的裸 JSON 值**（不是 `{value: …}` 包装），DELETE 走 204。
 */
import { request } from '../client'

const BASE = '/api/ui-prefs'

export const uiPrefs = {
  all: () => request<{ prefs: Record<string, unknown> }>(BASE),
  set: (key: string, value: unknown) =>
    request<void>(`${BASE}/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(value) }),
  remove: (key: string) =>
    request<void>(`${BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' }),
}
