# 反代书源操作手册

> 目标：让青阅通过**你自己的中转服务**访问目标站，而不是直连。
> 适用场景：目标站按 IP 限流 / 需要固定出口 IP / 想加缓存 / 想隐藏真实来源。

## 0. 先说清楚两件事

**这不是"绕过反爬"的工具。** 反代能解决的是**网络位置**问题（出口 IP、限流、缓存），
解决不了**登录**与**JS 挑战** —— 那两件事走 Cookie（见 §5）。

**反代不改变书源规则。** 书源里写的 CSS/JSONPath 选择器是对**最终 HTML** 的，
所以反代必须**原样透传响应体**，不能改写内容。

## 1. 两种接法，先选一种

| 方案 | 做法 | 适合 |
|---|---|---|
| **A. 路径透传**（推荐） | 书源地址写成 `https://你的域名/proxy?url=<原地址>` | 通用，改动小 |
| **B. 域名伪装** | 书源地址写成 `https://你的域名/`，反代内部映射到目标站 | 书源规则里写死了绝对路径时 |

方案 A 更好维护：书源里只需要把 `bookSourceUrl` 换掉，规则原样不动。

## 2. 方案 A：Cloudflare Worker 反代

### 2.1 Worker 代码

```js
export default {
  async fetch(request) {
    const url = new URL(request.url)
    const target = url.searchParams.get('url')
    if (!target) return new Response('missing url', { status: 400 })

    // 只允许 http(s)，防止有人拿它当任意协议跳板
    let targetUrl
    try { targetUrl = new URL(target) } catch { return new Response('bad url', { status: 400 }) }
    if (!/^https?:$/.test(targetUrl.protocol)) return new Response('bad protocol', { status: 400 })

    // 透传原请求的 method / body / 少量必要头
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: {
        'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        'Referer': request.headers.get('Referer') || '',
        'Accept': request.headers.get('Accept') || '*/*',
      },
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    })

    // 原样透传响应体；只补必要的头
    const headers = new Headers()
    const passthrough = ['content-type', 'content-length', 'last-modified', 'etag']
    for (const h of passthrough) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    // 若目标站按 Referer 防盗链，这里补一个
    headers.set('Access-Control-Allow-Origin', '*')

    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
```

### 2.2 部署

```bash
npm create cloudflare@latest my-proxy
cd my-proxy
# 把上面的代码写进 src/index.js
npx wrangler deploy
# 得到 https://my-proxy.<你的账号>.workers.dev
```

### 2.3 书源怎么写

书源的 `bookSourceUrl` 填你的 Worker 地址，**规则里的相对地址会基于它解析**：

```json
{
  "bookSourceUrl": "https://my-proxy.example.workers.dev/proxy",
  "bookSourceName": "某站（反代）",
  "bookSourceGroup": "自建反代",
  "searchUrl": "?url=https://目标站/search?q={{key}}",
  "ruleSearch": {
    "bookList": ".result-list .item",
    "name": ".title@text",
    "author": ".author@text",
    "bookUrl": "a@href"
  }
}
```

> 关键点：`searchUrl` 里把**目标站地址整个塞进 `url` 参数**，并用 `{{key}}` 做关键词替换。
> 青阅会把 `bookSourceUrl` 与 `searchUrl` 拼起来，所以这样写是合法的。

### 2.4 导入并验证

```bash
# 1) 校验结构（不落库）
curl -s -X POST http://127.0.0.1:1234/api/agent/sources/validate \
  -H 'Content-Type: application/json' \
  -d '{"json":"<把上面那份书源 JSON 序列化成字符串>"}'

# 2) 逐阶段调试：看每一步取到了什么、错在哪
curl -s -N 'http://127.0.0.1:1234/api/sources/<源id>/debug?keyword=测试'
```

`debug` 是 SSE，会逐阶段回「结构 / 搜索 / 详情 / 目录 / 正文」——
**先过这一步再落库**，否则坏源进库后会污染搜索。

## 3. 方案 B：Nginx / Caddy 反代（自建服务器）

```nginx
location /proxy {
    set $target $arg_url;
    if ($target = "") { return 400; }
    proxy_pass $target;
    proxy_set_header Host $proxy_host;
    proxy_set_header Referer $http_referer;
    proxy_set_header User-Agent $http_user_agent;
    proxy_ssl_server_name on;
    # 关键：原样透传响应体，不改写
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
}
```

Caddy 更简单：

```
example.com {
    reverse_proxy /proxy* {
        dynamic upstream {query.url}
    }
}
```

> ⚠️ **不要开 `sub_filter` 改写内容**。书源选择器是对原 HTML 的，改写了就全乱。

## 4. 安全提醒（重要）

反代本质是一个**开放代理**，配不好会被别人白用：

| 风险 | 防护 |
|---|---|
| 被当跳板打别人 | 只允许特定目标域（白名单） |
| 被刷流量 | Cloudflare 侧加 rate limit |
| 泄露你的服务器 IP | 用 Cloudflare 代理（橙色云）而非直连 |
| 被用来访问内网 | **必须**拒绝内网/保留地址（见下） |

Worker 里加白名单：

```js
const ALLOWED = ['www.example-novel.com', 'm.example-novel.com']
if (!ALLOWED.includes(targetUrl.hostname)) {
  return new Response('host not allowed', { status: 403 })
}
```

Nginx 里加内网拦截：

```nginx
if ($target ~* "^https?://(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)") {
    return 403;
}
```

## 5. 如果目标站需要登录：不要用反代硬扛

反代解决不了登录。两条正路：

### 5.1 手贴 Cookie（最稳）

```bash
curl -s -X POST 'http://127.0.0.1:1234/api/sources/<源id>/login-cookie' \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"cookie":"k1=v1; k2=v2","url":"https://目标站"}'
```

Cookie 按**注册域**入库，同域的所有书源共享。

### 5.2 拉起真浏览器抓（需要 JS 挑战时）

```bash
# 1) 拉起本机 Chrome/Edge（独立临时 profile）
curl -s -X POST 'http://127.0.0.1:1234/api/sources/<源id>/browser/external-login'

# 2) 用户在弹出来的浏览器里登录

# 3) 收回 Cookie
curl -s -X POST 'http://127.0.0.1:1234/api/sources/<源id>/browser/external-login/capture'
```

> 这条能力依赖 `source/ExternalBrowserLogin.kt`。它属于**核心取数链路**的
> 登录前置（没有 Cookie 就读不到内容），所以不做成可卸载插件；
> 但"拉起浏览器"这个动作是可选的 —— 用户也可以只用 §5.1 手贴。

## 6. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 搜索有结果，点进去 404 | 书源里写的是**相对地址**，反代没拼对 | 用 `debug` 看 `bookUrl` 实际是什么 |
| 正文是空的 | 目标站按 Referer 防盗链 | Worker 里补 `Referer` |
| 中文乱码 | 响应头 `content-type` 没透传 | 透传 `content-type` |
| 图片全裂 | 图片走的是另一条链路 | 图片代理用 `/api/book/image`，它单独处理 Referer |
| 反代被刷 | 没做白名单/限流 | 见 §4 |
| 规则全失效 | 反代改写了 HTML | 关掉 `sub_filter` 之类的内容改写 |

## 7. 验证清单

- [ ] `validate` 返回 `valid: true`
- [ ] `debug` 的 5 个阶段都 ok
- [ ] 搜索能出书，点进去能看详情
- [ ] 目录能列出，正文能读到
- [ ] 图片能显示（走 `/api/book/image` 代理）
- [ ] 反代有目标域白名单 + 内网拦截
