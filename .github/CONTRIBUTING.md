# Contributing to QingYue AI Framework

欢迎为青阅贡献代码！这是一个**完全由人类控制、零自动化 Bot**的开源项目。

## 🤝 我们想要什么样的贡献者

### ✅ 我们希望你是：

- **负责任**: 你的提交和 PR 会直接影响用户体验
- **细心**: 遵循我们的代码风格和文档规范
- **沟通良好**: 愿意讨论技术细节和设计方案
- **尊重项目哲学**: 理解并认同"零依赖"和"完全人工控制"的理念

### ❌ 我们不想要的：

- **Bot 提交的代码**: 本项目拒绝任何形式的自动化依赖更新
- **未经测试的代码**: 请确保你的代码通过所有必要的测试
- **破坏性的改动**: 除非必要，避免大规模重构
- **忽略 issue 的 PR**: 请先阅读现有 issue，不要重复造轮子

---

## 🔧 开发环境设置

### 1. Fork 仓库

```bash
# 在 GitHub 上 fork 这个仓库到你的账号
git clone https://github.com/YOUR_USERNAME/qingyue.git
cd qingyue
```

### 2. 安装依赖（前端）

```bash
cd src/web
npm install
```

### 3. 后端（可选 - 用于完整集成测试）

```bash
cd product
./gradlew :app:installDist
```

### 4. 运行本地服务

```bash
# 启动前端开发服务器
npm run dev

# 访问 http://localhost:3000
```

---

## 📝 提交规范

### Commit Message 格式

```
type(scope): subject

[optional body]

[optional footer]
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式调整（不影响逻辑）
- `refactor`: 代码重构（不添加新功能或修复 bug）
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建过程或辅助工具的变动

### 禁止自动化工具

**重要声明**: 
> 本项目严格遵守人工控制原则。任何使用依赖自动化工具（如 dependabot, renovate 等）生成的 commit 都将被直接拒绝，无论其质量如何优秀。**所有依赖更新必须由人类开发者手动审核、选择版本、编写说明并提交。**

---

## 🚀 如何提 PR

### 步骤 1: 创建分支

```bash
git checkout -b feature/add-reader-theme
# 或使用 fix/xxx for bug fixes
```

### 步骤 2: 编码并提交

```bash
git add .
git commit -m "feat(reader): 添加夜间模式和主题切换功能"
```

### 步骤 3: 推送到远程

```bash
git push origin feature/add-reader-theme
```

### 步骤 4: 创建 Pull Request

在 GitHub 页面上创建 PR，并填写：
- 描述清楚你做了什么
- 引用相关的 issue 编号（如果适用）
- 提供测试截图或 GIF

---

## 🐛 报告 Bug

### Bug Report 模板

请使用 [GitHub Issues](https://github.com/linqinqiu/qingyue/issues/new)

**标题格式**: `[Bug] 简短描述问题`

**内容要求**:
- 问题重现步骤
- 预期行为 vs 实际行为
- 环境信息（操作系统、浏览器版本等）
- 错误日志（如果适用）

---

## 💡 功能建议

### Feature Request 模板

**标题格式**: `[Feature] 简短描述功能`

**内容要求**:
- 问题的背景（为什么要做这个功能？）
- 功能的具体描述
- 预期的用户价值
- 可能的实现方案（可选）

---

## 📖 代码审查流程

### 审查标准

所有 PR 都需要满足：

1. ✅ **代码质量**: 符合 TypeScript + React 最佳实践
2. ✅ **文档**: 公共 API 有完整的 JSDoc 注释
3. ✅ **测试**: 核心功能有单元测试或 E2E 测试
4. ✅ **无回归**: 不破坏现有功能
5. ✅ **人工验证**: 所有变更经过人类开发者验证

### 审查响应时间

- 普通 PR: 24-48 小时内审查
- 紧急修复：6-12 小时内响应
- 重大功能：可能需要多次迭代

---

## 🏆 认可与奖励

### Code Contributions

- 每获得 3 个 accepted PR，你的名字会出现在 CONTRIBUTORS.md
- 每次被采纳的设计方案，会得到致谢

### Community Recognition

- 活跃的贡献者会被邀请进入 Core Team
- 优秀的 Bug Reporter 会被标记为 "Trusted Reporter"

---

## ⚠️ 特别注意事项

### 关于自动化 Bot

**我们坚决反对任何形式的依赖自动化工具**。这意味着：

❌ 不允许：
- Dependabot
- Renovate
- Greenkeeper
- 其他自动更新的机器人

✅ 允许：
- 人工发起的依赖更新
- 经 Core Team 审核的版本升级

### 为什么这样做？

- **透明度**: 每个依赖变化都要有人负责解释
- **质量控制**: 避免引入破坏性更新
- **学习机会**: 了解每个第三方库的作用
- **控制权**: 保持对项目架构的完全掌控

---

## 📬 联系方式

如果你有任何问题，可以通过以下方式联系我们：

- **GitHub Discussions**: [提问或分享想法](https://github.com/linqinqiu/qingyue/discussions)
- **Email**: linqinqiu@example.com

---

## 🙏 致谢

感谢所有为我们的项目做出贡献的人！

没有您的参与，青阅就无法成为今天的样子。让我们一起打造最好的阅读体验！

---

**最后更新**: 2026-10-18  
**版本**: v0.9.0-alpha
