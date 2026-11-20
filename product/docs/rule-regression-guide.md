# 规则改动的回归验证手册（真实抓取 + 新旧 A/B）

> 适用：改 `RuleRunner` / `RuleValue` / 正文清洗 / 兜底这类**离线可判定**的规则引擎改动。
> 不适用：改 HTTP 层、界面、存储 —— 那些走 `tools/verify/*-check.mjs`（见 [gates-guide.md](gates-guide.md)）。
>
> 本文写的流程是 2026-11-19 ~ 11-20「段落兜底」那轮实际跑过的，命令可直接复制。
> 样本与脚本不随仓库走（含站点抓取结果，不入库），只留可复现的步骤。

## 0. 为什么需要这一层

规则引擎的单测只能证明「我构造的这个页面按预期处理了」。它证明不了两件事：

1. **真实页面的形状**：正文是 `<p>` 还是 `<div>`、页脚多长、导航是不是链接、站点有没有自述"内容没录入"。
2. **改动没有把别的页面弄坏**：兜底这类逻辑在几十个分支上取值，改一处很容易在另一处产生静默变化。

所以规则改动的最小验证是三层，**缺一层就不算验证完**：

| 层 | 能证明 | 不能证明 | 成本 |
|---|---|---|---|
| ① 单测 | 新判据按设计生效，反例会红 | 真实页面形状、其他页面是否被影响 | 秒级 |
| ② 真实抓取重放 | 判据在真实页面上怎么动作 | 与改动前相比有没有变差 | 抓样本一次性，重放 ~1 分钟 |
| ③ 新旧 A/B | **哪几页的输出变了、变好还是变坏** | 站点改版、登录源、JS 源 | 两次重放 ~3 分钟 |

2026-11-20 那一轮就是靠 ③ 抓到 ① 和 ② 都发现不了的真回归（见 §6.2）。

## 1. 准备样本：从书源库挑源、抓真实章节页

样本要**带着各自书源的 `ruleContent`**，否则重放时用的不是真实规则。

1. 从书源库（`legado.sqlite` 的 `source` 表，`payload` 是书源 JSON）里挑 `bookSourceType == 0`（文本）、`ruleContent.content` 不含 `@js:` / `<js>` / `{{` 的源，按域名去重。
2. 逐个探可达性（`curl --max-time 8`，直连与本地代理各试一次）。本机 2026-11-19 实测：200 个域名 80 个可达，中文站直连基本全灭、走 `http://127.0.0.1:6480` 有一部分通。
3. 每个可达站抓 1~3 个章节页：中间章、首章、末章各一个最好；番外/感言类短章单独抓一批（兜底最容易在这类页面误判）。
4. 落盘结构（目录名随意，`LEGADO_CALIBRATION` 指过去即可）：

```
<dir>/
  <id>.json   # {"id","host","sourceName","rule","chapterUrl","title","sourcePayload"}
  <id>.html   # 该章节页的原始响应体（不渲染、不转码）
  <id>.json 里的 sourcePayload = 书源 JSON 原文
```

**不要**把抓取结果提交进仓库：里面是第三方站点正文，且有体积。样本丢了就重抓，成本约 10 分钟。

### 1.1 章节页怎么找（这轮实际用的两种）

1. **走书源自己的入口**：`searchUrl` 搜一个常见词 → 详情页 → `ruleToc` 取目录 → 取中间章/首章/末章的 `chapterUrl`。这条能拿到「规则真的能跑通」的页面，但要求该站的搜索当天可用。
2. **搜索引擎兜底**：`https://www.bing.com/search?q=site%3A<域名>+第一章`，从结果里取章节 URL。Bing 对本机可达，但结果页里混着站内聚合页，取到后要人工看一眼是不是章节页。

两种都要**按站点限速**（≥1 秒/请求），并接受「同一站抓 3 页可能只成功 1 页」。抓取脚本是按站点现写的，不随仓库走；可复用的只有上面的落盘契约。

## 2. 离线重放：临时校准夹具

在 `product/app/src/test/kotlin/io/legado/` 放一个**临时**测试类（跑完删除，不提交）：

```kotlin
package io.legado

import io.legado.rules.RuleRunner
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import org.junit.Test

class ParagraphCalibrationTest {
    @Test
    fun dump() {
        val dir = System.getenv("LEGADO_CALIBRATION")?.let(::File) ?: return
        val tag = System.getenv("LEGADO_CALIBRATION_TAG") ?: "new"
        val rows = StringBuilder("id\tlen\tmedia\terror\n")
        dir.listFiles { f -> Regex("""\d+\.json""").matches(f.name) }!!.sortedBy { it.name }.forEach { json ->
            val obj = Json.parseToJsonElement(json.readText()).jsonObject
            val id = obj["id"]!!.jsonPrimitive.content
            val source = obj["sourcePayload"]!!.jsonPrimitive.content
            val url = obj["chapterUrl"]!!.jsonPrimitive.content
            val html = File(dir, "$id.html").readText()
            val result = runCatching { RuleRunner { _ -> html }.content(source, url) }
            val chapter = result.getOrNull()
            File(dir, "$id.$tag.txt").writeText(chapter?.content.orEmpty())
            rows.append("$id\t${chapter?.content?.length ?: -1}\t${chapter?.mediaUrl?.length ?: 0}\t")
                .append((result.exceptionOrNull()?.message ?: "").replace('\n', ' ').take(80))
                .append('\n')
        }
        File(dir, "engine-$tag.tsv").writeText(rows.toString())
    }
}
```

要点：

- **`RuleRunner { _ -> html }`** 把抓到的 HTML 直接当响应喂进去，不联网。
- **`id` 只匹配 `\d+\.json`**：抓取目录里常有 `index.json`，否则会在 `jsonObject` 上抛 `IllegalArgumentException`。
- 测试框架是 **JUnit4**（`org.junit.Test`），不是 `kotlin.test.Test`。
- 产物：`<id>.<tag>.txt`（正文原文）+ `engine-<tag>.tsv`（`id / 长度 / media 长度 / 异常`）。

跑：

```bash
cd product
LEGADO_CALIBRATION='D:/.../calibration' LEGADO_CALIBRATION_TAG=new \
  ./gradlew :app:test --tests "io.legado.ParagraphCalibrationTest" --rerun-tasks
```

**`--rerun-tasks` 必须加**：输入文件没变，Gradle 会判定测试 up-to-date 直接跳过，产物不更新（这轮踩过一次，误以为跑过了）。

## 3. 新旧 A/B：同一夹具跑两遍，逐字节比

```bash
cd E:/legado

# 1) 把「改动前」的引擎文件换回工作区（其它文件不动）
git checkout <baseline-commit> -- product/app/src/main/kotlin/io/legado/rules/RuleRunner.kt
cd product && LEGADO_CALIBRATION='D:/.../calibration' LEGADO_CALIBRATION_TAG=old \
  ./gradlew :app:test --tests "io.legado.ParagraphCalibrationTest" --rerun-tasks
cd ..

# 2) 换回当前版本
git checkout HEAD -- product/app/src/main/kotlin/io/legado/rules/RuleRunner.kt
cd product && LEGADO_CALIBRATION='D:/.../calibration' LEGADO_CALIBRATION_TAG=new \
  ./gradlew :app:test --tests "io.legado.ParagraphCalibrationTest" --rerun-tasks
```

比对（含「哪一页从多少字变成多少字、异常是什么」）：

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const dir = 'D:/.../calibration';
const o = readFileSync(dir + '/engine-old.tsv', 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
const n = readFileSync(dir + '/engine-new.tsv', 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
const nm = new Map(n.map(l => { const p = l.split('\t'); return [p[0], p]; }));
let same = 0; const diff = [];
for (const l of o) {
  const p = l.split('\t'); const id = p[0]; const q = nm.get(id);
  const a = readFileSync(dir + '/' + id + '.old.txt', 'utf8');
  const b = readFileSync(dir + '/' + id + '.new.txt', 'utf8');
  if (a === b) same++;
  else diff.push({ tag: id, oldL: p[1], newL: q[1], oldErr: p[3] || '', newErr: q[3] || '',
                   oldHead: a.replace(/\s+/g, ' ').slice(0, 45), newHead: b.replace(/\s+/g, ' ').slice(0, 45) });
}
console.log('相同:', same, '不同:', diff.length);
for (const d of diff) console.log(JSON.stringify(d));
"
```

## 4. 怎么判读结果

**只有三种结论可以写进提交信息**，其余都要先查清：

| 现象 | 判定 | 处理 |
|---|---|---|
| 逐字节相同 | 无影响 | 直接写「N 页相同」 |
| 新输出**少了链接堆/页脚/导航**，正文完整 | 改进 | 记录减少了多少字、减的是什么 |
| 新输出**正文变短、或从有内容变成异常** | **劣化** | 停下来查，不许「看起来还行」就放过 |

劣化的常见原因是新判据把「正文段落」也算成了噪声。2026-11-20 的实例：链接密度筛选把三条导航链接剔掉后，**段数**从 5 掉到 2，撞上「≥5 段」门槛，正确正文直接变成「未提取到内容」——单测和 Node 复算都没发现，只有 A/B 能看见。

## 5. 口径陷阱（每个都踩过）

1. **`engine.tsv` 里的长度是「兜底之后」的长度。** 拿它当「规则自己取到多少字」，会把兜底救回来的正文误判成规则取到的正文，进而得出「兜底一次都没救回」这种反向结论（§6.1）。
2. **Node 复算 ≠ 引擎。** 用 Node 复刻 `cleanContent` / 段落筛选只能做量级估算；判定「触发与否」必须用真引擎。Node 那份结果只能用来选阈值、找候选，不能当验收证据。
3. **`##` 替换段先决定要不要截。** 想量「兜底判断那一刻的 pageText」，得先截掉 `ruleContent.content` 顶层的 `##`（那是 `replaceRegex`，在兜底之后才生效）；想验「用户最终看到什么」，就不能截。两种口径混用会得到一堆假差异。
4. **字符长度按 Kotlin 的 `Char.isWhitespace()` 算。** `&nbsp;` 解实体后是 `\u00A0`，Kotlin 当空白、JS 的 `\s` 也当空白，但**按原文数**会当成 6 个字符——链接密度、正文长度都会被稀释。
5. **异常要当成一种输出比。** 「从 3439 字变成异常」和「从 3439 字变成 2000 字」是同一类问题，别只看长度。

## 6. 两个实例（这轮的真实数字）

### 6.1 口径错了会得出反向结论

第一版验收用 Node 复算，结论是「3× 兜底的 4 次触发全部注入页脚/广告，0 次救回正文」。真引擎 A/B 显示：yydskxs 那一章的 3,439 字里 **2,111 字正是兜底救回来的正文**（剩下 1,300 字是链接堆）。原因就是陷阱 1 —— `engine.tsv` 的 3,439 是兜底之后的值。

### 6.2 A/B 抓到的真回归

第一版候选筛选把「≥5 段」判在筛选之后。yydskxs 的正文是**单个 2,273 字的 `<p>`**，三条导航都是链接，筛完只剩 2 段 → 正确正文变成异常（3 个样本页同时红）。改成「段数按筛选前算、拼进候选的只用筛选后的段落」后恢复。

**最终 A/B：48/56 逐字节相同，8 页有差异，0 页劣化。**

| 页 | 旧 | 新 | 判定 |
|---|---|---|---|
| yydskxs ×3 样本 | 3439 | 2111 | 正文完整，末尾链接堆剔除 |
| 林纾 ×3 | 4829 / 3472 / 1551 | 各 −7 字 | 删掉书名链接段 |
| xs777 ×2 | 339 / 346 | 105 / 106 | 页脚兜底被拦住 |

## 7. 收尾清单

1. **删掉临时夹具**：`rm product/app/src/test/kotlin/io/legado/ParagraphCalibrationTest.kt`，`git status` 里不该出现它。
2. 单测补上 A/B 暴露的形状（这轮补了 3 条：链接堆不参与兜底 / 重复提示+链接堆不冒充正文 / 手打中不拿页脚当正文）。
3. 跑一遍受影响的测试类，**加 `--rerun-tasks`**：
   ```bash
   cd product && ./gradlew :app:test --tests "io.legado.RuleRunnerTest" \
     --tests "io.legado.GoldenRuleTest" --tests "io.legado.ContentRefreshHttpTest" --rerun-tasks
   ```
4. 门禁：`npm --prefix product run changelog:check`、`version:check`。
5. 把「样本数 / 相同数 / 差异数 / 劣化数 / 每页判定」写进提交信息与 `docs/research/` 对应文档；口径错误要以**追加更正**的方式写在原文档，不改历史数字。

## 8. 这层验证仍然证明不了的

- 没做浏览器渲染验收：正文是否「读起来对」由文本人工判定。
- 样本偏向「能抓到、规则简单」的源；登录源、JS 源、要浏览器模式的站点没覆盖。
- 站点改版会让样本过期，A/B 结论只对「这批抓取」成立。
- 抓取当天的网络状况会影响可达率，换环境要重抓、不能直接复用结论。
