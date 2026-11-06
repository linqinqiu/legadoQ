# 现场事实清单（facts）

> 单一事实源：本文件记录**带时间戳、带命令、带口径**的实测数字。
> 其他文档（`docs/STATUS.md`、`backend-layering.md`、`frontend-host.md`）里的规模数字写于各自 commit，
> 属于历史事实；与本文冲突时以本文为准，并重新跑一遍命令。
>
> 最近采集：**2026-11-05 22:33–22:42（本地）**。工作树当时**不干净**，见 §5。

---

## 0. 口径约定（读数字前先看）

1. **区分 HEAD 与工作树**：有未提交改动时，文件数/行数会变。每条都标注口径。
2. **`@Test` 计数 ≠ 测试通过数**：`grep -rho "@Test"` 只是静态计数，没有运行。
3. **计数用 `grep -o`，不用 `grep -c`**：后者是“包含该 token 的行数”，不是出现次数。
4. **运行态 ≠ 源码**：服务跑的是某个 jar；源码改过但没重建时，两者不一致。
5. **瞬时状态单列**（§5），不要当成“项目一直如此”。

---

## 1. 锚点

| 项 | 值 | 取证 |
|---|---|---|
| 仓库 | `E:\legado` | — |
| HEAD | `76ffe0d`（2026-11-05 18:33:56 +0800） | `git log -1 --format="%h %ad" --date=iso` |
| 版本 tag | `v0.2.17` | `git tag --points-at HEAD` |
| 版本 | 0.2.17 / build 13（22:33 快照；当前 build 见下方注记） | `cat VERSION BUILD_NUMBER`；`/healthz` |
| 版本真源 | `product/app/build.gradle:117` | 其余为派生 |

> 2026-11-06 00:03：`BUILD_NUMBER` 由 13 bump 到 **16**（内部计数；对外版本仍 0.2.17）。
> 2026-11-06 10:32：`BUILD_NUMBER` 由 16 bump 到 **17**（`login` 金标准 fixture；对外版本仍 0.2.17）。
> 2026-11-06 10:44：`BUILD_NUMBER` 由 17 bump 到 **18**（阅读器全崩修复 + 冒烟判据；对外版本仍 0.2.17）。
> 2026-11-06 11:27：`BUILD_NUMBER` 由 18 bump 到 **19**（reader 拆组、数据目录退回、便携包说明；对外版本仍 0.2.17）。

---

## 2. 源码规模（工作树，2026-11-05 22:33）

| 项 | 值 | 命令 | 口径 |
|---|---:|---|---|
| 后端 `.kt` | **128** | `find product/app/src/main/kotlin/io/legado -name '*.kt' \| wc -l` | 含 2 个未跟踪文件 |
| 后端行数 | **32,511** | `find ... -exec cat {} + \| wc -l` | 同上 |
| 后端 `@Test` | **947** | `grep -rho '@Test' product/app/src/test --include=*.kt \| wc -l` | 静态计数，未运行 |
| 后端测试文件 | **120** | `find product/app/src/test -name '*.kt' \| wc -l` | — |
| 前端 ts/tsx | **178** | `find product/web/src -name '*.ts' -o -name '*.tsx' \| wc -l` | — |
| 前端测试文件 | **111** | `ls product/web/test/*.test.ts \| wc -l` | — |

**HEAD 干净树（21:35 实测）**：126 个 `.kt` / 32,408 行。差额来自未跟踪的
`rules/GzipLimits.kt` 与 `rules/SearchFlow.kt`。

> 23:52 复核：**952** 个 `@Test` / **121** 个测试文件（`GoldenRuleTest` 新增 4 项）。
> 2026-11-06 10:32 复核：**954** 个 `@Test` / **121** 个测试文件（`GoldenRuleTest` 新增 login v1/v2 两项；
> `rule-golden` 共 15 个 fixture 文件）。后端仍 128 个 `.kt`。
> 2026-11-06 10:44 复核前端：**112** 个测试文件 / **911** 项通过（新增 `ReaderScreenSmoke.test.ts`）。
> 2026-11-06 11:27 复核结构：后端 **129** 个 `.kt`（新增 `DesktopDataDir.kt`）；前端仍 177 个 ts/tsx，
> 但 `features/reader` 由「50 个文件平铺」改为「根 8 + 8 组」：
> `tts/8` `interaction/8` `content/13` `notes/3` `dialogs/3` `settingsPanel/11` `typeset/3` `dict/1`。

---

## 3. 构建产物

| 项 | 值 | 备注 |
|---|---|---|
| fat jar | `legado-0.2.17-all.jar`，34,771,619 B，2026-11-06 11:27 | 已含 build 19；UI 与 dist 一致 |
| web/dist | 22 个文件，3.3 MB | 与 jar 内嵌 `static/` 逐字节一致（sha256 核对） |
| 桌面 zip | `dist/legadoq-desktop-0.2.17.zip`，**180 条**，sha256 `BF14964D…` | build 19；新增 `使用说明.txt` / `启动.bat` |
| 运行 UI 指纹 | `index-DghFeY15.js`（sha256 前缀 `2ac37b18…`） | dist / jar / `/healthz` 三处一致（11:27）；拆组不改最终 bundle |

---

## 4. 数据库（`product/data/legado.sqlite`，22:33 运行态快照）

| 指标 | 值 |
|---|---:|
| 库文件 | 222 MB（WAL 5.1 MB，SHM 32 KB） |
| 页大小 × 页数 | 4096 × 56,595 ≈ 231.8 MB |
| 空闲页 | 385（≈1.5 MB，碎片率极低） |
| journal / auto_vacuum | `wal` / `0`（关闭） |
| 书源总数 / 启用 | 5,600 / 5,600 |
| RSS 源 / 订阅 | 178 / 1 |
| 书架书 / 分组 | 8 / 4 |
| 阅读进度 / 阅读记录 | 10 / 78 |
| 笔记 / 书签 | 0 / 1 |
| 正文缓存 | 6,053 行 / 52,432,811 B（约 50.0 MB） |
| 目录缓存 | 523 |
| Cookie / 书源体检 / 替换规则 / 脚本缓存 | 586 / 41 / 288 / 137 |
| 日志 | 5,000（**疑似**保留上限，未经代码确认） |
| 磁盘 | 4 份库快照共 872 MB（最新 21:30）；`server.log` 13.6 MB |

查询方式（只读，不碰 WAL）：

```bash
sqlite3 "file:product/data/legado.sqlite?mode=ro" \
  "SELECT count(*) FROM source;"
sqlite3 "file:product/data/legado.sqlite?mode=ro" \
  "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;"
```

---

## 5. 现场状态（瞬时，2026-11-05 22:42）

| 项 | 状态 |
|---|---|
| 工作树 | 脏：`M rules/JavaPackages.kt`、`M rules/JsGuard.kt`、`?? rules/GzipLimits.kt`、`?? rules/SearchFlow.kt` |
| `:app:compileKotlin` | **失败**：`JsGuard.kt:30:37 Unresolved reference 'DEFAULT_TIMEOUT_MS'`（22:33、22:42 两次复测同一错误） |
| `ArchitectureBoundaryTest` | 无法运行（编译前置失败） |
| `depth-check` | 通过（22:36）：后端 128 个 `.kt`，过深 11 个，无新增 |
| 服务 | 运行中，PID 20028，21:30:34 启动 |
| `/healthz` | `0.2.17 / build 13 / ok / index-WpCwxxOG.js` |
| live vs 源码 | **不一致**：jar 18:44，源码 21:42+ 有未提交改动 |

上述任一项都会随下一次 commit / 重启变化，**不要**把它们写进“项目常驻描述”。

---

## 6. 文档/记忆与实测的偏差

| 来源 | 说法 | 实测 | 处置 |
|---|---|---|---|
| 记忆 | 0.2.13 / build 10（2026-11-02） | 0.2.17 / build 13 | 已更新记忆，来源 `/healthz` |
| `docs/STATUS.md` | 0.2.14 / 927 / 120 / 175 / 900 | 0.2.17 / 947 / 120 / 178 / 111 | 整份过期，标记指向本文 |
| `backend-layering.md` | 123 / 32,153 / 935 | 128 / 32,511 / 947 | 写于 `bebd824`，数字以本文为准 |
| `frontend-host.md` | 177 / 110 | 178 / 111 | 同上 |
| `rule-processor-migration-plan.md` | `RuleRunner` 2413 行 | 2405 | 直接修正 |
| `RuleProcessor.kt:83` 注释 | “当前状态（0.2.14）……2413 行” | 0.2.17 / 2405 | 注释过期，“尚未接入”仍成立 |

**纪律**：不要把旧文档里的数字逐项改成新数字——那会让它们变成永远追不上 HEAD 的第二事实源。
正确做法是在文档头加一行“写于 `<commit>`，规模数字已过期，以 `facts.md` 为准”。
