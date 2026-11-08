# 当前结构与成果

> ⚠️ **本文写于 0.2.14，版本与规模数字已过期**；当前事实以 `product/docs/restructure/facts.md` 为准（带命令与时间戳）。
>
> 版本 **0.2.14** ｜ 分支 `main` ｜ 远端 `linqinqiu/legadoQ`（私有） ｜ 后端 **927** 项测试 / Web **900** 项测试，全绿
> 本文只写**现在真实具备的能力**，规划中的东西放在最后「已知缺口」一节，且明确标注是缺口。

---

## 1. 仓库形态

`E:\legado` 本身就是 git 仓库（origin = `linqinqiu/legadoQ`），不再分内外两层：

| 路径 | 是什么 |
|---|---|
| `product/` | **唯一能跑的产品**：Kotlin/Ktor 后端 + 内置 Web UI + 桌面壳 + 打包脚本 |
| `docs/` | 总览、API 参考、目录规划、研究笔记与实测记录 |
| `VERSION` / `package.json` | 安装根版本封条与 npm 入口（`npm start` → `product/start.mjs`） |
| `legado-releases/` | 本地留存的历史发行产物 |

版本号真源是 `product/app/build.gradle`；`product/package.json`、`product/web/package.json`、根 `package.json`、根 `README.md`、根 `VERSION`、`agent-api.json` 六处是抄本，由 `npm run version:check`（7 处含真源）钉住一致。

---

## 2. 后端结构（Kotlin / Ktor 3.4.3，JDK 17）

**规模**（实测计数）：后端 129 个源文件 / 约 3.40 万行，128 个测试文件 / 1,009 项测试；前端 186 个 `.ts/.tsx` / 约 3.67 万行，128 个测试文件 / 1,003 项测试。

### 2.1 包职责

| 包 | 职责 |
|---|---|
| `http/` | 路由与 HTTP 边界：13 个 `*Routes.kt` 域模块 + `Routes.kt` 只做域声明；系统域（目录/服务/日志/诊断/关于/更新日志）独立成 `http/system/SystemRoutes.kt`；`Guard.kt`（同源写门）、`NetworkSecurity.kt`（出站 SSRF）、`RouteCatalog.kt`（端点目录）、`ProxyHeaders.kt` |
| `data/` | 表级 DAO，全部写成 `Database` 的扩展函数；`Database.kt` 只是组合根（连接池 / 建表 / 迁移 / Cookie 工具四件事拆在 `data/db/`：`ConnectionPool` `Schema` `Migration` `CookieUtil`） |
| `reading/` | 阅读域收口 `ReadingRepository`：进度 / 阅读记录 / 笔记划线书签 / 本书检索 / 章节窗口 |
| `ai/` | 进程内 AI 网关：三种协议（OpenAI 兼容 / Responses / Anthropic）、流式 SSE、工具循环、连接与预设、技能库、内置工具与参数 schema、MCP 客户端（外部工具接入） |
| `rules/` | 书源规则引擎（Rhino 沙箱、正文/目录/搜索规则、loginUi V1/V2 渲染与动作）；`RuleProcessor` / `RuleContext` / `RuleDispatcher` 是**已接入的扩展点**（0.2.34：求值前先问处理器、没人认领再走内联），`rules/processor/demo/` 是两个可直接注册的示例 |
| `source/` | 书源模型与登录链路（真浏览器登录、跨域凭据抓取、Cookie 罐） |
| `cache/` | 正文缓存、封面缓存、缓存任务调度 |
| `localbook/` | 本地书解析（TXT 分章 / EPUB） |
| `content/` | 正文净化与标题处理 |
| `subscription/` | 书源订阅、RSS |
| `tts/` | Edge TTS 与朗读会话 |
| `ops/` | 日志、更新检查、备份等运维面 |
| `backup/` | 备份包导入导出（zip 与裸 JSON，兼容兄弟项目扩展条目） |
| `model/` | 跨层数据模型（`@Serializable`） |

桌面壳 `DesktopLauncher.kt` 负责窗口、启动画面、托盘与安装目录解析。插件装载机制已整体移除（代码里没有 `plugin/` 包），保留的是工具 / 协议 / 连接选择策略三类**运行时注册表**扩展点。

### 2.2 端点分布（161 条 / 19 组）

| 组 | 条数 | 组 | 条数 |
|---|---:|---|---:|
| 内置浏览器 | 17 | 书架 | 16 |
| 登录与凭据 | 15 | AI 自定义接入 | 16 |
| 书源 | 12 | 净化规则 | 10 |
| 进度与笔记 | 9 | 朗读 | 9 |
| 系统 | 8 | RSS | 7 |
| 分章规则 | 7 | 阅读 | 6 |
| 图片与媒体 | 6 | 书源订阅 | 5 |
| 发现页 | 3 | 备份 | 5 |
| 离线缓存 | 3 | 搜索 | 2 |
| 目录 | 1 | | |

契约由 `resources/agent-api.json` 描述，`FrameworkContractTest`、`web/test/ApiCatalog.test.ts` 与源码双向核对；`npm run docs:api-check` 校验 `docs/API-REFERENCE.md` 一致。

### 2.3 数据层（SQLite，代码建 20 张表）

`source` `source_login_state` `cookie` `book_shelf` `book_group` `reading_progress` `reading_log` `book_note` `book_content_cache` `book_content_process` `book_cache_status` `book_toc_cache` `cover_cache` `replace_rule` `source_subscription` `rss_source` `log_entry` `source_health` `script_cache` `app_meta`

（分章规则不是独立表：`book_shelf.toc_rule` 记住这本书用哪条规则切的章。AI 连接、会话与技能走文件存储，不进库。**代码建的表 ≠ 磁盘上的表**：老库里可能留着已删功能的遗留表（如 0.6.12 移除书签后仍在的 `book_mark`），数表数量要用 `sqlite_master` 实测。）

写入走**单写连接 + 全局锁**（WAL + `busy_timeout` + 失败重连），避免流式搜索与进度写入并发撞 `SQLITE_BUSY`。启动时按碎片率决定是否 `VACUUM`。

---

## 3. 前端结构（TypeScript / React 19）

**规模**：175 个 ts/tsx / 约 3.46 万行（`src/`，实测计数）。

| 目录 | 内容 |
|---|---|
| `pages/` | 9 个页面组件：发现、书库、RSS（含面板）、备份、更新日志、阅读记录、关于、功能说明 |
| `features/reader/` | 49 项（另有 `settingsPanel/` `typeset/` `dict/` 三个子目录）：阅读器主体、目录虚拟列表、笔记/标注、TTS 引擎与播放条（`ReaderTtsManager` + `ReaderTtsContext`）、排版（无 DOM 布局引擎 + Worker）、分页缓存、翻页动画、手势/快捷键 |
| `features/bookshelf/` | 书架页 + 封面、空态引导、书类型、拖拽排序、布局与自定义顺序 |
| `features/source-editor/` | 书源页 + 编辑器面板、字段表单、健康体检、登录浮层（V1 表单 / V2 脚本动作）、换源弹窗、订阅面板 |
| `features/settings/` | 设置页 + 分区表（数据权威源 `settingsSections.ts`）、AI 工具、Cookie、壁纸分区 |
| `features/ai/` | AI 悬浮球、对话面板（流式）、多会话、连接管理、技能库 |
| `lib/api/` | 按域拆分的 API 客户端：`client.ts`（统一 fetch）+ `types.ts`（全部类型）+ `domains/{sources,search,reader,backup,agent,system,brand}.ts`；`lib/api.ts` 保留旧 `api` 对象形状作兼容层 |
| `lib/` 其余 | 品牌 store、导航、UI 上下文、离线存储、搜索 store 等 |
| `plugins/` | Slot / Extension 外壳：`slotRegistry`（槽位声明）、`extensionRegistry`（扩展注册）、`attachmentStore`（零依赖 `useSyncExternalStore` 挂载表）、`ExtensionSlot`（渲染占位） |
| `components/` | 通用弹层与控件（ContextMenu、Select、Toast、各类 Modal） |

**页面与业务的边界**：`pages/` 只放"路由级页面"，业务实现在 `features/<域>/`；`lib/api.ts` 是兼容层，
新代码按域引用（`lib/api/domains/*` 或 `lib/api` 的类型），旧的 `api.xxx` 写法继续可用。

**阅读器三个地基**：逻辑位置模型（章节 + 字符偏移 + 段落锚点 + 校验值，页码只作派生显示）；分页引擎（字体/字号/行距/边距/窗口精确分页，Worker 计算，IndexedDB 缓存，改字号靠锚点原地重量）；章节窗口（前接章 + 当前章 + 后接章，后端 `chapterWindow()` 已实现）。

---

## 4. 安全模型

这台服务**不设身份**（无账号、无 token、无会话），安全边界靠四条：

1. **只绑回环**：默认 `127.0.0.1:1234`，不对外监听。
2. **同源写门（全局 Ktor 插件）**：所有 `POST/PUT/PATCH/DELETE` 统一拦截，`Origin` 必须是服务自己；不带 `Origin` 的本机客户端放行。两类显式例外：只读 POST 白名单、书源登录 Cookie 同步（自己判来源）。
3. **出站 SSRF 闸门**：`NetworkSecurity` 对目标域名解析后逐 IP 判内网/回环/链路本地/CGNAT/组播/保留段；已覆盖书源抓取、封面、媒体代理、订阅、AI 外呼、登录页、自定义 TTS 重定向逐跳。
4. **两个默认关闭的开关**：AI 接内网/回环 baseURL 默认拒绝（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 才放行，且仍硬拒打回服务自己）；插件 jar 扫描默认关闭（`LEGADO_PLUGIN_JAR_SCAN=1` 才开）。

---

## 5. 质量门禁

| 门禁 | 命令 | 现状（0.2.14） |
|---|---|---|
| 后端测试 | `npm test`（`gradlew :app:test`） | **927 项 / 0 失败** |
| Web 测试 | `web: npm test` | **900 项 / 0 失败** |
| 类型检查 | `npm run check`（`tsc -b`） | 通过 |
| 端点文档一致 | `npm run docs:api-check` | 161 条 / 19 组，一致 |
| 更新日志 | `npm run changelog:check` | 无待记录（提交后钩子自动起草） |
| 版本单一来源 | `npm run version:check` | 7 处一致，0.2.14 |
| 真浏览器门禁 | `tools/verify/*-check.mjs` | 共 **46** 个脚本（约 40 个要活服务 + 真浏览器）：阅读排版、笔记、备份、缓存、登录跨域抓取等多条 |

CI：`ci.yml`（后端测试 / 前端类型检查与构建 / 版本一致性）、`version-gate.yml`（PR 要求代码变更带 CHANGELOG 或版本、Tag 与版本一致）、`contract.yml`（契约）。

---

## 6. 近两版交付

### 6.1 0.1.7（2026-10-28）

- 桌面版启动画面与完整托盘菜单（打开窗口、数据目录、日志目录、复制地址）。
- 品牌统一为 legadoQ：`legadoq.exe` / `legadoq-*.zip`，界面不再出现旧名；协议同意记录换新键。
- 窗口按屏幕自适应；移除安装提示条。
- 托盘图标改 PNG（Java 读不了 ICO）；启动失败留完整堆栈；悬浮球与面板按安全区留距。

### 6.2 0.1.8（2026-10-29）

- **正文手动刷新**：目录内单章或勾选多章强制回源覆盖缓存；失败直接报错，不拿旧正文冒充成功。
- **兄弟备份包导入**：按内容判别 zip / 裸 JSON，不依赖扩展名；兼容 MD3、Max、Night-Reader 等项目的条目标记，书源、书架、分组、替换规则、RSS、凭据一并导入。
- **登录界面本地解析**：`loginUi` V1 静态表单与 V2 脚本渲染（`render`/`action` 两条接口）在应用内直接可用。
- **AI 三种协议**：OpenAI 兼容、OpenAI Responses、Anthropic；预设自带协议与地址，连接表单可拉取模型清单。
- **流式对话**：SSE `start / delta / reasoning / tool_start / tool_end / usage / end / error`，可随时停止，思考过程与 token 用量可见。
- **技能库**：内置书源排错、阅读助手、书库整理三条；用户技能落 `{home}/agent-skills/<id>.md`，可覆盖、停用、删除（进回收站），按关键词或显式 id 最多选 3 条注入系统提示。
- **契约与工具体**：新增 4 条 AI 端点进目录；55 个内置工具补齐 JSON Schema 参数。

期间修掉的缺陷：内置技能 `builtin` 标记未置位（界面徽标与删除保护对不上）；端点计数断言停在 144；`SearchDeadlineTest` 用 `delay` 模拟阻塞会被取消吞掉（改用 `CountDownLatch` 模拟不可取消的写阻塞）；发版时根 `package.json` 与 `README` 版本漏抄（Version check 已扩到 7 处并把 README/契约纳入）。

### 6.3 0.1.9（2026-10-29）

- **提示词预设**：把「先给结论、不超过多少字」这类要求存成可开关、可排序的条目，落 `{home}/agent-prompts.json`；AI 接入弹窗新增「提示词」区块（停用/启用、上移/下移、编辑、删除），删除前整份文件备份进 `{home}/.trash`。与技能的分工写进界面与注释：预设管「怎么说话」，技能管「这类任务怎么做」。
- **注入顺序如实回报**：system 段顺序为宿主人设 → 提示词预设 → 技能；`promptsUsed` 只报真正注入的那几条（超出每轮预算被整条挡掉的不算「用了」）。
- **上下文预算**：`LEGADO_AI_MAX_CONTEXT_CHARS`（默 24000 字符）超了从最旧的**整轮**开始丢，以 user 消息为段边界，不拆散工具调用与它的结果；system 与最后一条用户消息必留，那条自己超预算也不截。`trimmed` 随 `start` / `end` / `chat` 回报，气泡显示「已裁历史 N 条」。
- **三条新端点**：`GET/POST /api/agent/prompts`、`DELETE /api/agent/prompts/{id}`（后两条过同源写门）；端点总数 151 → 154，AI 自定义接入组 13 → 16。
- **实测揪出并修掉的竞态**：`agent-prompts.json` 是整份「读 → 改 → 写」，界面点一次「上移」并发两条保存，后落盘的把先落盘的顶掉（实测两条 order 变成同一个数）。修法两层：存储层加写锁（`save` / `delete` 串行），前端改成顺序 await 两条保存；判据 `并发保存不能互相顶掉` + 一条源码判据盯住不许再用 `Promise.all`。
- **新增判据**：`AgentPromptContextTest`（15 项，断言打在 provider 实际收到的消息序列上——只看返回码分不清「没注入」与「注入了但被裁掉」）、`AgentRoutesHttpTest` 三条 prompts 用例（含跨站写被拒）、`AiPromptPresets.test.ts`（7 项，守界面区块、API 接线与顺序保存）。

---

## 7. 已知缺口（按价值排）

| 缺口 | 现状 | 影响 |
|---|---|---|
| ReaderScreen 未拆完 | 已拆出 TTS（`ReaderTtsManager` + `ReaderTtsContext`）、目录（`ReaderCatalog`）、设置（`ReaderSettingsSheet`），`ReaderScreen.tsx` 2942→2863 行；**正文渲染与分页测量**仍在里面 | 剩下两块是交互核心（段落点击/划词/图片放大/分页锚点），拆它们要先补交互判据，否则改坏了静态测试看不见 |
| 图标小尺寸清晰度 | 512 插画细分多，16–24px 仍糊；ICO 尺寸声明已修（按档渲染 16/24/32/48/64/128/256） | 任务栏/托盘辨识度（要根治得换扁平标记，待定） |
| 可观测性 | 解析/规则求值/出站抓取已有分阶段耗时与失败率（`GET /api/diagnostics` 的 `stages`，运行日志页可展开）；**前端分页测量仍无指标** | 后端慢在哪一层能查了，界面卡顿仍只能靠猜 |
| 发布链路 | 有打包脚本与手动发布，未做签名 | 产物未签名 |
| 插件 jar 装载 | 默认关闭、无沙箱 | 有意为之，不是缺陷 |

---

## 8. 一句话总结

后端是「单进程 + 单写 SQLite + 19 组 HTTP 端点」的本地阅读服务，前端是自研排版引擎的 Web 阅读器；0.1.8 把 AI 侧补成「多协议 + 流式 + 技能 + 工具 schema」的完整闭环，0.1.9 再加上可开关排序的提示词预设与按整轮裁剪的上下文预算，阅读侧补上正文刷新、兄弟备份导入与登录界面本地解析。质量靠 2,012 项自动化测试（1,009 后端 + 1,003 前端）、7 条命令门禁与 46 个 `tools/verify/*-check.mjs` 脚本守着。当前最大的未完成项仍是**阅读器的跨章定位体验**与**把内联解析搬进处理器（把 RuleRunner 拆薄）**。
