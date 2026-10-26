# legadoQ API 参考

> 版本：0.0.0 · 端点数：141 · 生成时间：2026-10-26
> 本文由 `node scripts/gen-api-reference.mjs` 从 `app/src/main/resources/agent-api.json` 生成；
> 那份 JSON 就是 `GET /api/catalog` 吐出去的契约，以此为准，不要在手写正文里改端点。

## 连接

- Base URL：`http://127.0.0.1:1234`
- 认证：本服务不设身份：绑定地址就是唯一的门。写操作（write=true）从浏览器发起必须带与 Host 同源的 Origin 头；本机脚本或 AI 客户端直接调用即可（不带 Origin 就放行），不需要令牌。唯一反向例外是 WebSocket：那条把「没有 Origin」当作跨站拒掉。把 LEGADO_HOST 改成 0.0.0.0 等于把整个库的写权限交给局域网。
- Content-Type：`application/json; charset=utf-8`
- 错误：失败一律是非 2xx + {"code":..., "message":...}；message 是给人看的一句中文，可以直接显示或据此改动作

## 端点分组

| 分组 | 条数 |
|---|---:|
| 目录 | 1 |
| 系统 | 7 |
| 书源 | 12 |
| 登录与凭据 | 11 |
| 发现页 | 3 |
| 内置浏览器 | 17 |
| 搜索 | 2 |
| 书源订阅 | 5 |
| 备份 | 3 |
| RSS | 7 |
| 阅读 | 5 |
| 净化规则 | 10 |
| 书架 | 16 |
| 分章规则 | 7 |
| 离线缓存 | 3 |
| 图片与媒体 | 6 |
| 进度与笔记 | 9 |
| 朗读 | 9 |
| AI 自定义接入 | 8 |
| **合计** | **141** |

## 目录（1）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/catalog` | 否 | 就是这份机器可读契约；version 字段回的是当前运行的构建号 |

## 系统（7）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/server` | 否 | 服务现在绑在哪个主机与端口（界面上那个「服务端口」就是它） |
| PUT | `/api/server/port` | 是 | 改监听端口：写进包目录下的 port.txt，下次启动生效；请求体：port=1–65535 |
| GET | `/api/logs` | 否 | 读运行日志（界面「运行日志」那一档同源；书源规则失败、图片取不到都记在这里）；query：category=可选，按类别筛，level=可选，按级别筛，limit=默认 200 |
| DELETE | `/api/logs` | 是 | 清空运行日志（界面「运行日志」那一档上的清空按钮走的也是这条） |
| GET | `/api/about` | 否 | 「关于」那三样：名字、版本、发布仓库（版本只有一个来源，界面不写死） |
| POST | `/api/about/update-check` | 是 | 去发布页看有没有新版本（这一步要出网，所以它过同源写门） |
| GET | `/api/changelog` | 否 | 随包那份更新日志的 Markdown 原文（Content-Type 是 text/markdown，不是 JSON） |

## 书源（12）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/sources` | 否 | 书源列表（投影，不载完整规则 JSON）；query：q=可选，按名称或地址子串筛，忽略大小写 |
| POST | `/api/sources/batch` | 是 | 一批源一起做整理动作（启用 / 停用 / 删除 / 改分组 / 贴分组标签），一次事务；请求体：action=enable \| disable \| delete \| set_group \| tag_group \| untag_group，ids=["书源地址"]，group=分组名（set_group / tag_group 必填） |
| POST | `/api/sources/health-check` | 是 | 健康体检：阻塞式长任务（并发 16、单个默认 5 秒超时），跑完才回，没有进度流。不给 ids 就只体检启用中的源；请求体：ids=可选，timeoutMs=默认 5000，夹在 1000–10000，keyword=可选，用什么词去搜 |
| GET | `/api/sources/export` | 否 | 导出书源（不给 id 就是全部）；query：id=可选，可重复；只导点名的这几条 |
| POST | `/api/sources/import` | 是 | 一批导入（手机备份里那种字符串数组）；请求体：sources=["每份是书源 JSON 字符串"]，overwrite=服务端不看这个字段：导入永远是按 id 覆盖式 upsert（已在库的保留本机启用/停用选择），别指望 false 能跳过同名 |
| PUT | `/api/sources/order` | 是 | 存一份自定义排序（整串 id 的次序）；请求体：ids=["按你想要的顺序排好的书源地址"] |
| DELETE | `/api/sources/order` | 是 | 清掉自定义排序，回到按名称排（无请求体） |
| GET | `/api/sources/{id}` | 否 | 取一份书源（id 是剥掉 # 注解的书源地址） |
| PUT | `/api/sources/{id}` | 是 | 新建或覆盖一份书源；路径里的 id 不作数，以体里 json 的 bookSourceUrl 为准；请求体：json=整份书源 JSON 字符串，version=可选；给了就防并发改写，版本不符回 409 version_conflict |
| DELETE | `/api/sources/{id}` | 是 | 删一份书源（登录凭据按域共享，不连带清掉别的源的 Cookie） |
| POST | `/api/sources/{id}/validate` | 是 | 结构校验，不落库：可带草稿 json 校验编辑器里未保存的内容；请求体：json=可选；不给就校验库里那一份 |
| GET | `/api/sources/{id}/debug` | 否 | SSE 逐阶段调试（结构 / 搜索 / 详情 / 目录 / 正文），每步给取到什么、为什么失败；query：keyword=默认「测试」，bookUrl=可指定从哪本书往下走，chapterIndex=从第几章取正文 |

## 登录与凭据（11）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/cookies` | 否 | 全部登录凭据的域名清单（只回域名与键名，不回值） |
| DELETE | `/api/cookies` | 是 | 撤掉某个域的全部凭据；query：url=要清的那个地址或域 |
| GET | `/api/sources/{id}/login-ui` | 否 | 这本书源要求的登录表单（上游 loginUi 那套动态项） |
| POST | `/api/sources/{id}/login-info` | 是 | 存登录填写项 / 请求头 / 书源变量；请求体：loginInfo={"键":"值"}，loginHeader=可选整串，sourceVariable=可选 |
| DELETE | `/api/sources/{id}/login-info` | 是 | 清掉这本书源存的登录填写项 |
| POST | `/api/sources/{id}/login-header` | 是 | 存一份登录请求头；请求体：loginHeader=整串头，给 null 即清除 |
| POST | `/api/sources/{id}/login-cookie` | 是 | 直接灌 Cookie（按注册域入库，会先归一化成 k1=v1; k2=v2 并剥掉 Path/HttpOnly 这类指令属性）；请求体：cookie=整串，url=可指定挂到哪个域 |
| DELETE | `/api/sources/{id}/login-header` | 是 | 清掉这本书源存的登录请求头 |
| POST | `/api/sources/{id}/login-action` | 是 | 执行书源自定义的登录动作（loginUi 里的按钮规则）；请求体：action=规则原文，loginData={"表单字段":"填好的值"}，isLongClick=是否长按，browserCompleted=浏览器流程是否已走完 |
| GET | `/api/sources/{id}/login-check` | 否 | 登录态检查：配了 loginCheckJs 才可能 verified=true，否则只回答「有/无凭据」，不假装能判定登录有效 |
| GET | `/api/sources/{id}/credential` | 否 | 某个地址所在注册域上到底有没有凭据（界面用它把「要登录」和「站点确实没内容」分开）；query：u=必填，要查哪个地址所在域 |

## 发现页（3）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/sources/{id}/explore` | 否 | 这一家书源的发现页分栏；supportsPaging 说这一栏吃不吃页码（服务端按规则写法静态判，不执行书源代码） |
| GET | `/api/explore/sources` | 否 | 配了发现页（exploreUrl）的书源清单 |
| POST | `/api/explore` | 是 | 取某一栏某一页的书（它过同源写门，所以本机脚本要**不带 Origin**才放行）；请求体：sourceId=书源地址，url=栏目地址（可含 {{page}} 或 <a,b> 翻页段），page=默认 1 |

## 内置浏览器（17）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| POST | `/api/sources/{id}/browser/session` | 是 | 开一个内置浏览器会话（服务端反代目标站），回一次性令牌；界面那侧 iframe 走 opaque origin，不开 allow-same-origin |
| DELETE | `/api/sources/{id}/browser/session` | 是 | 关掉内置浏览器会话 |
| GET | `/api/sources/{id}/browser/cookies` | 否 | 内置浏览器会话里已抓到的 Cookie |
| DELETE | `/api/sources/{id}/browser/cookies` | 是 | 清掉内置浏览器会话里某个域的 Cookie；query：u=要清哪个域 |
| POST | `/api/sources/{id}/browser/external-login` | 是 | 拉起这台机器上的真浏览器登录（Chrome/Edge，独立临时 profile） |
| GET | `/api/sources/{id}/browser/external-login` | 否 | 查真浏览器登录的状态（进程还在不在、看到几个域） |
| POST | `/api/sources/{id}/browser/external-login/capture` | 是 | 从真浏览器的临时 profile 里把 Cookie 收进库 |
| DELETE | `/api/sources/{id}/browser/external-login` | 是 | 结束真浏览器登录并清临时 profile |
| GET | `/api/sources/{id}/browser/page` | 否 | 经服务端代理取目标站的一页（带上这一会话已落地的 Cookie 与 Referer）；query：t=必填，session 发的那枚令牌，u=必填，要打开的地址，charset=回包字符集按上游 Content-Type |
| POST | `/api/sources/{id}/browser/inline` | 是 | 在内置浏览器里以脚本方式提交（登录表单常见），回一个可接着读的资源键；请求体：字段=见 SourceLoginActionRequest |
| GET | `/api/sources/{id}/browser/res` | 否 | 取这一页的子资源（图片 / CSS / XHR），方法、请求体与 Content-Type 原样透传；query：t=令牌，u=资源地址 |
| POST | `/api/sources/{id}/browser/res` | 否 | 同上：以 POST 取/提交子资源；query：t=令牌，u=资源地址 |
| PUT | `/api/sources/{id}/browser/res` | 否 | 同上：以 PUT 提交子资源；query：t=令牌，u=资源地址 |
| PATCH | `/api/sources/{id}/browser/res` | 否 | 同上：以 PATCH 提交子资源；query：t=令牌，u=资源地址 |
| DELETE | `/api/sources/{id}/browser/res` | 否 | 同上：以 DELETE 提交子资源；query：t=令牌，u=资源地址 |
| GET | `/api/sources/{id}/browser/submit` | 否 | 以 GET 方式提交登录表单：除 t 与 u 之外的 query 参数都当作表单字段值，拼到 u 后面发给目标站。门是 session 令牌 t，不是 Origin；query：t=令牌，u=表单动作地址，字段名=当作表单值 |
| POST | `/api/sources/{id}/browser/submit` | 否 | 以 POST 提交登录表单：请求体与 Content-Type 原样转给目标站。门同样是令牌 t（外加 u），这条不看 Origin；query：t=令牌，u=表单动作地址 |

## 搜索（2）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| POST | `/api/search` | 是 | 同步搜索：所有源都跑完才一次性回（流式版本是 WS /api/search/stream）；请求体：keyword=书名或作者，sourceIds=不给就是全库启用源 |
| WS | `/api/search/stream` | 否 | 流式搜索：连上后逐源推结果，慢源不必等全库。它与其余 HTTP 条目的反差在于**没带 Origin 会被拒**（本机脚本得自己发一个 Origin: http://127.0.0.1:1234） |

## 书源订阅（5）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/subscriptions` | 否 | 书源订阅地址清单（订阅的是「一批书源的下载地址」，跟 RSS 订阅不是一回事） |
| POST | `/api/subscriptions` | 是 | 加一个书源订阅地址；请求体：url=订阅地址，enabled=默认 true |
| DELETE | `/api/subscriptions/{id}` | 是 | 删掉一个订阅（id 是数字主键，不是地址） |
| POST | `/api/subscriptions/{id}/update` | 是 | 立刻更新这一个订阅（去抓那个地址，把拿到的书源入库） |
| POST | `/api/subscriptions/update` | 是 | 更新所有启用的订阅 |

## 备份（3）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/backup/kept` | 否 | 服务器上留存的备份条目清单（手机导出的 .zip 里那几段，段级存下来了） |
| GET | `/api/backup/kept/{name}` | 否 | 取其中一个条目的 JSON 原文（name 用清单里给的那个，别自己拼） |
| POST | `/api/backup/import` | 是 | 上传手机导出的 .zip 备份包入库（multipart）；请求体：file=multipart 文件字段，必须是 .zip，password=可选，加密包用的 |

## RSS（7）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/rss/sources` | 否 | RSS 订阅源列表（投影，不含规则 JSON）；query：q=可选，按名称或地址筛 |
| POST | `/api/rss/sources` | 是 | 一批导入 RSS 源；请求体：sources=["每份是 RSS 源 JSON 字符串"] |
| POST | `/api/rss/sources/enabled` | 是 | 启用或停用某家 RSS 源；请求体：sourceUrl=哪家，enabled=开或关 |
| DELETE | `/api/rss/sources` | 是 | 删一家 RSS 源；query：sourceUrl=要删哪家（必填） |
| GET | `/api/rss/tabs` | 否 | 某家 RSS 源的分栏；supportsPaging 说这一栏吃不吃页码；query：sourceUrl=哪家（必填） |
| POST | `/api/rss/articles` | 是 | 取某一栏某一页的文章列表；请求体：sourceUrl=哪家，url=栏目地址，page=默认 1 |
| POST | `/api/rss/content` | 是 | 取一篇文章的正文；请求体：sourceUrl=哪家，link=文章地址 |

## 阅读（5）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| POST | `/api/books/details` | 是 | 取一本书的详情（顺带把封面异步抓进缓存）；请求体：sourceId=书源地址，bookUrl=书页地址 |
| POST | `/api/books/chapters` | 是 | 取这本书的目录（有缓存先给缓存；在线书挂了可能回落到按正文切章）；请求体：sourceId=书源地址，bookUrl=书页地址 |
| POST | `/api/books/content` | 是 | 取一章正文（净化规则已套上；离线缓存命中就直接给缓存；有 AI 覆盖就回覆盖版）；请求体：sourceId=书源地址，chapterUrl=章节地址，bookUrl=可选，用于查缓存与套书级净化规则 |
| POST | `/api/books/content-process` | 是 | AI 闭环：落一份「AI 净化/润色覆盖正文」，下一次读这一章就回覆盖版（正文实时重载）；请求体：sourceId=哪本书，bookUrl=哪本书，chapterUrl=哪一章，kind=ai_clean（净化）/ ai_rewrite（润色），original=原始正文，processed=AI 处理后的正文 |
| DELETE | `/api/books/content-process` | 是 | 撤掉某一章的 AI 覆盖（恢复原始正文）；query：sourceId=哪本书（必填），bookUrl=哪本书（必填），chapterUrl=哪一章（必填），kind=ai_clean/ai_rewrite，缺省 ai_clean |

## 净化规则（10）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/replace-rules` | 否 | 净化规则列表（正文里那些广告、乱码行就是它们删的）；query：q=可选，按名字筛，group=可选，按分组筛，scope=可选，作用范围，bookName=可选，只看作用到某本书的那些 |
| GET | `/api/replace-rules/{id}` | 否 | 取一条规则的完整字段 |
| POST | `/api/replace-rules` | 是 | 新建一条净化规则；请求体：name=名字，pattern=正则或字面子串，isRegex=布尔，replacement=替换成什么，scope=作用范围，group=可选，timeoutMillisecond=可选 |
| PUT | `/api/replace-rules/{id}` | 是 | 改一条净化规则：整条覆盖，字段与新建那条一样，id 以路径里的为准；请求体：字段=与 POST /api/replace-rules 同一套，整条覆盖 |
| DELETE | `/api/replace-rules/{id}` | 是 | 删掉一条净化规则 |
| POST | `/api/replace-rules/delete-batch` | 是 | 一次删掉多条净化规则；请求体：ids=["规则 id"] |
| POST | `/api/replace-rules/toggle` | 是 | 一次启用或停用多条净化规则；请求体：ids=["规则 id"]，enabled=布尔 |
| GET | `/api/replace-rules/export` | 否 | 导出规则（不给 id 就是全部）；query：id=可选，可重复 |
| POST | `/api/replace-rules/import` | 是 | 一批导入净化规则（吃 GET /api/replace-rules/export 吐出来的那种字符串数组）；请求体：sources=["每条是规则的 JSON 字符串"] |
| POST | `/api/replace-rules/preview` | 否 | 拿一段文本试规则（不落库、不发消息；它是只算一次的本地判定，所以不过写门）；请求体：text=要试的正文，rule=可选，整条规则对象（字段同 POST /api/replace-rules），不是规则字符串 —— 给它字符串会 400 invalid_request，bookName=可选，按书筛规则，sourceUrl=可选，按源筛 |

## 书架（16）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/bookshelf` | 否 | 书架清单（按最后阅读时间倒序） |
| POST | `/api/bookshelf` | 是 | 把一本书加进书架（同一 sourceId+bookUrl 再来一次是更新，不会重复）；请求体：sourceId=书源地址，bookUrl=书页地址，name=书名，author=可选，tocUrl=目录地址，coverUrl=可选 |
| POST | `/api/bookshelf/import-local` | 是 | 导入本机文件（txt/epub 等，multipart 一次一批）；query：tocRule=可选，用哪条分章规则；不给就走自动判定；请求体：file=multipart 文件字段，可多个 |
| GET | `/api/bookshelf/groups` | 否 | 书架上的分组清单（那个虚拟的「未分组」不在这份里，它是 groupId=0） |
| POST | `/api/bookshelf/groups` | 是 | 新建一个书架分组；请求体：name=分组名 |
| DELETE | `/api/bookshelf/groups/{id}` | 是 | 删一个分组（组里的书回到未分组，不删书） |
| PUT | `/api/bookshelf/group` | 是 | 把一本书挪到某个分组；请求体：sourceId=哪本书，bookUrl=哪本书，groupId=目标分组，null 或 0 即未分组 |
| PUT | `/api/bookshelf/order` | 是 | 存一份书架自定义排序（整串书的次序）；请求体：books=[{sourceId,bookUrl}]，按你想要的顺序 |
| DELETE | `/api/bookshelf/order` | 是 | 清掉书架自定义排序，回到按最后阅读时间排（无请求体） |
| DELETE | `/api/bookshelf` | 是 | 从书架删一本书（顺带清它的封面与离线缓存）；query：sourceId=哪本书（必填），bookUrl=哪本书（必填） |
| PUT | `/api/bookshelf/status` | 是 | 标已读 / 取消已读；请求体：sourceId=哪本书，bookUrl=哪本书，completed=布尔 |
| PUT | `/api/bookshelf/info` | 是 | 改书架上这本书自己的书名/作者/封面（不动书源）；请求体：sourceId=哪本书，bookUrl=哪本书，name=新书名，不许空，author=可选，coverUrl=可选 |
| POST | `/api/bookshelf/switch-source` | 是 | 换源：把书架上这本书从旧源切到另一家源，保留阅读进度；请求体：oldSourceId=旧书源，oldBookUrl=旧书地址，book=新的那一份（同加书架那几个字段），alternateSources=候选源列表 |
| POST | `/api/bookshelf/batch-delete` | 是 | 一次从书架删掉多本书；请求体：books=[{sourceId,bookUrl}] |
| POST | `/api/bookshelf/batch-move-group` | 是 | 一次挪多本书到某分组；请求体：books=[{sourceId,bookUrl}]，groupId=目标分组 |
| POST | `/api/bookshelf/batch-mark-read` | 是 | 一次标多本已读/未读；请求体：books=[{sourceId,bookUrl}]，isRead=布尔 |

## 分章规则（7）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/books/toc-rules` | 否 | TXT 分章规则表：可选项、当前启用哪条、哪些是用户改过的 |
| POST | `/api/books/toc-rules/toggle` | 是 | 开关某条具体规则（auto 与内置规则不许开关）；请求体：key=规则 id，enable=布尔 |
| POST | `/api/books/toc-rules/save` | 是 | 新建或改一条分章规则；请求体：key=不填=新建，填规则 id=改这条，name=名字，rule=正则原文，example=样例文本，enable=布尔 |
| POST | `/api/books/toc-rules/delete` | 是 | 删一条用户建的规则；请求体：key=规则 id |
| POST | `/api/books/toc-rules/reset` | 是 | 把规则表还原成随包那份（清掉所有本机覆盖） |
| POST | `/api/books/toc-rules/apply-backup` | 是 | 把手机备份包里的 TXT 分章规则搬进本机规则表 |
| POST | `/api/books/reparse-local` | 是 | 本机的书换一条分章规则重切目录；请求体：sourceId=哪本书，bookUrl=哪本书，ruleKey=用哪条规则（auto 表示自动判定） |

## 离线缓存（3）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| POST | `/api/bookshelf/cache` | 是 | 排队把一段章节缓存到本机（任务在服务端后台跑，这条立刻回）；请求体：sourceId=哪本书，bookUrl=哪本书，startIndex=从第几章，endIndex=到第几章，count=或直接给章数 |
| GET | `/api/bookshelf/cached-chapters` | 是 | 这本书已经缓存了哪些章（代码里这条也调了同源写门，但 GET 属安全方法，那道门自己就放行）；query：sourceId=哪本书，bookUrl=哪本书 |
| DELETE | `/api/bookshelf/cache` | 是 | 停掉这本书正在跑的离线缓存任务，可选连已经下载好的正文一起清掉；query：sourceId=哪本书，bookUrl=哪本书，clearData=给了才连已缓存的正文一起删 |

## 图片与媒体（6）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/covers/{key}` | 否 | 按缓存键取本机已有的一张封面（回的是图片字节，不是 JSON） |
| GET | `/api/covers/proxy` | 否 | 代取外部封面：浏览器发不出 Referer，站点的防盗链就 403，这一条由服务端带着 Referer 去取并落缓存；query：url=封面地址（必填），referer=可选，防盗链要的那一跳 |
| GET | `/api/books/local/asset` | 否 | 取本机书（EPUB 那类）里内嵌的一张图/一个资源；query：bookId=本机的书标识，path=包内相对路径 |
| GET | `/api/book/image` | 否 | 正文配图代理（阅读器和朗读页都走这一条，缓存上限 5 MiB）；query：url=图片地址（必填），page=这一张所在的那一页 —— 拿来当 Referer，图站按防盗链判来源 |
| POST | `/api/book/image/refresh` | 是 | 把一张已经失败的正文图重取一遍：先取到再原子覆盖缓存，取不到就留着原来那份，不会把图挖空；query：url=图片地址（必填），page=所在页，当 Referer |
| GET | `/api/book/media` | 否 | 音视频流式代理（音频/视频/EPUB 直链）：浏览器原生 audio/video 带不上 Referer 与 Cookie，这条由服务端代取并原样转发 Range，所以能拖进度；query：url=媒体地址（必填），referer=可选 |

## 进度与笔记（9）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/reading-progress` | 否 | 读一本书上次读到哪；query：sourceId=哪本书（必填），bookUrl=哪本书（必填） |
| PUT | `/api/reading-progress` | 是 | 存阅读进度（scrollPosition 是章内 0–1 的比例）；请求体：sourceId=哪本书，bookUrl=哪本书，chapterUrl=哪一章，chapterIndex=第几章，不能为负，scrollPosition=0.0–1.0，必须是有限数 |
| GET | `/api/reading-log` | 否 | 最近几天的阅读时长（界面「今日已读」那一栏就是它）；query：days=回几天 |
| POST | `/api/reading-log` | 是 | 累加一段阅读时长到「今天」这一行（同一天同一本书只有一行，秒数相加）；请求体：sourceId=哪本书，bookUrl=哪本书，bookName=书名，chapterIndex=读到第几章，seconds=这一段读了多少秒，负数按 0 |
| GET | `/api/notes` | 否 | 一本书的笔记清单；query：sourceId=哪本书（必填），bookUrl=哪本书（必填） |
| POST | `/api/notes` | 是 | 划一条笔记（选段本身在 excerpt 里，正文不动）；请求体：sourceId=哪本书，bookUrl=哪本书，bookName=书名，chapterUrl=哪一章，chapterIndex=第几章，startOffset=章内起点，endOffset=章内终点，excerpt=选中的那段原文 |
| PUT | `/api/notes/{id}` | 是 | 给一条笔记补写想法；请求体：note=笔记文字 |
| DELETE | `/api/notes/{id}` | 是 | 删掉一条笔记（阅读器划词那条弹层里的删除） |
| GET | `/api/book-search` | 否 | 本书正文检索：在已离线缓存的章节正文里按关键词子串找命中（没缓存的章节搜不到）；query：sourceId=哪本书（必填），bookUrl=哪本书（必填），q=关键词（必填，非空） |

## 朗读（9）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/tts/voices` | 否 | 可选的朗读音色清单 |
| POST | `/api/tts/session` | 是 | 开一个朗读会话（边合边播，比整章一次性 /tts/speak 起播快） |
| POST | `/api/tts/session/{id}/chunks` | 是 | 往会话里塞一片要念的文本（按章/段带序号，服务端按序排队合成）；请求体：chunkId=这片自己的标识，text=要念的文本，chapterIndex=第几章，paragraphIndex=第几段，engine=引擎，voice=音色，rate=语速，pitch=音高，customUrl=自建引擎才填，customHeader=可选，customMethod=可选 |
| POST | `/api/tts/session/{id}/control` | 是 | 控制这个会话：暂停 / 继续 / 跳到某片 / 停；请求体：action=动作名 |
| DELETE | `/api/tts/session/{id}` | 是 | 关掉会话并丢掉它排队的分片 |
| GET | `/api/tts/session/{id}/audio` | 否 | 从会话里取已经合好的那一段音频（播完一片再取下一片） |
| GET | `/api/tts/session/{id}/events` | 否 | 这个会话的事件流：哪一片好了、能播了、出错了吗 |
| POST | `/api/tts/speak` | 是 | 一次性把一段文本合成完整音频（整章文本走会话那条更好）；请求体：text=要念的文本，不许空，voice=音色，rate=语速，pitch=音高，engine=引擎，customUrl=自建引擎才填，customHeader=可选，customMethod=可选 |
| GET | `/api/tts/speak` | 否 | 同样的一次性合成，参数走查询串（给 audio 标签这种没法发 POST 的地方用）；query：text=文本（必填），voice=音色，rate=语速，pitch=音高 |

## AI 自定义接入（8）

| 方法 | 路径 | 写门 | 说明 |
|---|---|---|---|
| GET | `/api/agent/manifest` | 否 | 列出 AI 能力的清单（工具名 / 分组 / 是否写库），以及是否登记了外部连接 |
| GET | `/api/agent/connections` | 否 | 列出当前已登记的外部连接（没有就是空列表） |
| POST | `/api/agent/connections` | 是 | 注册或更新一个外部连接（OpenAI 兼容），落到 agent-profiles.json，重启仍生效；需同源写门；请求体：id=可选，缺则按 name 生成，name=连接名（必填），kind=openai-compatible（唯一支持），baseUrl=模型网关地址，apiKey=可选，model=可选模型名，options=可选键值对 |
| DELETE | `/api/agent/connections/{id}` | 是 | 删除一个外部连接，清掉对应 agent-profiles.json 记录；需同源写门 |
| POST | `/api/agent/sources` | 是 | 新建或覆盖一份书源（AI 也能写库）：json 是整份书源字符串，带 version 防并发覆盖；需同源写门；请求体：json=整份书源 JSON 字符串，version=可选，版本不符回 409 version_conflict |
| POST | `/api/agent/sources/validate` | 否 | 只校验书源合法性不落库（AI 接入前的探针）：结构能解析就 valid=true；请求体：json=整份书源 JSON 字符串 |
| POST | `/api/agent/comprehend` | 否 | 文章阅读理解：必须有外部模型连接，不落库；请求体：text=文章正文（必填），question=可选问题，给出则返回答案句，summarySentences=默认 3，topKeywords=默认 8 |
| POST | `/api/agent/chat` | 否 | 自由对话（多轮）：必须有外部模型连接，不落库；请求体：messages=[{role:system\|user\|assistant, content:string}]，至少一条非空 |

