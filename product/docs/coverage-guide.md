# 覆盖率怎么看、怎么补

> 一条命令出总报告：`npm run coverage`

## 1. 一条命令

```bash
npm run coverage              # 跑前后端测试 + 生成总报告
npm run coverage:report-only  # 不跑测试，只用现有数据重出报告
```

产物（`coverage-report/`，已 gitignore）：

| 文件 | 用途 |
|---|---|
| `index.html` | 总报告，浏览器打开 |
| `summary.md` | 一句话摘要，可直接贴 PR |
| `summary.json` | 机器可读（CI 用） |

## 2. 当前数据（2026-10-21，补测三轮后）

**整体行覆盖 70.1%**（15014 / 21427 行）

| | 行 | 分支 | 函数 |
|---|---:|---:|---:|
| 后端（JaCoCo） | 66.1% | 40.8% | — |
| 前端（c8） | 74.18% | 81.09% | 68.04% |

### 补测成果（三轮，新增 88 条测试）

| 目标 | 起始 | 现在 | 说明 |
|---|---:|---:|---|
| `AgentCatalog` | 0% | **97.1%** | 纯读 JSON，一个测试类解决 |
| `settingsSections.ts` | 32% | **100%** | 从"只读源码字符串"改成"真调用" |
| `BackupStore` | 37.7% | **100%** | 纯文件读写，重点在路径安全 |
| `SubscriptionService` | 30.2% | **49.2%** | 订阅源五种包装形状 |
| `UpdateCheck` | 31.4% | **46.7%** | 抽出 `parseReleases` 纯函数 |
| `OpenAiCompatibleProvider` | 5.7% | **37.1%** | 抽出 `endpointUrl` / `parseReply` |
| `PwaManager.tsx` | 13.8% | **21.5%**（函数 80%） | 三个导出函数的行为 |

补测过程中**挖出并修掉 3 个真实缺陷**：

1. `OpenAiCompatibleProvider.endpointUrl`：`baseUrl` 为空串时会拼出 `/v1/chat/completions`
   —— 没有 host 的地址，`URI.create` 能过、`HttpClient.send` 才炸，
   表现为"AI 连不上"而不是"baseUrl 没配"。
2. `OpenAiCompatibleProvider.parseReply`：注释写着"解析失败退回响应原文"，
   但 `parseToJsonElement` 遇到非 JSON 会**抛异常**，这条兜底根本走不到。
   上游返回 HTML 错误页时会被吞成"模型没回答"。
3. `BackupStore.KEEP_NAMES`：`httpTTS.json` 与 `httptts.json` 同时存在，
   是同一个文件名的两种写法。

### 后端最该补的包

| 包 | 行覆盖 | 为什么低 |
|---|---:|---|
| `io.legado`（根） | 33.3% | `Application.kt` / `DesktopLauncher.kt` 启动装配难单测 |
| `http` | 43.5% | 路由层大量 handler 只在 E2E 里跑，单测没覆盖 |
| `subscription` | 49.2% | 订阅更新是网络任务，已补到纯逻辑部分 |
| `tts` | 49.2% | Edge-TTS 要真实 WebSocket 连接 |
| `source` | 53.4% | `WebViewProxy` / `ExternalBrowserLogin` 要真浏览器 |

### 后端最该补的 15 个类

```
  0%    DesktopLauncherKt              （桌面启动器，E2E 才跑得到）
  0%    ai.AgentCatalog                （28 行，纯读 JSON，最容易补）
  7%    source.ExternalBrowserLogin    （114 行，要真浏览器）
  7.7%  ai.OpenAiCompatibleProvider    （65 行，外呼 HTTP，可 mock）
 25.3%  source.SourceDebugger
 27.1%  subscription.SubscriptionService
 31.4%  ops.UpdateCheck
 31.5%  source.WebViewProxy           （197 行，最大的未覆盖块）
 31.7%  tts.EdgeTtsService
```

### 前端最该补的目录

| 目录 | 行覆盖 | 说明 |
|---|---:|---|
| `src/components` | 43.2% | 大组件：`ReplaceRulesModal`（505 行未覆盖）、`OfflineCacheModal`、`Select` |
| `src/sources` | 64.9% | `SourceSwitchModal` 17.8% 拖累 |
| `src/pages` | 66.6% | 页面级组件 |
| `src/lib` | 84% | 工具函数，覆盖较好 |
| `src/reader` | 86.8% | 阅读器内核，覆盖最好 |
| ~~`src/settings`~~ | **100%** | 已补完（`settingsSections.ts`） |

## 3. 建议的补充顺序

按「**补了收益最大 / 成本最低**」排，不是按百分比排。
**第一、第二优先已全部补完**（见 §2 的成果表），下面保留原始判断依据供参考，
第三优先仍是当前该做的。

### ✅ 第一优先：纯逻辑、易测、没覆盖（已完成）

| 目标 | 行数 | 结果 |
|---|---:|---|
| `ai.AgentCatalog` | 28 | 0% → **97.1%** |
| `settingsSections.ts` 的 33-134 行 | ~100 | 32% → **100%** |
| `ops.UpdateCheck` | 70 | 31.4% → **46.7%**（抽 `parseReleases`） |

### ✅ 第二优先：要 mock 但值得（已完成）

| 目标 | 行数 | 结果 |
|---|---:|---|
| `ai.OpenAiCompatibleProvider` | 87 | 5.7% → **37.1%**（抽 `endpointUrl` / `parseReply`） |
| `subscription.SubscriptionService` | 63 | 30.2% → **49.2%**（抽 `parseSources`） |
| `backup.BackupStore` | 53 | 37.7% → **100%** |
| `subscription.SubscriptionService` | 59 | mock 抓取，覆盖成功 / 失败 / 内容未变三种 |
| `backup.BackupStore` | 47 | 纯文件读写，用临时目录 |

### 第三优先：成本高，先记着

| 目标 | 行数 | 难点 |
|---|---:|---|
| `source.WebViewProxy` | 197 | 要真浏览器 / 反代会话 |
| `source.ExternalBrowserLogin` | 114 | 要拉起本机 Chrome |
| `tts.EdgeTtsService` | 240 | 要真实 Edge-TTS WebSocket |
| `DesktopLauncherKt` | 177 | 桌面启动路径，E2E 覆盖 |

这几块**不要硬写单测**——它们的价值靠 `tools/verify/` 的真浏览器门禁覆盖
（`external-login-check`、`reader-flow-check` 等）。单测硬 mock 只会测到 mock 本身。

## 4. 为什么不设覆盖率门禁

**故意的。** 三个理由：

1. **一上来就卡数字只会逼人写凑数测试** —— 测 getter、测常量、测"能 new 出来"，
   覆盖率上去了，缺陷检出率没变。
2. **本项目的主要保障不是覆盖率，是判据测试**：665 条前端判据 + 535 条后端测试 +
   78 个真浏览器门禁。它们验的是**行为与不变量**（端点契约、依赖方向、界面文案、
   开书链路），不是"这行被执行过"。
3. **高覆盖率的地方不代表没问题**。`rules` 83% 覆盖，但书源方言的坑是靠
   `RuleRunnerTest` 一条条钉出来的，不是靠覆盖率发现的。

**反过来也成立**：这三轮补测最有价值的产出不是百分比，而是**挖出的 3 个真实缺陷**
（见 §2）。它们都不是"覆盖率低"这件事本身发现的，而是"为了测它，必须先把逻辑
从 `post()` / `check()` 里抽出来"——抽的过程逼人重新读了一遍那段代码。

所以：**先看清楚哪里没覆盖，再决定要不要卡、卡在哪**。现在整体 70.1%，
第一/第二优先已补完，可以考虑对**新增代码**设门禁（`c8 --check-coverage`
只对 diff 生效），比全仓卡阈值有用得多。

### 一条更重要的原则：该测什么，不该测什么

| 该写单测 | 不该写单测 |
|---|---|
| 纯函数、边界条件、解析、拼装 | React 组件渲染、布局、交互 |
| 安全校验（路径穿越、SSRF、写门） | 真实 HTTP 往返（mock 只会测到 mock） |
| 契约一致性（条数、字段、白名单） | 真浏览器 / WebSocket / 外部服务 |

右列那些靠 `tools/verify/` 的真浏览器门禁覆盖。单测硬 mock 它们，
测的是 mock 的行为，不是产品的行为。`ReplaceRulesModal`（505 行未覆盖）就是典型 ——
它是纯 UI，该由 `replace-rules-check` 那类门禁管。

## 5. CI 里怎么跑

`.github/workflows/coverage.yml`：

- push to main / PR / 手动触发；
- 后端 `:app:testCoverageReport`（**ignoreFailures**，已知失败基线不挡报告）；
- 前端 `npm run test:coverage`；
- 合并成总报告，摘要贴进 Job Summary，HTML 作为 artifact 上传（保留 30 天）。

**不阻塞合并**：没有任何 `--check-coverage` 或阈值判断。

## 6. 两个技术细节（踩过的坑）

### 6.1 后端为什么单独一个 `testCoverageReport` 任务

`jacocoTestReport` 依赖 `test`，而本机 `test` 有一条**已知的、环境相关的**失败
（`E2EScenariosTest` scenario 2，在 `tools/verify/baselines/server-test-failures-47.txt` 里）。
那条一红，`test` 任务失败，**覆盖率报告整个生成不出来** ——
而覆盖率恰恰是最该在有失败时看的。

所以复制了一份 test 任务，唯一区别是 `ignoreFailures = true`：
测试照跑、执行数据照记，任务不中断，报告能正常出。

```bash
./gradlew :app:testCoverageReport
# 产物：app/build/reports/jacoco/testCoverage/html/index.html
```

### 6.2 为什么过滤掉 JaCoCo 里的 lambda 类

JaCoCo 会把 Kotlin 的匿名类列成独立类，名字长这样：

```
io.legado.tts.EdgeTtsService.synthesize.listener.new WebSocket.Listener() {...}
```

它们没有独立名字、也没法单独写测试。实测前 15 名里 11 个是这种 ——
列在"最该补"里只会把真正该补的类挤下去。所以汇总脚本过滤掉含 `.new ` 的类。

### 6.3 Windows 上跑子进程

`gradlew.bat` 与 `npm.cmd` **必须**经 shell 才能启动（直接 spawn 报 EINVAL / ENOENT），
但 `shell: true` + 参数数组会触发 Node 的 DEP0190。所以脚本按平台分两条路：
Windows 用 `execSync` 跑拼好的整串命令，其他平台用 `execFileSync`。
命令都是脚本里写死的，没有注入面。
