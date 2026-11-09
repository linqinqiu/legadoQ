# 许可边界说明

本仓库同时包含 MIT 与 GPL-3.0 覆盖的内容，按路径区分：

| 范围 | 许可证 | 说明 |
|------|--------|------|
| 根目录（`README.md`、`CHANGELOG.md`、`docs/`、`scripts/`、`.github/`、根 `package.json`） | MIT（见 `LICENSE`） | 仓库级文档、脚本与工具 |
| `product/`（Kotlin 后端、内置 Web UI、桌面壳与打包脚本） | GPL-3.0-or-later（见 `product/LICENSE`） | 产品本体 |

第三方依赖遵循各自的许可证，见 `product/web/package-lock.json` 与 `product/gradle/libs.versions.toml`。

分发说明：

- 只分发根目录代码与文档时，按 MIT 执行。
- 分发 `product/` 或其构建产物（`legado-*.jar`、`legado-dist.zip`、`legadoq-desktop-*.zip`）时，必须遵守 GPL-3.0，并向接收方提供对应源码。
