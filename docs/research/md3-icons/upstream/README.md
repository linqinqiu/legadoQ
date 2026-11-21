# 上游 MD3 图标原始矢量（vendor）

本目录是 `HapeLee/legado-with-MD3` 仓库 `app/src/main/res/` 的一个**最小子集**，供 `product/tools/verify/render-brand-presets.mjs` 渲染 9 套预设图标用。

## 来源与校验

- 来源仓库：`https://github.com/HapeLee/legado-with-MD3`
- 本机原始副本：`E:\_legado-attic-2026-11-18\legado-out\upstream\app\src\main\res\`（二代仓大清理时归档的临时目录，随时可能消失）
- 2026-11-21 抽查 6 个文件（`ic_launcher_foreground.xml`、`ic_launcher1_b.xml`、`ic_launcher3.xml`、`launcher0.xml`、`colors.xml`、`colors_material_design.xml`）与 GitHub 上游**逐字节一致**；故整批 vendor 进仓，不再依赖 attic 目录或网络。

## 目录内容

- `drawable/`（13 个）：9 个前景矢量 `ic_launcher1`~`7`、`ic_launcher_foreground`、`ic_launcher_foreground_m`；4 个背景矢量 `_b` 变体（`ic_launcher1_b`/`4_b`/`5_b`/`7_b`）。
- `mipmap-anydpi-v26/`（10 个）：9 个 adaptive-icon 声明（`ic_launcher`、`launcherw`、`launcher0`~`6`，对应上游 `AndroidManifest.xml` 的 9 个 `activity-alias`）+ `ic_launcher_round`（本流水线不用，留档）。
- `values/`（2 个）：`colors.xml`（`ic_launcher_background`=#2E2D3D、`ic_launcher_background_w`=#F2F1F6）、`colors_material_design.xml`（`md_yellow_600`=#FDD835、`md_grey_50`=#FAFAFA）。

## 为什么不用上一层的 `*.svg`

上一层 `docs/research/md3-icons/*.svg` 是一次性工具 `extract-md3-icons.mjs` 的转换产物，有 3 类已核实的缺陷，不能直接用来渲染预设：

1. 8 位 ARGB `#00000000`（全透明填充）被误读成 `#000000` → 粉色描边圆环变成实心黑盘，盖住书+笔图形；
2. `ic_launcher_foreground` / `_m` 外层的 `<group scale=0.5011111 translate=92.29444>`（adaptive-icon 中央 72/108 安全区内缩）被丢弃 → 图形大一号且不在安全区；
3. `ic_launcher1_b` 的 `<aapt:attr>` 两段 linear 渐变被降级成纯色。

新流水线直接从本目录的原始 XML 重新转换，正确处理上述三点。
