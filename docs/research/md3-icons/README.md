# 上游（HapeLee/legado-with-MD3）的图标资产清单

> 2026-11-17 从 `E:\legado-out\upstream\app\src\main\res\` 抽出来的，供我们比对与借鉴。
> 原文件是 Android **VectorDrawable**（`.xml`），这里把每个 `<path>` 的 `pathData` / `fillColor` /
> `fillAlpha` / `strokeColor` 转成等价的 SVG，并用 Chrome 渲染了 256px 预览图（`preview/`）。
> 转换脚本：`legado-out/tools/extract-md3-icons.mjs`（不在仓库里，属于一次性工具）。

## 一、正式在用的那套（MD3 自适应图标）

| 资产 | 说明 |
| --- | --- |
| `mipmap-anydpi-v26/ic_launcher.xml` | 自适应图标声明：`background` = `@color/ic_launcher_background`，`foreground` = `ic_launcher_foreground`，`monochrome` = `ic_launcher_foreground_m`（Android 13 主题色图标） |
| `mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.webp` · `ic_launcher_round.webp` | 5 档密度的位图回退（48/72/96/144/192px） |
| `drawable/ic_launcher_foreground.xml` | 前景（370×370 viewport，8 条路径）；`ic_launcher_foreground_m.xml` 是同一图形的单色版（7 条路径） |
| `ic_launcher-web.png` · `assets/web/favicon.ico` · `modules/web/public/favicon.ico` | 网页端用的位图 |

## 二、历史/备选设计：7 套（含各自的 `_b` 变体）

这些是上游保留的**全部版本图标**（同一 108×108 viewport，形状差异就是不同时期的图标方案）：

| 文件 | 路径数 | 备注 |
| --- | ---: | --- |
| `ic_launcher1.svg` | 21 | 早期方案（笔画细、留白多） |
| `ic_launcher1_b.svg` | 4 | 1 号的简化/底色变体 |
| `ic_launcher2.svg` | 16 | 带描边的方正图形 |
| `ic_launcher3.svg` | 47 | 最复杂的一套（细节最多，小尺寸会糊） |
| `ic_launcher4.svg` | 4 | 极简几何 |
| `ic_launcher4_b.svg` | 1 | 4 号的单路径变体 |
| `ic_launcher5.svg` | 17 | 中等复杂度 |
| `ic_launcher5_b.svg` | 1 | 5 号的单路径变体 |
| `ic_launcher6.svg` | 4 | 极简几何 |
| `ic_launcher7.svg` | 17 | 中等复杂度 |
| `ic_launcher7_b.svg` | 1 | 7 号的单路径变体 |

**看图**：`preview/*.png`（256px，透明底）用任意图片查看器打开即可横向对比；
`ic_launcher_foreground.svg` 与 `..._m.svg` 是上游现在真正用的那一套。

## 三、我们自己的图标（`product/web/public/brand-icon.svg`）

上游那 7 套都是 Android 时代的方案，直接搬过来有两个问题：
1. 细节偏多 —— 16×16 的任务栏/列表视图会糊成一团；
2. 没有我们自己的辨识符号（上游是书 + 笔，我们是 **legadoQ**，多一个 Q）。

所以自定义了一枚：**深靛→紫的 MD3 squircle 底 + 一页纸 + 琥珀色书签带 + 靛蓝「Q」环**。
取舍：只保留「一眼能认出的三个形状」，去掉所有细节线；书签带负责在小尺寸下仍然有颜色锚点，
Q 环压在纸的下半部，16px 时退化成一个小圆点也不会脏。

流水线（沿用仓库既有工具，不引入新依赖）：

```bash
# 1) 改这张 SVG（单一真源）
product/web/public/brand-icon.svg
# 2) 渲染成 brand-icon.png（512，透明底）
node legado-out/tools/render-brand.mjs
# 3) 生成 favicon 全家桶 + PWA 图标
cd product && node tools/verify/render-icons.mjs
# 4) 拼 Windows 多尺寸 ico（16/24/32/48/64/128/256）
node tools/verify/make-ico.mjs   # → assets/app.ico
```

旧图标留了一份 `product/web/public/brand-icon-legacy.png`，想退回只要覆盖回 `brand-icon.png` 再跑 3、4 两步。

> 注意 `product/assets/` 是 `product/.gitignore` 第 66 行刻意忽略的产物目录（`assets/app.ico` 由 `make-ico.mjs` 现生成，
> CI 的 Windows job 会自己跑）。所以**源文件放 `product/web/public/brand-icon.svg`**（入库、随站一起发），
> 本目录（`docs/research/md3-icons/`）存上游那 13 枚的 SVG 与 256px 预览，供比对。

## 四、9 套预设图标（2026-11-21 新增）

用户要「获取 md3 上游仓库图标，应该有 9 个，让咱们也能切换自定义图标」。9 套 = `mipmap-anydpi-v26/` 里那 9 个 adaptive-icon，对应上游 `AndroidManifest.xml` 里的 9 个 `activity-alias`（`ic_launcher` + `launcherw` + `launcher0`~`launcher6`）—— 那是上游自己的「换图标」功能。

产物落在 `product/web/public/brand-presets/{9 个 id}.png`（512×512 不透明方形，满幅不烘焙圆角遮罩）。

> ⚠️ **不能复用本目录里那 13 枚 `.svg`**——一次性转换脚本（`legado-out/tools/extract-md3-icons.mjs`，不在仓库）有三类已核实的缺陷：
> 1. 8 位 ARGB `#00000000`（全透明填充）被误读成 `#000000` → 粉环那圈实心黑盘盖住书+笔；
> 2. `ic_launcher_foreground` / `_m` 外层的 `<group scale=0.5011111 translate=92.29444>`（中央 72/108 安全区内缩）被丢弃 → 图形大一号且不在安全区；
> 3. `ic_launcher1_b` 的 `<aapt:attr>` 两段 linear 渐变被降级成纯色。
> 正确产物由下面这条新流水线重新生成。

新流水线（沿用仓库既有工具，不引入新依赖；上游源文件已 vendor 进 `docs/research/md3-icons/upstream/`）：

```bash
node product/tools/verify/render-brand-presets.mjs
# 输出 9 张 512×512 PNG 到 product/web/public/brand-presets/
```

设置弹窗里点选预设走「取字节 → 当作上传文件 → 复用既有 POST /brand/icon」，后端零改动、不新增端点。

### 0.2 版图标恢复（同次提交）

`brand-icon.svg` 是 2026-11-17 那次改版引入的单一真源；用户要求换回 0.2 规范版，故已删除 `brand-icon.svg`，
改回 0.2 那套 `brand-icon.png`（512 真源）+ 各尺寸派生图（favicon 全家桶 / pwa / maskable / apple-touch / shortcut）。
现在的图标来源：`product/web/public/brand-icon.png`；`product/tools/verify/render-icons.mjs` 由它生成尺寸族。
`ic_launcher-web.png` / `favicon.ico` 是上游 web 端用的位图，与我们的品牌无关。

