# 门禁（tools/verify）怎么跑、怎么接 CI

> `tools/verify/` 顶层 **80 个** `.mjs` 脚本（`retired/` 另有 2 个已退役），其中 45 个是 `*-check.mjs` 判据。
> 它们都是"现量"判据：开真 Chrome 打开真界面量，不打桩、不看快照。这份文档说清它们的分类、怎么在本地跑、CI 里跑哪些。
>
> 数字会随脚本增删漂移。**权威清单永远是 `node scripts/run-all-gates.mjs --list` 的输出**，
> 本文的数字是 2026-10-21 的实测值，对不上时以命令输出为准。

## 0. 一条命令跑完全部（**先跑这个**）

```bash
node scripts/run-all-gates.mjs            # 串行跑全部 45 个 *-check.mjs
node scripts/run-all-gates.mjs --list     # 只列清单
node scripts/run-all-gates.mjs --filter=ui  # 只跑名字含 ui 的
```

串行、失败继续、最后汇总，产物落在 `tools/verify/out/gates-<时间戳>.json`。

**为什么必须有这条命令**：CI 里用通配符 `*-check.mjs` 扫，但本地从来没人跑过全部。
2026-10-21 第一次跑，**47 个里 12 个红** —— 其中大部分红了很久，没人知道。
门禁一直红着的代价比没有门禁更大：它会训练所有人忽略 CI 的红。

**跑一次约 22 分钟**（最慢的 `subscription-check` 275 秒、`reading-log-check` 142 秒）。

## 1. 分类（别一股脑全跑）

| 类别 | 数量 | 特征 | 何时跑 |
|---|---|---|---|
| **冒烟三件套** | 3 | 快、覆盖面大、不依赖具体书源 | 每次 push / PR |
| **真浏览器门禁** | 34 | 需 Chrome + 服务在跑，单个 10~275 秒 | main 推送 / 发版前 |
| **普查类** | 若干 | 只产出数据（`*-census.mjs` / `snapshot*`），不是判据 | 需要数据时手动跑 |
| **诊断类** | 若干 | 排查问题用，无断言 | 出问题时手动跑 |
| **退役** | 2 | 被测对象已删除，放在 `tools/verify/retired/` | 永不跑（留作历史） |

顶层 `80` 个脚本里 **57 个需要服务在跑**（引用 `BASE`）、**45 个会拉起真浏览器**
（`puppeteer.launch`）；只看 45 个 `*-check.mjs` 判据则是 **42 个要服务**、**34 个要浏览器**。
所以不能全塞进 CI。

## 2. 冒烟三件套（发布红线）

```bash
# 前置：服务在跑
npm start

# 1) 版本号单一来源 + 前端产物一致 + 顶栏版本可读
node tools/verify/version-check.mjs          # 17 项

# 2) 端到端：搜索→详情→目录→正文→净化（会真的联网打书源）
node tools/verify/selfcheck.mjs              # 34 项

# 3) 开源卫生：无个人路径 / 无说谎文档 / 端点不悬空
node tools/verify/opensource-hygiene-check.mjs   # 11 项
```

三个都绿 = 可以发版。

## 3. CI 里跑哪些（`.github/workflows/gates.yml`）

| Job | 触发 | 跑什么 |
|---|---|---|
| `smoke` | push to main / 手动 | 上面三件套 |
| `full` | 手动（`full=true`）/ release | 全部 `*-check.mjs`，串行，跑完汇总 |

**为什么 `selfcheck` 设 `continue-on-error`**：它真的联网打书源站，
CI 出口 IP 常被限流或墙掉。红了不代表产品坏 —— 但**必须看日志**，
因为也可能是产品真坏了。这一条不阻塞合并，但也不该被忽略。

## 4. 本地全量跑

```bash
# 服务必须在跑
for f in tools/verify/*-check.mjs tools/verify/selfcheck.mjs; do
  case "$f" in
    *census*|*snapshot*|*report*) continue ;;
  esac
  echo "──── $f ────"
  node "$f" || echo "FAILED: $f"
done
```

**一律串行**：多个门禁会抢同一个 Chrome profile 与同一个实例的探针数据。

## 5. 环境变量

| 变量 | 用途 |
|---|---|
| `LEGADO_CHROME` | 指定 Chrome 路径（`env.mjs` 会自动探测 Windows/macOS/Linux） |
| `LEGADO_BASE_URL` | 对着隔离实例跑（默认 `http://127.0.0.1:1234`） |
| `LEGADO_VERIFY_OUT` | 截图与产物目录（默认 `tools/verify/out`） |
| `LEGADO_VERIFY_TMP` | 临时目录 |

## 6. 修过的判据 bug

门禁本身也会错。以下是**已修的真误报**。

### 6.1 `selfcheck` 把"没有本地书"判成产品坏了

原判据：`shelf.some(b => b.source_id === 'loc_book')` —— 要求书架上**必须有本地书**。

问题：那取决于用户导没导入过，是**环境状态**不是产品事实。在没有本地书的库上必然红。

改成：只验"自检全程没有增删书架条目"（比较前后条数）。这才是"不碰用户数据"的正确表达。

### 6.2 `opensource-hygiene-check` 看不懂嵌套路由

原逻辑：在 Kotlin 源码里找 `"<路径>"` 字符串字面量。

问题：嵌套路由是**分段**写的 —— `route("agent") { get("/manifest") }`，
源码里根本没有字符串 `"/agent/manifest"`。于是 `/api/agent/manifest` 被误判成"悬空"，
等于**逼着文档不敢写嵌套端点**。

改成：先收集每层 `route(...)` 的段与每条 `get/post/...` 的路径，组合出真实端点再比对。

### 6.3 全量跑一遍才暴露的 12 个红（2026-10-21）

第一次把 47 个门禁在本地串行跑完：**35/47 通过，12 个红**。按性质分四类：

| 类别 | 门禁 | 真相 | 处理 |
|---|---|---|---|
| **前置没做** | `desktop-check`、`package-check` | 产物没构建 | 跑 `package.mjs` / `package-desktop.mjs` 后全过 |
| **过期门禁** | `next-mount-check`、`next-ui-check` | `/next/` 架构已删（404，`.grid-cards`/`.md-list` 等 class 一个都不存在） | 移到 `tools/verify/retired/` |
| **判据写错** | `cache-range-check`、`source-health-check`、`explore-empty-check`、`source-editor-check`、`webview-*-check` | 见下 | 改判据 |
| **外部漂移** | `media-reader-check` | 外部音频站搜不出书 | 改判 NOTE（跳过） |
| **已知未修** | `stalled-client-check` | 24 个停读客户端能让 `/healthz` 卡 15 秒（任务 #36） | 保留红，如实记录 |

### 6.4 五个"判据写错"的具体错法（值得记，都是同类）

**① `cache-range-check`：以为打开抽屉就能看到档位区**

档位网格在目录抽屉的**页脚**里，而页脚默认**折叠**（只露一行「离线缓存 · 这本书」）。
"打开抽屉"不等于"看到档位区"，还得再展开页脚。产品没坏，是判据少了一步。

**② `source-health-check`：把"抓到 running 那一瞬"当成必要条件**

```js
ran.sawRunning && (ran.sawStop || header.includes('本轮检测'))   // 错
```
两条 `.test` 源 0.1 秒就扫完，轮询根本来不及捕捉 `正在并发探测` 那一帧，
于是 `sawRunning=false` ⇒ 必然红。**这与它自己上一行的注释是矛盾的**
（注释写着"轮询必须比它更快，否则会把一个正常的功能判成缺失"）。
改成三者有其一即可：`sawRunning || sawStop || header.includes('本轮检测')`。

**③ `explore-empty-check`：点错了选择器**

发现页有**两个** Select：左边「按分组筛选」、右边「搜索并选择发现页书源」。
判据点 `.explore-source-picker .ui-select-trigger` —— 那是**第一个**命中，分组选择器。
搜索词填进分组框，源选项列表自然为空（实测候选 `[]`）。
改成按 `ariaLabel` / `:not(.explore-group-select)` 精确定位。

**④ `source-editor-check`：用旧 DOM 句柄点按钮**

```js
for (const btn of await p.$$('...')) { if (...) { await btn.click(); break } }   // 错
```
选中行之后 React 会重渲染页头，`p.$$()` 拿到的句柄指向**已被卸载的旧节点**，
`btn.click()` 静默无效（实测：`dialog` 一个都没弹，删除请求根本没发）。
必须在页面里**现查现点**：`page.evaluate(() => { ...querySelector... .click() })`。

**⑤ `webview-*-check`：写死绝对路径**

```js
const require = createRequire('E:/legado/product/web/package.json')   // 错
```
旧目录名 + 某台机器的盘符。换机器 / 改目录名就 `MODULE_NOT_FOUND`，门禁直接崩。
改成从 `import.meta.url` 推仓库根。

### 6.5 一条通用教训

这五个错法有个共同点：**判据在描述"实现细节"，而不是"用户能看到的行为"**。

- 盯 `.cache-range-btn-grid` 在不在 → 应该盯"档位区可见"
- 盯 `sawRunning` 这一帧 → 应该盯"体检真的跑起来了"
- 盯"第几个 `.ui-select-trigger`" → 应该盯"选源控件选得出番茄源"
- 盯 `p.$$` 句柄 → 应该盯"删除按钮点得动"
- 盯某个盘符路径 → 应该盯"仓库里那个文件"

写新门禁时先问：**这条判据在说什么坏了？用户能感觉到吗？** 感觉不到就是在测实现。

### 6.6 环境敏感门禁：该 NOTE 就 NOTE

`media-reader-check` 靠 `https://m.lrts.me/` 能不能搜出书。站点改版 / 反爬 / 下线
都会让它失败 —— 那不是本产品坏了。这种情况**记 NOTE（跳过）而不是 FAIL**，
让"没测到"与"测了但坏了"分开。

真坏了的部分（能搜到书、但界面没渲染成播放器）仍然会红 —— 那才是产品问题。

## 7. 加一个新门禁时

1. 放 `tools/verify/<name>-check.mjs`，命名带 `-check` 后缀才会被 CI 的 full job 收进去；
2. 用 `env.mjs` 的 `ROOT` / `BASE` / `launchOptions()`，**不要硬编码路径或 Chrome 位置**；
3. 输出格式对齐现有的：`PASS/FAIL/NOTE` + 末尾一行汇总 `xxx-check: PASS n / FAIL m`；
4. 退出码：有 FAIL 就 `process.exit(1)`；
5. 需要联网的标 `continue-on-error`，并在注释里写明"红了可能是网络不是产品"；
6. **写完先跑 `node scripts/run-all-gates.mjs --filter=<你的名字>`**，
   再跑一次全量确认没把别人搞红。

### 7.1 三个"别这么写"

| 别写 | 改写成 |
|---|---|
| `p.$$(...)` 拿句柄再 `btn.click()` | `page.evaluate(() => document.querySelector(...).click())`（现查现点，避开 React 重渲染后的失效句柄） |
| 用固定 `sleep(1500)` 等异步结果 | `page.waitForFunction(...)` / `waitForSelector(...)`（等条件，不猜时间） |
| 点"第一个匹配的选择器" | 用 `aria-label` / `:not(...)` 精确定位（页面上常有多个同类控件） |

### 7.2 判据该盯什么

**盯用户能感觉到的行为，不盯实现细节。**

| 盯实现（会误报） | 盯行为（可靠） |
|---|---|
| `.cache-range-btn-grid` 在不在 | 档位区可见、只剩两档 |
| `sawRunning` 这一帧 | 体检真的跑起来了（running / 停止键 / 跑完结论，有其一） |
| "第几个 `.ui-select-trigger`" | 选源控件选得出番茄源 |
| `p.$$` 句柄点得动 | 删除按钮点得动、行真的消失 |
| 某个盘符路径 | 仓库里那个文件 |

写之前先问：**这条判据在说什么坏了？用户能感觉到吗？** 感觉不到就是在测实现。

## 8. 判据的设计原则（从现有脚本读出来的）

- **现量，不打桩**：真开浏览器、真打接口。
- **反向对照**：不只验"对的能过"，还要验"错的会红"（如 `ApiCatalog.test.ts` 里
  "假端点、漏端点、write 说谎都必须被逮住"）。
- **不写死会变的数字**：书源条数、规则条数这类"读库与接口一致"即可，
  写死历史数字等于替用户数据下结论。
- **区分"规则写坏了"与"站点没内容"**：前者报错，后者正常返回空。
- **环境敏感就 NOTE**：外部站点改版不该让 CI 红（见 §6.6）。
- **过期就退役**：被测对象已删除的门禁移到 `tools/verify/retired/`，
  别留在 `*-check.mjs` 里一直红（见 §6.3）。
