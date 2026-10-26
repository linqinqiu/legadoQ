# 项目目录规划

## 原则

> 仓库可整体移动到任意盘符：代码与脚本只用相对路径；下表中的 `<仓库外>`、`<备份目录>` 只是示例占位。

1. **单一产品**：能跑的产品在 `product/` 子目录（与本仓库同一 git 仓）。
2. **只写现有功能**：文档只描述 1234 当前具备的能力，不写规划中的功能。
3. **根目录只放入口**：README、LICENSE、NOTICE、VERSION、package.json、启动脚本、总览文档。
4. **产物出库**：发布包、上游参照、历史资料放在仓库外（统一在 `<仓库外>/legado-out/`）。
5. **运行数据不入库**：数据库、封面、日志、浏览器配置、构建产物一律忽略。

## 单一仓（2026-10-25 重组后）

整个项目是一个 git 仓：`E:\legado`。`product/` 是**产品本体**（Kotlin/Ktor 后端 + 内置 Web UI + 测试 + 工具），`docs/` 是**文档/编排层**（本 README、API 参考、目录规划、版本治理），`scripts/` 是启停包装，`product/` 与外层共享同一个 git 历史。旧的"外层 + 内层两层嵌套仓库"已归档到 `E:\legado-archive\`（其 `.git` 设为只读），如需旧提交用归档的历史。

## 目录职责

| 路径 | 放什么 | 不放什么 |
|---|---|---|
| `product/` | 后端源码、内置 UI、后端文档、测试、工具 | 旧前端、旧内嵌模式 |
| `product/app/` | Kotlin/Ktor 源码与资源 | 前端代码 |
| `product/web/` | 内置 Web UI 源码与测试 | 独立前端实验 |
| `product/data/` · `product/app/data/` | 运行数据库、封面、本地书、浏览器配置 | 任何需要提交的文件 |
| `docs/` | API 参考、目录规划、索引 | 历史文档 |
| `scripts/` | `start` / `stop` 包装，委托 `product` | 旧内嵌模式启动脚本 |
| `product/logs/` | 1234 运行日志 | 需要提交的文件 |

## 仓库外目录（统一在 `<仓库外>/legado-out/` 下）

| 路径 | 内容 |
|---|---|
| `<仓库外>/legado-out/assets/refs` | 上游参照资料（含 gedoor 原版、corpus） |
| `<仓库外>/legado-out/assets/archive` | 历史文档、旧框架资料、旧版本文档 |
| `<仓库外>/legado-out/assets/probe` | 探针数据 |
| `<仓库外>/legado-out/assets/legacy-archive` | 旧前端与内嵌模式 |
| `<仓库外>/legado-out/upstream` | HapeLee/legado-with-MD3 参照浅克隆 |
| `<备份目录>/qingyue-2026-10-19` | v0.1.0 旧包与清理备份 |

> 2026-10-25 已清理的旧物（不再存在，勿再引用）：`legado-out` 外的旧发布包 `release-v0.8.1`/`qingyue-dist-v0.8.2`、旧构建 `assets/dist/qingyue-0.8.1`、`refs/md3`（与 `upstream` 重复的副本）。

## 新增文件放哪里

- 后端功能 → `product/app/src/...`
- 内置 UI → `product/web/src/...`
- 后端文档 → `product/docs/`
- 总览/API/目录说明 → `docs/`
- 发布包 → 仓库外 `<仓库外>/legado-out/`（或按发布流程另指）
- 临时脚本 → `product/tmp/`（已忽略）或仓库外

## 禁止事项

- 不写、不保留 1234 没有的功能说明。
- 不在根目录新建第二套前端或第二套后端。
- 不把 `release/`、`refs/`、数据库、JRE、node_modules 加回 git。
- 不手工改 `product/app/build/libs/` 里的 jar 而不重新构建。
- 不执行 `git clean -fd` / `git reset --hard`。

## 版本与入口

- 版本唯一来源：`product/app/build.gradle` 的 `version`。
- 产品入口：`npm start` 或 `scripts/start.cmd` / `scripts/start.sh`（经 `--prefix product` 转发到 `product/`）。
- 停止：`npm run stop` 或 `scripts/stop.*`。
- CI：门禁在根 `.github/workflows/`（版本治理 `version-gate.yml`、文档契约 `contract.yml` 含 `doc-gate`/`structure-gate`、构建 `ci.yml`/`build-jar.yml` 等）；路径按统一仓标定（`product/app`、`product/web`、`product/scripts`、`product/tools`）。
