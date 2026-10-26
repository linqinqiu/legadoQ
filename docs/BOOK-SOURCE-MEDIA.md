# 书源媒体链路：文本 / 图片 / 音频 / 视频 / 文件

> 2026-10-27 审计。参考实现：`HapeLee/legado-with-MD3`（浅克隆在 `E:\legado-out\legado-with-MD3`，工作区外）。
> 本文只写**当前代码真实具备的能力**与**实测过的结论**；没做的明确列在「仍存在的限制」里。

## 1. 类型定义与本机库分布

Legado 的 `bookSourceType` 只有 0~3；`4 视频`是社区扩展（本机库确实有 15 个源这么填）。

| `bookSourceType` | 含义 | 本机库数量 | 阅读器渲染 |
|---|---|---:|---|
| 0 | 文本 | 5122 | 正文段落；`<img>` 转 `![图片](url)` 占位 |
| 1 | 音频 | 117 | `<audio>`；直链缺失时按播放页处理 |
| 2 | 图片（漫画） | 284 | 正文里的 `![图片](url)` → 同源图片代理 |
| 3 | 文件 | 60 | 按地址后缀决定播放器或下载链接 |
| 4 | 视频（扩展） | 15 | `<video>` / HLS / 播放页 iframe |

统计来自 `product/data/legado.sqlite` 的 `source` 表（2026-10-27，共 5598 个源）。

## 2. 链路

1. **正文**：`RuleRunner.content()` 返回 `ChapterContent(title, content, mediaUrl)`。
   - `yp_url` 赋值 → `mediaUrl`；
   - `java.startBrowser(播放页)` → `openUrl`，媒体类型下也作为 `mediaUrl` 透出；
   - 正文恰好是一条媒体直链（含「刷新正文 / 直链：」这种短文本里唯一一条）→ `mediaUrl`。
2. **图片**：`preserveContentImages()` 把 `<img>`（含 `data-src`/`data-original`）换成独占一行的
   `![图片](绝对地址)`，`cleanContent()` 用哨兵保住 div 里的图；前端 `renderContentBlock()` 认整行占位，
   走 `/api/book/image` 同源代理（注入 Referer / Cookie，7 天落盘缓存，拒 SVG）。
3. **音频 / 视频 / 文件**：前端 `MediaBlock` 按地址分类：
   - 直链 → `<audio>` / `<video>`，走 `/api/book/media` 流式代理（Referer + Cookie + Range）；
   - `.m3u8/.m3u` → `HlsVideo`（hls.js，动态加载）；
   - 播放页（没有媒体后缀）→ 同源代理 HTML 并注入 `<base href="原始地址">`，用沙箱 iframe 打开，
     并永远留一条「在浏览器打开」外链；
   - 其余 → 下载链接（带 `download=1`，服务端补 `Content-Disposition` 文件名）。

## 3. 本轮修复（2026-10-27）

- `http/MediaRoutes.kt`
  - GET/HEAD 共用一套实现，补 `HEAD /api/book/media`（部分播放器先探 HEAD）；
  - 上游没给 `Content-Type` 或只给 `application/octet-stream` 时按后缀补（mp4/webm/mp3/m4a/flac/m3u8…）；
  - 上游 416（拖动越过文件尾）原样回 416，不再误报 502；
  - `download=1` 补 `Content-Disposition`（`filename*=UTF-8''…`，中文名可用）；
  - m3u8 播放列表重写：分片、`#EXT-X-KEY`/`#EXT-X-MAP` 等 `URI="…"` 全部改成同源代理地址，
    相对地址按**重定向后的最终地址**解析；HLS 主列表与二级列表都实测通过；
  - 播放页 HTML 注入 `<base href="最终地址">`，iframe 里的相对资源回原站解析。
- `rules/RuleRunner.kt`
  - 视频源的 `java.startBrowser(播放页)` 地址透出为 `mediaUrl`（本机库 15 个视频源里 12 个用这个）；
  - 短文本里恰好一条媒体直链也认（仅媒体类型，文本源不误判）；
  - `yp_url` / 直链带 `,{…}` 请求选项时先取地址部分，至少不再把整串当 URL。
- `cache/CoverCache.kt`
  - 正文图片上限 5 MiB → **20 MiB**（漫画长图），封面仍 5 MiB；读流时就限，不先整包进内存。
- 前端
  - 新增 `reader/mediaKind.ts`（纯分类）、`reader/HlsVideo.tsx`（hls.js）；
  - `MediaBlock` 支持 HLS / 播放页 iframe / 文件下载；
  - 新增 `web/test/mediaKind.test.ts`；`package.json` 增加 `hls.js@^1.7.3`。
- 判据：后端 **626** 项（新增 8）、前端 **744** 项（新增 6），全绿。

## 4. 实测记录（部署后打本机 1234）

| 场景 | 结果 |
|---|---|
| `HEAD /api/book/media?url=<mp3>` | `200`，`Content-Type: audio/mpeg`，`Content-Length: 8945229`，`Accept-Ranges: bytes` |
| `Range: bytes=0-99` | `206`，`Content-Range: bytes 0-99/8945229`，实际 100 字节 |
| HLS 主列表（test-streams.mux.dev） | 变体地址全部改写为 `/api/book/media?url=…m3u8` |
| HLS 二级列表 | 每个 `.ts` 分片改写为 `/api/book/media?url=…ts` |
| 播放页 HTML（w3.org） | 返回 HTML，`<head>` 后注入 `<base href="https://www.w3.org/">` |
| `download=1`（mp3） | `Content-Disposition: attachment; filename="download"; filename*=UTF-8''SoundHelix-Song-1.mp3` |

`example.com` / `soundhelix.com` 的 HTML 在本机网络下分别超时/500，属外部网络，不是代理逻辑。

## 5. 仍存在的限制（下一轮再做）

1. **`url,{headers/method/body}` 请求选项没有完整下传**。真实规则里音频 3 个、视频 1 个用到；
   典型是网易音乐 `api.php,{method:post,body:…}`。当前只取地址部分，POST 类仍会失败。
   要做需要：`ChapterContent` 增加 `mediaHeaders/mediaMethod/mediaBody`，`/api/book/media` 接受并校验
   （拒 Host/Content-Length/CRLF，body 限长），前端透传。属于接口契约变更，单独一轮。
2. **播放页并非都能内嵌**：站点若用 `X-Frame-Options`/CSP `frame-ancestors` 或只认 WebView JS 桥，
   iframe 会空白；已保留「在浏览器打开」外链兜底。
3. **图片源裸 URL 行**（不是 `<img>`，也不是 `![图片]`）没有转换；`srcset`/`<picture>` 也没解析。
   真实漫画源目前抽样都是 `<img>`（`ruleContent` 自己拼 `<img src>`），主路径已覆盖。
4. **HLS 直播**：播放列表用 `no-store`，分片实时代理；加密 HLS 的密钥也走代理。未专门测低延迟直播。
5. **本地 EPUB**：包内图片只认 png/jpeg/gif/webp/bmp；SVG 因同源 XSS 面明确拒绝，AVIF/TIFF 未支持。
6. **图片上限 20 MiB**：极长条漫仍可能超；超限会显示「这张图没取到 + 重取这一张」，不会静默。

## 6. 参考仓库对照

- `app/src/main/java/io/legado/app/constant/BookSourceType.kt`：`default=0 / audio=1 / image=2 / file=3`，
  没有 4；我们的 4 是扩展，渲染上按视频处理。
- `BookContent.kt`：音频/视频**不做 HTML 格式化**，正文原样就是链接；图片走 `HtmlFormatter.formatKeepImg`
  保留 `<img>` —— 与我们的 `preserveContentImages` 等价。
- `ExoPlayerHelper.kt`：Media3/ExoPlayer，原生支持 HLS/DASH，并通过 `url + SPLIT_TAG + headers JSON`
  把每个 URL 的请求头带进播放器 —— 这正是我们第 5.1 条还缺的能力。

## 7. 怎么复验

```bash
cd E:/legado/product
npm --prefix web run check
npm --prefix web test                 # 744
./gradlew :app:test --console=plain   # 626
node tools/verify/bundled-ui-check.mjs
# 媒体代理实测（服务在跑）
curl -s -I "http://127.0.0.1:1234/api/book/media?url=https%3A%2F%2Fwww.soundhelix.com%2Fexamples%2Fmp3%2FSoundHelix-Song-1.mp3"
curl -s -r 0-99 -D - -o /dev/null "http://127.0.0.1:1234/api/book/media?url=…mp3"
```

## 8. 涉及文件

- `product/app/src/main/kotlin/io/legado/http/MediaRoutes.kt`
- `product/app/src/main/kotlin/io/legado/rules/RuleRunner.kt`
- `product/app/src/main/kotlin/io/legado/cache/CoverCache.kt`
- `product/app/src/test/kotlin/io/legado/MediaProxyHelpersTest.kt`（新增）
- `product/app/src/test/kotlin/io/legado/MediaUrlSniffTest.kt`
- `product/web/src/reader/mediaKind.ts`（新增）
- `product/web/src/reader/HlsVideo.tsx`（新增）
- `product/web/src/reader/MediaBlock.tsx`
- `product/web/src/styles.css`
- `product/web/test/mediaKind.test.ts`（新增）
- `product/web/package.json` / `package-lock.json`（`hls.js`）
