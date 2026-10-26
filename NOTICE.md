# 许可边界说明

本仓库包含多个来源的组件，适用不同的许可证：

| 范围 | 许可证 | 说明 |
|------|--------|------|
| 根目录、`src/web/`、`app/`、`docs/`、`scripts/` | MIT（见 `LICENSE`） | 青阅自有代码与文档 |
| `legado/` | GPL-3.0（见 `legado/LICENSE`） | 后端服务与内置 Web UI，独立 git 仓库 |
| `refs/` | 各自原许可证 | 上游参照资料，来源见 `refs/SOURCES.md` |

分发说明：

- 只分发根目录代码时，按 MIT 执行。
- 分发包含 `legado/` 或其构建产物（`legado-server-*-all.jar`、整合包）时，必须同时遵守 GPL-3.0，并向接收方提供对应源码。
- `release/` 中的整合包属于后一种情况。
