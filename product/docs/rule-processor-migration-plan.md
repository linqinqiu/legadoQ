# RuleProcessor 接入 RuleRunner：分阶段方案

> 状态：**扩展点已接入（0.2.34）；把内建实现搬进处理器的迁移仍未做（可选）**。
>
> 0.2.15 只交付了契约（`RuleProcessor` / `RuleContext` / `RuleResult` / `RuleDispatcher`）与四个
> 「尚未实现」的占位类，`RuleRunner` 收了个 `ruleDispatcher` 参数却从不读 —— 于是新写一种解析方式
> 能编译、能单测，**求值时永远走不到它**。
>
> 0.2.34 换了个更小的做法把扩展点接上（见 §0）：**先问处理器、没人认领再走内联**。
> 内建四种类型（CSS / XPath / JSONPath / JS）一个字节都没动，等价性因此不需要"重写再对齐"来证明。
> 本文 §3 的 P4–P7（把内联实现搬进处理器）仍是可选项，动机从"让扩展点生效"变成"把 2405 行拆薄"。

## 0. 0.2.34 已落地：扩展点先接上

| 位置 | 改动 |
|---|---|
| `NodeValue.value(rule)` | 求值前先 `dispatcher.claim(rule)`；认领了就由处理器给值，**认领即拥有**（不落回内联） |
| `RuleRunner.nodes(body, rule)` | 列表规则先问 `claimNodeRule`（只问声明了 `producesNodes` 的处理器） |
| `RuleRunner.dispatcher` | 公开可注册；`RuleRuntime`（调度器 + 日志出口）随每个节点往下传，不依赖线程变量 |
| `RuleInput.evaluateBuiltin` | 处理器可以"先按老规则取个值再加工"，走内联、不经过扩展点（不会自递归） |
| `@css:` | 值侧早就有，列表侧补上（此前 `@css:.list li` 被整串喂给选择器方言，整源 0 条） |
| `processor/` 包 | 删掉四个「尚未实现」的占位类；`demo/` 两个示例改成新契约并**真的能跑** |

判据：`app/src/test/kotlin/io/legado/RuleProcessorTest.kt`（7 项）—— 值级生效、列表级生效、
值型处理器不接管列表、认领即拥有、处理器抛异常不拖垮整源、`@css:` 两侧一致、注册/覆盖/摘除。

**为什么不让内建类型也走处理器**：那需要把 Jsoup / Rhino / JSONPath 的解释逻辑整体搬进处理器，
再由处理器调回同一批底层件 —— 搬错一处的症状是"某个源少一条结果"，而这类退化只有金标准语料看得见。
扩展点的价值是"能加新类型"，不是"必须把老类型重写一遍"。想拆薄 `RuleRunner` 时按 §3 走。

## 1. 现状与为什么不能一次替换

| 事实 | 数字/位置 | 后果 |
|---|---|---|
| `RuleRunner.kt` 体量 | **2405 行**，单一类 | 任何"顺手重构"都会跨越搜索/详情/目录/正文/登录/JS 六条链路 |
| 规则求值入口 | `searchWithReason`(135) `bookItems`(201) `explore`(271) `details`(494) `chapters`(648) `parseTocPage`(710) `content`(845) `contentPage`(968) | 每个入口自己解析规则字符串、自己决定 CSS / JSONPath / JS |
| 具体解析器耦合点 | Jsoup / Rhino / `Context.enter` 直接出现在 **15 处** | 处理器接口要收口它们，先得把"取节点"与"解释规则"拆开 |
| 变量与跨页状态 | `@put/@get`、`vars`、`rememberRuleData` | `RuleContext` 的 `getVariable/putVariable` 必须承载同一语义，否则跨页规则静默失效 |

**结论**：一次性把入口改成 `dispatcher.dispatch(type)` 不可行——没有等价性判据时，
"搜索少一条结果""目录少一章"这类退化在现有测试里看不见（后端 927 项里没有金标准书源回归集）。

## 2. 接入前置条件（先做这三件，缺一不可）

### 2.1 金标准书源回归集（最重要）

固定 5～8 个**离线快照**书源：把真实站点的 HTML/JSON 响应存成 fixture，用现有 `RuleRunner` 跑一遍，
把结果（搜索结果条数/书名/章数/正文前 200 字哈希）存成 `expected.json`。

- 位置建议：`app/src/test/resources/rule-golden/<source>/<case>.html` + `expected.json`
- 判据：`GoldenRuleTest` —— 对每个 case 断言 `searchWithReason` / `chapters` / `content` 的输出与 expected 逐项一致
- **这条判据必须在改造前先绿**（它锁的是"改造前的行为"）

### 2.2 规则形态盘点

把书源里实际出现的规则形态归类（同一份 fixture 语料即可统计）：

| 形态 | 例子 | 归属处理器 |
|---|---|---|
| CSS 选择器 + `@text`/`@href` 后缀 | `div.book-list@class` | 内联（`valuePlain` / `selectLegadoSegments`） |
| XPath | `//div[@id='list']/a` | 内联（`xpathTexts` / `xpathNodes`） |
| JSONPath | `$.data.list[*].name` | 内联（`valueJson` / JsonPath） |
| JS 片段 `<js>...</js>` / `@js:` | `<js>result.replace(...)</js>` | 内联（`JsSandbox`） |
| `\|\|` 备选、`,` 合并、`##` 排除 | `rule1\|\|rule2` | 交给上层组合（不是处理器） |

盘点结果决定 `canHandle()` 的判定顺序 —— 现在占位实现里的 `canHandle` 是猜的，必须以语料为准。

### 2.3 把"取节点"与"解释规则"分开

`RuleContext` 目前只有 `fetch/getVariable/putVariable/log`。要承接现有逻辑还缺两件事：

- `fun parseHtml(input: String): Any` —— 宿主提供 Jsoup Document（处理器不 import Jsoup）
- `fun evalJs(script: String, bindings: Map<String, Any?>): String?` —— 宿主提供 Rhino 沙箱

> 现有 `RuleContext` 若直接暴露 Jsoup 类型，就等于把"可复用"的卖点丢了；
> 但完全抽象又会让 `JsoupProcessor` 无法工作。折中：**上下文暴露能力，处理器只拿结果**，
> 且 `RuleProcessor` 的 `execute` 返回 `RuleResult`（已定义）。

## 3. 实施阶段（每阶段独立可回滚）

| 阶段 | 动作 | 判据 |
|---|---|---|
| P1 | 补 §2.1 金标准回归集，`GoldenRuleTest` 绿 | 新增测试全绿 |
| P2 | `RuleContext` 增加 `parseHtml`/`evalJs`，由 `RuleRunner` 的宿主实现提供 | 编译 + `GoldenRuleTest` 仍绿 |
| P3 | `JsoupProcessor.execute` 真正实现（先只覆盖"列表节点"一类），**不接入** | 单测：喂 fixture 断言 `RuleResult.nodes` |
| P4 | `bookItems` 内部改为 `dispatcher.dispatch("css")`，其余入口不动 | `GoldenRuleTest` 全绿 + 现有 927 项 |
| P5 | 依次迁移 `chapters` → `content` → `explore` → `details`，每迁一个跑一次全套 | 同上 |
| P6 | `RhinoProcessor` 最后迁（JS 沙箱边界最敏感） | 同上 + `JsSandbox` 相关测试 |
| P7 | 删除 `RuleRunner` 里被替换的内联分支，`RuleDispatcher` 成为唯一入口 | 全量 + 代码里不再出现 `Jsoup.parse` 散落 |

**每阶段都必须能单独 revert**：P4 的 commit 只允许改 `bookItems` 一段。

## 4. 明确不做的事

- 不新增第二种规则语法（本方案只搬实现，不做能力扩张）
- 不改 `RuleResult` 的形状去迁就某个入口（要改先加字段并写兼容判据）
- 不在 P4 之前动 `RuleRunner` 的任何一行（占位处理器留在 `processor/` 里不影响运行）

## 5. 相关文件

| 想看什么 | 看哪 |
|---|---|
| 契约定义 | `app/src/main/kotlin/io/legado/rules/RuleProcessor.kt` |
| 处理器示例 | `rules/processor/demo/`（两个，可直接注册） |
| 扩展示例 | `rules/processor/demo/{DemoHello,DemoMarkdown}Processor.kt` |
| 接入判据 | `app/src/test/kotlin/io/legado/RuleProcessorTest.kt` |
