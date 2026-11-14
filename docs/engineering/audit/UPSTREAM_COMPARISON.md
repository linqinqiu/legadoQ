# legadoQ 上游对照（UPSTREAM_COMPARISON）

> 审计日期：2026-11-14 ｜ 性质：第一阶段只读审计。
> 数据来源声明：本轮网络受限，未重新抓取上游。以下对照基于 2026-11-13 对照报告第 6.4 节，上游为 HapeLee/legado-with-MD3 v3.26.25（commit 2e2c63c，2026-11-08）。

## 1. 对照基线

| 项目 | legadoQ | MD3 |
| --- | --- | --- |
| 形态 | Kotlin/Ktor 后端 + React Web 前端 | Android 原生应用 |
| 规则引擎 | Rhino 沙箱 + 白名单 | Rhino（Android WebView 环境更完整） |
| 数据库 | SQLite（WAL，无 schema version） | Android SQLite（Ashwa 完整迁移链） |
| 书源兼容目标 | Legado 生态 | 即 Legado 生态本体分支 |

## 2. 五分类对照结论

### A. 可借鉴的业务逻辑
- 书源规则语义与解析顺序（保持 Legado 兼容的核心）。
- 阅读进度、书签、笔记的数据关系。
- 书源导入冲突策略（legadoQ 已有 WIP 对应实现）。
- 替换规则作用域与顺序。

### B. 可借鉴的数据结构
- 书源字段集（MD3 的 BookSource 模型可作为字段对齐参照）。
- RSS 源与文章模型。
- 书籍分组与批量操作模型。
- 注意：仅参照字段语义，不照搬 Android 持久化实现。

### C. 可借鉴的交互设计
- 阅读器菜单层级（亮度、字体、背景、翻页模式的组织方式）。
- 书架排序、筛选、批量管理的交互分档。
- 书源体检结果分档展示（对应第三阶段 UI 强化）。
- 段评入口的手势与浮层定位思路。

### D. 需要重新实现的跨平台能力
- TTS（Android TextToSpeech 不可移植，legadoQ 需独立方案）。
- WebView 相关能力（段评 WebView 注入、cookie 提取——legadoQ 已有 WebViewProxy 独立实现）。
- 系统级文件与目录访问（桌面端用 AppPaths 方案）。
- 更新与安装机制（Android APK 分发不可复用）。

### E. 不适合移植的 Android 专属实现
- ContentProvider/Room/WorkManager 等 Android 框架组件。
- Android 生命周期与权限模型。
- 原生 View 体系与 Material 组件实现（只借鉴视觉语言）。
- 依赖 Android 文件扫描的媒体库逻辑。

## 3. 兼容性差异（本轮实测）

- java.t2s / java.s2t：MD3 侧存在，legadoQ 零实现（grep 证实；STATUS.md 第 167 行记 30/7 源受影响，P1-2）。
- globalThis.environment：legadoQ 已实现（JsSandbox.kt 第 414-420 行，IS_LEGADO_SIGMA=false，提交 2cdf9d8），STATUS.md 仍列为缺失属文档滞后（P1-4）。
- 段评：MD3 有完整阅读内评论交互；legadoQ 仅有后端 + 前端死代码封装（P1-6）。
- 书源规则语义：golden corpus 仅 15 文件，对上游规则行为的回归捕捉不足（P1-1）。

## 4. 建议跟进的上游变化

- MD3 的规则引擎修复与书源兼容补丁：出现影响通用语义的修复时评估同步。
- 书源模型字段扩展：新字段先评估是否属于 Legado 生态通用语义。
- 不要跟进：Android UI 组件实现、Android 专属性能优化。

## 5. 对照原则重申

- 对照 MD3 研究业务语义与交互思想，不复制 Android 架构。
- legadoQ 的目标架构是 Modular Monolith + 轻量 Clean Architecture，不是 Android 架构的跨平台翻版。
- 每次跟进上游变化前先确认 Legado 生态兼容性测试集（golden corpus）覆盖到位。
