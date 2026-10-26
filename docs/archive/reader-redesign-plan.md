# 青阅阅读器 · 改造方案（reader-redesign-plan）

> **目的**：把 [`reader-archive.md`](reader-archive.md)（v0.8.4 现状清点）转成**可执行改造方案**。
> 本文件只讲「做什么 / 为什么 / 顺序 / 验收 / 红线」，不动手改代码。
> 细节论据、file:line、接口草图、门禁补丁均来自 `docs/research/01~07`，本文件只做汇总与编排。
>
> **基线**：v0.8.4（`VERSION` = `0.8.4`，服务 `http://127.0.0.1:1234`）。
> 代码基线：`legado/web/src/reader/` 35 文件约 6,200 行，核心 `ReaderScreen.tsx` 2,518 行。
> 关联：研究纪要 `docs/RESEARCH-NOTES.md` §8（框架纪律）、`docs/STRUCTURE.md`（目录与禁令）。
>
> ⚠️ **行号时效**：各研究报告的 `文件:行` 来自不同快照，`styles.css` 在审计期被追加 AI 悬浮球约 +78 行、另有成员 +77 行，**行号已漂移**。动手前一律先 `git diff` 复核，勿直接照抄行号。

---

## 0.1 阅读器增强 · 本会话实现追踪（2026-10 起，goal round 1–8）

> 以下均为**纯前端、可 `tsc`/门禁验证**的增强，全部 `npm run check` 退出 0、`npm test` 682 pass/0 fail。门禁纪律（UiContract / overlay-tier-check / CopyStyle / FrameworkHasNoContent / ApiCatalog）全程守住：未新增外壳/遮罩、未用装饰字形、未写未定义 CSS 令牌、未加任何 HTTP 路由。

| # | 增强 | 落点 | 复用既有 |
|---|---|---|---|
| 1 | 划线/标记菜单（划线/笔记/复制/AI） | `MarkingMenu.tsx` + `ReaderScreen` | `Select`/`toast`/令牌 |
| 2 | 阅读专属配色（护眼暖黄/豆沙绿/夜间黑读，只染阅读区） | `readerSettings.ts`/`ColorTab.tsx`/`styles.css` | `--surface/--line/--accent-*` |
| 3 | 顶栏一键护眼/夜间快捷开关（四态循环） | `Md3Chrome.tsx`/`ReaderScreen` | `md3-icon-btn`/`is-active`/`eye`/`moon` |
| 4 | 右键菜单补全划线/笔记/AI（抽 `buildSelectionDraft`） | `ReaderScreen` `onBodyContextMenu` | `ContextMenuItem`/`showContextMenu` |
| 5 | 目录当前章内进度指示 | `VirtualChapterList.tsx` `CurrentChapterProgress` | `readerProgress`（`getServerSnapshot` 过 SSR） |
| 6 | 目录已读/未读区分 | `VirtualChapterList.tsx` + `styles.css` | `--ink`/`--muted` |
| 7 | 目录头部全书已读比例 | `TocDrawerHeader.tsx` `overallProgress` | `color-mix`+`--accent` |
| 8 | 右键菜单「复制为引用」 | `ReaderScreen` `onBodyContextMenu` | `book` 图标/clipboard/toast |
| 9 | **书签**（后端 + 前端打通） | `Models.kt`/`ReadingDao.kt`/`Database.kt` + `MarkingMenu.tsx`/`NotesPanel.tsx`/`api.ts` | 复用 notes 表（新 `bookmark` 列 + 迁移 + `addNote/listNotes` 持久化）；前端 标记菜单/右键「书签」+ 笔记面板「全部/书签」过滤 + 书签徽标 |
| 10 | **搜索本书**（后端 + 前端打通） | `Models.kt`/`ReadingDao.kt`/`ProgressRoutes.kt`/`agent-api.json` + `api.ts`/`BookSearchDialog.tsx`/`Md3Chrome.tsx`/`ReaderScreen.tsx` | 新增只读路由 `GET /api/book-search`（目录总数 139→140，闸门同步）；查 `book_content_cache` 已缓存章节正文；底栏「搜书」打开弹窗，命中切章 |
| 11 | **阅读器 AI 闭环**（后端 + 前端打通） | `Models.kt`/`Database.kt`/`CacheDao.kt`/`ReadingRoutes.kt`/`agent-api.json` + `api.ts`/`ReaderAiDialog.tsx`/`Md3Chrome.tsx`/`ReaderScreen.tsx` | 新增 `book_content_process` 覆盖表 + DAO；`POST/DELETE /api/books/content-process`（目录总数 140→142，闸门同步）；`POST /api/books/content` 读路径叠 AI 覆盖；顶栏「AI 净化/润色本章」弹窗，落库后正文实时重载（所见即所得），可撤销 |

**已核对「无需再动」**：键盘导航（翻页/章节/字号/主题/TOC/设置/TTS/全屏，见 `ReaderScreen` `onKeyDown`）、点屏中央切工具栏（`toolbarsVisible`）、TTS 设置弹窗（`TtsSettingsModal.tsx` 已完整）、翻页/固定/缓存（见 `reader-archive.md`）。

**后端缺口（仍待定）**：仿真卷页（唯一缺失翻页动画，需 canvas，高风险）。（搜索本书、阅读器 AI 闭环已于本轮补齐：前者只读路由 `GET /api/book-search`，后者 `book_content_process` 覆盖表 + `POST/DELETE /api/books/content-process` 落库重载，目录总数现为 142，闸门同步。）
> 书签此前被误判为「需 Kotlin 不可验」，但本环境已验证 `gradlew :app:compileKotlin` 可离线编译（JDK17 在 `E:\Apps\DevTools\Eclipse Adoptium`），故书签已落地并编译通过。印证：`icons.tsx` 的 `bookmark` 图标此前是「计划内未实现」，本轮补上。

---

## 0. 与现状清点、研究纪要的关系

| 文档 | 角色 | 本方案如何引用 |
|---|---|---|
| `reader-archive.md` | **现状基线**（只描述有什么） | 所有「当前行为」以它为准；本方案 §3–§6 的「现状」列均回指它 |
| `research/01` AI 位置与阅读问题核实 | R1 核实 | 阅读器 AI 闭环的「已完成 / 真缺口 / 非缺陷」判定 |
| `research/02` 界面可塑性优化 | R2 主题 | 令牌、主题包、性能/规模量级差论证 |
| `research/03` 悬浮层延展 | R3 主题 | z-index 令牌化、OverlayHost、门禁冲突 ledger |
| `research/06` AI 与插件能力核实 | R1 核实 | AI 工具 vs 端点缺口、插件脚手架缺口 |
| `research/07` MD3 借鉴与阅读器 AI 增强 | R1 设计 | 阅读器 AI 正确形态、划词闭环模板、不适用清单 |
| `RESEARCH-NOTES.md` §8 | 框架纪律 | 本方案 §1 的全部红线来源 |
| `AI 与插件框架全面审计报告`（2026-10-22，本次会话） | 连接选择/SSRF/连接 UI/插件可见性/契约一致性/工具上限 | 主题 D 新增项（§6.9–§6.12），并补 §7 门禁与 §9 不要做 |

---

## 1. 设计红线（不可违反）

本方案的任何一条实现都不得突破以下红线。它们不是风格，是**用判据测试落地的硬约束**（详见 RESEARCH-NOTES §8）。

1. **不新增第二套外壳**。浮层外壳只有 `.dialog-shell` / `.reader-drawer` / `.tts-floating-bar` 三档（`UiContract.test.ts:290-293` 的 `SHELL_WHITELIST`）。新增弹窗一律套 `.dialog-shell` + `.size-s|m|l`；不新增 `.overlay-backdrop` 变体；不新增第二套前端/后端。
2. **框架只立钩子、不夹带内容**（RESEARCH-NOTES §8.1）。`lab/`、`extensions/` 不依赖 `plugins/`、`features/`；AI 是**功能条目**（`features/ai`），不是插件；扩展只能以「工具 / 实验条目 / 设置分区 / LLM 协议」形态注入。
3. **扩展不增 HTTP 路由（默认）**。插件与 AI 工具只往 `ToolRegistry` 加能力，不产生新 `/api/*`；若确需新路由，必须同步 `agent-api.json` 并跑 `ApiCatalog.test.ts`，且把 `web/test/ApiCatalog.test.ts` 的钉死计数同步 +1 并说明（当前全量契约 142 端点 / 19 组）。
4. **依赖方向单向**：内容 → 框架。改 `lab/`、`extensions/`、`plugin/` 前先看 `FrameworkHasNoContent.test.ts`。
5. **改动必须同步门禁**。每条「需改测试闸门」的项，实现与判据补丁**同一提交**，否则 CI 必红（见 §7 门禁清单）。
6. **令牌必须已定义**。不在 `:root` 定义的 `--x` 被 `var()` 引用 = 声明作废（reader-archive §15.10 教训，P0-4 真 bug）。新增令牌先定位置（三处 `:root` 块之一）。
7. **不用装饰字形、不写死版本号、不用 `export default`**（`CopyStyle.test.ts` / `HeaderMenu.test.ts` / `NamingConventions.test.ts`）。图标一律 `<Icon name>`。
8. **存储键迁移不破坏数据**。改 `localStorage` 键名须「读旧、写新、不删旧」，配迁移函数（§4.1）。

---

## 2. 总览：四大主题与排序原则

### 2.1 排序原则（已论证是量级差）

R2 §5.1 独立复核结论：**性能 / 规模问题 > 主题可塑性**，不是小幅领先：

| 维度 | 性能/规模（§3 主题 A） | 主题可塑性（§4 主题 B） |
|---|---|---|
| 受影响用户 | **100%**（默认搜索即全库扫描） | 少数换肤/换密用户 |
| 单次损失 | 约 **25 分钟**等待，且 `selfcheck` 2 FAIL 证明默认路径走不通 | 无损失，只是「没得选」 |
| 是否阻断核心价值 | **是**（源→书转化链断） | 否（7 套皮肤够日常） |
| 修复成本 | 前端小改 + 后端 1 个字段 | 需 650 处令牌替换打底 |

> 一句话：**规模治理是雪中送炭，主题可塑性是锦上添花**。Z/G 档可塑性可排进同迭代后半段（互不阻塞），**但 P0 量级问题不能后放**。唯一可并行的例外是 R2 的 **Z1**（一行零风险对比度引线修复）。

### 2.2 四大主题

- **主题 A — 性能与规模治理（P0 量级）**：默认搜索全库 ≈25 分钟、书源健康度不回灌、列表无虚拟滚动。
- **主题 B — 界面可塑性（R2）**：配色已成熟（62 令牌），空洞在动效令牌 / 密度令牌 / 主题包 / 几何采纳率。
- **主题 C — 悬浮层 / 覆盖层系统（R3）**：几何已收口，层级 / 位置 / 生命周期各写各的。
- **主题 D — 阅读器 AI 增强（R1/06/07）**：已完成「位置」（阅读器挂 AI 球），缺口在「对应地点研究」闭环、AI 工具与端点对齐、插件脚手架。

### 2.3 合并优先级表（P0→P2）

| 优先级 | 主题 | 事项 | 档位 | 依赖 |
|---|---|---|---|---|
| **P0** | A | 默认搜索范围改「分组」+ 量化成本预期（不再是全库扫描） | 纯前端 | 无（会红 `SearchStatePersistence.test.ts:39`） |
| **P0** | A | 书源健康度进 `/api/sources`（`SourceSummary.health`）+ 前端徽标/排序 | 架构级 | 后端排期 |
| **P0** | B | Z1：对比度引线 + `var(--text)` 无效声明（一行×4） | 零风险 | 无 |
| **P0** | B | Z2：收编 8 个僵死令牌（3 个当前生效 bug） | 零风险 | 无 |
| **P0** | C | 清账：删 `.fw-*`/`.lab-*` 死样式、修「界面偏好」说谎控件、修 AI 面板宽度覆盖 | 零风险 | 无 |
| **P0** | D | 阅读器 AI 工具 `ai.textClean` / `ai.text Rewrite`（选中→净化/润色→落库→重载） | G2 后端 | 无 |
| **P0** | D | 参考上下文 `referenceText`（让模型知「你正在看哪里」） | G2 后端 | 无 |
| **P0** | D | 书源分组 AI 工具（两报告一致） | 后端 | 无 |
| **P0** | D | 进度保存补 `set` 工具（仅 06 发现：只有读无写） | 后端 | 无 |
| **P0** | D | **SSRF 防护**：`OpenAiCompatibleProvider` 外呼 `baseUrl` 前拒绝内网/保留地址（`127.0.0.1`/`169.254.x`/`0.0.0.0`/localhost） | 后端 | 新增 Guardrail + 判据 |
| **P1** | A | 书源列表虚拟滚动、结果区「还在搜 N 个慢源」+「不等了」 | 架构级 | A 后端 |
| **P1** | B | Z3：字面量→令牌（650 处，机械替换） | 零风险 | 无 |
| **P1** | B | G1：动效令牌（5 令牌 + 5 处替换 + 新判据） | 需加判据 | Z3 无关可并行 |
| **P1** | B | G3：`useOverlayFocus` + 8 个单例弹窗接入 | 需加 hook | 无 |
| **P1** | B | G2：主题包 schema + 导入导出 + 判据 | 需加判据 | Z3（密度部分） |
| **P1** | B | G4：断点收敛到 4 档 + 新判据 | 需改现有 5 处 + 新判据 | 先 11 档普查 |
| **P1** | C | z-index 令牌化（37→`--z-*`，价值最高） | 需改 UiContract 两处正则 + 自证 | 清账在前 |
| **P1** | C | 拖动 + 吸附 + 持久化（`useOverlayDrag`） | 零门禁冲突 | 清账在前 |
| **P1** | C | 焦点陷阱 + 滚动锁 | 纯行为 | 无 |
| **P1** | D | 划线/标记菜单（选中即现）、朗读胶囊、阅读专用配色/护眼、逐章进度同步 | G2 | 无 |
| **P1** | D | 朗读/备份/`source.switch` 的 AI 工具对齐 | 后端 | 无 |
| **P1** | D | 连接与工具管理 UI：默认连接设置 + 实测探测 + 删除后自动 refresh + API Key 掩码/轻混淆 + 系统提示词模板 + 悬浮球增强（拖拽记忆/隐藏/多会话） | 前端 | 无 |
| **P1** | D | 插件来源标注（`manifest` 标 `source:plugin:xxx`）+ 插件事件订阅可视化 | 前端+后端 | 无 |
| **P2** | A | 搜索两阶段（先健康源后慢源） | 架构级 | A 后端 |
| **P2** | B | Z4/Z5/Z6：文案漂移、40 处内联样式收编、触屏 hover 补齐 | 零风险 | 无 |
| **P2** | B | A4：偏好统一存储层 + 迁移 | 架构级 | Z/G 落完 |
| **P2** | B | G2 延伸：密度/圆角偏好 UI | 需 G2 | Z3 + G2 |
| **P2** | C | `OverlayHost` 统一挂载、多实例并存 | 中（动 main.tsx） | 清账在前 |
| **P2** | C | 可调整大小面板（需改 `overlay-tier-check.mjs`） | 高（改门禁） | C 清账 |
| **P2** | C | dock 层 / 插件 dock 入口 | 中（须定 `--z-dock` 取值） | 清账 + 层级令牌化 |
| **P2** | D | 翻译胶囊、插件脚手架 + 示例 + 文档 | G2 | 无 |
| **P2** | D | Agent 工具上限可配置（`MAX_TOOL_ROUNDS`/`MAX_TOOL_DATA` 提至 AppConfig）+ 长文本摘要模式 | 后端 | 无 |
| **P2** | D | 发行版版本号显示（`BuildInfo.version` 在 `jar` manifest 落地，与 `agent-api.json` 一致） | 后端 | 无 |
| **—** | C | 统一 Esc 层栈（替换 4 种手写写法） | 高（`UiContract:559-601` 钉函数名） | **不建议做** |

---

## 3. 主题 A — 性能与规模治理（P0 量级）

> 论据：R2 §2.0、§2.2 P0-1/P0-2、§5.1。这是用户「每次搜索都踩」的阻断性问题。

### 3.1 现状（来自 archive + R2）
- 书源 **5,598 条**，默认 `scopeMode:'all'`（`searchStore.ts:179`）→ 一次默认操作 ≈ **25 分钟**，`selfcheck` 2 FAIL。
- 体检结论只进 `localStorage` 的 `legado.health.baseline`，书源列表（`SourcesPage.tsx:190-195`）只统计 `total/enabled/login/groups`，**健康度不回灌**——5,598 条源在列表上无健康区分。
- 列表无虚拟滚动，`SOURCE_PAGE_SIZE=120`，5,598 条需 46 次「加载更多」。

### 3.2 改造项
- **A-1（P0，纯前端）**：默认搜索范围改为「按分组」或「健康源优先」；搜索前显示「将搜索 N 个源，约 X 分钟」量化预期。⚠️ 会红 `SearchStatePersistence.test.ts:39`（钉 `'all'`），同步改断言。
- **A-2（P0，架构级）**：`SourceSummary` 增 `health?: { tier: HealthTier; checkedAt: number; latencyMs?: number } | null`（`api.ts:10` 只增字段，不破 139 端点契约）。前端书源列表加健康度徽标（`--tier-good/pending/bad` 色点，用语义色非裸 hex）+ 按健康度排序 + 「只搜健康源」开关。
- **A-3（P1，架构级）**：书源列表虚拟滚动；结果区标「还在搜 N 个慢源」+「不等了」按钮。
- **A-4（P2，架构级）**：搜索两阶段（先健康源后慢源，涉及 WS 或两次连接）。

### 3.3 验收
- [ ] 5,598 条库上：默认范围不再等于全库；界面给出「将搜索 N 个源」量化预期。
- [ ] 书源列表一眼看出哪个源是活的（健康度徽标 + 排序）。
- [ ] `selfcheck` 红线恢复绿。

---

## 4. 主题 B — 界面可塑性（R2）

> 论据：R2 全文。配色维度已成熟（62 令牌、2,066 次 `var()`、7 套内置皮肤 + 不限量自定义皮肤库），空洞在**动效令牌 / 密度令牌 / 主题包 / 几何采纳率**。

### 4.1 零风险档（Z，不改测试、不改行为）
- **Z1（P0，一行×4）**：删 `.primary-button` 的 `--accent`+`#fff` 引线（`styles.css:398`，夜读对比 1.54 靠 L4467 后置覆盖压住，CSS 重排即复燃）；把 `color: var(--text)` 改为 `var(--ink)`（`:4103/4107`，`--text` 不存在→声明作废）。验收：`node --test` 全绿 + 夜读确认主按钮仍是 `--accent-solid`+`--on-accent`。
- **Z2（P0）**：收编 8 个僵死令牌：在 `:root` 补 `--ink-soft/--ink-dim/--warn`、把 `--t-s`→`--t-sm`（手误 bug）、`--accent-line`→`var(--line)`、`--ctl-34`→`--ctl`、`--ctl-md` 新增 `38px`。其中 3 个无 fallback 是当前生效 bug。
- **Z3（P1）**：字面量→令牌，**只做值与某令牌逐字符相等的声明**（不含 `padding` 复合值）：`font-size` 335 处、`border-radius` 128 处、`gap` 187 处，合计 **650 处**。替换前后脚本展开 `var()` 比对必须逐字节相同。这是密度/圆角偏好的前置条件。
- **Z4（P2）**：修设置页「三档」文案漂移（`settingsSections.ts:53` → 不写死数量）。
- **Z5（P2）**：`ReplaceRulesModal.tsx` 40 处内联样式收编为语义类（注意 `UiContract.test.ts:449-469` 扫类名，新增类须同时加样式规则）。
- **Z6（P1）**：触屏 `hover:none` 补齐（目前仅 2 处，全站大量 `:hover` 在移动端粘住）。

### 4.2 需改测试闸门档（G，必须同提交）
- **G1（P1）动效令牌**：`styles.css :root` 追加 `--dur-fast/.18s`、`--dur-base/.25s`、`--dur-slow/.4s`、`--ease-out`、`--ease-soft`；替换 5 处抽样（`:4577/961/5727/5711/1368`）。**好消息**：动效令牌不碰 `UiContract.test.ts`，比 z-index 令牌化更易落地。新增 `MotionTokens.test.ts`（禁 `transition/animation` 时长位写字面量，允许 `0s/.01ms` reduced-motion 兜底）。
- **G3（P1）焦点归还**：新增 `web/src/lib/useOverlayFocus.ts`（打开移焦入浮层、Tab 循环、关闭归还触发元素；先判 `node.contains(activeElement)` 尊重已有 `autoFocus`）。先改 `main.tsx` 的 8 个单例弹窗（`CustomizeModal`/`LogsModal`/`ShortcutHelp`/`ServerPortModal`/`ChangelogModal`/`BackupModal`/`AboutModal`/`ReadingLogModal`）。零判据冲突（不破 `UiContract.test.ts:170-171`）。
- **G2（P1）主题包 schema**（见 §4.3）。
- **G4（P1）断点收敛**：先 11 档宽度普查脚本截图标真实变化；`640/720` 设主断点，把 `760/768/900/420` 的 5 处迁到最近主动断点；新增判据「宽度断点只许 `640/720/960/1200` 四档」（与迁移同提交，单提即红）。

### 4.3 主题包设计（G2 核心，可塑性天花板的解法）
新增 `web/src/reader/themeTokens.ts`（camelCase，非 JSX）：

```ts
// 可被主题包覆盖的令牌白名单（只含已有定义，新增令牌须同步加这里）
export type ThemeTokenKey =
  | 'canvas' | 'surface' | 'surfaceMuted' | 'ink' | 'muted' | 'line'
  | 'accent' | 'accentSoft' | 'accentInk' | 'accentSolid' | 'accentSolidHover'
  | 'onAccent' | 'danger' | 'dangerSolid' | 'onDanger' | 'shadow'
  | 'radiusSm' | 'radiusMd' | 'radiusLg' | 'radiusPill'
  | 'spaceUnit' | 'rowHeight' | 'controlHeight'
  | 'fontScale' | 'durationScale' | 'easing'

// 一个主题包：可导出、可导入、可版本化
export type ThemePack = {
  spec: 1
  id: string
  name: string
  base: BuiltinSkinId
  tokens?: Partial<Record<ThemeTokenKey, string>>
  css?: string            // 高级用户历史数据，仍可整段 CSS
  author?: string
  description?: string
}
```

- **与现有类型兼容**：`CustomSkin` 增补可选 `tokens?/author?/description?`，`parseCustomSkin` 条件展开（`...(tokens && Object.keys(tokens).length ? { tokens } : {})`）——`CustomizeSkin.test.ts:80-89` 的 `deepEqual` 旧断言**自动继续通过**，只需加一条新用例。
- **注入**：`composeSkinCss(skin)` 纯函数合成 `.theme-<id>{ decls }` + `css`，经 `SkinStyle` 走 `textContent` 一条路；`sanitizeTokenValue` 必做（颜色只认 `#rgb/#rrggbb/#rrggbbaa/oklch()/color-mix()`，尺寸只认数字+`px/em/rem/%`，剥 `{ } ; < >` 换行）。
- **导出/导入**：`exportThemePack` → `.qingyue-theme.json`；`importThemePack` 整包校验（spec≠1 / id 清洗空 / 无名 / 无 tokens 无 css / 未知令牌 / 非法值全部报错，不做半套）。阈值 `css.slice(0,20000)`、名字 `slice(0,40)`。
- **新增判据**：`ThemePack.test.ts`（白名单与样式表同步、注入走 textContent 且值被清洗）。

### 4.4 三层用户偏好模型 + 密度圆角落地（G2 延伸，解决 C1 天花板）
- **三层互不混淆**（`web/src/lib/appearance.ts`）：① 主题（ThemePack，长什么样，可导出）② 布局（LayoutPrefs，东西摆哪，收编 `shelfLayout.ts`）③ 阅读（ReaderSettings，正文，本次**不动**）。
- **存储键规范**（`web/src/lib/preferences.ts`）：`qingyue.<领域>.<用途>.v<整数>`，旧键→新键一次性迁移（**读旧写新不删旧**）。现有 14 key / 4 种前缀风格（`legado-`/`legado_`/`legado.`/`qingyue-`/无前缀）统一收口。
- **密度/圆角**：`:root` 加 `--density-scale`/`--r-scale`，`--s-*`/`--r-*` 令牌自身乘比例（就地改写 L4519-4523，**不可再定义一次**）；`--r-pill` 不参与（保持 `999px`）。`main.tsx` effect 扩两行：`root.dataset.density/radius/motion`（走 `data-*` 非 `theme-*` 类，因与皮肤正交）。动效档 `data-motion="off"` 与 `reduced-motion` 兜底取并集。

### 4.5 验收（R2 §7）
- [ ] `web/test` 全绿；`tsc --noEmit` 零错误。
- [ ] 夜读 / 石墨两套暗色下：主按钮、体检四档徽标、书籍类型徽标、规则调试轨迹色全部可读（实底控件对比度 ≥4.5）。
- [ ] 改密度为 compact：书架/书源/设置三页行高同步收紧，无文字截断。
- [ ] 导出主题包 → 清 localStorage → 导入 → 外观完全一致。
- [ ] 反向对照：故意导入 `spec:2` 的包，必须被拒绝并说清原因。

---

## 5. 主题 C — 悬浮层 / 覆盖层系统（R3）

> 论据：R3 全文。几何已收口得很干净（一档 `.dialog-shell` + 一条 `.overlay-backdrop` + 一颗 `.overlay-close`，两道门禁钉着），但**位置 / 层级 / 生命周期**三件事各写各的。

### 5.1 阶段 0：清账（不含新能力，纯删减与修复）
| 任务 | 改动 | 风险 |
|---|---|---|
| 0-1 删 `.fw-*` 死样式（约 55 行，`src/` 0 引用） | `styles.css` | 零（无主样式不触发 `UiContract:449`） |
| 0-2 删 `.lab-*` 死样式（约 40 行，逐条核对 `.lab-plugin-*` 仍在用） | `styles.css` | 零 |
| 0-3 决定「界面偏好」去留（`WindowPrefsSection.tsx` 在描述已删除的浮动窗能力，是说谎控件） | `features/settings/`、`builtinSettings.ts`、`main.tsx:449` | 零（建议**删**，与 0-1/0-2 同批） |
| 0-4 修 AI 面板宽度被 `.dialog-shell` 覆盖（`P4`：面板实际 680px 非 420px） | `styles.css` 删 `width` + `AiFloatingBall.tsx` 加 `size-s` | 零（顺手补 `AiFloatingAssistant.test.ts:36` 空断言文案） |
| 0-5 修 AI 球层级与注释矛盾（`.ai-fab`=900 注释却写「低于模态遮罩」） | 等阶段 1 令牌化后写 `var(--z-dock)`/`--z-dock-panel` | 零（单独改无判据读此值） |

> 0-1/0-2 净效果（实测核算）：z-index 字面量 **37→34**、不同数值 **25→24**，为阶段 1 令牌化清掉无主层。

### 5.2 阶段 1：z-index 令牌化（价值最高，但必须同步改判据）
- **全量映射**（37 处 / 25 数值 → 21 个 `--z-*` 令牌，节选关键映射）：

| 现值 | 语义 | 令牌 |
|---|---|---|
| 2 / 3 / 10 | 组件内部层叠 / 卡片角标 | `--z-inline: 2` |
| 20 | 吸顶/吸底 chrome | `--z-chrome: 20` |
| 26 | 阅读器内浮动件（TTS 条/点击区编辑） | `--z-reader-float: 26` |
| 30 / 28 | 抽屉本体 / 抽屉遮罩 | `--z-drawer: 30` / `--z-drawer-scrim: 28` |
| 38 | 底部弹层 | `--z-sheet: 38` |
| 40 | 笔记浮层 / 顶栏（**40=40 是隐患**，靠 DOM 顺序决胜） | `--z-popover: 400` / `--z-chrome` |
| 100 / 120 | 模态遮罩 / 嵌套遮罩 | `--z-scrim: 100` / `--z-scrim-nested: 120` |
| 200 / 320 / 400 | 菜单 / 右键 / 下拉 | `--z-menu` / `--z-context` / `--z-popover` |
| **900（AI 球，须下调）** | 悬浮球常驻 | **`--z-dock: 60`**（必须在遮罩之下） |
| 1000 | 看图画布 | `--z-viewer: 900` |
| 9999 | Toast | `--z-toast: 1000` |

- ⚠️ **反向陷阱（R3 §3.3，最关键交叉发现）**：`UiContract.test.ts:62-68` 与 `:71-83` 用正则从 CSS 文本读**字面数字**；一旦 `z-index: 26` 改成 `var(--z-reader-float)`，正则匹配不到数字，`bar` 落回 `9999`、`drawer` 落回 `0` → 断言 `9999 < 0` 为假，**判据由绿变红**（实测复现）。**所以令牌化必须连带修改 `UiContract.test.ts` 两处正则 + 补一条负向自证**，否则「令牌与字面量并存」比不改更糟。
- **正确做法**：令牌只定义一处（`:root`），消费处一律 `z-index: var(--z-xxx)`；禁止组件内 `style={{ zIndex: 900 }}`；判据侧改为读 `:root` 令牌值。补丁与负向自证见 R3 §6.1。

### 5.3 阶段 2：拖动 + 吸附 + 持久化 + 跨页常驻（零门禁冲突）
- 新增 `lib/overlay/overlayDrag.ts`（从 `ttsBarPosition.ts` 抽出 `useOverlayDrag`）。**保留** `ttsBarPosition.ts` 的 `HOLD_MS=250`/`SLOP=9`/`clampPosition`/`legado-tts-bar-reset`/`closest('button,a,input,select,textarea')`——`TtsBarPosition.test.ts:62-81` 逐条正则匹配，只能「抽出去再引回来」不能搬走。
- 几何走 `--ov-*` 自定义属性（非 `left/top` 像素），`overlay-tier-check.mjs` 读 `width` 仍解析为 `min(--dw-N,94vw)`，**拖动完全不影响任何实测断言**。
- `OverlayHost.tsx` 唯一挂载点，替代 `main.tsx` 双份手挂（`ToastContainer` 挂 3 次、`ContextMenuLayer` 挂 2 次）；不动 `openModal` 单例体系（`UiContract.test.ts:559-601` 钉函数名）。

### 5.4 阶段 3：可调整大小面板（需改门禁）
- 新增 `.tool-panel` 一档（**不是** `.dialog-shell`，且不得同时写 `max-height/border-radius/box-shadow`），`SHELL_WHITELIST` 加它。
- 改 `overlay-tier-check.mjs:206-209`（宽度等式 → 合法区间）与 `:228-235`（全局收口断言排除可缩放层）+ 补负向自证。

### 5.5 阶段 4：dock 层 / 插件 dock 入口
- `.dock-*` 独立档，**不带 `.overlay-backdrop`**（天然不触发 `overlay-tier-check.mjs:203-205`）；层级取 `--z-dock: 60` / `--z-dock-panel: 61`（**必须在遮罩之下**——模态打开时球应被遮住）。
- 插件注册 dock 入口：`extensions/registry.ts` 增 `dockEntries?: PluginDockEntry[]`，**必须与 `OverlayHost` 的 dock 支持同一提交**（否则是 plugin-framework 批评的「承诺渲染不出来的能力」）。纪律：插件不自带外壳，只 `render()` 内容，外壳/层级/关闭由 `OverlayHost` 给。

### 5.6 设计红线与状态机
- **不新造外壳**：`OverlayHost` 只做「栈管理 + 事件委派 + 把手套」，渲染仍是现有 `.overlay-backdrop` + `.dialog-shell`。
- **层栈状态机**（`OverlayStack`）：`push(kind)` / `requestClose` / `top` / `snapshot`；Esc 派发修复 P8 四种手写写法；滚动锁/焦点陷阱计数器式（两层 modal 只锁一次）。
- **渐进迁移**：只停在「登记 + dock 层」（R3 §4.5 步骤 1+4），统一 Esc/返回栈（步骤 2-3）收益低、风险高，**不建议做**。

### 5.7 验收
- [ ] z-index 字面量 0 处（全 `var(--z-*)`）；`UiContract.test.ts` 读令牌值断言全绿 + 负向自证存在。
- [ ] 拖动 TTS 条 / 任意 dock 面板不触发任何门禁；位置记忆跨会话。
- [ ] 模态打开时 AI 球被遮住（层级语义正确）。
- [ ] 键盘 Esc 关嵌套弹窗逐层正确，不一次关两层。

---

## 6. 主题 D — 阅读器 AI 增强（R1 / 06 / 07）

> 已完成（0.8.5，archive §14）：阅读器挂 AI 球 + `uiContext`（含书/章），对话历史跨页跨会话（`aiChatStore` + `localStorage legado.ai.chat.v1`），面板 480px / z=60，测试全绿。
> 真缺口（非缺陷见 §6.5）。

### 6.1 P0：阅读器内 AI 交互闭环（07 王牌链路）
MD3 `ReadAiDelegate` 的「采上下文 → 发任务 → 防抖 → 确认 → 落库 → 重载」直接可复制到青阅：
1. **校章**：`chapterIndex` 不符则 `showToast("章已切换")` 放弃。
2. **采上下文**：`contextBefore`/`contextAfter` 各 **1000 字符**（解决「模型不知你选中了哪段、在章内什么位置」）。
3. **建请求**：`{ bookUrl, chapterIndex, chapterTitle, chapterPosition, originalText, contextBefore, contextAfter }`。
4. **发任务** → 观察任务状态，同书+同章+同原文 `isCurrent*` 防抖。
5. **落库 + 重载**：写入 `book_content_process` 表，`reloadChapterAfterContentProcessChanged` 按 `chapterPosition` 重载该章正文（所见即所得）。

### 6.2 P0：后端 AI 工具（不破坏 139 端点契约）
`ai/BuiltinTools.kt` 新增（当前工具数两报告口径不一：01 实测 39、06 实测 42，均含内置，记为 ≈40）：
| 工具 | 用途 | 读写 |
|---|---|---|
| `ai.textClean` | 选中文本交 AI 净化，返回替换段 | 写 |
| `ai.textRewrite` | 选中文本润色/改写（带 `referenceText` 参考上下文） | 写 |
| `ai.selectTextAction` | 选中文本做翻译/总结/圈名 | 写 |

请求/响应沿用 `AiComprehendRequest`/`AgentResult` 形状，**不新增 HTTP 路由**（`ApiCatalog.test.ts` 守恒）。

### 6.3 P0：参考上下文 `referenceText`
扫当前章前后 **80 章**，提取高频关键词（2–4 字短语 / A-Z 缩写），取 **6 条 × 600 字符**摘录，发给模型——让模型知「你正在看的世界是什么」。青阅 `AiTextFactoryUseCase` 补 `referenceText` 字段。

### 6.4 P0/P1：AI 工具与端点对齐（06 缺口）
后端端点有、AI 工具未暴露的真实缺口（5 处）：
| 缺口 | 端点已有 | 建议工具 | 优先级 |
|---|---|---|---|
| 书源分组 | `book_group` / `book_shelf/groups` | `source.group.*` | **P0** |
| 进度保存 | `PUT /api/reading-progress` | `progress.set`（仅 06 发现：只有读无写） | **P0** |
| 朗读控制 | `/api/tts/*` | `tts.play/pause/stop/volume/speed` | P1 |
| 备份恢复 | `/api/backup/*` | `backup.import/export/restore` | P1 |
| 书籍换源 | `switch-source` | `source.switch` | P1 |
| 订阅创建 | `/api/subscriptions` | `subscription.create` | P2 |
| 分组删除 UI | `DELETE /api/bookshelf/groups/{id}` 后端有、前端无 | 前端入口 | P2 |

### 6.5 P1：MD3 形态借鉴（已论证可行）
- 划线/标记菜单（选中即现「划线/书签/注释/标记」）。
- 朗读胶囊（`ReadAloudCapsule` 形态，与 `TtsPlayerBar` 一致）。
- 阅读专用配色/护眼（`--reader-*` 已有，分层 `全局主题/阅读主题/护眼`）。
- 逐章进度同步：`progress.get` 补 `titleIndex` / `titleProgress`。
- 桌面悬浮菜单（`reader/MenuBarFloating.tsx`）+ 复用 `desktop-pin-btn`/`desktop-reverse-btn`。

### 6.6 P2：翻译胶囊 + 插件生态
- 翻译胶囊（`TranslationThinkingCapsule` 形态，`ai.translate` 工具）。
- **插件脚手架 + 示例 + 文档**（当前 `loaded:0`，唯一缺的是「5 分钟写出第一个插件」的三件套：`manifest.json` + `tool.ts` + `ui.tsx` + `docs/plugin-development-guide.md` 30 分钟指南）。插件通过 `ToolRegistry` 增 `ai.*`、订阅「选中文本」事件、`extensions/registry.ts` 贡献阅读器 AI 菜单项。

### 6.7 不适用清单（不要搬 MD3 的）
MD3 的 **Material Design 3 视觉体系**、Android `ViewModel/Lifecycle/Context` 全家桶、`ReadAloudCastDelegate` 的扬声器/蓝牙硬件 API、`EyeProtection.kt` 的护眼传感器、桌面 OS 菜单——均**不适用**青阅（青阅有自有 7 套主题 + 62 令牌；是 Ktor+React SPA 非 Android；现阶段护眼做成配色+行距即可）。

### 6.9 连接选择与接入管理 UI（审计新增）

> **现状校准（据 `legado/AGENTS.md`）**：审计里「连接管理无探测入口 / 无状态指示 / API Key 明文」等指摘，**多数已落地**——`AGENTS.md` §7–§8 描述「AI 接入 · 对话助手」面板已含连接登记、书源只读校验、`probe` 实测状态（probing/ok/fail 三色 `ai-tag`）与「显示状态/实测状态」双维度；failover 按设计**不做**（FirstProfileSelector 取第一个，插件可 `selectorRegistry.setDefault` 替换）。因此下方「默认连接设置 / 探测按钮 / 状态三色」视为**已具备**，不再单列任务；仅「API Key 轻混淆 + 掩码」与「系统提示词模板切换」仍可作为小改进。**阅读器标记菜单（§6.9.1）是本次已实做的第一项**。

- **连接选择行为（审计确认正确，保持不变）**：`FirstProfileSelector` 默认取 `agent-profiles.json` 第一个连接；不可达即返 `409 no_connection`，**无本地兜底、不顺延**——这是正确的已确认行为，不做自动 failover。
- （已具备）前端「AI 接入」面板含连接登记 / 实测探测 / 状态三色标签；删除连接后自动 `refresh`。
- （可选小改）API Key 本地存储做轻混淆（Base64）+ 前端 `type="password"` 掩码（`agent-profiles.json` 当前明文，须改）。
- （可选小改）系统提示词模板切换：小说助手 / 书源调试 / 代码解释 / 通用助手。
- 悬浮球增强（复用 §5.3 `useOverlayDrag`）：拖拽位置记忆、隐藏开关、多并行会话（`AiChatState` 增 `sessionId`）。

#### 6.9.1 阅读器标记菜单（划线/标记菜单，已实做）
- 选中正文后先弹**标记快捷条**（MD3 MarkingSelectionMenu 形态），四个动作：**划线**（仅高亮，不写备注）/ **笔记**（展开 `NoteToolbar` 编辑器）/ **复制** / **AI**（打开全局 AI 悬浮球，选区已写入 `selectionStore` 由 AI 面板读取）。
- 实现：`reader/MarkingMenu.tsx`（新增组件，挂在 `reader-main` 之外，不触发 `onReaderMouseUp`）+ `ReaderScreen` 接线（选区→快捷条，点「笔记」才展开编辑器）+ `.reader-marking-menu`/`.reader-marking-btn` 样式（复用 `--surface/--line/--r-*/--accent-*` 等既有令牌，未新增令牌）。
- 标记快捷条另含「书签」与「搜索本书」（见 §6.9.9 / §6.9.10）：前者复用 `GET /api/notes` 的 `bookmark` 字段落库，后者新增只读路由 `GET /api/book-search`（目录总数 139→140，闸门同步）。两项均已在后端补接口并接进快捷条/底栏，不再属「缺后端 API」。

#### 6.9.2 阅读专属配色（护眼/阅读滤镜，已实做）
- MD3 `ReadBookColorTheme` 思路但做成「**只染阅读文字区、不染外壳**」：新增 `readerEyeTheme` 设置（`off`/护眼暖黄/豆沙绿/夜间黑读），`ReaderScreen` 在 `.reader-workspace` 上挂 `data-reader-eye`，CSS 用「`.reader-workspace[data-reader-eye=...] .reader-main / .reading-content ...`」选择器（特异性高于 `.reader-main`、`.reading-content p` 的 `var()` 声明）覆盖阅读区背景与墨色，不动工具栏/抽屉/外壳。
- 与全局主题解耦：暗色外壳也能有暖色阅读区，反之亦然；开启时自动关掉「背景图/压暗」叠加，避免三层颜色打架。
- 实现：`readerSettings.ts`（类型 + 默认值 + `parseReaderEyeTheme` + `loadReaderSettings` 接线）、`ColorTab.tsx`（「阅读配色」分段控件）、`.reader-workspace[data-reader-eye]` 覆盖规则 + `.segmented-control` 样式（均复用既有令牌，未新增令牌）。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.3 顶栏一键护眼/夜间（阅读配色快捷开关，已实做）
- 复用 §6.9.2 的 `readerEyeTheme`：MD3 顶栏右侧加一个 `md3-icon-btn`（护眼 `eye` / 夜间 `moon`，开启时 `is-active` 高亮），点按在 `off → 护眼暖黄 → 豆沙绿 → 夜间黑读 → off` 间循环，免进设置页即可一键切阅读滤镜。
- 实现：`Md3Chrome.tsx`（`Md3TopBar` 增 `readerEyeTheme` / `onToggleEye` 两 props + 图标按钮，复用 `md3-icon-btn`/`is-active`）、`ReaderScreen` 接线四态循环、`onSettingsChange` 落库。复用既有令牌与图标（`eye`/`moon`），未新增令牌/外壳/字形。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.4 右键菜单补全划线/笔记/AI（选中段落的右键入口，已实做）
- 用户 2026-10-04 明确要「选定段落后右击功能」：把 `onReaderMouseUp` 里算 `noteDraft` 的算法抽成 `buildSelectionDraft()`（同一份选区 → `noteDraft` + 同步 AI 的 `selection`），左键松手与右键菜单共用。
- 右键菜单现在选中文字时给出：**复制 / 划线（直调 `api.addNote` 空备注）/ 笔记（展开 NoteToolbar）/ 发给 AI（`setSelectionFromDraft` + 打开 AI 悬浮球）/ 章节目录**。划线/笔记/AI 走的是临时算出的 draft，不污染左键标记快捷条的状态（`noteDraft` 在右键时保持 null，避免浮层叠浮层）。
- 实现：`ReaderScreen` 抽 `buildSelectionDraft` + 改 `onBodyContextMenu`（沿用既有 `ContextMenuItem`/`showContextMenu`，图标 `copy`/`edit`/`file`/`sparkles`/`list`，无装饰字形、无新外壳）。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.5 目录当前章内进度指示（已实做）
- 目录抽屉的「当前章」行底部加一条薄进度条，实时反映**章内阅读比例**（章 + 章内比例，沿用 `readerProgress` 的 `fraction`）。
- 实现：`VirtualChapterList.tsx` 新增小组件 `CurrentChapterProgress`（自带 `useSyncExternalStore` 订阅进度 store，带 `getServerSnapshot` 以过 SSR 快照判据），只挂在 `current` 行、不拖累整张虚拟列表重渲染；CSS `.reader-chapter-progress`（绝对定位贴底 2px、accent 填充，`color-mix` 复用既有令牌）。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.6 目录已读/未读区分（已实做）
- 目录项按「是否已在当前章之前」区分：已读章用 `--ink`（实色），未读章用 `--muted`（淡），当前章仍走 `.current`（accent）。一眼看出本书读到了哪、剩多少。
- 实现：`VirtualChapterList.tsx` 行 `className` 增 `read`（`chapter.index < activeChapterIndex`）；CSS `.reader-chapter-item.read { color: var(--ink) }`，复用既有令牌。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.7 目录头部全书已读比例（已实做）
- 目录标题栏底部加一条细进度条 + 「已读 X%」文字（`overallProgress` 由 `chapterIndex` + `fraction` 算全书进度），一眼看到整本书读了多少。
- 实现：`TocDrawerHeader.tsx` 头部自带 `useSyncExternalStore`（带 `getServerSnapshot`）订阅进度 store，算出 `overallPct`；CSS `.drawer-progress`（绝对定位贴底 2px、`color-mix` + `--accent`，`.drawer-header` 加 `position: relative`）。复用既有令牌。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.8 右键菜单「复制为引用」（已实做）
- 选中文字右键时多给一项「复制为引用」：把选区原文连同出处 `—— 《书名》· 章节名` 一并写入剪贴板（用 `book` 图标，与「复制」区分）。便于把读到的句子按出处引用，纯前端、无后端、不污染标记状态。
- 实现：`ReaderScreen` 的 `onBodyContextMenu` 在 `selectedText` 分支追加该项，沿用 `navigator.clipboard` + `toast`，无新外壳/令牌/字形。`tsc` 与 `npm test`（682 pass）全绿。

#### 6.9.9 书签（后端 + 前端打通，已实做）
- 需求来源：标记菜单/右键原有「划线/笔记/复制/AI」，独缺「书签」——只标阅读位置、不写想法，与划线/笔记区分。此前 `icons.tsx` 已预留 `bookmark` 图标却无后端支撑，属「计划内未实现」。
- 后端（Kotlin，本环境 `gradlew :app:compileKotlin` 离线编译通过）：
  - `model/Models.kt`：给 `BookNote` 与 `BookNoteWrite` 各加 `bookmark: Boolean = false`（写在构造器末尾，老调用点用具名参数不受影响）。
  - `data/ReadingDao.kt`：`addNote` 把 `bookmark` 落库（INTEGER 0/1）、返回时带回；`listNotes` 的 SELECT 与映射同步带上 `bookmark`。**不新增路由**——前端从既有 `GET /api/notes` 按 `bookmark` 字段筛出书签，故 `agent-api.json` 仍是 139 条、目录闸门不红。
  - `data/Database.kt`：`book_note` 建表加 `bookmark integer not null default 0`，并新增 `migrateBookNote(db)`（用 `pragma table_info` 探列、`alter table add column` 补列，与既有 `migrateSourceTable` 同款做法）在 `initialize()` 里调用，老库缺列自动补齐。
- 前端：
  - `lib/api.ts`：`BookNote` / `BookNoteWrite` 各加 `bookmark?: boolean`。
  - `MarkingMenu.tsx`：加「书签」按钮（`onBookmark`），SVG 用 `bookmark` 形状，与划线/笔记/复制/AI 并列。
  - `ReaderScreen.tsx`：标记菜单 `onBookmark={bookmarkFromMenu}`（调 `addNote({...draft, bookmark:true})` 后入 `notes` 并 toast）；右键菜单 `onBodyContextMenu` 在 `selectedText` 分支追加「书签」项（同法落库）；两者都 `setNoteDraft(null)` 收尾。
  - `NotesPanel.tsx`：列表项带「书签」徽标；书本有书签时显示「全部 / 书签 N」过滤（纯前端 `useState`，不加端点）；导出沿用 `notesToMarkdown`（书签随笔记一起导出）。
  - `styles.css`：`.reader-note-badge`、`.reader-notes-filter`、`.reader-notes-filter-btn` 复用既有 `--accent/--line/--ink/--muted/--s-*/--t-*` 令牌，无新增令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 682 pass / 0 fail；`agent-api.json` 计数仍是 139（未加路由）。全部门禁（UiContract/overlay-tier-check/CopyStyle/FrameworkHasNoContent/ApiCatalog）守住。

#### 6.9.10 搜索本书（后端 + 前端打通，已实做）
- 需求来源：阅读界面的「所有功能」之一——在**已离线缓存的章节正文**里按关键词检索（目录章节标题搜索已存在，这是正文级检索）。此前缺后端接口，属「后端缺口」。
- 后端（Kotlin，离线编译通过）：
  - `model/Models.kt`：新增 `BookSearchHit(val chapterUrl, val chapterIndex, val title, val snippet)`（`@Serializable`，纯回包结构）。
  - `data/ReadingDao.kt`：新增 `searchBookContent(sourceId, bookUrl, query)`，对 `book_content_cache` 里这本书已缓存的章节做 `content like ? escape '\'` 子串匹配（转义 `%`/`_`/反斜杠，防通配符被吞），命中后 Kotlin 侧按 `query` 在 `content` 里定位并截取前后各 24 字成 `snippet`。只覆盖离线缓存到的章节——没缓存的搜不到（前端如实提示）。
  - `http/ProgressRoutes.kt`：新增 `GET /api/book-search`（`requireSameOriginWrite` 不涉及，只读、`write:false`），校验 `sourceId`/`bookUrl`/`q` 非空，调 `searchBookContent` 回 `List<BookSearchHit>`。
  - `resources/agent-api.json`：**新增** 1 条 `GET /api/book-search`（group `进度与笔记`，write false，purpose/response/group 齐全）。目录总数 **139 → 140**，并在 `ApiCatalog.test.ts` 的断言钉死数同步改为 140（按 AGENTS.md §6「重排时同步改此断言并说明」）。
- 前端：
  - `lib/api.ts`：新增类型 `BookSearchHit` 与方法 `bookSearch(sourceId, bookUrl, query)`（`request<BookSearchHit[]>('/api/book-search?...')`）。
  - `reader/BookSearchDialog.tsx`（新文件）：复用既有 `.overlay-backdrop` + `.dialog-shell.size-m` + `.dialog-head` 外壳（UiContract 判据：套外壳、有 `role="dialog"`+`aria-label`、接 `useEscapeClose`、不 inline 压宽高），内容样式只新增 `.reader-book-search*` 且复用既有 `--accent/--line/--ink/--surface/--muted/--s-*/--t-*` 令牌。输入防抖 300ms 调 `bookSearch`，结果列「第 N 章 · 标题 + snippet」，点一项 `onJump(chapterIndex)` 切章并关弹窗。
  - `reader/Md3Chrome.tsx`：底栏动作排加「搜书」`md3-pill`（`<Icon name="search" />`），`onBookSearch` 打开弹窗。
  - `reader/ReaderScreen.tsx`：`bookSearchOpen` 状态；`Md3BottomBar` 传 `onBookSearch={() => setBookSearchOpen(true)}`；渲染 `<BookSearchDialog sourceId bookUrl onJump onClose>`，`onJump` 调 `changeChapter(index,'first')` 后关弹窗。
  - `styles.css`：`.reader-book-search*` 内容样式（输入/状态/结果列/项），全部复用既有令牌，无新增设计令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 684 pass / 0 fail（目录闸门 142 同步、UiContract 对新增弹窗的 Esc/外壳/role/名字/inline 宽高全过）。

#### 6.9.11 阅读器 AI 闭环（后端 + 前端打通，已实做）
- 需求来源：plan D 的 P0「AI 净化/润色 → 落库 → 重载」（所见即所得）。原方案主张「不新增路由、复用 `ai.textClean/textRewrite` 工具」，但那两条工具当前 `writes=false` 且不落库、且 `textRewrite` 不真正调 LLM，经权衡改为**前端驱动 + 显式覆盖路由**的更可控实现（仍守门禁，仅把目录计数 140→142）。
- 设计取舍：只做「**整章**」净化/润色，不做「选中片段」。原因：选区文本是 `convert`（繁→简等）之后的展示文本，而正文落库存原始文本；在原始坐标里按展示文本做片段替换会把段落切花（偏移对不上）。整章层面无此问题——整章原文交 AI、整章结果落库，`convert` 照常叠在展示层。选中片段的净化/润色继续走既有「发给 AI」对话面板。
- 后端（Kotlin，离线编译通过）：
  - `model/Models.kt`：新增 `ContentProcess(...)` 与请求体 `ContentProcessRequest(sourceId, bookUrl, chapterUrl, kind, original, processed)`（`@Serializable`）。
  - `data/Database.kt`：新增 `book_content_process` 表（PK `source_id, book_url, chapter_url, kind`；`kind` ∈ `ai_clean` 净化 / `ai_rewrite` 润色；存 `original`/`processed`/`updated_at`）。
  - `data/CacheDao.kt`：新增 `getContentProcess` / `saveContentProcess`（覆盖写，on conflict 更新）/ `deleteContentProcess`。
  - `http/ReadingRoutes.kt`：`POST /api/books/content` 读路径在回包前查 `book_content_process` 覆盖（`ai_clean` 优先于 `ai_rewrite`），命中则回覆盖版（净化规则照套、离线缓存照写，行为只多一层覆盖）；新增 `POST /api/books/content-process`（落覆盖）与 `DELETE /api/books/content-process`（撤覆盖，恢复原始正文），均 `requireSameOriginWrite`。
  - `resources/agent-api.json`：**新增** 2 条（`POST`/`DELETE /api/books/content-process`，group `阅读`，write true，purpose/response/group 齐全）。目录总数 **140 → 142**，并在 `ApiCatalog.test.ts` 断言钉死数同步改为 142。
- 前端：
  - `lib/api.ts`：新增类型 `ContentProcess`/`ContentProcessRequest` 与方法 `saveContentProcess(req)`、`deleteContentProcess(sourceId, bookUrl, chapterUrl, kind?)`；AI 调用复用既有 `agentChat(messages)`（走 `POST /api/agent/chat`，须先连外部模型）。
  - `reader/ReaderAiDialog.tsx`（新文件）：复用 `.overlay-backdrop` + `.dialog-shell.size-m` + `.dialog-head` 外壳（UiContract 合规）。两个动作「AI 净化本章 / AI 润色本章」+「撤销上次 AI 处理」。每个动作把整章原始正文（来自 `chapterBaseContentRef`，正常加载时写入）交给 `agentChat`（system prompt 区分净化/润色，要求只回正文、剥掉偶发代码块），把返回落 `saveContentProcess`，再 `onApplied(processed)` 让阅读器 `setContent` 实时重载；撤销调 `deleteContentProcess` 后回滚到 `original`。无外部模型时优雅报错（「尚未连接外部模型，AI 不可用」）。
  - `reader/Md3Chrome.tsx`：顶栏护眼按钮旁加「AI 净化 / 润色本章」`md3-icon-btn`（`sparkles` 图标），`onOpenAi` 打开弹窗。
  - `reader/ReaderScreen.tsx`：`readerAiOpen` 状态；`chapterBaseContentRef` 记住「非 AI」的原章正文（只在 `applyContent` 正常加载时写入，AI 覆盖走 `setContent` 不污染）；渲染 `<ReaderAiDialog sourceId bookUrl chapterUrl original onApplied onClose>`，`onApplied={processed => setContent(processed)}` 即同章重载（复用 `ReplaceRulesModal.onRulesChanged` 的 `setContent` 模式，绕开 `changeChapter` 同章早退）。
  - `styles.css`：`.reader-ai*` 内容样式（动作排 / 状态），复用既有 `--accent/--line/--ink/--surface/--muted/--s-*/--t-*` 令牌，无新增设计令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 684 pass / 0 fail（目录闸门 142 同步、UiContract 对新增弹窗的 Esc/外壳/role/名字/inline 宽高全过）。

### 6.10 安全：SSRF 防护（审计新增， P0）
- `OpenAiCompatibleProvider` 直接调用用户配置的 `baseUrl`，**无内网/保留地址校验**；`AgentContext.boundHost="127.0.0.1"` 仅作元数据，未在外呼时强制校验。
- **必须在 `Agent`/`LlmProvider` 层增加 `baseUrl` 合法性校验**：拒绝 `127.0.0.1`、`169.254.x.x`、`0.0.0.0`、`localhost`、链路本地等，返回明确 `cross_origin` 错误而非静默失败（参考 `Guardrails.refuseExternalBind()`，但作用于外呼）。
- 真实安全漏洞，优先级高于体验类，建议与阶段 1.5 同期落地（§8）。

### 6.11 Agent 工具上限可配置（审计新增，P2）
- `Agent.MAX_TOOL_ROUNDS=6`、`MAX_TOOL_DATA=4000` 硬编码；提升为 `AppConfig` 配置项，支持运行时动态调整。
- 长文本工具（如 `source.run`）增加「摘要模式」。

### 6.12 插件来源标注与事件可视化（审计新增，P1）
- 插件注册的工具在 `manifest()` 标注来源（`source: "plugin:xxx"`），便于审计。
- AI 接入面板增加「插件事件」小节，显示已订阅事件名与插件 ID。

### 6.13 验收
- [ ] 选中一段 → AI 净化/润色 → 确认 → 该章正文实时重载（所见即所得）。
- [ ] 模型收到的上下文含「书/章/选中段落 ±1000 字符 + 参考章节摘要」。
- [ ] 书源分组、进度保存可由 AI 直接操作；朗读/备份可由 AI 控制。
- [ ] 第一个社区插件 5 分钟内按模板跑通。

---

## 7. 门禁 / 判据清单（改动必须同步）

| 判据测试 | 守什么 | 本方案哪些项会触碰 |
|---|---|---|
| `UiContract.test.ts` | 浮层外壳白名单、z-index 正则、关闭键、像素宽高、类名→样式表 | C 全阶段（尤其阶段 1 正则改）、B G2/G4、C 0-4 |
| `overlay-tier-check.mjs` | 遮罩 ≤2、backdrops===1、宽度 `min(--dw-N,94vw)`、max-height/radius/animation 唯一 | C 阶段 3（resize）、阶段 4（dock 不带 backdrop） |
| `CopyStyle.test.ts` | 装饰字形禁用（`BANNED_GLYPHS`）、`BANNED_CLAIMS`（说谎文案）、`BANNED_PHONE_PHRASES` | 全部文案、B 0-3 说谎控件、C 0-3 |
| `ApiCatalog.test.ts` | 142 端点 / 19 组双向一致；`agent-api.json` 版本号须等于 `BuildInfo.version` | D 后端工具（不新增路由，守恒）、A `SourceSummary` 增字段（按端点核不破）；新增端点两处登记 |
| `FrameworkHasNoContent.test.ts` | 依赖方向 content→framework、容器零内容、AI 非插件 | D 插件接入、任何 `lab/extensions` 改动 |
| `CustomizeSkin.test.ts` | `CustomSkin` 形状 `deepEqual` | B G2（条件展开保兼容） |
| `ThemePack.test.ts`（新增） | 白名单与样式表同步、注入走 textContent 且值被清洗 | B G2 |
| `MotionTokens.test.ts`（新增） | 动效时长/缓动只从令牌取 | B G1 |
| `NamingConventions.test.ts` | hooks 文件名 `useXxx.ts`、禁 `export default` | B/C 新文件 |
| `HeaderMenu.test.ts` | 禁写死 `'x.y.z'` 字面量 | 全部 |
| `TtsBarPosition.test.ts` | `HOLD_MS=250`/`SLOP=9`/`legado-tts-bar-reset` 等字面量必须保留 | C 阶段 2（抽出去再引回） |
| `SearchStatePersistence.test.ts` | 钉默认 `'all'` | A-1（同步改断言） |
| `selfcheck`（发布红线） | 搜索默认路径 | A 全（恢复绿） |
| `AgentSecurity`/provider 校验（建议新增） | `baseUrl` 拒绝内网/保留地址；API Key 存储须非明文 | D-SSRF（§6.10）、D 连接 UI（§6.9） |

---

## 8. 分阶段路线图（把 A/B/C/D 串成迭代）

> 排序原则：先修「在说谎的东西」→ 再做零门禁冲突的能力 → 最后做需改门禁的能力（R3 §6 排序精神）。

| 阶段 | 内容 | 主题/档 | 门禁 |
|---|---|---|---|
| **阶段 0** | 清账 + Z1/Z2：删 `.fw-*`/`.lab-*` 死样式、修「界面偏好」说谎控件、修 AI 面板宽度、对比度引线、僵死令牌 | C0 / B-Z1-Z2 | 零风险 |
| **阶段 1** | 性能 P0：搜索默认范围改分组 + 量化预期；A-2 后端 `health` 字段 + 前端徽标/排序 | A | A-1 改 `SearchStatePersistence` 断言 |
| **阶段 1.5** | 安全与接入（审计）：SSRF `baseUrl` 校验、连接 UI（默认连接/探测/删除刷新/API Key 掩码/提示词模板）、悬浮球增强（拖拽记忆/隐藏/多会话） | D（审计新增） | 新增 SSRF 判据 |
| **阶段 2** | R2 零风险 + 动效：Z3（650 处令牌）、Z4/Z5/Z6、G1 动效令牌 + `MotionTokens` | B-Z/G1 | G1 加新判据 |
| **阶段 3** | R2 焦点/断点：G3 `useOverlayFocus` + 8 弹窗；G4 断点 4 档 + 普查 | B-G3/G4 | G4 改现有 5 处 + 新判据 |
| **阶段 4** | R3 层级令牌化：21 个 `--z-*` + 改 `UiContract` 两处正则 + 负向自证（AI 球层级随此落地） | C1 | **动核心判据，须同步改** |
| **阶段 5** | R2 主题包 + 三层偏好 + 密度圆角 UI：G2 schema/导入导出 + `ThemePack` 判据 + `appearance`/`preferences` + 设置页行 | B-G2 延伸 | G2 加新判据 |
| **阶段 6** | R3 拖动/跨页常驻 + dock：C2 `useOverlayDrag` + `OverlayHost`、AI 球拖动+记忆、`dockEntries` 插件接入 | C2/C4 | 零门禁冲突（dock 不带 backdrop） |
| **阶段 7** | R1 阅读器 AI 闭环：`book_content_process` 覆盖表 + `POST/DELETE /api/books/content-process` 落库重载 + 顶栏 AI 净化/润色弹窗（前端驱动 `agentChat`） | D-P0 | 端点 140→142，闸门同步 |
| **阶段 8** | R1 工具对齐 + 插件：朗读/备份/`source.switch`/`progress.set`/`source.group` 工具 + 插件脚手架/示例/文档 | D-P1/P2 | `ApiCatalog` + `FrameworkHasNoContent` |
| **阶段 8.5** | 审计补充：Agent 工具上限可配置 + 长文本摘要、插件来源标注与事件可视化、版本号 manifest | D（审计新增） | 无 |
| （穿插） | R3 阶段 3 resize（需改 `overlay-tier-check`）、A-3/A-4 虚拟滚动/两阶段搜索 | C3 / A-P1/P2 | 高（改门禁）需单独评审 |

**关键路径**：`Z1→Z3→G2→密度UI`；`A-1→A-2→健康度徽标`；`清账→C1 层级→C2 拖动→C4 dock`；`D 闭环→D 工具对齐→插件`。各链互不阻塞可并行。

---

## 9. 跨主题「不要做」清单（合并 R2 §6 + R3 §10 + §1 红线）

1. **不要**新增第二套 dialog 外壳（`UiContract:290-293` 会红）。
2. **不要**给 dock 层加 `.overlay-backdrop`（`overlay-tier-check:203-205` 会红）。
3. **不要**在 TSX 写 `width/height/maxWidth/maxHeight` 像素值（`UiContract:154-163` 会红）。
4. **不要**把 resize 作用在 `.dialog-shell` 上（`overlay-tier-check:206-209` 会红）。
5. **不要**删 `ttsBarPosition.ts` 的 `HOLD_MS=250`/`SLOP=9`/`legado-tts-bar-reset`（`TtsBarPosition.test.ts:62-81` 逐条匹配）。
6. **不要**把 z-index 令牌化单独提交——会红 `UiContract:62-68/71-83`，必须与判据补丁同提交。
7. **不要**在 `:root`「再定义一次」已有令牌加比例（添重复声明），就地改写原定义。
8. **不要**把主题包做成「任意 CSS 变量」——白名单是校验/迁移唯一前提。
9. **不要**在没写迁移函数时改 `localStorage` 键名（皮肤库/布局/阅读设置都在里）。
10. **不要**在 `extensions/registry.ts` 先加 `dockEntries` 类型而后补宿主（承诺渲染不出来的能力）。
11. **不要**照搬 MD3 的 Material Design 3 视觉体系 / Android 全家桶（破坏主题可塑性目标、非 Android 应用）。
12. **不要**各写一份夹取算式——`lib/overlayGeometry.ts` 的 `clampOverlay` 是唯一来源。
13. **不要**用装饰字形、写死版本号、`export default`（对应判据会红）。
14. **不要**不经校验直接外呼用户配置的 `baseUrl`（SSRF，§6.10）——必须在 `Agent`/`LlmProvider` 层拒绝内网/保留地址。
15. **不要**为连接选择加自动 failover（`FirstProfileSelector` 取第一个、不可达返 `409 no_connection` 是无本地兜底的正确行为，审计确认）。

---

## 10. 一句话收尾

本方案把 5 份研究报告（R1/R2/R3 + AI 核实 + MD3 借鉴）+ 1 份 AI & 插件框架审计报告收口成一个**分阶段、可验收、守门禁**的改造计划：先雪中送炭（性能/规模 P0），再锦上添花（界面可塑性 + 悬浮层系统 + 阅读器 AI 闭环 + 审计新增的连接/安全/插件项），全程不新增第二套外壳、不破坏端点契约（当前 142 端点 / 19 组，任何新增必两处登记 + 闸门同步）、不绕过任何既有判据测试。所有 `文件:行` 动手前先 `git diff` 复核。
