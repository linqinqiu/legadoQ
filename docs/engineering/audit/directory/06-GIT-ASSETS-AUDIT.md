# 06 · Git 资产审计（GIT-ASSETS-AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 6/9）
> 方法：`git ls-files` / `git status --ignored` / `git check-ignore -v` 对照 + 文件名模式筛查。共 978 个被跟踪文件。
> 约束执行：禁读区只列清单/取大小；未读任何凭据/cookie/token 内容；未执行任何 git 写操作。

## 1. 敏感文件筛查 —— 通过

按文件名模式（`.env*` / `*credential*` / `*secret*` / `*.jks` / `*.p12` / `*keystore*` / `*cookie*.json` / `*token*`）查被跟踪文件：仅 `product/.env.example`（模板）与 `web/test/M3Tokens.test.ts`（设计 token 测试，误命中）。**无** keystore/jks/p12/cookie json 被跟踪。

忽略核实（`git check-ignore -v` 逐条命中）：

| 路径 | 规则 | 内容性质 |
| --- | --- | --- |
| `product/data` | product/.gitignore:42 | 用户书库（未读内容） |
| `product/.data` | :25 | 运行数据 |
| `product/app/data` | :44 | 运行数据 |
| `product/agent-profiles.json` | :28 + 根 :40 双保险 | 含 apiKey 的运行档案（未读内容） |
| `docs/.scratch/*` | 根 :66（仅 README.md 放行且已跟踪） | 审计草稿/语料克隆，25MB jsonl 等 9 项均忽略 |

## 2. 大文件与二进制 —— 通过

- 被跟踪最大 25 个中最大 `pwa-512x512.png` 423KB；**无 >1MB 被跟踪文件**。
- 唯一 jar：`gradle/wrapper/gradle-wrapper.jar` 54KB（Gradle 标准件，合理）；14 个 PNG 均为 web/public 图标。
- 无 zip/exe/dll/lnk/sqlite/db/log/diff/jsonl 被跟踪。
- 大文本提示（非违规）：`web/src/styles.css` 343KB、`reader/dict/openccData.ts` 244KB（生成词表，.gitignore:77-80 明确入库口径）、`ReaderScreen.tsx` 123KB（拆分路线图在案）。

## 3. 未跟踪 / 忽略核对

### G-1 `product/port.txt` 未跟踪且未被忽略 —— 中

- 证据：`git status --short` → `?? product/port.txt`；`git check-ignore -v` 无命中（同批 server.log/tmp/data 均命中规则）。`product/scripts/runtime.mjs:22-36`、`start.cmd:10` 证实它是「用户在界面改端口」时写的运行文件。
- 风险：`git add -A` 会把它入库；属运行数据，违反 STRUCTURE 原则 5。
- 建议：`product/.gitignore` 增加 `/port.txt`（与 `/agent-profiles.json` 同段，锚住安装根）。

### G-4 本机运行残留堆积（均已忽略，不污染 git）—— 低

- `product/app/hs_err_pid*.log` 39 个 + `replay_pid*.log` 2 个（JVM 崩溃转储，集中 11-12～11-14，属后端测试 worker 崩溃已知现象）。
- `product/tmp` 38MB（约 20 份 ~1MB sqlitejdbc.dll 解压副本 + 3 张截图）；根 `logs/` 2 个日志。
- 全部被 `*.log` / `/tmp` / `logs/` 规则覆盖；`scripts/clean-local.sh:16-73` 已把它们列为可安全删除目标。
- 建议：停服后跑 `bash scripts/clean-local.sh`（本轮只读，未执行）。JVM 频繁崩溃根因可转稳定性专项。

### G-12 审计期间的新未跟踪文件（并行活动提示）

- 开局仅 `?? product/port.txt`；收尾多出 `?? docs/research/研究-外部建议核对-2026-11-14.md`——本审计系列的主会话产物，将由主会话提交，非杂物。
- 纪律提醒：G-1 的忽略补丁提交时不得顺手 `git add -A`。

## 4. 空目录与预留

### G-5 `docs/engineering/{remediation,product,quality}/` 三个空目录 —— 低

- `find -type f` 零输出；全 docs/ grep 零引用；创建于 11-14 02:49，与 audit/（11 份报告）同时刻。
- 判定：疑似第一阶段审计预留的报告分册目录；git 不跟踪空目录，克隆后不存在。
- 建议：若预留则放 README 说明用途，否则删除（本轮审计的 9 份报告落 `audit/directory/`，不占用这三个目录）。

## 5. 库内归档口径

### G-6 `docs/archive/` 在库内 vs STRUCTURE「历史资料出库」—— 低

- 跟踪 8 文件共 540K（最大 `研究-界面与AI借鉴.md` 196K）；STRUCTURE.md:10/34 要求历史资料放仓库外 `legado-out/assets/archive`，但 AGENTS.md §0/§6 把 `docs/archive/` 当库内禁读区。
- 判定：两份纪律文档口径不一致；体积可控，属有意保留的轻量归档。
- 建议：STRUCTURE.md 补一句「docs/archive 为库内轻量归档例外」，或按原则 4 迁出。二选一，消除口径漂移。

## 6. 未查项（明示）

- `product/data/`、`product/app/data/`、`.data/` 内容（书库，仅验证忽略状态）；`docs/archive/`、build/dist/node_modules/jar 内容（仅 grep 命中行与体积）。
- `.env.example`、`agent-profiles.json`、cookie 相关文件内容（按约束只按路径判断）。
- git 历史大 blob / 历史泄密追溯（仅对 PluginManager.kt 做了一次 `git log --all` 定位移除时点）；仓库外 `E:\legado-out/`、`E:\legado-archive/` 实物未盘点。
- `product/tools/verify/retired/`（3 文件，白名单有意保留）未逐一评估退役价值。

## 7. 小结

git 卫生良好：无敏感文件入库、无 >1MB 产物入库、运行数据忽略网完整且有注释化白名单设计。需要动手的只有 G-1（补 `/port.txt` 忽略，中）与 G-2（插件遗留资产，见 07 分册，中），其余为低危清理与文档收口。