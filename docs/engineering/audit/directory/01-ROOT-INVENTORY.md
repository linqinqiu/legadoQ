# 01 · 根目录盘点（ROOT-INVENTORY）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 1/9）
> 方法：`ls -la` + `git ls-files` 对照 + 引用关系 grep。判定基准：STRUCTURE.md 原则 3「根目录只放入口」。

## 1. 根目录全量清单（21 个条目）

| 条目 | 类型 | 跟踪状态 | 职责 | 判定 |
|---|---|---|---|---|
| `.codebuddy/` | 目录 | 跟踪（1 文件） | CodeBuddy 子代理配置（code-explorer.md） | 合规；内容陈旧见 04 分册 S-3 |
| `.github/` | 目录 | 跟踪（24 文件） | CI 工作流 7 份 + codex 提示词 + SECURITY/CONTRIBUTING 权威版 | 合规；两份政策文档内容失效见 03 分册 D-15/16 |
| `.gitignore` / `.gitattributes` | 文件 | 跟踪 | git 配置 | 合规；细节见 05 分册 S-26 |
| `AGENTS.md` | 文件 | 跟踪（146 行） | AI 协作纪律完整版 + 任务→位置速查 | 合规；测试数漂移见 D-13，措辞见 S-4 |
| `CLAUDE.md` / `GEMINI.md` / `.cursorrules` | 文件 | 跟踪（各 22 行） | 三份生成入口，SHA256 与模板一致 | 合规；模板缺项见 S-1/S-2 |
| `README.md` | 文件 | 跟踪（6.9K） | 仓库总览 + 上手 | 合规；功能表缺 AI 行（D-6）、端点手抄数（D-27） |
| `LICENSE` | 文件 | 跟踪（MIT，1.8K） | 仓库层许可 | 合规；与 product/LICENSE(GPL) 按路径分许可，NOTICE 明确，**必须两份** |
| `NOTICE.md` | 文件 | 跟踪 | 第三方与参照项目声明 | 合规 |
| `CHANGELOG.md` | 文件 | 跟踪（87B，3 行） | 指针 → product/CHANGELOG.md | 合规，有意分层 |
| `VERSION` / `BUILD_NUMBER` | 文件 | 跟踪（0.2.42 / 55） | 版本入口抄本 | 合规；version-check 钉住 |
| `RELEASES.md` / `RELEASING.md` | 文件 | 跟踪 | 发布台账（自动，不手改）/ 发布流程 | 合规；RELEASING 两处过时见 D-10/11 |
| `package.json` | 文件 | 跟踪（795B，纯转发脚本，无依赖） | npm 入口 | 合规 |
| `docs/` | 目录 | 跟踪 | 工程文档层 | 合规；engineering/ 未登记见 D-18 |
| `scripts/` | 目录 | 跟踪（13 文件） | 启停包装 + 版本/发布/协议工具 | 合规；两份死脚本见 S-8/S-9 |
| `product/` | 目录 | 跟踪 | 产品本体 | 合规；见 02 分册 |
| `logs/` | 目录 | **忽略**（根 .gitignore:37 `/logs/`，2 个运行日志） | 运行产物 | 合规 |

## 2. 结论

根目录**符合**「只放入口」原则：无散落产物、无未跟踪杂物、无职责不明文件。外部建议②快照中担心的「根目录越来越多文件」未发生——21 个条目全部有明确职责与引用方。

唯一运行态异常是 `product/port.txt`（未跟踪未忽略，见 G-1），不在根目录。

## 3. 与外部建议②根目录方案的差异

建议②提出根目录增加 `.ai/`、`tests/`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`ROADMAP.md` 等。**不采纳**：

- `.ai/` 与现有 AGENTS.md + protocol 机制重复（第二权威），见 04 分册 §2。
- `tests/` 顶层目录与现有「测试随产品」（product/app/src/test、product/web/test）冲突，门禁与 CI 路径全部按现布局标定，搬迁无收益。
- CONTRIBUTING/SECURITY 权威版已在 `.github/`（GitHub 社区标准位置），根目录再放一份会制造双权威；问题是内容失效（D-15/16），不是位置。
- ROADMAP 已在 docs/（唯一索引入口），根目录不放第二份。