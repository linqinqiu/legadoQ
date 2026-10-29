/**
 * 全局登录凭据（按注册域归桶的 Cookie）的客户端。
 *
 * 单独成文件而不是加进 `lib/api.ts`：那一份正在被另一个任务改，同文件并行改动会互相踩。
 * 取数口径与 `lib/api.ts` 的 `request` 完全一致 —— 相对路径（同源）、`credentials: 'same-origin'`、
 * 非 2xx 时把服务端的 `message` 原样抛出来给界面显示。`request` 在那里是模块私有的，
 * 不能 import 也不该为了复用去动那个文件，所以这里保留一份同样写法的薄封装。
 */

/** 凭据列表里的一桶：注册域 + 键名。列表接口**刻意不回值**。 */
export type GlobalCookieEntry = {
  domain: string
  keys: string[]
  /** 有多少本书源的配置里写到过这个域（粗筛，不等于"会访问"）。 */
  mentionedBy: number
  /** 其中属于**会话层**的键：只活到本次服务重启，也不进备份包。 */
  sessionKeys?: string[]
  /** 因为整条 `Cookie` 头超过 4096 字符而**发不出去**的键（丢的是最久没更新的）。 */
  droppedKeys?: string[]
  /** 实际会发出去的那条头的字符数。 */
  headerChars?: number
  /** 只剩一条仍然超过 4096：照发，但这桶本身就不正常。 */
  oversized?: boolean
}

export type GlobalCookieList = {
  count: number
  cookies: GlobalCookieEntry[]
}

/** `GET /api/cookies/detail`：某个域的凭据原文，编辑前回填用。 */
export type GlobalCookieDetail = {
  domain: string
  cookie: string
  /** 见 `GlobalCookieEntry.sessionKeys`。 */
  sessionKeys?: string[]
  /** 见 `GlobalCookieEntry.droppedKeys`。 */
  droppedKeys?: string[]
}

/** `POST /api/cookies` 的回包：写进哪个桶、合并后该桶有几个键。 */
export type GlobalCookieSaveResult = {
  ok: boolean
  domain: string
  count: number
}

/** `DELETE /api/cookies` 的回包：`removed` 表示原来那一桶在不在。 */
export type GlobalCookieRemoveResult = {
  ok: boolean
  removed: boolean
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new Error(body.message ?? '请求失败')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export const cookieApi = {
  /** 全部凭据桶（域名 + 键名 + 被几本书源提到），按域名排序由服务端给定。 */
  list: () => request<GlobalCookieList>('/api/cookies'),
  /** 读某个域的凭据原文。列表接口不回值，只有点「显示」或打开编辑时才拉这一条。 */
  detail: (domain: string) => request<GlobalCookieDetail>(`/api/cookies/detail?u=${encodeURIComponent(domain)}`),
  /**
   * 写入某个域的凭据。`url` 传站点地址或裸域名都行，服务端按注册域归桶；
   * 语义是**同名覆盖、其余保留**，所以这里可以只提交要改的那几个键。
   */
  save: (url: string, cookie: string) => request<GlobalCookieSaveResult>('/api/cookies', {
    method: 'POST',
    body: JSON.stringify({ url, cookie }),
  }),
  /** 删掉某个域的全部凭据（不可撤销）。 */
  remove: (domain: string) => request<GlobalCookieRemoveResult>(`/api/cookies?u=${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  }),
}
