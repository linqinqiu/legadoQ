# 贡献指南（指向权威版）

> 权威版（GitHub「Contribute」页展示）在仓库根 [`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。
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
npm run doctor       # 只读体检：Node / npm / JDK / wrapper / 依赖 / 产物 / 端口
npm run pr           # 提交前门禁：契约、脚本、前端类型与用例、后端用例
npm test             # 全部用例：前端 node:test + 后端 JUnit
npm run check        # 前端类型检查（tsc）
node stop.mjs        # 停掉本项目在端口上的那个 java 进程
npm run build        # 见下面四步
npm run full         # pr + 完整构建 + 包内界面与体积预算
node start.mjs       # 起服务并自动开浏览器（默认 127.0.0.1:1234）
```

## 构建顺序：先停，再建，再起

`npm run build` 是四步（`scripts/tasks.mjs`），顺序有意义：

| 步 | 做什么 | 产出 |
| --- | --- | --- |
| 1/4 | `npm --prefix web run build` | `web/dist/`（文件名带内容哈希） |
| 2/4 | `tools/verify/dist-check.mjs` | 断言 `index.html` 与它引用的 `assets/` 真的存在（防"构建到一半"的残骸进包） |
| 3/4 | `gradlew :app:fatJar` | `app/build/libs/legado-<版本>-all.jar`（把 `web/dist` 烤进 `static/`） |
| 4/4 | `tools/verify/bundled-ui-check.mjs` | 断言「jar 内 == processResources == dist == 运行中的实例」四处前端一致 |

**Windows 构建临时目录**：`web` 的标准及备用构建均经 `scripts/build-web.mjs` 执行，保留
`tsc -b` 和各自 Vite 参数。每次为子进程分配仓库根目录下独立的 `tmp/web-build-*`（已忽略），
结束后清理，避免共享 `TEMP/TMP` 中的 esbuild 大块输入删除失败；不改系统环境变量。

**仍报 `[vite:esbuild-transpile] remove ... Access is denied` 时**：检查报错路径是否为上述
独立目录，再排查文件权限及外部占用；本次实测仅确认更换目录可解除故障，未确定占用程序。可用
`LEGADO_WEB_BUILD=fallback npm run build`（PowerShell：`$env:LEGADO_WEB_BUILD='fallback'; npm run build`）
让整条链改走 `build:fallback`（`--target esnext --minify terser`，仍然压缩），并在提交说明里注明；
**不要**把这条兜底当成发布默认值 —— 发布仍应在正常环境用标准 `npm run build`。两条路都会经过
`2/4` 的 `dist-check`。

**为什么必须先 `node stop.mjs`**：跑着的服务加载的是磁盘上那份 `-all.jar`。Windows 上覆盖它其实会成功（不是文件锁问题），但如果构建中途有东西把服务拉起来，那个进程读到的就是**写了一半的包** —— 表现是首页已经新了、`/healthz` 还报旧哈希。真正出过的事故是另一头：`fatJar` 一度只被 `npm run build` 调用，谁走 `gradlew build` / IDE 构建就只刷新普通 jar，`-all.jar` 静默留在过去，重启了也还是旧界面。现在两侧都有守卫：

- `start.mjs` 启动前：当前版本 fatJar 缺失，或包内界面指纹与 `web/dist` 不一致 → **自动重建一次**并复验；`--no-build` / `LEGADO_NO_AUTO_BUILD=1` 可禁用，显式回滚旧包仍用 `LEGADO_ALLOW_STALE_JAR=1`。
- `start.mjs` 启动及复用前：按选中 jar 检查实际 HTTP 首页与静态资源内容，失败时不打开浏览器、以非零退出；动态品牌 manifest 校验成功响应与结构。
- `app/build.gradle`：有 `web/dist` 时 `assemble` 依赖 `fatJar`，走 Gradle 的构建也会刷新可运行包。

一条命令确认"跑的是哪份前端"：`curl -s http://127.0.0.1:1234/healthz` —— 0.8.7 起它会回显 `ui`（包内主 bundle 哈希）与 `startedAtMs`（进程启动时刻）。

## 提交前 / 分支与 PR / 提交信息

- 提交前跑 `npm run pr`；动了框架层还要先跑 `./gradlew :app:verifyFramework`。
- 版本号唯一来源是 `app/build.gradle` 的 `version`；发版前升一档并在 `CHANGELOG.md` 顶部补一条。
- 从 `main` 切描述性分支，**别直接推 `main`**；一个 PR 只做一件事。
- 提交信息沿用 `<type>(<scope>): <中文说明>`（`fix` / `feat` / `refactor` / `docs` / `chore` / `test`）。
- 政策口径、支持范围、漏洞报告方式见仓库根 [`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md)。
