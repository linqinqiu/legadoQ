# 青阅（QingYue）版本与变更日志治理规范

> 本文是青阅本地阅读服务的**版本号 / 变更日志 / 发布流程**治理规范，只约束治理动作
> （文档、脚本、CI），不修改任何应用源码（`legado/app/src`、`legado/web/src`）。
>
> 适用范围：父仓库 `E:\legado`（含 `VERSION`、`package.json`、`README.md`）与应用仓库
> `E:\legado\legado`（Kotlin/Ktor 后端 + React 前端，Gradle 真源所在，CI/工作流落在此处）。

---

## 1. 目标与原则

- **版本号只有一个真源**，杜绝手写第二份版本号导致的四处漂移。
- **代码/功能更新**与**内容数据更新**是两类不同性质的变更，走两套相互独立的版本通道。
- **变更日志不手写**：用 Conventional Commits 驱动自动生成，人只写提交信息。
- **发布动作原子化**：版本号、变更日志、Tag、Release 在同一工作流里串行完成，要么全成、要么全不成。

---

## 2. 两类更新：代码/功能 vs 内容数据

| 维度 | 代码 / 功能更新 | 内容数据更新 |
| --- | --- | --- |
| 例子 | 接口、UI、看书/搜索/换源逻辑、插件框架、构建 | 书源、发现页规则、内置清洗/正文/目录规则、默认配置 |
| 版本通道 | **app 版本**（`version`，随发布递增） | **contentRev**（独立递增，不 bump app 版本） |
| 变更记录 | `CHANGELOG.md`（用户可见变化） | 内容仓库各自的变更记录（见 §7） |
| 是否触发 app 发布 | 是 | 否 |
| 界面展示 | "关于 / 系统信息" 的 **应用版本** | "关于 / 系统信息" 的 **内容版本** |

**铁律**：内容数据更新**绝不**混用 app 版本号。一份书源或一条默认规则的增删改，只让
`contentRev +1`，不改 `version`，不发 app Release。这样用户能区分"软件升级了"与"内置资料更新了"。

---

## 3. 版本单一真源（Single Source of Truth）

**真源 = 应用仓库 Gradle 构建文件里的 `version` 字段**，当前为 `0.8.6`
（`E:\legado\legado\app\build.gradle` 的 `version = '0.8.6'`）。

该值在构建时被写入 jar 清单的 `Implementation-Version`，服务端从清单读取后经 `/healthz`
回报给界面，因此 **构建产物、接口、顶栏显示的是同一个数**（`app/build.gradle` 中 `jar` /
`fatJar` 任务的 `Implementation-Version: project.version`）。

以下各项**全部由真源派生**，禁止再手写一份版本号：

| 派生物 | 位置 | 派生方式 |
| --- | --- | --- |
| `VERSION` 文件 | `E:\legado\VERSION` | 等于真源，CI 校验一致性 |
| `package.json` version | `E:\legado\package.json`、`E:\legado\legado\package.json` | 等于真源，CI 校验一致性 |
| `README.md` 版本说明 | 两仓库 README 中的"当前版本" | 等于真源（建议改为引用 `/healthz` 或构建注入，避免再次手写漂移） |
| `CHANGELOG.md` 标题 | `## [x.y.z]` 顶部条目 | 由发布工具从真源生成 |
| Git Tag | `vX.Y.Z` | 去掉 `v` 后等于真源，否则发布中止 |

**版本目录（Version Catalog，`gradle/libs.versions.toml`）** 只承载**插件/依赖**版本，
与应用 `version` 是两件事；两者都必须是单一来源，并由 CI 校验"应用 version、Tag、各派生文件"
彼此一致（见 §6）。插件版本收口到 Version Catalog，不散落在各 `build.gradle`。

---

## 4. 变更日志自动化（CHANGELOG 不手写）

- 提交信息遵循 **Conventional Commits**：`feat:` / `fix:` / `perf:` 等会进入日志，
  `chore:` / `docs:` / `refactor:` 等默认不进用户可见段落。
- 使用 **release-please** 或 **git-cliff** 从提交历史自动生成 `CHANGELOG.md`，
  不手工维护条目。
- **Unreleased 段由 CI 维护**：合并到 `main` 的 PR 触发更新，把待发布的 feat/fix 累积到
  `## [Unreleased]`（或从上一版本条目派生）。
- **发布时自动转版本段落**：release 工具读取当前 `version`，把 Unreleased 内容落定为
  `## [0.8.6] - YYYY-MM-DD`，并开启下一个 Unreleased。
- `CHANGELOG.md` 随 fatJar 打进 `meta/changelog.md`（界面"更新日志"页读这份），见
  `app/build.gradle` 的 `processResources`，无需手写磁盘路径。

> 现状兼容说明：当前 `legado/CHANGELOG.md` 已有人工维护的 `[0.8.6]` 段落与固定小节顺序
> （新增→变更→修复→移除）。自动化接入后，以工具生成为准；存量条目作为 Unreleased 基线保留
> （见 §8）。

---

## 5. 发布四件套原子化

一次发布 = 四个动作在**同一工作流内串行执行**，任一步失败则整体回滚/中止：

```
1. version bump   → 更新 Gradle version（及 Version Catalog 如需）
2. CHANGELOG 生成 → 工具把 Unreleased 落定为新版本段落
3. Tag 打点       → 打 vX.Y.Z（去掉 v 必须等于第 1 步的 version）
4. Release 创建   → GitHub Release + 产物（fatJar / Docker）+ 通知
```

- 四个步骤**串行**且**同一 workflow**，不允许分步手工凑。
- 第 3 步前必须断言 `Tag 去掉 v == Gradle version`，不等则中止（§6）。
- 第 4 步后必须跑冒烟（§6），断言通过再对外可见。

---

## 6. CI 门禁

工作流落点：应用仓库 `E:\legado\legado\.github/workflows/`（发布类工作流只绑定 `main` 与
`v*` Tag）。详见随附的 `version-gate.yml`。

### 6.1 PR 门禁（代码路径变更时）
- 当 PR 触及代码路径（`legado/app/**`、`legado/web/**`、`legado/server/**` 等）时，
  **必须**同时满足其一：
  1. 本次变更包含 `CHANGELOG.md` 条目（或 Unreleased 段更新）；或
  2. 本次变更包含 `version` 字段变更。
- 纯内容数据 PR（`contentRev` 通道）不要求 app 版本/CHANGELOG 变更，改为要求内容变更记录
  （§7 门禁）。
- 纯文档/CI 变更豁免（由路径白名单控制）。

### 6.2 Tag / version 一致性校验
- 解析 `app/build.gradle` 的 `version` 与触发发布的 Tag（`vX.Y.Z`）。
- `Tag.replace(/^v/,'')` 必须 **严格等于** `version`，否则**中止发布**并报错。
- 同时校验 `VERSION` 文件、`package.json` version 与该值一致。

### 6.3 发布后冒烟（/healthz 断言）
- 启动构建产物，等待 `/healthz` 可答。
- 断言响应中的 `version` 字段 **等于本次 Tag（去 v）**。
- 不等则判定产物来自旧构建，发布失败、需重打 fatJar。

### 6.4 其它推送 / 配置约束
- **发布类工作流**只绑 `main` 与 `v*` Tag；`canny_dev`（开发分支）只跑 `build + lint`，
  不触发发布、不打 Tag。
- **Dependabot** 只开 `github-actions` 生态；插件/依赖升级单独提 PR，用 `assembleDebug`
  等做兼容门禁，不与功能 PR 混。
- 发布链路上的**第三方 Action 固定到 commit SHA**（不浮动 `v4` 之类分支引用），降低供应链风险。
- **Telegram 通知**用 `continue-on-error: true`，通知失败不阻断发布。
- **签名 keystore 用 Secrets 注入**，绝不进仓库；本地与 CI 都从 Secrets/环境变量读。
- 上述内容（§3 真源、§6 一致性、Version Catalog 单一来源）统一由 `version-gate.yml` 与
  `scripts/version-reconcile.mjs` 兜底校验。

---

## 7. 内容更新独立通道（contentRev）

内容数据（书源、发现页、内置清洗/正文/目录规则等）与 app 版本解耦：

1. **不 bump app `version`**，改为维护独立的 `contentRev`（单调递增整数或日期串）。
2. 内容更新**必须有自己的变更记录**（内容仓库内 `CHANGELOG` 或等价记录），说明本次改了哪些
   书源/规则。
3. **contentRev 递增校验**：内容 PR 必须让 `contentRev +1`，CI 校验未递减/未重复。
4. 界面「关于 / 系统信息」**分别展示**应用版本（来自 `/healthz`）与内容版本（来自
   `contentRev`），让用户一眼区分"软件升级"与"资料更新"。
5. 内容通道的发布可以是静默的内容同步，不触发 app Release、不打 app Tag。

---

## 8. 存量补救（分阶段）

### 8.1 先做版本对账（基线）
用 `scripts/version-reconcile.mjs` 比对以下四项，找出漂移并补 Unreleased 基线：
- 当前 `version`（`app/build.gradle`）
- 最新 Git Tag（应用仓库与父仓库）
- `CHANGELOG.md` 最新条目
- `/healthz` 实际返回值（服务可达时）

**当前实测漂移（2026-10-24）**：`version`/`VERSION`/`CHANGELOG` 顶部均为 `0.8.6`，
但应用仓库最新 Tag 仅 `v0.7.0`（落后约 107 个提交），父仓库最新 Tag 为 `v0.8.1`
（落后约 32 个提交）。这是典型的"真源已前进、Tag 没跟上"，需按下方分阶段补救。

### 8.2 短期（立刻可做）
- 加 **Tag/version 一致性校验**（§6.2）与 **PR 门禁**（§6.1）。
- 对账脚本接入 CI / 定时任务，漂移即告警。
- 在下一个正式发布时，补打 `v0.8.6` Tag 对齐真源，并清点 `0.7.0 → 0.8.6` 之间漏打的条目。

### 8.3 中期（接入自动化）
- 接入 release-please / git-cliff，Unreleased 段自动维护、发布自动转版本段落。
- 把 `README` 的"当前版本"改为引用 `/healthz` 或构建注入，消除又一处手写源。

### 8.4 长期（内容通道独立）
- 落地 §7 的 `contentRev` 独立通道，界面双版本展示，内容更新彻底脱离 app 版本。

---

## 9. GitHub 推送与插件配置

- **发布类工作流只绑定 `main` 与 `v*` Tag**；`canny_dev` 只跑 `build + lint`。
- **Tag 与版本目录（`libs.versions.toml`）、构建文件 version 必须单一来源**，CI 校验一致。
- **插件版本收口到 Version Catalog**，不散落各 `build.gradle`。
- **Dependabot 只开 `github-actions`**；插件/依赖升级单独 PR，用 `assembleDebug` 做兼容门禁。
- 发布链路**第三方 Action 固定 SHA**。
- **Telegram 通知 `continue-on-error`**。
- **签名 keystore 用 Secrets 注入，不进仓库**。

---

## 10. 插件系统结论

- 保留 `plugin` 包与事件总线，但**不新增扩展点**（维持现有工具/钩子/模型协议/连接策略四态）。
- `LEGADO_PLUGIN_JAR_SCAN` **默认关闭**：不自动装载磁盘上的第三方 jar（装载 = 在本机进程执行
  任意代码，而服务不设身份认证）。确需者显式置 `1`，且目录有 jar 未装载时运行日志明示、不静默。
- **不投入**插件市场 / 注册中心 / 签名流水线。
- 典型能力**先用内置模块实现**，不走第三方插件。
- **无沙箱不开放第三方插件**：在不提供隔离执行环境的前提下，不对外放开第三方插件装载。

---

## 11. 校验脚本与对账流程

- 脚本：`scripts/version-reconcile.mjs`（Node，仅内置模块 + child_process 调 git）。
- 用法（在父仓库根执行）：
  ```powershell
  node E:\legado\scripts\version-reconcile.mjs
  ```
- 它读取：Gradle 真源、父仓库 `VERSION`、`CHANGELOG.md` 顶部、两仓库最新 Tag、`/healthz`
  （不可达时跳过），逐项核对并列出漂移；发现漂移返回退出码 `1`，供 CI 门禁复用。
- 建议作为 CI 的"版本漂移"检查步骤，与 `version-gate.yml` 互补。

---

## 12. 执行清单（落地顺序）

1. 本规范与 `version-reconcile.mjs`、`version-gate.yml` 入仓（仅治理物，不动源码）。
2. 跑对账脚本，确认 §8.1 漂移清单。
3. 合入 `version-gate.yml`：PR 门禁 + Tag/version 一致性 + 发布后 `/healthz` 冒烟。
4. 在下次发布补打 `v0.8.6` Tag，对齐真源。
5. 中期接入 release-please / git-cliff，长期落地 `contentRev` 独立通道与界面双版本展示。
