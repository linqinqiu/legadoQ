# 04 · AI 指令体系审计（AI-INSTRUCTIONS-AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 4/9）
> 范围：AGENTS.md、CLAUDE.md、GEMINI.md、.cursorrules、.codebuddy/、scripts/protocol-template.md、scripts/protocol.mjs。

## 0. 已核无问题项

- CLAUDE.md / GEMINI.md / .cursorrules / scripts/protocol-template.md 四份 SHA256 完全一致（`c5389962…b98a5b89`，各 22 行 2196B）——「三份入口由模板生成」机制真实有效。
- `protocol:check` 已接 CI：`contract.yml:132` `node ../scripts/protocol.mjs --check`。
- 模板与 AGENTS.md 的测试命令等价（`cd product/web && npm test` ≡ `npm --prefix product/web test`）、后端命令一致、探索纪律一致。
- `.codebuddy/` 下仅 `agents/code-explorer.md` 一份。

**结论：外部建议担心的「五份指令各自漂移」在生成链内的三份上已被机制防住；真正的盲区在生成链外（S-2/S-3）与模板内容缺项（S-1）。**

## 1. 发现清单

### S-1 精简版协议缺「禁读区」与版本纪律 —— 中

- 路径：`scripts/protocol-template.md:7-12` vs `AGENTS.md:4,17`
- 证据：模板五条铁律只讲「别乱读/先查表/委派子代理」，无禁读区清单（docs/archive/**、product/data/** 等）、无 BUILD_NUMBER 纪律；AGENTS.md:4 有完整禁读区。
- 风险：只自动加载 CLAUDE.md/GEMINI.md/.cursorrules 的工具（如 Claude Code 读 CLAUDE.md 不读 AGENTS.md）拿不到这两条硬规则，除非主动跟指针读 AGENTS.md。
- 建议：模板加一行禁读区 + 一行版本纪律，`protocol:sync` 重生成。

### S-2 AGENTS.md ↔ 模板无双向防漂移机制，已存在具体漂移 —— 中

- 路径：`scripts/protocol.mjs:11`；`scripts/protocol-template.md:15` vs `AGENTS.md` §3
- 证据：`targets = ['CLAUDE.md','GEMINI.md','.cursorrules']`——check 只钉「三份==模板」，不校验「模板与 AGENTS.md 关键规则一致」。实例：模板:15 称「书签/笔记在 useReaderNotes.ts」，AGENTS.md §3 明确「toggleBookmark 仍在 ReaderScreen.tsx」。
- 建议：`protocol.mjs --check` 增加关键规则断言（测试命令/禁读区/版本纪律字符串比对），或模板热点段从 AGENTS.md 派生。

### S-3 code-explorer.md 在同步机制外，行数已陈旧 —— 中

- 路径：`.codebuddy/agents/code-explorer.md:29`
- 证据：`ReaderScreen(2402) / RuleRunner(2333)` vs AGENTS.md 实测 2346 / 1679；该文件也不含禁读区。protocol targets 不含它，无任何门禁钉它。
- 建议：纳入同步或改为纯符号引用（去掉行数）；补禁读区一行。

### S-4 AGENTS.md 自述措辞矛盾 —— 低

- 路径：`AGENTS.md:140`
- 证据：「协议已在 CLAUDE.md·.cursorrules·GEMINI.md·AGENTS.md 各放一份自包含精简版」——AGENTS.md 自身是 146 行完整版，非精简版（同段后文「三份精简版」才准确）。
- 建议：改为「三份精简版 + 本完整版」。

### S-5 Codex 审查提示词单行压缩、无 CI 引用 —— 低

- 路径：`.github/codex/prompts/review.md`（1368B，全文 0 换行）
- 证据：与重组期 7 个工作流「压成一行」同形态；7 个工作流均不引用它（应为 Codex 云 PR 审查约定路径，未验证是否现役）。内容本身合格（只读、抗注入、P0-P3 分级）。
- 建议：确认 Codex 集成是否消费；恢复多行可读格式。

## 2. 与外部建议的对照

建议②提出建 `.ai/core|workflows|agents` 统一规范中心。**不采纳该形态**：本仓已有「AGENTS.md 完整版 + 模板生成三份精简版 + protocol:check 门禁」的等价机制，另建 `.ai/` 会制造第二权威。正确动作是补上述 S-1～S-3 三个盲区，并把「AI 指令唯一源 = AGENTS.md + protocol-template.md」写进 STRUCTURE.md（见 08 分册）。