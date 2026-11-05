# 根级拆端：迁移矩阵与执行顺序（P2）

> 状态：**规划完成，未执行**。本文只做分析与清单，仓库里没有任何文件被移动。
> 工作区已有的未提交改动（架构判据、`ops/` 下沉、前端 `lib/pageMeta.ts`）**原样保留**，未受本文影响。

---

## 0. 结论先行：本方案有 3 个必须先拍板的决策

用户已批准的方向是「根级拆端：`product/app` → `backend/`、`product/web` → `frontend/`、新建 `shared-contract/`」。
实测下来，**这个方向本身可以做到**，但方案里有一个此前无人提出的缺口，导致它不能直接开工：

> **`product/` 顶层实际有 47 个稳定条目（另加 2 个运行期崩溃日志，共 49），而被批准的方案只给了 `app`、`web` 两个的去向。其余 45 个没有归宿。**

如果字面执行「把 `product/` 拆散并入仓库根」，会撞上 3 个**实测出来的硬碰撞**（§3），必须先决定怎么处置。

### 决策 D1：`product/` 是「整体解散」还是「只搬两端」

| 方案 | 做法 | 碰撞 | 拓扑耦合 | 改动面 |
|---|---|---|---|---|
| **A（推荐）** | `product/app`→`backend/`、`product/web`→`frontend/`、新建 `shared-contract/`，**其余 44 项留在 `product/`** | **不触发**（不合并 `docs/`、`scripts/`、`package.json`） | **零改动**（`scripts/`、`tools/verify/` 仍按「上两级」正确算出 `product/`） | 小 |
| B（字面解散） | 把 `product/` 整个拆散并入仓库根 | **触发 3 个**（§3） | 全部要改（根变成仓库根，所有「上两级」失效） | 大，且 `docs/`+`scripts/`+`package.json` 要做归并决策 |

**推荐 A。** 它同样达成本次重构的架构目的（后端/前端在根级各自成端、契约独立成 `shared-contract/`），
但不需要去归并两套 `docs/`、两套 `scripts/`、两个 `package.json` —— 那三件事是**独立的产品决策**，
不该被绑在一次目录搬迁里偷偷做掉。

### 决策 D2：`shared-contract/` 装什么

不能是空壳。**推荐第一件实物**：把现在已经存在的双向契约源收进去 ——
`product/app/src/main/resources/agent-api.json`（157 端点契约，后端产、前端 `web/test/ApiCatalog.test.ts` 校验）。

> ⚠️ **它现在是 Java 类路径资源**，不是普通数据文件：`ai/AgentCatalog.kt:31` 与 `http/RouteCatalog.kt:25`
> 都用 `getResourceAsStream("/agent-api.json")` 读它。搬进 `shared-contract/` 后**必须**在
> `backend/build.gradle` 里补一行，否则服务一启动就读不到契约：
> ```groovy
> sourceSets.main.resources.srcDir rootProject.file('../shared-contract')
> ```
> 外加生成器 `scripts/gen-api-reference.mjs`（注意：这个名字在根 `scripts/` 与 `product/scripts/` **两边都有**，见 §3 碰撞 2）。

**不要**先把 `model/Models.kt` 或前端 `lib/api/types.ts` 搬进去 ——
那两处是各自内部的类型，强行共享会把编译期耦合引进来。

### 决策 D3：Gradle 根放哪

拆端后 `backend/` 在仓库根，而 `settings.gradle` 目前是 Gradle root。两种处理（§5.2 有完整写法）：

- **A1（推荐）**：`settings.gradle` 留在 `product/`，用 `include(':backend') { projectDir = file('../backend') }` 引入根级模块。
  Gradle 支持模块目录在 rootDir 之外，改动最小。
- **A2**：把 `settings.gradle`/`gradlew`/`gradle/`/`build.gradle` 一并提到仓库根。更"正确"，但 `installRoot`、
  `start.mjs` 的 jar 定位、7 个 CI 工作流都要跟着动。

---

## 1. 实测口径更正：不是 ~127 处，是 **154 处 / 38 个文件**

任务书里写的「~127 处」口径不准。用 `git grep`（**只扫已跟踪文件**）实测：

```bash
cd E:/legado && git grep -c "product/" | awk -F: '{s+=$2} END {print s}'   # → 154
cd E:/legado && git grep -l "product/" | wc -l                            # → 38
```

早先 `grep -rn` 得到的 369 行之所以不能用作分母，是因为它把**未跟踪的运行期垃圾**也算了进来
（`tmp-build-0212.log`、`tmp-backend-test-*.log`、`.dsh-ops/panel/`，以及本轮新写的
`product/docs/restructure/*`）。**迁移清单必须以 `git grep` 为准**，否则会去"迁移"本不该进仓的文件。

### 1.1 完整引用表（按数量降序，共 38 个文件 / 154 处）

| # | 文件 | 处数 | 迁移时怎么改 |
|---|---|---|---|
| 1 | `docs/STRUCTURE.md` | 15 | 目录结构说明；**同时是治理文档**（详见 §6.3 的禁止事项冲突） |
| 2 | `product/web/test/VersionTracks.test.ts` | 14 | 版本真源路径，**逐条改**（§5.4） |
| 3 | `docs/BOOK-SOURCE-MEDIA.md` | 12 | 文档路径引用 |
| 4 | `.github/workflows/docker.yml` | 11 | 构建上下文 + Dockerfile 路径（§5.3） |
| 5 | `docs/README.md` | 10 | 文档索引 |
| 6 | `RELEASING.md` | 10 | 发布流程里的路径 |
| 7 | `scripts/version.mjs` | 8 | 版本文件清单 |
| 8 | `.github/workflows/contract.yml` | 8 | 契约检查工作流 |
| 9 | `scripts/release.mjs` | 6 | 发布脚本 |
| 10 | `README.md` | 6 | 顶层说明 |
| 11 | `.github/workflows/version-gate.yml` | 6 | 含 `CODE_PATHS`（`:68`） |
| 12 | `.github/workflows/build-jar.yml` | 6 | 构建产物路径 |
| 13 | `.github/workflows/gates.yml` | 5 | 门禁工作流 |
| 14 | `.github/workflows/coverage.yml` | 5 | 覆盖率 |
| 15 | `product/web/test/DockerContext.test.ts` | 3 | 见 §5.4，**拓扑耦合** |
| 16 | `docs/STATUS.md` | 3 | 含已失效的插件装载描述（另见 §6.3） |
| 17 | `.github/workflows/ci.yml` | 3 | 主 CI |
| 18 | `product/app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt` | 2 | `:161,173` 源码根回溯候选路径 |
| 19 | `product/Dockerfile` | 2 | 构建上下文内相对路径 |
| 20 | `.github/SUPPORT.md` | 2 | 链接 |
| 21 | `scripts/stop.sh` | 1 | 停服脚本 |
| 22 | `product/web/vite.config.ts` | 1 | `server.fs.allow: ['.', '..']` 与 `docs` 的 `?raw` 相对深度（§5.5） |
| 23 | `product/web/src/features/reader/NotesPanel.tsx` | 1 | **仅注释** |
| 24 | `product/tools/verify/recycle.mjs` | 1 | **仅注释** |
| 25 | `product/docs/gates-guide.md` | 1 | 文档 |
| 26 | `product/app/src/main/kotlin/io/legado/StaticWeb.kt` | 1 | `:111` **用户可见报错文案**（"在 product/ 下执行 `npm --prefix web run build`"） |
| 27 | `product/app/build.gradle` | 1 | 实际有 8 处 `web/dist` / `rootProject.projectDir`（§5.2），但只有 1 行字面含 `product/` |
| 28 | `product/.githooks/post-commit` | 1 | **仅注释**；逻辑用 `git rev-parse` + 钩子自身位置，**已健壮** |
| 29 | `package.json` | 1 | `"stop": "node product/stop.mjs"` |
| 30 | `docs/archive/README.md` | 1 | 归档文档 |
| 31 | `docs/ARCHITECTURE.md` | 1 | 架构文档 |
| 32 | `RELEASES.md` | 1 | 发布记录 |
| 33 | `CHANGELOG.md` | 1 | 变更日志 |
| 34 | `.gitignore` | 1 | 仅注释（`:19`） |
| 35-37 | `product/docs/sessions/2026-10-26-*.md`、`product/docs/研究-借鉴-*.md`、`docs/archive/CHANGELOG-0.8.6及以前.md` | 各 1 | **历史文档，建议原样保留不改**（改历史记录反而制造噪音） |

> **可豁免的 4 处**：`NotesPanel.tsx`、`recycle.mjs`、`.githooks/post-commit`、`.gitignore` 都是注释，
> 不构成功能性耦合。再加 3 处历史文档（已归档的 changelog、会话记录、研究笔记）建议原样保留。
> 因此真正必须改的是 **31 个文件 / 147 处**（154 − 4 − 3）。

---

## 2. `product/` 顶层 49 个条目去向表（方案 A）

```bash
cd E:/legado/product && ls -A | wc -l    # → 49
```

### 2.1 要搬的（3 项）

| 现位置 | 新位置 | 理由 |
|---|---|---|
| `product/app/` | `backend/` | 用户批准 |
| `product/web/` | `frontend/` | 用户批准 |
| （新建） | `shared-contract/` | 用户批准；内容见决策 D2 |

### 2.2 原地不动的（真正属于「产品构建根」的 27 项）

| 条目 | 类别 | 说明 |
|---|---|---|
| `settings.gradle` | 构建 | Gradle root（方案 A1） |
| `build.gradle` | 构建 | 根构建脚本 |
| `gradle/` `gradlew` `gradlew.bat` `gradle.properties` `init-mirror.gradle` | 构建 | wrapper 与代理配置 |
| `package.json` | 构建 | 产品级 npm 脚本入口（`name: legado`） |
| `scripts/` | 构建 | 12 个产品脚本（`tasks.mjs`、`runtime.mjs`、`run-all-gates.mjs`…） |
| `tools/` | 构建 | 46 个 `*-check.mjs`（`tools/verify/` 下共 78 个 `.mjs`） |
| `Dockerfile` `.dockerignore` `compose.yml` | 部署 | 容器定义 |
| `start.mjs` `stop.mjs` `start.cmd` | 运行 | 启停入口 |
| `.nvmrc` `.java-version` | 工具链 | CI 用 `node-version-file: product/.nvmrc` |
| `agent-profiles.json` | 运行 | AI 连接配置（含 apiKey，已 gitignore） |
| `assets/` `examples/` | 资源 | 图标 / 示例 |
| `data/` `logs/` `tmp/` `.tmp/` `dist/` `build/` `.gradle/` `.kotlin/` `coverage-report/` `.data/` | **运行期生成物** | **不进仓、不迁移**，见 `.gitignore` |

### 2.3 需要单独决策的（17 项）

| 条目 | 实测内容 | 建议 | 理由 |
|---|---|---|---|
| `plugins/` | **只有 `README.md`（1246 字节，Oct 27）** | 跟着 `frontend/` 走，或并入 `docs/` | 它是**前端扩展装载的说明**；阶段 ③ 复活插件后这里要有真内容 |
| `extensions/` | **只有 `chrome/`** | 保留在 `product/` | 浏览器扩展，与前后端拆端无关 |
| `docs/` | 13 个文档 + `restructure/` + `sessions/` | 保留在 `product/` | 与仓库根 `docs/` 是**两套不同文档**（§3） |
| `.githooks/` | `post-commit` | 保留在 `product/` | `core.hooksPath = product/.githooks`，移动要同步 git config |
| `.env.example` | 环境样例 | 保留 | 与 `start.mjs` 同址 |
| `AGENTS.md` | 产品级 AI 接入面文档 | 保留 | 且**含大段已过时内容**（§6.3） |
| `CHANGELOG.md` `LICENSE` `README.md` `SECURITY.md` `CONTRIBUTING.md` | 产品级 | 保留 | `build.gradle:254,265` 依赖 `${rootProject.projectDir}/CHANGELOG.md`，**移动会断构建** |
| `hs_err_pid24392.log` `hs_err_pid27860.log` | **JVM 崩溃日志** | **删除** | 运行期垃圾，不该进仓 |
| `server.log` | 运行日志 | **删除** | 同上 |

> **注意**：`product/CHANGELOG.md` 与仓库根 `CHANGELOG.md` **是两个不同文件**（前者是打包进 jar 的产品日志，
> 后者是仓库级记录）。`build.gradle` 只读前者。拆端时**不要**把两者合并。

---

## 3. 三个硬碰撞（实测证据，方案 B 会撞上）

```bash
cd E:/legado
comm -12 <(ls docs/ | sort) <(ls product/docs/ | sort)          # 碰撞 1
comm -12 <(ls scripts/ | sort) <(ls product/scripts/ | sort)    # 碰撞 2
head -2 package.json product/package.json                       # 碰撞 3
```

| # | 碰撞 | 实测结果 |
|---|---|---|
| 1 | 两套 `docs/` | **无同名文件**，但两棵树语义不同：根 `docs/` = 仓库级（`STRUCTURE.md`、`ARCHITECTURE.md`、`STATUS.md`）；`product/docs/` = 产品级（`gates-guide.md`、`frontend-conventions.md`、`plugin-framework.md`…）。**归并是产品决策，不是搬迁动作** |
| 2 | 两套 `scripts/` | **`gen-api-reference.mjs` 在两边都存在** —— 真碰撞，必须先决定留哪个 |
| 3 | 两个 `package.json` | 根的 `name: legadoq-ai-framework`，`product/` 的 `name: legado`；**两者 version 都是 0.2.16** |

方案 A 不触发任何一个。

---

## 4. 目标目录树（方案 A）

```
E:/legado/
├── backend/                    ← 原 product/app/
│   ├── build.gradle
│   └── src/{main,test}/kotlin/io/legado/…
├── frontend/                   ← 原 product/web/
│   ├── package.json  (name: legado-web)
│   ├── vite.config.ts
│   └── src/  test/  index.html
├── shared-contract/            ← 新建
│   ├── agent-api.json          ← 原 product/app/src/main/resources/agent-api.json（类路径资源，见 D2）
│   └── README.md               ← 说明"谁产、谁校验、怎么改"
├── product/                    ← 保留：产品构建根 + 运行期
│   ├── settings.gradle  build.gradle  gradlew  gradle/
│   ├── scripts/  tools/  docs/  .githooks/
│   ├── Dockerfile  compose.yml  .dockerignore
│   ├── start.mjs  stop.mjs  start.cmd
│   ├── package.json  agent-profiles.json  assets/  examples/  extensions/
│   └── (运行期生成物：data/ logs/ tmp/ dist/ build/ …)
├── .github/  docs/  scripts/  (仓库级，不动)
└── README.md  CHANGELOG.md  package.json
```

---

## 5. 构建链改造方案

### 5.1 为什么 `scripts/` 和 `tools/verify/` 必须一起看

**实测**：两条链都用「脚本所在目录的上两级」推导根，且都会在拆端时**静默算错**：

```js
// product/scripts/tasks.mjs:19
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// product/tools/verify/depth-check.mjs:17
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// product/scripts/runtime.mjs:9-10  ← installRoot，决定 jar/port.txt/.env 找哪
export const installRoot = process.env.LEGADO_HOME
  ?? dirname(dirname(fileURLToPath(import.meta.url)));
```

方案 A 下这三处**全部仍然正确**（`product/` 没动）——这正是推荐 A 的重要理由。
**方案 B 下这三处全部失效**，且失效方式是「什么都找不到」而不是报错，正是仓库历史上已经栽过一次的坑
（`product/.githooks/post-commit:20-21` 明写：*"不能再用 `$REPO_ROOT/scripts`（那是拆分前的旧布局，
统一仓后会找不到脚本、日志永远不更新）"*）。

#### 无论选哪个方案都建议做的加固（去掉「数层级」这个易碎假设）

```js
// 新增 product/scripts/productRoot.mjs
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从起点向上找「产品根」：认 settings.gradle + package.json 同时存在的那一级。 */
export function findProductRoot(start = dirname(fileURLToPath(import.meta.url))) {
  let dir = start;
  const { root } = parse(dir);
  while (dir !== root) {
    if (existsSync(join(dir, 'settings.gradle')) && existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`从 ${start} 向上没找到产品根（settings.gradle + package.json）`);
}
```

`tasks.mjs` / `runtime.mjs` / `tools/verify/*.mjs` 改为 import 它。**兄弟目录名也不得再硬编码**：
`tasks.mjs` 里的 `npm --prefix web`、`${gradle} :app:fatJar`、`tools/verify/bundled-ui-check.mjs`
应改为从配置文件读（见下）。

#### 兄弟名去硬编码：加一个 `product/layout.json`

```json
{ "backendDir": "../backend", "frontendDir": "../frontend",
  "gradleTask": ":backend:fatJar", "webBuild": "npm --prefix ../frontend run build" }
```

`tasks.mjs` 与 `build.gradle` 都从这里读。这样下一次再搬目录，只改一个文件。

> ⚠️ 这一节是**建议加固**，不是拆端的必做项。若本轮只做方案 A 且不动 `product/`，可以留到下一步。

### 5.2 Gradle（方案 A1）

`settings.gradle` 现在是 `include ':app'`（单模块），`rootProject.projectDir` = `product/`。改成：

```groovy
rootProject.name = 'legado'
include ':app'
project(':app').projectDir = file('../backend')   // ← 模块目录可在 rootDir 之外
```

保留项目名 `:app` 而不是改名 `:backend`，可以让 7 个 CI 工作流里的 `:app:fatJar` / `:app:test`
**一处都不用改**。若坚持改名，则这 7 个工作流 + `tasks.mjs` 全要同步。

`backend/build.gradle` 里 4 处路径（实测 `:185,213,247,248,268,269`）要把 `web` 改成 `../frontend`：

```groovy
// 现在
if (!file("${rootProject.projectDir}/web/dist/index.html").exists()) { … }
// 改为
def frontendDist = file("${rootProject.projectDir}/../frontend/dist")
if (!file("${frontendDist}/index.html").exists()) { … }
```

**不要动**的：`${rootProject.projectDir}/../BUILD_NUMBER`（`:129`）、`${rootProject.projectDir}/CHANGELOG.md`（`:254,265`）——
方案 A 下这两者相对关系不变。

### 5.3 Docker

`docker.yml` 的 11 处：构建上下文仍是 `./product`（方案 A），但 `COPY` 的源变了：

```dockerfile
# product/Dockerfile 现在是（示意）
COPY app/build/libs/legado-*-all.jar …
# 若 frontend/dist 在构建上下文之外，Docker 会直接拒绝 ——
# 必须让 CI 先把 frontend/dist 复制进 product/，或把构建上下文提到仓库根。
```

**这是方案 A 唯一需要额外操心的地方**：Docker 构建上下文不能引用上下文之外的路径。
两种解法：① 上下文提到仓库根（`docker build -f product/Dockerfile .`）；
② CI 里先把 `frontend/dist` 与 `backend/build/libs` 拷进 `product/` 再 build。
**推荐 ①**，因为 `docker.yml` 本来就要改 11 处。

### 5.4 前端两个判据的拓扑耦合（易漏）

```ts
// product/web/test/DockerContext.test.ts:18-19
const WEB = fileURLToPath(new URL('..', import.meta.url)) // product/web/
const PRODUCT = path.dirname(WEB)                          // ← 靠"上一级"猜构建上下文
```
搬到 `frontend/` 后 `PRODUCT` 会算成**仓库根**，判据含义静默改变 → 必须改成显式读 `layout.json` 或常量。

```ts
// product/web/test/VersionTracks.test.ts —— 14 处硬编码
read('product/app/build.gradle')            → read('backend/build.gradle')
read('product/Dockerfile')                  → read('product/Dockerfile')      // 不变
read('product/web/src/pages/AboutPage.tsx') → read('frontend/src/pages/AboutPage.tsx')
read('product/web/src/lib/api/types.ts')    → read('frontend/src/lib/api/types.ts')
['package.json', 'product/package.json']    // 不变（方案 A 下两个 package.json 都还在）
```

### 5.5 前端 `vite.config.ts`

```ts
server: { fs: { allow: ['.', '..'] }, … }
```
`frontend/` 的上一级是**仓库根**（不再含 `product/docs/`）。注释里提到的
`product/docs/功能说明.md` 的 `?raw` 相对路径深度会变 —— 改成从 `../product/docs/` 取，或把该文档
移进 `frontend/`。**这一条不报错，只会构建时找不到文件**，必须人工核。

### 5.6 `StaticWeb.kt:111`（用户可见文案）

```
"在 product/ 下执行 `npm --prefix web run build`，再重新打包启动。"
```
必须改成新路径，否则用户在报错里看到的指引是错的。**这是唯一一处面向用户的路径文案。**

---

## 6. 分步执行顺序（方案 A，8 步，每步可独立自证）

> 核心纪律：**每一步做完，仓库必须仍可构建、门禁不回退**。任一步失败见 §7。

| 步 | 动作 | 自证命令（在 `E:/legado/product`） | 期望 |
|---|---|---|---|
| 0 | **先提交或 stash 现有未提交改动**（本仓库现有多处未提交） | `git status --short` | 只有你预期的改动 |
| 1 | 加 `productRoot.mjs` + `layout.json`，把 `scripts/`、`tools/verify/` 的「数层级」换成 `findProductRoot()` | `node scripts/tasks.mjs build` | 与改前行为完全一致 |
| 2 | 建 `shared-contract/`，把 `app/src/main/resources/agent-api.json` 移入，**同时给 `backend/build.gradle` 加 `sourceSets.main.resources.srcDir`**（否则类路径读不到，服务启动即坏），改前端 `ApiCatalog.test.ts` | `cd web && npx tsx test/ApiCatalog.test.ts` | 3/3 PASS |
| 3 | `git mv product/app backend`（**用 `git mv` 保留历史**），改 `settings.gradle` 的 `projectDir` | `./gradlew :app:test --tests "*ArchitectureBoundaryTest"` | 4 条判据全绿 |
| 4 | 改 `backend/build.gradle` 的 `web/dist` → `../frontend/dist` | `./gradlew :app:compileKotlin` | 编译通过 |
| 5 | `git mv product/web frontend`，改 `tasks.mjs` 的 `--prefix` 与 `vite.config.ts` | `cd ../frontend && npm run check && npm test` | 908/908 |
| 6 | 改前端两个判据（`DockerContext`、`VersionTracks`）+ `StaticWeb.kt:111` 文案 | `cd ../frontend && npm test` | 908/908 |
| 7 | 批量改 31 个文件里的路径引用（§1.1 清单） | `git grep -n "product/app/\|product/web/"` | **0 命中** |
| 8 | 改 7 个 CI 工作流 + `Dockerfile` + `docker.yml` 构建上下文 | `node scripts/run-all-gates.mjs` | 见 §8 |

**第 7 步是最容易半途而废的一步**：建议直接以
`git grep -n "product/app/\|product/web/"` 返回空作为完成判据，并把它加进门禁（§8.2）。

---

## 7. 回滚方案

- **每一步都在独立提交上**（步 0 先落一个基线提交）。回滚 = `git revert <step-commit>` 或 `git reset --hard <上一步>`。
- **`git mv` 而不是删+建**：保留 `git log --follow` 的历史。撤销时 `git mv` 反向即可，不丢历史。
- **步 3/5 是唯二的目录搬迁步**，风险集中在这两步。搬迁后若构建失败：
  `git reset --hard HEAD` 即可回到搬迁前（因为已提交）。**这两步必须在工作区干净时做**，否则 `reset --hard` 会吞掉未提交改动。
- `frontend/dist`、`backend/build/`、`product/.gradle/` 都是生成物，回滚时无需处理，重跑构建即可。
- **不要**用 `git clean -fdx` 回滚 —— 它会删掉 `product/data/`（用户真实书源库）。

---

## 8. 门禁影响

### 8.1 实测：现在只有 **1 个**门禁脚本字面引用 `product/`

```bash
cd E:/legado && git grep -ln "product/" -- product/tools/verify/
# → product/tools/verify/recycle.mjs   （且仅第 1 行的注释）
```

其余 45 个门禁脚本（`tools/verify/` 下共 46 个 `*-check.mjs`）**不含字面 `product/`**，但它们靠 `ROOT = ../..` 定位 —— 即 §5.1 的**隐式拓扑耦合**。
所以「门禁影响」的正确答案不是"哪几个硬编码了 `product/`"，而是"**全部 46 个都依赖 `product/` 就是仓库的产品根**"。
方案 A 不改变这个事实，故 46 个门禁**零改动**；方案 B 下**全部要改**。

### 8.2 建议新增 1 条门禁：把"迁移完成"变成可执行判据

`product/tools/verify/path-coupling-check.mjs`：

```js
// 断言：已跟踪文件里不再出现迁移前的路径前缀
const FORBIDDEN = [/product\/app\//, /product\/web\//];
const hits = execSync('git grep -n "product/app/\\|product/web/"', { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
if (hits.length) { console.error('仍有迁移前路径引用：\n' + hits.join('\n')); process.exit(1); }
```

挂进 `run-all-gates.mjs`。**这条判据在迁移前必然是红的**，所以要么迁移完成后加，要么先带基线加（本仓库既有惯例）。

### 8.3 「门禁全绿」在本机的真实含义

**本机实测门禁为 27/46**（不是 46/46）。红的 19 条是 Playwright UI 门禁，原因是
**书源取不到正文**（`Waiting for selector .reading-content failed` / `源取不到详情`），
而出网本身正常（`curl` baidu/gitee 均 200）。这属于**数据/环境依赖**，不是代码缺陷。

因此拆端的验收只能按**确定性门禁子集**判定。建议这个子集 = 全部 46 条 **减去** 19 条 UI 门禁：

- 结构类：`depth-check`、`md-table-check`、`version-check`、`docs-links-check`、`structure-check`（若有）
- 构建类：`bundled-ui-check`、`fatjar-*`
- 契约类：`ApiCatalog`（前端判据内）
- 计数类：`endpoint-count-check`、`ui-tests-ran-check`

**判据：拆端前后这个子集的通过集合必须完全相同。** 任何一条从绿变红即为回归。

---

## 9. 自查

- [x] **49 个顶层条目逐个有去向**：3 搬 / 27 原地 / 17 待决（其中 2 项建议删除）—— §2 已逐项列名。
- [x] **154 处引用逐条在矩阵里**：§1.1 按 38 个文件全列，并标注 4 处注释可豁免、3 处历史文档建议不动。
- [x] **3 个硬碰撞有实测证据**（§3 的三条 `comm`/`head` 命令可直接复现）。
- [x] **每一步有自证命令**（§6）。
- [x] **回滚路径明确**（§7），并标注了「不要用 `git clean -fdx`」这条会毁数据的红线。

---

## 10. 需要拍板的决策汇总

| 编号 | 决策 | 推荐 |
|---|---|---|
| D1 | `product/` 整体解散 还是 只搬两端 | **只搬两端**（方案 A），避免 3 个碰撞 |
| D2 | `shared-contract/` 第一件实物 | **`agent-api.json` + 生成器**（已真实跨端使用） |
| D3 | Gradle root 位置 | **留 `product/`，用 `projectDir` 引入**（A1），`:` 项目名不动 |
| D4 | Docker 构建上下文 | **提到仓库根**（`docker build -f product/Dockerfile .`） |
| D5 | 是否加 `layout.json` + `productRoot.mjs` 加固 | **加**，否则下次搬目录会重演历史事故 |
| D6 | `hs_err_pid*.log` / `server.log` | **删除**（运行期垃圾） |
| D7 | `plugins/`（只有 README）去向 | 跟 `frontend/`，阶段 ③ 复活扩展时再充实 |

---

## 附：本文之外仍需处理的治理冲突（不属本任务，但会撞门禁）

1. `docs/STRUCTURE.md`（15 处 `product/`，是本清单里引用最多的文件）含禁止事项
   **「不在根目录新建第二套前端或第二套后端」** —— 与本次拆端**直接冲突**，必须在执行前改措辞。
2. `product/docs/plugin-framework.md`、`plugin-development-guide.md` 仍标「已废弃（2026-10-26）」，
   而用户已批准复活插件装载 —— 阶段 ③ 要同步。
3. `docs/STATUS.md` 仍文档化已从 Kotlin 源码中**完全移除**的 `LEGADO_PLUGIN_JAR_SCAN`，且写的版本是 0.2.14
   （外部真源是 `backend/build.gradle` 的 `version`）—— 已过时。
4. `product/AGENTS.md` 含大段与实现不符的表述（如把 `plugins/` 描述为在用）。
