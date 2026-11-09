# legacyQ 用户指南 v0.2.35

> **本地小说/漫画阅读服务** - 无需安装任何依赖，开箱即用

---

## 📦 快速开始（零依赖版本）

### Windows 用户

#### 方法一：便携版（推荐，无需安装）

1. 下载 [legacyQ_便携版.zip](https://t.me/legadoQ)
2. 解压到任意文件夹（例如 `D:\Books\legacyQ`）
3. 双击运行 `legacyQ_便携版.bat`
4. 浏览器打开 http://127.0.0.1:1234

**特点**: 
- ✅ 无需安装 Java
- ✅ 即开即用
- ✅ 可移到任何磁盘分区

#### 方法二：开发者版本（需 Java 环境）

```bash
# 只需 Java 17+，无需 Node.js
gradlew :product:app:build
java -jar backend/build/libs/legado-server.jar
```

### Linux/macOS 用户

```bash
chmod +x start.sh
./start.sh
# 访问 http://127.0.0.1:1234
```

---

## 🎯 核心功能一览

### 书架管理 📚

| 功能 | 说明 |
|------|------|
| **书籍导入** | 支持从 URL、EPUB、TXT 文件导入 |
| **分组管理** | 自定义分类，拖拽排序 |
| **批量操作** | 一键删除、移动分组、标记已读/未读 |
| **封面缓存** | 自动下载并缓存书籍封面 |
| **阅读进度** | 自动记录，支持多设备同步 |

### 阅读器功能 📖

#### TXT 支持
- 滚动模式 / 分页模式切换
- 章节智能分章规则
- 净化规则（去除广告、无关文字）

#### EPUB 支持
- 内嵌字体渲染
- 目录导航
- SVG/CSS 样式解析

#### 个性化设置
- **显示**: 字号（8-72px）、行距、边距、配色方案
- **字体**: 支持加载自定义字体文件
- **翻页**: 滑动、点击、快捷键
- **背景**: 白昼、夜间、护眼、墨黑四种主题

### 搜索与发现 🔍

| 功能 | 描述 |
|------|------|
| **多源并发** | 同时搜索多个书源，速度提升 10 倍 |
| **WebSocket 流式返回** | 搜索结果实时展示 |
| **发现页** | 按书源分类浏览精选书籍 |
| **智能推荐** | 根据你的阅读习惯推荐相似书籍 |

### 离线缓存 ☁️

- **整本书缓存**: 服务端预下载，节省流量
- **IndexedDB 下载**: 浏览器端离线存储
- **智能去重**: 自动检测重复章节
- **空间配额**: 可配置缓存上限（默认 2GB）

### 朗读功能 🔊

| 引擎 | 特点 |
|------|------|
| **Edge TTS** | 高质量语音，支持多种语言 |
| **Web Speech API** | 浏览器原生，零延迟 |
| **自定义 HTTP** | 对接第三方语音服务 |

**特性**:
- 跨章连播（无缝衔接）
- 定时停止（睡前阅读不失眠）
- 语速调节（0.5x - 3.0x）

### RSS 订阅 📰

- 订阅外部 RSS 源
- 自动抓取最新内容
- 文章去重与关键词过滤
- 定时推送更新

### 备份与迁移 💾

- **Legado 兼容**: 直接导入 legado 备份包
- **JSON 导出**: 书架、书源、规则全量导出
- **增量同步**: 只传输变更数据
- **云存储**: 支持 OneDrive、Google Drive

---

## ⚙️ 高级设置

### 安全配置

```bash
# 默认只监听回环地址（最安全）
LEGADO_HOST=127.0.0.1
LEGADO_PORT=1234

# 暴露到局域网（谨慎使用）
LEGADO_HOST=0.0.0.0
# 必须加此参数才允许绑定
--allow-external-bind
```

**安全建议**:
- ✅ 仅本机使用 → 保持默认配置
- ✅ 局域网共享 → 启用同源写门
- ❌ 公网暴露 → 强烈不建议（无身份认证）

### 性能优化

```properties
# JVM 内存分配
-Xmx512m  # 最大内存，根据机器调整
-Xms256m  # 初始内存

# 日志级别
LOG_LEVEL=INFO   # DEBUG/WARN/ERROR
```

### 存储路径

默认数据存放位置：
- **Windows**: `%APPDATA%\legacyQ\`
- **Linux**: `~/.config/legacyQ/`
- **macOS**: `~/Library/Application Support/legacyQ/`

---

## 🛠️ 常见问题 FAQ

### Q1: 为什么启动很慢？

**A**: 首次编译需要时间。之后应秒级启动。

**解决方法**:
1. 检查 Java 是否安装正确：`java -version`
2. 清理构建缓存：`gradlew clean`
3. 增加 JVM 内存：见上表"性能优化"

### Q2: 无法导入某些书源？

**A**: 可能的原因：

1. **WebView 依赖**: 该源需要 Android WebView（不支持）
2. **登录验证**: 需要先手动登录获取 Cookie
3. **反爬虫机制**: 触发 Cloudflare 等防护

**解决**:
- Telegram 群组反馈：https://t.me/legadoQ
- 提交书源调试截图

### Q3: 阅读器卡顿怎么办？

**A**: 可能原因：

1. **正文过长**: 使用章节缓存功能
2. **图片过多**: 关闭"懒加载"选项
3. **字体文件太大**: 改用系统字体

**优化**:
- 降低字号到 16-18px
- 启用"分页模式"替代滚动
- 清空 IndexedDB 缓存

### Q4: 如何升级版本？

**A**: 新版本发布流程：

1. 关注 Telegram 群组通知
2. 下载最新版压缩包
3. 备份旧数据（可选）
4. 解压覆盖即可（数据保留）

**自动更新检查**:
- 每次启动时自动检查
- 有更新时在界面上方提示

### Q5: 数据丢失如何恢复？

**A**: 从备份恢复：

1. 进入 设置 → 备份与恢复
2. 上传之前导出的 JSON
3. 确认覆盖现有数据

**预防**:
- 定期导出备份到云盘
- 开启自动备份功能

---

## 🔐 隐私与安全声明

### 数据采集情况

✅ **完全不采集以下信息**:
- 个人身份信息
- 设备指纹
- IP 地址
- 阅读历史
- 书籍列表

✅ **本地化设计**:
- 所有数据存储在本地
- 不需要账号登录
- 不连接任何远程服务器

### 网络访问权限

**仅当执行这些操作时才会联网**:
- 搜索书籍（访问书源网站）
- 下载封面和简介
- 刷新 RSS 订阅
- Edge TTS 语音合成（微软服务）
- 检查更新（GitHub Releases）

**不会访问**:
- 任何第三方 CDN
- 广告追踪域名
- 数据统计服务

---

## 📜 开源许可与免责声明

### 许可证

本项目采用 **MIT License**，核心条款如下：

```
Copyright (c) 2026 legadoQ Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 免责声明

1. **内容责任**: 使用者自行负责导入的所有书源内容的合法性。本项目不对任何违规内容承担责任。

2. **数据安全**: 虽然提供备份功能，但不保证数据永不丢失。建议用户定期手动备份重要数据。

3. **技术支持**: 本软件为开源项目，提供有限的技术帮助。对因使用不当造成的问题，不承担任何赔偿。

4. **兼容性**: 由于平台差异，部分功能可能在特定环境中不可用。以实际测试为准。

5. **更新风险**: 新版本可能引入未知问题，建议在非生产环境先测试再应用。

### 联系方式

- **Telegram 群组**: https://t.me/legadoQ
- **仓库地址**: https://github.com/linqinqiu/legadoQ
- **Issue 反馈**: https://github.com/linqinqiu/legadoQ/issues
- **Pull Request**: 欢迎贡献代码

---

## 📞 获取帮助

### 官方渠道

1. **Telegram 群组**（最活跃）
   - https://t.me/legadoQ
   - 即时问答 & 故障排查
   - 每周新书源分享

2. **GitHub Issues**
   - Bug 报告
   - 功能建议
   - 文档纠错

3. **Wiki 文档**
   - 深度技术教程
   - API 参考手册
   - 最佳实践指南

### 社区资源

- **Discord 服务器**: 待建设
- **QQ 群**: 待开放
- **中文论坛**: 待建设

---

## 🎉 致谢

感谢以下开源项目：
- **[Legado](https://github.com/gedoor/legado)** - 灵感来源与书源语法兼容
- **[Ktor](https://ktor.io/)** - 优雅的 Kotlin Web 框架
- **[Material Design 3](https://m3.material.io/)** - UI/UX 设计指导
- **[Rhino](https://developer.mozilla.org/en-US/docs/Mozilla/Rhino)** - JavaScript 沙箱引擎

特别感谢：
- 所有贡献代码的开发者
- 无私分享书源的社区成员
- 积极反馈 Bug 的用户们

---

**版本号**: 0.2.35  
**发布日期**: 2026-11-08  
**构建号**: 47  

**最后更新时间**: 2026-11-08
