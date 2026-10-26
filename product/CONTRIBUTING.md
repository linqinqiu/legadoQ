# 贡献指南（指向权威版）

> 权威版（英文，GitHub「Contribute」页展示）在仓库根 [`../../.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md)。
> 本文件只保留中文读者需要的**本地操作要点**，政策口径以权威版为准，避免双份维护。

## 环境要求

| | 版本 |
| --- | --- |
| JDK | **17**（`app/build.gradle` 的 toolchain 锁 17；CI 也统一用 17 —— 只装 21 时 Gradle 会去找一个不存在的 17 直接红） |
| Node | **20+**（CI 用 22，见 `.nvmrc`） |
| Gradle | 用仓库自带 `./gradlew` |

## 本地开发

```bash
npm --prefix web install
npm run dev          # 只起前端 dev server（热重载，不含后端）
npm test             # 全部用例：前端 node:test + 后端 JUnit
npm run check        # 前端类型检查（tsc）
node stop.mjs        # 停掉本项目在端口上的那个 java 进程
npm run build        # 见下面三步
node start.mjs       # 起服务并自动开浏览器（默认 127.0.0.1:1234）
```

## 构建顺序：先停，再建，再起

`npm run build` 是三步（`scripts/tasks.mjs`），顺序有意义：

| 步 | 做什么 | 产出 |
| --- | --- | --- |
| 1/3 | `npm --prefix web run build` | `web/dist/`（文件名带内容哈希） |
| 2/3 | `gradlew :app:fatJar` | `app/build/libs/legado-<版本>-all.jar`（把 `web/dist` 烤进 `static/`） |
| 3/3 | `tools/verify/bundled-ui-check.mjs` | 断言「jar 内 == processResources == dist == 运行中的实例」四处前端一致 |

**为什么必须先 `node stop.mjs`**：跑着的服务加载的是磁盘上那份 `-all.jar`。Windows 上覆盖它其实会成功（不是文件锁问题），但如果构建中途有东西把服务拉起来，那个进程读到的就是**写了一半的包** —— 表现是首页已经新了、`/healthz` 还报旧哈希。真正出过的事故是另一头：`fatJar` 一度只被 `npm run build` 调用，谁走 `gradlew build` / IDE 构建就只刷新普通 jar，`-all.jar` 静默留在过去，重启了也还是旧界面。现在两侧都有守卫：

- `start.mjs` 启动前：磁盘上有比 fatJar 更新的 `web/dist` → **拒绝启动**，并给出该敲的命令（回滚验证要绕过用 `LEGADO_ALLOW_STALE_JAR=1`）。
- `start.mjs` 启动后：抓 `/` 与 `web/dist` 比主 bundle 哈希，不一致就不打开浏览器、以退出码 1 结束。
- `app/build.gradle`：有 `web/dist` 时 `assemble` 依赖 `fatJar`，走 Gradle 的构建也会刷新可运行包。

一条命令确认"跑的是哪份前端"：`curl -s http://127.0.0.1:1234/healthz` —— 0.8.7 起它会回显 `ui`（包内主 bundle 哈希）与 `startedAtMs`（进程启动时刻）。

## 提交前 / 分支与 PR / 提交信息

- `npm run check` 与 `npm test` 都要过；动了框架层还要先跑 `./gradlew :app:verifyFramework`。
- 版本号唯一来源是 `app/build.gradle` 的 `version`；发版前升一档并在 `CHANGELOG.md` 顶部补一条。
- 从 `main` 切描述性分支，**别直接推 `main`**；一个 PR 只做一件事。
- 提交信息沿用 `<type>(<scope>): <中文说明>`（`fix` / `feat` / `refactor` / `docs` / `chore` / `test`）。
- 政策口径、支持范围、漏洞报告方式见仓库根 [`../../.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md)。
