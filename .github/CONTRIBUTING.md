# 贡献指南

欢迎为 legadoQ 贡献代码！这是一个**完全由人类控制、零自动化 Bot** 的开源项目。
本文件是 GitHub「Contribute」页展示的权威版；本地构建细节见 [`product/CONTRIBUTING.md`](../product/CONTRIBUTING.md)，
文档唯一索引见 [`docs/README.md`](../docs/README.md)。

## 我们想要什么样的贡献

- **负责任**：你的提交和 PR 会直接影响用户体验
- **细心**：遵循代码风格与文档规范（前端约定见 `product/docs/frontend-conventions.md`）
- **沟通良好**：愿意讨论技术细节和设计方案
- **尊重项目边界**：本地优先、不内置书源与内容、默认安全模型不放宽（见根 README「边界」）

不接受：依赖自动更新 Bot（Dependabot/Renovate 等）生成的提交、未经测试的代码、
无必要的大规模重构。**所有依赖更新必须由人类开发者手动审核、选择版本、编写说明并提交。**

## 开发环境

| | 版本 |
| --- | --- |
| JDK | **17**（`product/app/build.gradle` toolchain 锁 17，CI 同） |
| Node | **20+**（CI 用 22，见 `product/.nvmrc`） |
| Gradle | 用仓库自带 `product/gradlew` |

```bash
git clone https://github.com/YOUR_USERNAME/legadoQ.git
cd legadoQ
npm --prefix product/web install   # 前端依赖

npm start                          # 起完整服务（默认 127.0.0.1:1234，自动开浏览器）
npm run stop                       # 停服

npm --prefix product/web run dev   # 只起前端 dev server：127.0.0.1:5174，/api 代理到 1234
```

测试与检查（提交前都要过）：

```bash
npm --prefix product/web test          # 前端全量（node:test 自研 runner，不是 vitest）
npm --prefix product/web run check     # 前端类型（tsc -b）
cd product && ./gradlew :app:test      # 后端全量（勿与前端测试并发跑）
```

构建顺序（先停、再建、再起）与 fatJar/前端一致性守卫的详细说明见
[`product/CONTRIBUTING.md`](../product/CONTRIBUTING.md)。使用 AI 辅助开发时，
先读根目录 `AGENTS.md` 的仓库纪律与任务→位置速查表。

## 提交规范

```
type(scope): 中文说明

[可选正文：改了什么 / 为什么 / 怎么验证]
```

type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore` / `ci`。

- **明确列出要提交的文件**（`git add <file>...`），不要 `git add .` / `-A`。
- 用户可见的变化必须在 `product/CHANGELOG.md` 顶部补条目；纯内部整改在提交信息带 `[no-changelog]`。
- 版本号唯一真源是 `product/app/build.gradle` 的 `version`；**日常提交不 bump `BUILD_NUMBER`**，
  发布时才随 `RELEASES.md` 记账（`VersionTracks.test.ts` 钉住）。发版流程见 `RELEASING.md`。

## 提 PR

1. 从 `main` 切描述性分支（`feature/...` / `fix/...`），别直接推 `main`
2. 一个 PR 只做一件事；测试全绿、类型检查通过
3. 描述清楚：做了什么、为什么、怎么验证的（UI 改动附截图）
4. 引用相关 issue（如有）

审查为个人项目维护者尽力而为：普通 PR 数日内响应，紧急安全问题优先。

## 报告 Bug / 功能建议

用 [GitHub Issues](https://github.com/linqinqiu/legadoQ/issues/new/choose)（有模板）。

- Bug：`[Bug] 简短描述` + 重现步骤、预期 vs 实际、环境（OS/浏览器）、日志
- 功能：`[Feature] 简短描述` + 背景、具体描述、用户价值
- **安全漏洞不要开公开 issue**，走私密报告通道（见 [SECURITY.md](SECURITY.md)）

## 认可

被采纳的贡献会在 CHANGELOG / 发行说明中致谢。项目不设贡献者等级或奖励承诺。

## 联系

- [GitHub Discussions](https://github.com/linqinqiu/legadoQ/discussions)：提问或分享想法
- GitHub Issues：Bug 与功能建议

---

最后更新：2026-11-14