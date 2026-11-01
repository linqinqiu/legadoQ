# 发布流程

这份文档只说「怎么把一次改动变成一版可下载的发行」。功能面看 [`README.md`](README.md)，
部署与整合包看 [`product/docs/deploy.md`](product/docs/deploy.md)。

## 1. 两套号，各管各的

| | 对外版本 | 内部构建号 |
| :--- | :--- | :--- |
| 形式 | `X.Y.Z` | 非负整数 |
| 真源 | `product/app/build.gradle` 的 `version` | 仓库根 `BUILD_NUMBER` |
| 谁看 | 用户、`/healthz`、关于页、发行 tag | 排查「同一版本、哪个包」 |
| 何时变 | 对外发布前 | 每完成一项改动 |

对外版本只有一处真源。`scripts/version.mjs set-external` 会把 `app/build.gradle` 的号同步到 6 处抄本
（三份 `package.json`、根 `VERSION`、`agent-api.json`、README 顶部），改完必须跑
`npm --prefix product run version:check` 确认 7 处一致。

内部构建号不参与版本比较。`BUILD_NUMBER` 由 Gradle 的 `generateBuildInfo` 写进
`meta/build-info.properties`，服务端从 classpath 读出后经 `/healthz` 与 `/api/about` 报给界面；
关于页的「构建」就是它。`0` 表示这个包没读到注入文件，不是有效构建号。

## 2. 一项改动做完时

```bash
npm run build:bump        # BUILD_NUMBER +1，对外版本不变
```

一个对外版本可以对应很多个构建号。**发布那一刻才打 tag**，平时不要动 tag，也不要为了凑号改
`BUILD_NUMBER` —— 它是单调计数器，倒退会让「同一个包里两个号」重新出现。

## 3. 发布：六步

全程在仓库根执行。任一步失败就停下，修好再从这一步重来。

### ① 定对外版本

只在对外语义变化时改：

```bash
node scripts/version.mjs set-external 0.2.11
npm --prefix product run version:check
```

`set-external` 只接受 `X.Y.Z` 三段数字。本项目**不使用预发布后缀**：候选版本就在本地按正式版验证，
不另发 `-rc.N`。需要「先给人试」时发普通小版本，出问题下个小版本修；这样 tag、CHANGELOG、
RELEASES 与 `version-check` 的格式始终只有一种。

### ② 写 CHANGELOG

`product/CHANGELOG.md` 顶部加一节：

```markdown
## [0.2.11] - 2026-11-01

### 新增
- **一句话说清多了什么。**
```

小节顺序固定为 `### 新增` → `### 变更` → `### 修复` → `### 移除`，每条一行、约 60 字以内。
工程根因、实测数字、环境变量名不进这里，写到 `docs/sessions/`。

### ③ 同步文档与接口清单

- 改了接口：`npm --prefix product run docs:api`，把 `docs/API-REFERENCE.md` 一起提交。
- 改了兼容性：`product/docs/compatibility.md` 与 README 的支持度矩阵要同时改。
- 改了行为：`product/docs/功能说明.md`、关于页文案与对应判据要一起看。

### ④ 全量验证并重新构建

```bash
npm --prefix product run check          # 前端类型检查
npm --prefix product run test           # 前端 + 后端全量判据
npm run build                           # 先 web/dist，再 fatJar（顺序不能倒）
```

`npm run build` 走 `product/scripts/tasks.mjs build`：先 `npm --prefix web run build`，再
`./gradlew :app:fatJar`。**不能反过来**，否则烤进 jar 的是上一份前端产物。构建完确认：

```bash
unzip -p product/app/build/libs/legado-0.2.11-all.jar meta/build-info.properties
# version=0.2.11
# build=<BUILD_NUMBER>
```

### ⑤ 提交代码

发布脚本只负责「记录 + tag」，不替你提交功能改动。先把这一版的所有代码、测试、文档提交：

```bash
git status --short          # 应当只剩 RELEASES.md 未跟踪/未提交
git add <明确列出的文件>
git commit -m "release: legadoQ 0.2.11"
```

工作区必须干净，否则 `npm run release` 会拒绝执行 —— tag 不能盖在未提交改动上。

### ⑥ 记账、打 tag、推送

先看一眼将要做什么：

```bash
npm run release:dry
```

确认无误后：

```bash
npm run release
```

它会依次：校验 7 处版本一致 → 校验 CHANGELOG 有 `## [0.2.11]` → 校验 tag 未存在、RELEASES 未记过
→ 向 `RELEASES.md` 追加一行「版本 | 构建号 | 当前 HEAD」 → 提交这条记录 → 在该提交上打
`v0.2.11` 注释 tag → 推送分支与 tag。

**tag 指向记录提交，表里的 Commit 是代码提交。** 两者差一个 commit 是正常的：记录提交只改
`RELEASES.md`，代码提交是它前面那个 HEAD。想回看某一版代码，用表里的 commit，不要用 tag 解引用。

CI 的 `version-gate` 与 `build-jar` 会在 tag 上运行，并创建 GitHub Release（jar + 整合包）。
若 CI 失败，修的是下一版；已推的 tag 不移动、不删除。

## 4. 桌面包与发行资产

CI 跑在 Linux 上，桌面版必须在本机打：

```bash
node product/scripts/package-desktop.mjs
# 产物：product/dist/legadoq-desktop-0.2.11.zip
```

上传到该 tag 的 GitHub Release。上传接口只带 `name` 参数：

```bash
curl -X POST -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @product/dist/legadoq-desktop-0.2.11.zip \
  "https://uploads.github.com/repos/linqinqiu/legadoQ/releases/<release-id>/assets?name=legadoq-desktop-0.2.11.zip"
```

## 5. 发布后核对

```bash
node stop.mjs && node start.mjs --no-open
curl -s http://127.0.0.1:1234/healthz
```

`version` 必须是这一版的对外版本，`build` 必须等于 `BUILD_NUMBER`，`ui` 是这次构建的前端指纹。
再打开关于页确认「版本 / 构建」两格与实际一致，并抽查一条书源搜索。

## 6. 发布清单

- [ ] `BUILD_NUMBER` 已递增，且大于上一版记录的构建号
- [ ] `version-check` 7 处一致
- [ ] CHANGELOG 有当前版本小节，小节顺序正确
- [ ] 接口/兼容性/功能说明已同步
- [ ] 前端 `check` 与全量判据通过
- [ ] `npm run build` 完成，`meta/build-info.properties` 的 version/build 正确
- [ ] 工作区干净，功能改动已提交
- [ ] `release:dry` 输出符合预期
- [ ] `release` 完成，`RELEASES.md` 有一行，tag 已推
- [ ] CI 的 GitHub Release 已生成
- [ ] 桌面包已打包并上传
- [ ] `/healthz` 的 version/build 与记录一致
