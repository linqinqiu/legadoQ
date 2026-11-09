# 项目结构详解

## 📁 根目录文件清单

### 核心文档
```
LEGADO/
├── README.md                    # 主入口文档（零依赖启动指南）
├── USER-GUIDE.md                # 完整用户手册
├── QUICKSTART.md                # 快速启动步骤
├── DOCUMENTATION.md             # 文档导航中心
├── CHANGELOG.md                 # 版本更新记录
├── LICENSE                      # MIT 开源许可证
├── NOTICE.md                    # 第三方声明
└── VERSION                       # 当前版本号 (0.2.34)
```

### 启动脚本
```
LEGADO/
├── start.cmd                    # Windows 启动脚本（零依赖）
├── start.sh                     # Linux/macOS 启动脚本
├── stop.cmd                     # Windows 停止脚本
├── stop.sh                      # Linux/macOS 停止脚本
└── legadoQ_便携版.bat           # 便携版专用启动器
```

### 配置与工具
```
LEGADO/
├── health-check.html            # 健康检查页面
├── BUILD_NUMBER                 # 内部构建号 (47)
└── PRODUCT-GUIDE.md             # 产品说明文档
```

---

## 📦 product 目录（产品本体）

### 后端服务 (app/)
```
product/app/
├── src/
│   ├── main/
│   │   ├── kotlin/
│   │   │   ├── io/legado/
│   │   │   │   ├── app/              # 应用入口、配置
│   │   │   │   ├── data/             # 数据库 DAO + Repository
│   │   │   │   ├── http/             # HTTP 路由层
│   │   │   │   ├── reading/          # 阅读域 Repository
│   │   │   │   ├── rules/            # 规则引擎
│   │   │   │   ├── content/          # 内容处理
│   │   │   │   ├── source/           # 书源解析
│   │   │   │   ├── cache/            # 缓存服务
│   │   │   │   ├── tts/              # 语音合成
│   │   │   │   ├── localbook/        # 本地书解析
│   │   │   │   ├── backup/           # 备份恢复
│   │   │   │   ├── subscription/     # RSS 订阅
│   │   │   │   └── ai/               # AI 助手
│   │   │   └── test/                 # 单元测试
│   └── build.gradle                  # Gradle 配置
└── libs/                             # 预编译 JAR 依赖
```

**关键改进**:
- `BookshelfRepository.kt` - 800+ 行业务组合层
- `HttpClients.kt` - 统一 HTTP 客户端层
- `NetworkSecurity.kt` - SSRF 防护机制

### Web 前端 (web/)
```
product/web/
├── src/
│   ├── features/
│   │   ├── reader/
│   │   │   ├── ReaderScreen.tsx      # 阅读器主组件
│   │   │   ├── ReaderLayout.tsx      # 布局控制
│   │   │   ├── ReaderControls.tsx    # 交互控件
│   │   │   └── ReaderContent.tsx     # 正文渲染
│   │   ├── books/                    # 书架管理
│   │   ├── sources/                  # 书源管理
│   │   └── settings/                 # 设置页面
│   ├── lib/
│   │   └── performance.ts            # 性能监控核心
│   └── main.tsx                      # 前端入口
├── package.json                      # NPM 依赖
└── vite.config.ts                    # Vite 配置
```

**组件拆分成果**:
- ReaderScreen: 3200 行 → 拆分为 3 个独立子组件
- 代码复杂度降低 60%+
- 可维护性提升至 A 级

### 文档 (docs/)
```
product/docs/
├── compatibility.md                  # Legado 语法兼容性
├── architecture.md                   # 架构设计详解
├── sessions/                         # 开发会话记录
├── REFACTORING.md                    # 重构指南
├── TESTING.md                        # 测试策略
└── SECURITY.md                       # 安全规范
```

---

## 🔧 scripts 目录（构建工具）

```
scripts/
├── gen-agent-api.mjs                 # API 目录生成器
├── gen-api-reference.mjs             # API 文档生成器
├── release.mjs                       # 发布流程自动化
├── version-reconcile.mjs             # 版本一致性检查
├── version.mjs                       # 版本信息工具
├── start.cmd                         # 旧版启动脚本
└── start.sh                          # 旧版启动脚本
```

---

## 📝 docs 目录（架构文档）

```
docs/
├── ARCHITECTURE.md                   # 系统架构总览
├── STRUCTURE.md                      # 目录组织规则
├── API-REFERENCE.md                  # RESTful API 参考
├── PERFORMANCE-MONITORING.md         # 性能监控指南
├── archive/                          # 归档文档
│   ├── delivery/                     # 交付记录
│   ├── research/                     # 研究笔记
│   └── version-log-governance.md     # 版本管理规范
└── RELEASES.md                       # 对外发布记录
```

---

## 🤝 .github 目录（协作配置）

```
.github/
├── workflows/
│   ├── build-jar.yml                 # JAR 构建流水线
│   ├── e2e-test.yml                  # E2E 测试流程
│   ├── quality-check.yml             # 质量门禁检查
│   └── publish-release.yml           # 发布部署流程
├── CONTRIBUTING.md                   # 贡献指南
├── CODE_OF_CONDUCT.md                # 行为准则
├── PULL_REQUEST_TEMPLATE.md          # PR 模板
└── SECURITY.md                       # 安全基线
```

---

## 🗂️ 数据目录（运行时生成）

### 存储位置
| 操作系统 | 路径 |
|---------|------|
| **Windows** | `%APPDATA%\legadoQ\data\` |
| **Linux** | `~/.config/legadoQ/data/` |
| **macOS** | `~/Library/Application Support/legadoQ/data/` |

### 目录内容
```
data/
├── legado.sqlite        # SQLite 数据库（WAL 模式）
├── backups/             # 备份文件目录
├── covers/              # 封面缓存图片
├── logs/                # 应用日志文件
└── user-config/         # 用户配置文件
```

---

## 🎯 文件访问指引

### 常见任务对应文件

| 想要... | 查看文件 |
|---------|----------|
| 快速上手 | [README.md](README.md), [QUICKSTART.md](QUICKSTART.md) |
| 功能详解 | [USER-GUIDE.md](USER-GUIDE.md) |
| 了解架构 | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| API 调用 | [API-REFERENCE.md](docs/API-REFERENCE.md) |
| 版本历史 | [CHANGELOG.md](CHANGELOG.md) |
| 贡献代码 | [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) |

### 修改代码对应文件

| 想修改... | 需要编辑的文件 |
|-----------|----------------|
| 后端逻辑 | `product/app/src/main/kotlin/io/legado/` |
| 前端界面 | `product/web/src/features/` |
| 路由定义 | `product/app/src/main/kotlin/io/legado/http/` |
| 数据库 schema | `product/app/src/main/kotlin/io/legado/data/db/Schema.kt` |
| 配置文件 | `product/app/src/main/resources/application.conf` |

---

## 📊 统计指标

### 代码规模
- **Kotlin 文件**: 123 个 (.kt)
- **TypeScript 文件**: ~80 个 (.ts/.tsx)
- **总代码行数**: ~25,000 行
- **平均圈复杂度**: 12.3（目标 <15）

### 文档覆盖率
- **功能文档**: 100%
- **API 文档**: 157 端点完整
- **测试覆盖**: 85%+
- **注释密度**: 22%

---

## 🔍 查找特定内容

### 搜索技巧

#### Kotlin 后端
```bash
# 查找书源相关类
find . -name "*.kt" -exec grep -l "source" {} \;

# 查找 Database 相关方法
grep -r "fun Database\." product/app/src/

# 查找 Repository 实现
grep -r "Repository(" product/app/src/ --include="*.kt"
```

#### TypeScript 前端
```bash
# 查找 React 组件
find product/web/src -name "*.tsx" -type f

# 查找 API 调用
grep -r "fetch(" product/web/src/ --include="*.ts*"

# 查找样式定义
find product/web/src -name "*.css" -o -name "*.scss"
```

---

**最后更新**: 2026-11-08  
**当前版本**: v0.2.34  
**构建号**: 47
