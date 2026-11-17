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
