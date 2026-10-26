# 更新日志自动化

用户 2026-10-24：「当更新修改内容自动更新更新日志」。

这份说清三件事：机制是什么、"自动"能做到哪、以及为什么停在"提交"这个边界上。

## 一句话

提交说明是日志的唯一事实来源。`feat` / `fix` 一类提交会被自动补成当前版本条目；
该记而没记时，`npm test` 与 CI 直接拦。

## 命令

| 命令 | 做什么 |
|---|---|
| `npm run changelog` | 把没进日志的提交写进 `CHANGELOG.md`（不自动提交，措辞留给你改） |
| `npm run changelog:dry` | 只看会写什么，不动文件 |
| `npm run changelog:check` | 有漏记就退出码 1（`npm test` 第 0 步与 CI 用它） |
| `npm run hooks:install` | 启用提交后自动补写（`npm install` 也会顺手跑） |

## 自动发生在哪两处

1. **git 钩子**（`.githooks/post-commit`）：每次提交之后，把这条提交（若它是 feat/fix/perf/revert）
   补成当前版本条目写进 CHANGELOG。**只改工作区、不 commit、不 amend** ——
   日志是给人读的文案，机器只能起草，最后一道措辞留给人；
   所以你可以在下一笔提交里顺手把措辞改掉。
2. **门禁**（`npm test` 的第 0 步 + `.github/workflows/contract.yml`）：
   最后一笔动过 CHANGELOG 的提交之后又有了 feat/fix，而日志没动 → 红。
   若 CHANGELOG 已有未提交改动，视为"正在补写"，放行。

## 哪些进、哪些不进

只认约定式提交 `type(scope)!: 一句话`。

- 进日志：`feat` → 新增，`fix` / `revert` → 修复，`perf` → 变更。
- 不进：`docs` `test` `chore` `build` `ci` `style` `refactor`。
  理由就是 CHANGELOG 顶部那条规矩：**只写用户能看见的变化**，"加了 12 条判据"对读者不是变化。

不记某一条 / 改写措辞：

```text
fix(缓存): 内部修复 XYZ-1 [no-changelog]

Changelog: 已缓存的章节不再误显示未缓存
```

- `[no-changelog]`（标题或正文）= 这条不进日志。
- `Changelog: 一句人话` = 用这句替换自动文案。
- `Changelog: none` = 同 `[no-changelog]`。
- 带 `!` 或 `BREAKING CHANGE:` 的，脚本会提示"该进档"，但**不擅自改版本号**：
  版本号的唯一书写处是 `app/build.gradle`，进档是人的决定。

## 边界与幂等（为什么不需要一份"进度文件"）

水位线 = 最后一次改动 `CHANGELOG.md` 的提交，不另存 sha。
再存一份状态就是再造一处会漂移的地方（本项目在版本号、端点数、体检基线上都栽过"两处各存一份然后互相不一致"）。
由此得到一条隐含规矩：**改完代码，把日志与代码一并提交**，下一轮边界就是那一笔。

幂等叠了两层：

1. 边界之后的提交才候选；
2. 生成的条目文案若与日志里已有的一条**逐字**相同，就跳过并报告"已记录 N 条"，
   所以你手写过一遍的不会又被插一条一模一样的。

想演练一段历史而不写盘：

```bash
node scripts/changelog.mjs --from v0.6.48 --dry-run
```

## 落点

| 文件 | 角色 |
|---|---|
| `scripts/changelog-lib.mjs` | 纯逻辑（解析标题、归类、合并进文本），不碰 git / 磁盘 |
| `scripts/changelog.mjs` | CLI：读 git、写文件、`--check` 门禁 |
| `scripts/install-hooks.mjs` | `git config core.hooksPath .githooks`（本地配置，进不了版本库） |
| `.githooks/post-commit` | 提交后起草条目 |
| `web/test/ChangelogAuto.test.ts` | 16 条判据钉住纯逻辑层（喂数据测，不起合成仓库） |

判据刻意只测 `changelog-lib.mjs`：git 与落盘那层要起真仓库跑 `git commit`，
在本机环境上不稳（实测会挂），所以所有**判断**都收进可测的纯函数里。
