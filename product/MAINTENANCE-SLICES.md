# MAINTENANCE-SLICES —— 旧仓维护切片

> **适用范围**：本文档只适用于 `E:\legado` 维护线（0.3.x）。
> **不改变** `E:\legadoQ\docs\DECISIONS.md` 的 D-012：二代重建仍在新仓进行，新功能开发去 `E:\legadoQ`。
> 本仓只做**维护、修缺陷、收口已有机制**，不新增功能面，不恢复 AI，不重排目录树。
>
> 最后更新：2026-11-18

---

## 0. 共同纪律

| 项 | 规则 |
|---|---|
| 范围 | 每个切片只允许动声明过的文件；不顺手改其它模块 |
| 判据 | `./gradlew :app:test` + `npm --prefix product/web test` + `npm --prefix product/web run build`（含 `tsc`）+ 对应 golden |
| 提交 | 一次提交一件事；搬代码与改行为分开 |
| 回退 | 任一判据红，该切片回滚，不进入下一个 |
| 不承诺排期 | 顺序固定为 1 → 2（先 spike）→ 3；不写「1–2 周」这类估算 |

---

## 切片 1 · ReaderConfigRegistry（纯数据注册表）

**状态**：1a 已落地（2026-11-18）；1b 未做。

### 问题（现状取证）

| 事实 | 位置 |
|---|---|
| 阅读设置一个模块同时承担类型、默认值、解析、迁移、上行同步 | `product/web/src/features/reader/settingsPanel/readerSettings.ts`（769 行） |
| 需要跨 origin 赎回的键是手写联合类型，新增一项要改类型 + 默认值 + `pushUiPref` 调用点 | `product/web/src/lib/uiPrefs.ts:19-23` |
| 服务端只存 `key → value`，默认值仍在前端硬编码 | `product/app/src/main/kotlin/io/legado/ops/UiPrefsStore.kt`（198 行） |

结果：加一项配置要动三处，且默认值、迁移逻辑、设置页控件三者没有单一真源。

### 做法

1. 新建 `product/web/src/features/reader/settingsPanel/readerConfigRegistry.ts`：**纯数据，不 import React**。每项声明：

   ```ts
   {
     key: string,              // 与 uiPrefs 的键一致
     type: 'number' | 'boolean' | 'string' | 'enum',
     default: unknown,
     appliesTo: Array<'scroll' | 'paginate' | 'desktop' | 'web'>,
     migrateFrom?: string[],   // 老键名，按顺序尝试
     control?: 'scalar'        // 只有标量控件可自动渲染
   }
   ```

2. **1a（先做）**：registry 只做单一真源——类型、默认值、迁移从它取；设置页 UI 仍手写，不改成自动渲染。
3. **1b（可选）**：只让标量控件（字号、行距、段距、对齐、简繁、翻页动画）由 registry 驱动渲染；皮肤编辑器、背景、点击区、TTS 保持手写。
4. `ui-prefs` 协议不变：仍只存 `key → value`；服务端 `UiPrefsStore` 不改。

### 判据

- 新增一项配置，1a 阶段只需改 registry 一处 + 现有 UI 的绑定一处。
- 老 `localStorage` / `ui-prefs` 数据经 registry 迁移后，值与迁移前逐项相等（新增表驱动用例）。
- 1a 阶段设置页渲染快照不变；1b 只对白名单控件生效。
- 既有 `readerSettings` 相关测试全绿。

### 不做什么

- 不做通用表单引擎；不把 TTS、皮肤、点击区塞进自动渲染。
- 不改服务端接口，不新增 `/api/ui-prefs/*` 端点。

### 风险与回退

1b 若控件抽象失控，停在 1a——registry 作为单一真源本身仍然成立。

### 落地记录（1a，2026-11-18）

| 项 | 结果 |
|---|---|
| 新增 | `product/web/src/features/reader/settingsPanel/readerConfigRegistry.ts`（176 行）：24 个标量项 + 17 个复杂项登记 |
| 改动 | `readerSettings.ts` 769 → 746 行：标量默认值与读回改由 registry 提供；`parse*` 函数保留为对外 API，内部委托给 registry |
| 判据 | `test/ReaderConfigRegistry.test.ts` 8 项：键集合双向一致、默认值同源、数字/布尔/枚举读回、v1 存档回读、v2 优先 |
| 实测 | 前端 `npm test` **1,100 项全绿**（新增 8 项）；`npm run check`（tsc -b）绿 |
| 未完成 | `vite build` 在本机因 esbuild 临时文件删除被拒（EPERM，环境问题，非代码）未跑完；换可删临时文件的终端需补跑一次 |

> 1a 只做「单一真源」，设置页 UI 未改；`appliesTo` 已登记但尚无消费方，1b 才用它决定哪些控件自动渲染。

---

## 切片 2 · 给 RuleProcessor 找真实使用者（或砍掉它）

**状态**：spike 已做（2026-11-18），结论是「没有真实使用者」；删除/降级待单独决策，未在本次执行。

### 问题

`RuleProcessor` 已接入热路径，但产品内零自定义处理器、包外 `import` = 0（审计 `04` C6），只剩两个 demo（`rules/processor/demo/DemoHelloProcessor.kt`、`DemoMarkdownProcessor.kt`）。机制空转。

### 必须先承认的技术事实

`RuleProcessor` 的契约是**一种新的取值方式**，不是内容管线阶段：

- `execute(rule, input, context)` 按**规则串**认领（`rules/RuleProcessor.kt:25-49`）；
- 认领即拥有，不再回退内建（`:118-127` 的 `claim` / `claimNodeRule`）；
- 内建 CSS / XPath / JSONPath / JS 四类行为零改动。

而这三件事都不是「按规则串取值」：

| 想搬的东西 | 实际位置 | 为什么不是取值方式 |
|---|---|---|
| 正文净化 | `content/ContentPipeline.kt`（37 行）、`content/ContentProcessor.kt`（184 行） | 处理的是已取回的正文全文，没有规则串可认领 |
| 繁简转换 | `rules/ScriptConvert.kt`，经 `JsSandbox` 的 `java.t2s/s2t` 调用 | 是 JS 桥能力，不是规则语法 |
| 排版后处理 | 前端 `web/src/features/reader/content/**` | 在渲染层，不在规则求值层 |

**结论**：这不是「接口不够用」，而是**扩展点种类不同**。硬把正文塞进「认领即拥有」的取值扩展点，会让一个处理器吞掉整章正文，风险高于收益。

### 做法（按顺序，任一步不成立就停）

1. **spike（只读 + 小样本）**：从本机 5,600 条书源里找出「解析失败的规则形状」，确认是否存在**真正缺一种取值方式**的场景。产出：形状清单 + 命中源数量 + 失败原因。
2. **有真实使用者**：用那个形状写处理器，注册进 `RuleRunner` 的 `RuleDispatcher`；列表型才声明 `producesNodes = true`。判据：该形状的源从失败变通过，且内建四类零 diff。
3. **没有真实使用者**：不造使用者。按审计 C6 的另一选项处理——删除扩展点（或降级为 `internal` demo），并在 `DECISIONS.md` 留一条记录。**删掉它同样是「证明它不是装饰」**。
4. 正文净化 / 繁简 / 排版若确实要收口，另立切片，落在 `content/` 或前端 `reader/content`，不占用 `RuleProcessor`。

### 判据

- spike 有书面产出（形状、命中数、结论）。
- 若写处理器：该形状的真实样本通过 + `GoldenRuleTest` 零 diff + 后端全量测试零回归。
- 若删除：`RuleProcessor` 从热路径移除，`RuleRunner` 行数下降，全部测试零回归，`DECISIONS.md` 有记录。

### 风险

spike 的结论很可能是「没有真实使用者」。这是可接受结果，不是失败——比继续挂着一个空转扩展点好。

### spike 记录（2026-11-18，只读）

**数据源**：`E:\legadoQ-archive\product\data\legado.sqlite`（5,601 条书源，`sqlite3 -readonly`）。

**方法**：用 `json_tree(payload)` 取出每条源的全部文本值，统计以 `@xxx:` 开头的取值前缀，
按源去重；`@tag.` 方言单独计数。

| 前缀 | 使用源数 | 引擎是否支持 |
|---|---:|---|
| `@js:` | 1,150 | 支持（Rhino 沙箱） |
| `@get:` | 289 | 支持（变量语法） |
| `@put:` | 246 | 支持（变量语法） |
| `@css:` | 144 | 支持 |
| `@json:` | 38 | 支持 |
| `@xpath:` | 5 | 支持 |
| 其它 `@type:` | **0** | — |
| `@tag.`（选择器方言，非前缀） | 1,994 | 支持（`RuleValue` / `RuleNodeSelection`） |

复现命令（只读，不碰归档）：

```bash
sqlite3 -readonly legado.sqlite "
WITH vals AS (SELECT s.id AS id, j.value AS v FROM source s, json_tree(s.payload) j
              WHERE j.type='text' AND length(j.value)>0),
     pref AS (SELECT id, lower(substr(v,1,instr(v,':')-1)) AS p FROM vals
              WHERE substr(v,1,1)='@' AND instr(v,':')>1)
SELECT p, count(DISTINCT id) FROM pref
WHERE p GLOB '@[a-z]*' AND p NOT GLOB '*[^@a-z]*'
GROUP BY p ORDER BY 2 DESC;"
```

**结论**：

1. 5,601 条源里**没有出现内建四类之外的取值前缀**——不存在「缺一种取值方式」的真实使用者。
2. 正文净化 / 繁简 / 排版后处理不是取值方式（见上表），不适合塞进 `RuleProcessor`。
3. 因此「搬三个处理器」不成立。按本切片第 3 步，应删除扩展点或降级为 `internal` demo。
4. 删除会动规则求值热路径与后端 993 项测试，**本次未执行**；需单独立切片、跑全量后端测试、
   并在 `DECISIONS.md` 留一条记录。spike 只负责给出「没有真实使用者」这个前提。

---

## 切片 3 · Command Bridge 安全边界（先闸后功能）

**状态**：最低优先级。切片 1 落地、切片 2 有结论后再启动；**先写边界文档，再决定是否实现**。

### 问题

桌面端已有托盘、日志、数据目录等系统能力，但没有受控的外部命令钩子。若直接加「配置文件里写命令」，等于给本机开一个任意执行入口。

### 做法（顺序不可颠倒）

1. **白名单**：只允许登记过的可执行文件 + 参数模板；不接受任意 shell 字符串，不做 `sh -c` / `cmd /c`。
2. **确认闸**：每次执行弹确认，展示完整命令行与工作目录；默认关闭，首次启用需二次确认。
3. **路径校验**：工作目录与所有路径参数解析后必须落在数据目录内；拒绝 `..`、符号链接逃逸、盘符切换。
4. **资源上限**：超时、输出字节上限、并发 1；超限终止并记录。
5. **日志**：记录命令、退出码、耗时；不记录环境变量与凭据。
6. **不做**：网络下载后执行、任意解释器、开机自启、静默执行。

### 判据

- 安全用例全绿：路径逃逸、参数注入、超时、超长输出、非白名单命令。
- 默认配置下**没有任何执行面**（未开启时不存在可触发的入口）。
- 执行日志不含凭据。

### 风险

这是新增执行面，做错的代价是本地后门。**若没有明确用户场景，只保留本文档的边界定义，不写实现。**

---

## 与其它文档的关系

- 重建期审计已清理（内容保留在 git 历史中），其中的「外科式重建」方案未被采纳，本文档不依赖它。
- 新仓 `E:\legadoQ` 的方向由 D-012 决定，本文档不构成替代，也不改变其复核条件。
- 本文档不进入 `docs/` 索引；若后续要长期保留，再迁到 `docs/` 并在 `docs/README.md` 加一行。
