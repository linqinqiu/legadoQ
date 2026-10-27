# 漫画 / 文件型书源与登录 Cookie 现状研究

> 2026-10-27。结论基于当前 `main`（0.0.7）源码；行号会随代码变化，以函数名与文件为准。

## 一、漫画 / 文件型书源

### 1. 类型语义

`bookSourceType`：`0` 文本 / `1` 音频 / `2` 图片（漫画）/ `3` 文件 / `4` 视频（社区扩展）。

- 定义：`app/src/main/kotlin/io/legado/model/Models.kt:318`、`RuleRunner.kt:1498`
- 落到书架：`ShelfDao.kt:20`（第 20 列 `json_extract(src.payload,'$.bookSourceType')`）
- 前端标签：`web/src/shelf/bookType.ts`（漫画 / 音频 / 文件 / 视频徽标），`LibraryPage.tsx:352` 同书多源类型一致才挂徽标

### 2. 正文链路（已能读漫画）

漫画源的一章正文是**一串图片**，当前走的是「图片占位行」方案：

1. 后端取回 HTML 后，`RuleRunner.preserveContentImages()`（约 1418 行）把每个 `<img>` 换成 `![图片](绝对地址)` 占位行，再交给 `cleanContent()` 去标签。
   - 已处理 Legado 的 `地址,{"headers":…}` 形态（逗号后是请求选项，不是地址的一部分）；
   - `data:` 内联图直接丢弃（会撑爆缓存）；
   - 漫画页常见的「每页图包在一个 `<div>` 里」有专门处理，否则占位行会被 `DIV_BLOCK` 连壳吃掉（注释里记了「爱看漫画」整章变空的历史）。
2. 前端按行还原：`ReaderScreen.tsx:907 renderContentBlock()` → `contentImageUrl()` 认出占位行 → `readerImage.ts` 生成图片地址 → `<img>`。
3. 图片统一走服务端代理 `GET /api/book/image?url=…`（`MediaRoutes.kt:117`），带 7 天落盘缓存；`POST /api/book/image/refresh` 绕缓存重取。
4. 预热：`contentImages.ts warmContentImages()` 在首屏渲染时把后续图片提前喂给代理；下一章含图时也会预热（`ReaderScreen.tsx:1319`）。
5. 失败重取：单张图失败会渲染「这张图没取到 + 重取这一张」（`ReaderScreen.tsx:920`），重取成功换代次、作废浏览器那份 7 天副本。

结论：**漫画「能读」**——图片在正文流里正常显示、有代理缓存、有预热与单张重取。

### 3. 缺口

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| `imageStyle` 未消费 | 只有编辑器字段 `bookSourceFields.ts:487`；后端 `grep imageStyle` 无命中 | `FULL`（铺满）不生效，图片永远按版心宽度显示 |
| `imageDecode` 未消费 | 同样只有编辑器字段 `bookSourceFields.ts:494` | 需要 JS 解密图片字节的源（防盗链/加密图）读不出来 |
| 没有漫画专用阅读模式 | 全仓无 `mangaMode` / 单图整屏 / 按图翻页 | 漫画只能按文本分页翻，长图被切页、跨页衔接不自然 |
| 分页几何用估算占位 | `layoutEngine.ts:58` `imgH = colWidth * imagePlaceholderRatio` | 图片实际高度与估算不一致时，分页点会偏（双栏下更明显） |
| 文件型（type 3）没有专门阅读器 | `mediaKind.ts` 按地址后缀分流播放器；文件类走下载/外链 | 文件源只能当媒体链接处理，没有「打开本地文件」的体验 |

### 4. 建议优先级

1. **`imageStyle: FULL`**：图片按容器满宽、去掉左右边距，改动集中在前端图片块与分页几何。
2. **漫画单图模式**：一屏一图、按图翻页、预取下一张；与现有分页引擎解耦（新 pageMode）。
3. **`imageDecode`**：后端在图片代理里对目标字节跑书源 JS，需要沙箱与缓存键配合。
4. 分页几何改为「按图片真实宽高比占位」（渲染后回填），减少长图分页偏移。

## 二、登录与 Cookie

### 1. 入口与规则

- 入口在**书源**列表的菜单「登录 / Cookie」（`SourcesPage.tsx:549`，仅 `source.hasLogin` 时出现）→ `SourceLoginModal`。
- 登录界面由书源 `loginUi` 决定（`RuleRunner.parseLoginUi()`，约 815 行）：
  - 纯 JSON：直接解析成表单项；
  - `@js:` / `js:` / `<js>…</js>`：在 Rhino 沙箱里跑出 JSON；
  - 没有 `loginUi` 但 `loginUrl` 是网址：退化成一颗「打开登录网页」按钮。
- `loginUrl` 可以是**整段 JS**（本机库 208 个源如此）：`loginBrowserStartUrl()` 会以 `login(true, false)` 跑一遍，拿脚本真正要打开的地址，而不是把 JS 当网址导航。
- 动作执行：`executeLoginAction()`，支持长按、`browserCompleted` 等参数。

### 2. 三条登录通道

1. **粘贴 Cookie**：`POST /api/sources/{id}/login-cookie`，按注册域归桶、同名键覆盖、其余保留。
2. **内置浏览器（服务端反代）**：`SourceWebViewModal` + `WebViewProxy`。
   - 目标站整站反代到本服务路径下，放进 iframe；
   - iframe **不开 `allow-same-origin`**，被代理页 JS 碰不到应用 DOM；
   - 反代端点用**一次性令牌**鉴权，不依赖管理会话；
   - 目标站 `Set-Cookie` 被服务端吸收进书源 Cookie jar，登录即生效。
3. **本机真浏览器**：服务端拉起本机 Chromium（独立持久 profile），登录完按域回读凭据（`api.sourceBrowserCookies` / `/browser/cookies`）。

### 3. 存储与判定

- 表结构：`cookie(url text primary key, cookie text not null, updated_at integer)`（`Database.kt:232`）——**明文存 SQLite**，按注册域归桶（`CookieDao.cookieBucket`）。
- 合并语义：同名覆盖、其余保留（`CookieDao.setCookieForUrl`）；`Set-Cookie` 只取第一个 `name=value`，不把 `Path/Expires/HttpOnly` 当 Cookie 存。
- 登录态判定：`checkLoginStatus()`（`RuleRunner.kt:912`）。
  - 有 `loginCheckJs` 就跑脚本；但上游语义里它是**响应改写器**，不是可靠的登录校验器；
  - 没有时只能按「有没有 Cookie / 登录信息 / 登录头」推断，**无法真正验证是否登录成功**。
- 备份：`cookies.json` 在备份包里**加密**（导入时用凭据解密密码解开），与库里明文不同。

### 4. 缺口

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| **没有全局 Cookie 管理页** | 后端有 `GET /api/cookies`、`DELETE /api/cookies?u=`（`SourcesRoutes.kt:105/119`）；前端 `api.ts` 从不调用 | 用户只能逐个书源进去看；删书源不连带清桶，凭据会「看不见又删不掉」——后端注释已点明这个风险 |
| Cookie 明文入库 | `Database.kt:232` | 本机单用户可接受，但与备份包的加密口径不一致 |
| 登录态无法验证 | `RuleRunner.kt:912` 注释 | 界面只能说「有凭据」，不能说「已登录」 |
| 凭据与域的关系不可见 | 只有 `credentialDomains()` 与 `mentionedBy` 计数 | 用户不知道某条 Cookie 到底被哪些书源用 |

### 5. 建议优先级

1. **补全局 Cookie 管理页**（五类核心功能里唯一的空位）：列出域、键名、被几个书源引用，支持按域删除；直接接现成的 `GET/DELETE /api/cookies`。
2. 在书源登录弹层里显示「这条凭据被哪些源引用」，删前有影响面提示。
3. 可选：Cookie 值默认打码、点开才显示；导出走备份包的加密口径。

## 三、两条线的交集

漫画源普遍要登录（图床防盗链），而图片代理目前只带**书源配置里的请求头**与按域取 Cookie（`ProxyHeaders.kt`）。也就是说：**Cookie 管理没做好，会直接表现成「漫画图裂」**。补全局 Cookie 页与「图片请求带对域 Cookie」的可见性，收益会同时落在两条线上。
