# legadoQ 长期任务框架：研究、对照与建议

> **采纳状态（2026-11-12）**：本文档由用户提供的外部建议（2026-11-11 生成）采纳为仓库长期路线图。
> 当前阶段：**S0 兼容内核** —— C-01 RSS/Atom 直解、C-02 分页占位均已收口并随 **0.2.39（build 52）** 发版推送
> （后端全量 1119 项过、DNS 双红为环境误报已定向复跑确认；判据见 compatibility.md §4.1 与对应测试）；
> **C-03 段评只读**为下一活动切片（后端规则执行 + 新端点 + 阅读器只读浮层，先补判据）。
> 执行纪律：垂直切片、先补判据、每片单独提交；长期任务经用户授权（2026-11-12）**全自主闭环**：
> 实现→验证→提交→发版→推送自行抉择，不逐次请示，不怕破坏性代码删改（git 保历史）。阶段进展见各切片提交与 `docs/sessions/`。

> 文档性质：基于公开仓库与项目自有文档的客观整理，供开发决策使用。  
> 生成日期：2026-11-11  
> 对象仓库：https://github.com/linqinqiu/legadoQ  
> 借鉴仓库：https://github.com/HapeLee/legado-with-MD3  

---

## 1. 文档范围与数据来源

### 1.1 范围

- 整理 legadoQ 当前能力与边界（以项目自有文档为准）
- 对照开源阅读生态中的兼容差异（以 legadoQ `compatibility.md` 为准）
- 以 **legado-with-MD3** 公开 README / Release 描述为借鉴清单（不臆测未公开实现）
- 给出可执行的长期任务框架（分层、阶段、模块矩阵、验收纪律）

### 1.2 主要数据来源（客观、可复核）

| 来源 | 路径或地址 | 用途 |
|------|------------|------|
| legadoQ README | `https://github.com/linqinqiu/legadoQ` / `README.md` | 产品定位、功能表、安全模型、版本 |
| legadoQ 兼容说明 | `product/docs/compatibility.md` | 与上游书源语义差异的权威表 |
| legadoQ 功能说明 | `product/docs/功能说明.md` | 用户可见能力清单 |
| legadoQ 待定功能 | `product/docs/待定功能.md` | 已移出界面、边界已定的设计记录 |
| legadoQ 架构 | `docs/ARCHITECTURE.md` | 端点数、域划分、表、安全边界 |
| legadoQ Changelog | `product/CHANGELOG.md` | 近期已交付能力（如阅读记录汇总） |
| MD3 README | `https://github.com/HapeLee/legado-with-MD3` | 分支特性原文 |
| MD3 English.md | 同仓库 | 英文特性表述对照 |
| MD3 Releases | 如 3.26.12 / 3.26.13 / 3.26.25 等 | 公开「新增」条目（主题、记录、缓存管理、设置搜索等） |
| MD3 开发文档站 | `https://hapelee.github.io/legado-with-MD3/dev/` | 规则/首页模块/段评等规范入口 |

### 1.3 刻意不采用的依据

- 未在兼容文档或源码 grep 中证实的「上游某文件某行」细节（除非项目自己已写入 compatibility.md）
- 对 MD3 内部未公开模块的猜测
- 无版本号、无公开描述的「社区传说功能」

---

## 2. legadoQ 客观现状摘要

### 2.1 产品定位（README）

- **本地小说 / 漫画阅读服务**
- 技术栈：Kotlin + Ktor 后端、SQLite、内置 Web UI（React）
- 默认监听：`127.0.0.1:1234`
- 数据只在本机；不内置任何书源、订阅源或作品内容
- 当前文档记载版本示例：**0.2.38**（以运行时 `/healthz` 为准）
- 许可：根目录 MIT；`product/` 为 GPL-3.0

### 2.2 功能面（README 功能表，客观罗列）

| 功能面 | 能力（文档原文归纳） |
|--------|----------------------|
| 书架 | 增删、分组、拖动排序、阅读进度、批量操作 |
| 阅读 | TXT / EPUB；滚动与分页；字号/行距/字体/配色/简繁；目录；划线笔记；阅读记录 |
| 搜索 | 多书源并发；WebSocket 流式；可中途停止 |
| 发现 | 按书源 exploreUrl 分栏浏览 |
| 书源 | JSON 文本/文件/URL 导入；编辑；逐阶段调试；体检；分组与排序；书源订阅 |
| 登录与凭据 | Cookie 管理、登录动作、内置浏览器完成登录 |
| 离线缓存 | 服务端按章节缓存；浏览器 IndexedDB |
| 分章规则 | 内置 TXT 分章；可新建编辑；按文件自动匹配 |
| 净化规则 | 增删改、导入导出、预览 |
| 图片与媒体 | 漫画逐图、音频、视频、文件直链 |
| 朗读 | Edge TTS、自定义 HTTP 音频、浏览器语音；跨章连播、定时 |
| RSS | 订阅源与文章读取 |
| 备份 | Legado 备份包导入与导出 |
| 系统 | 服务端口、运行日志等 |
| PWA | 可安装到桌面，支持离线壳 |

### 2.3 架构客观数字（ARCHITECTURE.md 快照说明）

| 项 | 数值或描述 | 备注 |
|----|------------|------|
| HTTP 端点 | **161** 条 | 19 组；以 `/api/catalog` 为准；文档注明为 2026-11-10 快照，发版后可能变化 |
| 路由组织 | Routes 装配点 + 多域 `*Routes.kt` | 领域含 source、rules、content、localbook、cache、tts、backup、subscription、ai、ops、reading 等 |
| 数据库 | SQLite WAL；代码建表约 **20** 张 | 书源、书架、进度、笔记、缓存、规则、订阅、日志等 |
| 安全 | 默认仅回环；写操作要求同源 Origin；出站拒内网/保留地址 | 无账号无 token；`LEGADO_HOST=0.0.0.0` 等于把写权限交给局域网 |
| 前端 | React 19 + Vite；构建进 jar | PWA / 静态 SPA |

### 2.4 书源语法支持度（compatibility.md 表格摘要）

**支持（文档标明支持）：**  
CSS（Jsoup）、XPath（`@xpath:`）、JSONPath / `@Json:`、`||` 备选、`<js>` / `@js:`（Rhino，允许顶层 return）、`{{…}}` 表达式、`:正则` 列表与 `$1`、comment 脚本、Packages/JavaImporter 白名单、java.ajax / ajaxAll / cache / cookie / jsLib、imageDecode、媒体类型 1–4、登录多入口等。

**明确不支持或行为不同：**

| 项 | 文档结论 |
|----|----------|
| 分页占位 `<1,2,3>` | **不支持**（上游写法）；请用 `{{page}}` 或自行拼接 |
| `webView: true` / 依赖 WebView 过挑战 | **不支持**；体检标 `needs_webview` |
| `ruleReview` 段评 | **不执行**（字段可存可备份，不产出段评） |
| 标准 RSS/Atom 且未写 `ruleArticles` | **不列目**（必须有列表规则，否则只能开原页） |

**登录：** 文档写明五条路（填表 / 内置反代浏览器 / 真浏览器 / 粘贴 Cookie / 书签回传），与上游单一 WebView 登录不同。

**备份加解密：** 文档写明按上游 BackupAES 口径（AES/ECB/PKCS5Padding，密钥派生方式与上游一致）。

### 2.5 近期已落地、与「体验层」相关的客观变更（Changelog）

以下摘自 `product/CHANGELOG.md` 已发布条目（非规划）：

- 阅读记录：汇总卡片、按书统计、最近 30/90/365 天窗口（0.2.37）
- 书架默认只铺前 120 本 + 加载更多（0.2.37）
- 书签接回界面；与划线共用笔记表；按章+段落跳转（0.2.22，待定功能中已标记落地）
- 漫画双页对开、读到第几张记忆（0.2.27）
- AI：模型连接、技能、提示词、MCP 外部工具、按任务选模型等（多版本）
- 运行诊断、书源无规则标记、Windows 免安装包等

---

## 3. 借鉴对象：legado-with-MD3 公开特性

### 3.1 项目定位（README 原文归纳）

- 基于开源阅读（Legado）的 **Material Design 3** 风格重构版本
- UI 重绘 + 多项分支独有功能
- 逐步从传统 View 迁移至 Jetpack Compose
- Stars 量级：公开页约 **6.9k–7k**（随时间变化，以 GitHub 实时为准）

### 3.2 分支特性（README「相比于官方版本」列表）

| 序号 | 公开描述 |
|------|----------|
| 1 | 全新 Material Design 3 设计界面；预测性返回手势；共享元素动画 |
| 2 | 更加个性化的阅读界面与菜单配置 |
| 3 | 详尽的阅读记录；**时间轴**与**章节维度**统计 |
| 4 | 更健全的**漫画阅读**、**有声书**与**发现**界面体验 |
| 5 | 更多书架布局选择；针对**平板端**的界面优化 |
| 6 | 书籍备注；**智能伴生分组**（自动归类已读/未读）；手柄上下翻页 |

### 3.3 Release 中可核对的相关「新增」方向（示例，非全量）

来自公开 Release 说明（如 3.26.12、3.26.13 等页面可见条目）：

- MD3 主题管理与分享系统
- 阅读记录展览、成就卡片、书籍详情阅读历史
- 缓存管理界面；下载线程调整
- 设置项搜索与定位
- 换源界面多选分组/书源、源编辑
- 发现页更多样式；主页模块可配置（另有 homepageModules 规范文档）
- 段评相关（如弹窗高度）；漫画导出图片文件夹/CBZ（较新 Release）
- AI 对话基础、章节总结等（分支后续版本）

**借鉴约束：** 仅将上述**已写在 README/Release 的能力名与体验目标**映射到 legadoQ 的 Web/服务架构；不引入 Android/Compose 实现栈。

---

## 4. 客观差距与优先级台账

### 4.1 兼容内核差距（来自 compatibility.md，最高优先级）

| ID | 差距 | legadoQ 现状 | 建议目标态 | 主要落点 |
|----|------|--------------|------------|----------|
| C-01 | 标准 RSS/Atom 无列表规则 | ✅ 已收口（0.2.39）：标准 feed 无规则直解列目 | 标准 feed 可直解列目 | subscription + Web RSS |
| C-02 | URL 分页 `<1,2,3>` | ✅ 已收口（0.2.39）：与上游语义一致，撤销误导告警 | 与上游语义兼容（可与 `{{page}}` 共存） | rules/RuleRunner |
| C-03 | ruleReview 段评 | 不执行 | 至少只读展示 | rules + reading + Web |
| C-04 | WebView 依赖源 | needs_webview 分档 | 保持诚实分档；可选外部引擎属扩展层 | source 体检 |

### 4.2 主路径与体验差距（功能说明 + MD3 公开特性对照）

| 主题 | legadoQ 已有客观基础 | MD3 公开可借鉴点 | 建议 |
|------|----------------------|------------------|------|
| 阅读记录 | 汇总卡片、按书、时间窗口 | 时间轴、章节维度、展览/历史 | 在现有 reading_log 上扩展查询与 UI，不重做进度模型 |
| 书架布局 | 卡片 + 分组 + 前 120 加载更多 | 多布局、平板优化、管理入口 | Web 增加列表/网格/紧凑；宽屏分栏 |
| 书籍备注 | 划线/笔记/书签 | 书籍备注 | 书级备注字段与详情展示（与段落笔记区分） |
| 智能分组 | 手工分组、已读完标记 | 已读/未读等伴生分组 | 虚拟/规则分组，可关，不覆盖用户组 |
| 缓存管理 | 整书缓存状态机、失败中止 | 缓存管理界面 | 占用、清理、暂停/恢复入口 |
| 主题 | 七套预设 + 自定义皮肤 | 主题管理与分享 | 导入/导出；是否进备份包需单独产品决策 |
| 发现/漫画 | 分栏发现、漫画双页与记忆 | 发现样式、漫画体验增强 | 样式与导出等作为体验层，不阻塞兼容层 |
| 设置 | 四分区 + 搜索 | 设置项搜索与定位 | 保持并强化，不新增顶级设置岛 |
| 换源 | 已有换源 | 多选源/分组、编辑入口 | 进度保持策略与失败说明写清 |

### 4.3 明确不纳入主线的项（客观冲突或形态不符）

| 项 | 原因 |
|----|------|
| Jetpack Compose / Android UI 迁移 | legadoQ 形态为本地服务 + Web UI |
| 默认内置 WebView 内核 | 与纯 JVM + 安全边界及 compatibility 结论冲突 |
| 内置书源或内容 | README 边界禁止 |
| MD3 comic 包本地 OCR/擦字等 | 依赖 Android 侧运行时与分包策略；无对等客观基础 |
| 完整段评发帖社区 | 超出「只读展示」最小目标；依赖 C-03 之后再评估 |

### 4.4 六大源仓库借鉴映射（Web 栈可移植性甄别，2026-11-12）

> 这六个仓库是借鉴仓 HapeLee/legado-with-MD3 的 README 致谢清单；本节往源头再挖一层。
> **硬约束**：legadoQ 是 Web 栈（React/Vite + Kotlin/Ktor），非 Android/Compose——
> 移植的是**算法思想与 UX 范式**，不是 Compose/View 代码。研究经隔离子代理核实源码级细节。

| 仓库 | 提供什么 | Web 可移植性 / 落点 | 优先级·状态 |
|------|----------|---------------------|-------------|
| **gedoor/legado** | 书源鼻祖：规则方言（@css:/@json:/@XPath:/@js:、&&\|\|%%、@put/@get、{{}}、##净化）、UrlOption、java.* 桥、nextTocUrl/nextContentUrl 翻页、ruleReview 段评、loginCheckJs/coverDecodeJs/jsLib；翻页/缓存/换源/简繁 UX | 服务端兼容基线，C-01/C-02/C-03 正在对齐。⚠️原仓因侵权案已清空仅存公告，取证用 gitee 镜像与教程 | 持续对齐基线（S0） |
| **Luoyacheng/legado-E**（阅读Sigma） | ⚠️**兼容增量**：`[newpage]` 正文分页、副文规则、`@webjs:`、eventListener+customButton、`java.refreshBookInfo/refreshBookToc/refreshContent/reLoginView/showBrowser`(半屏段评)`/showPhoto`、`chapter.update()`、`cache.get(onlyDisk)`、并发 skipRateLimit、登录检查规则、简介 HTML/MD/button、图片 click 键 | 书源会用、服务端不支持即报错。需逐项核实我们 JsSandbox 已支持哪些，再定缺口 | **兼容 backlog 待评估**（C-05+ 候选，先评估再决定是否插队 S0） |
| **komikku-app/komikku** | 漫画阅读器 UX：隐藏分类、批量收藏/多条目合并/范围选择迁移、**封面自动取色主题**、宽幅封面、更新错误屏+条目迁移、智能更新预览、更新分组、保存搜索芯片、源推荐 Feed；阅读器 tap zones（L形/电纸书/边缘）、webtoon 长条、宽页分割、双击缩放、跳过已读 | Compose 控件不可移植，取 UX 范式。tap zones 我们已有（`reader/interaction/tapZones`） | L2/L3 UX backlog |
| **FoedusProgramme/Gramophone** | 封面取色：确证**非 Palette API**，而是 Material `DynamicColorsOptions.setContentBasedSource(封面bitmap)` + `ColorUtils` HSL 派生背景/抬升/弱对比色，播放页 300ms 换色 | Web 等价：Canvas `getImageData` 量化选种子 + CSS transition。落点：阅读器/书详封面动态主题 | 封面主题链·组件①（S2 候选） |
| **jordond/MaterialKolor** | Material Color Utilities 的 KMP 移植：种子色→HCT→6 组 tonal palette→亮/暗 scheme（默认 TonalSpot，可调 contrast） | 官方 JS 移植 `@material/material-color-utilities`：`themeFromImage`/`themeFromSourceColor`/`applyTheme` 直接写 `--md-sys-color-*`，与我们现有 M3 令牌无缝对接 | 封面主题链·组件②（S2 候选） |
| **Calvin-LL/Reorderable** | 拖动排序：长按/即拖 handle、`onMove(from,to)`、`animateItem` 让位动画、边缘变速自动滚动、稳定 key | ✅**已有等价实现** `lib/dragSort.ts`（长按 250ms/移动阈值/边缘滚动/指针落点，书架与书源共用）；仅可选补让位动画 | 已对齐，勿重造 |

**综合判断（最高 ROI 新切片）**：Gramophone + MaterialKolor 合成「**书封面 → 种子色 → M3 动态主题**」链，
官方 `themeFromImage` + `applyTheme` 一个库即覆盖两者能力，且 komikku 也印证此范式。
落点齐全（7 套 theme-* 令牌 + `WallpaperLayer` + per-book `themeColor`）。注意：远程封面需 CORS（复用现有封面代理）、
量化前缩图、按书缓存。**排为 S2 候选，S0 收口后再开**；当前活动切片仍是 C-03。

---

## 5. 长期任务框架（结构性）

### 5.1 四层结构

```
L0  兼容内核层   书源/规则/RSS/分页/段评     → 决定「能不能用」
L1  阅读主路径层 书架/阅读器/记录/换源/缓存   → 决定「好不好用」
L2  体验与布局层 主题/布局/发现/漫画/备注/分组 → 借鉴 MD3 的主战场（Web）
L3  扩展与工程层 AI/可选引擎/同步/门禁/文档   → 差异化与可维护
```

**依赖规则：** L2/L3 不得绕过 L0 的兼容结论；L3 不得破坏默认回环与同源写门。

### 5.2 阶段（完成定义用客观产物，不绑死日历）

| 阶段 | 层级 | 主题 | 完成定义（可检查） |
|------|------|------|-------------------|
| S0 | L0 | C-01、C-02、C-03 | `compatibility.md` 对应行改写；各有可复现用例或测试 |
| S1 | L1 | 阅读记录时间轴+章节维、缓存管理、换源说明 | 功能说明与 UI/API 一致 |
| S2 | L2 | 书架多布局、主题导入导出、书级备注、虚拟分组 | 窄屏/宽屏各一套验收 |
| S3 | L2+L1 | 发现样式、漫画体验收口、设置搜索强化 | 不新增顶级主导航 |
| S4 | L3 | 可选外部引擎、WebDAV（配置/进度）、AI 阅读快捷动作 | 默关或显式配置 |
| 持续 | 工程 | API 契约、备份双向抽检、诊断指标、兼容表同步 | 发版清单可勾选 |

### 5.3 模块 × 层级矩阵

| 域 | L0 | L1 | L2 | L3 |
|----|----|----|----|-----|
| rules | 分页、段评执行 | — | — | — |
| source | 体检分档 | 换源协作 | — | 外部引擎适配 |
| subscription | RSS 直解 | — | 订阅/发现数据 | — |
| reading | 段评展示数据 | 记录/进度/笔记 | 备注、菜单配置 | AI 快捷 |
| cache | — | 生命周期/清理 | — | — |
| shelf | — | 换源后状态 | 布局、虚拟分组 | — |
| tts | — | 连播/定时体验 | — | httpTTS 文档对齐 |
| backup | — | 字段不丢 | 主题是否入包（决策） | WebDAV |
| ai | — | — | — | 快捷动作/MCP |
| web | 各入口 | 记录页/缓存页 | 主题/布局/发现 | 开关与设置 |
| docs/工程 | compatibility | 功能说明 | ROADMAP（可选） | 门禁与 sessions |

### 5.4 垂直切片模板（每个任务卡必填）

1. 用户故事（一句话）  
2. 数据：新列/新表或仅用现有表  
3. API：是否变更 `/api/catalog` 契约  
4. UI 入口  
5. 与 MD3 公开描述的对应句（若有）  
6. 验收步骤 + 回滚方式（开关或配置）  
7. 文档：compatibility / 功能说明 / Changelog 何者必改  

### 5.5 工程纪律（与现有仓库实践对齐）

| 纪律 | 客观依据 |
|------|----------|
| 兼容差异以 compatibility.md 为唯一台账 | 项目自有文档定位 |
| 增 API 须源码与契约双改 | ApiCatalog / ARCHITECTURE 门禁描述 |
| Changelog 只写用户可见；顺序 新增→变更→修复→移除 | product/CHANGELOG 约定 |
| 默认安全模型不放宽 | README 安全模型 |
| 借鉴可追溯 | 建议在 Changelog 或 docs 标注「对齐 MD3 公开特性：…」 |

### 5.6 Web 信息架构（建议长期固定）

```
主导航：书架 | 书库(搜索) | 发现 | 订阅
次级：书源管理 | 阅读记录 | 设置 | 关于
阅读器：独立壳（全屏）
设置分区：阅读 | 外观 | 数据与凭据 | 服务与接入
```

L2 新能力只挂入上述分区，避免再增加顶级设置岛。

---

## 6. 建议的近期唯一主线（可执行）

在框架依赖下，**优先只推进 S0**：

1. **C-01** 标准 RSS/Atom 无 `ruleArticles` 时直解列目  
2. **C-02** URL 分页占位 `<1,2,3>` 与现有 `{{page}}` 共存  
3. **C-03** `ruleReview` 段评只读展示  

S0 完成后再开 S1 中与 MD3 最直接对应、且 Changelog 已有基础的 **阅读记录时间轴 + 章节维度**。

---

## 7. 总结

| 维度 | 结论（有文档支撑） |
|------|-------------------|
| legadoQ 定位 | 本地优先、书源规则兼容、无内置内容的本机阅读服务；架构与门禁已较完整 |
| 最大客观短板 | compatibility 写明的 RSS 直解、分页占位、段评不执行；以及 WebView 源诚实分档 |
| MD3 最值得借的公开点 | 阅读记录多维度、书架多布局与平板友好、书籍备注、智能伴生分组、主题管理分享、缓存管理、设置搜索 |
| 不应借的 | Android/Compose 栈、默认 WebView、comic 本地推理包、内容与书源内置 |
| 长期方法 | L0→L1→L2→L3 分层；垂直切片；兼容表与契约同步；完成定义可检查 |

---

## 8. 附录：关键链接

- legadoQ：https://github.com/linqinqiu/legadoQ  
- legadoQ compatibility：仓库内 `product/docs/compatibility.md`  
- legadoQ 功能说明：仓库内 `product/docs/功能说明.md`  
- legado-with-MD3：https://github.com/HapeLee/legado-with-MD3  
- MD3 开发文档：https://hapelee.github.io/legado-with-MD3/dev/  

---

*本文件仅整理公开与项目自有客观信息及据此推导的任务结构；实现细节以各仓库当前源码与发版为准。*
