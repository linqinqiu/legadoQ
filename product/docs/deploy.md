# 部署与运维

> 最后核对：**0.3.0 / 2026-11-24**（补充匿名反馈中转与 Supabase RLS 验收；发行资产口径以 `.github/workflows/build-jar.yml` 为准）

这份文档说"怎么把它跑起来、怎么升级、跑坏了先看哪儿"。功能面看 [`../README.md`](../README.md)，
内部结构看 [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)。

## 1. 五种交付形态

| 形态 | 怎么来 | 装了什么 Java | 默认端口 | 适合谁 |
| :--- | :--- | :--- | :--- | :--- |
| 桌面程序 `legadoq-desktop-<版本>.zip` | `node scripts/package-desktop.mjs`（需 `JAVA_HOME` 指向带 `jpackage`/`jlink` 的 JDK） | 自带 jlink 裁过的精简运行时，**用户机器不用装 Java** | `1234`（被占则顺延，见 §3） | 双击用的普通人 |
| 整合包 `legadoq-<版本>.zip` | `node scripts/package.mjs`（先 `./gradlew :app:fatJar`） | 包内 `runtime/bin/java.exe`，同样免装 Java | `1234` | 想整个文件夹搬盘的人 |
| 裸 jar `legado-<版本>-all.jar` | `./gradlew :app:fatJar` | 需要本机 Java 17+ | `8080` | 已经有 JVM 的人 |
| Docker | `docker build -f Dockerfile -t legadoq .` | 三段构建：node 打前端 → gradle 打服务端 → `eclipse-temurin:17-jre` | 容器内 `8080`，`LEGADO_HOST=0.0.0.0` | 有 NAS / 服务器的人 |
| 源码 | `cd web && npm install && npm run dev` + `./gradlew :app:run` | 本机 JDK | dev server 5174 代理到 1234（可用 `LEGADO_PROXY_TARGET` 换） | 改代码的人 |

**当前 Releases 上有的**：正式版（`v*` tag）与滚动预发布（main 连续构建，不占 Latest）都给
`legado.jar` + `legado-dist.zip` + `legadoq-desktop-<版本>.zip` + `SHA256SUMS` 四件。
整合包 `legadoq-<版本>.zip` 不在 CI 产物里，是本机 `node scripts/package.mjs` 的产物。
桌面包**在 CI 里打**：`.github/workflows/build-jar.yml` 的 `desktop` job 跑在 `windows-latest` 上，
用 jlink + jpackage 出 `legadoq-desktop-<版本>.zip`，`release` job 依赖它 —— 桌面包没出来就不发版。
本机要单独打时用 `node scripts/package-desktop.mjs`，产物落在 `dist/`。

桌面壳为什么是 jlink + jpackage 而不是 Tauri / GraalVM，见
[`研究-桌面外壳与Tauri.md`](../../docs/research/研究-桌面外壳与Tauri.md)：结论是现有外壳已经满足"免装 JDK、只跑一个进程、
界面同源"，换 Tauri 省不下体积，还得再养一条 Rust 打包链。

## 2. 构建顺序不是可选的

```bash
npm --prefix web run build          # ① 前端产物 web/dist
node tools/verify/dist-check.mjs    # ② 断言 web/dist 里 index.html 与它引用的 assets 都在
./gradlew :app:fatJar            # ③ 把 ① 烤进 jar（app/build.gradle 的 processResources 把 web/dist 拷进 static/）
node tools/make-cds.mjs             # ④ 可选：CDS 类归档，冷启动 ~8.3s → ~5.3s
node scripts/package.mjs            # ⑤ 可选：整合包
node scripts/package-desktop.mjs    # ⑥ 可选：桌面包
```

③ 必须紧跟在 ① 之后。①②③并发或顺序倒了，jar 里烤进去的是**上一份 bundle**，表现是"源码改了、界面无变化"，
而 `version-check` / `ui-shell-check` 会三条一起红（服务端 bundle ≠ `web/dist`、顶栏版本不高亮、`build/libs` 里留着旧 all.jar）。
`build/libs` 里同时有新旧两个 `*-all.jar` 时，挑错包的经验教训已经写过一次：先把旧包挪走再验。

③ 的归档与那一份 jar **绑定**：重建 jar 后归档就过期。过期不用手管 —— `start.mjs` 照常启动（这一次没享受到那几秒），
并**在后台**用另一个空闲端口跑 `make-cds.mjs` 重建，下次启动就快。要手动重来：`node tools/make-cds.mjs`。

## 3. 端口从哪儿来

优先级（`scripts/runtime.mjs` 里一处判定，别在别处再算一遍）：

```
--port > 安装根/port.txt > .env / 环境变量 LEGADO_PORT > 1234
```

- **界面上就能改**：设置 → 服务 → 服务端口（写的是安装根下的 `port.txt`，**重启后生效** —— 正在跑的进程挪不了自己的监听口）。
- 桌面程序（`DesktopLauncher.kt`）：端口上已经是 legadoQ → 只开界面、不留第二个进程；被**别的程序**占了 → 从下一个端口起
  在 20 个内找空闲的，并用它写回 `port.txt`，下次仍稳定在它上面。应用窗口的地址带 `?desktop=1`，界面据此不显示 PWA 安装条；
  托盘可开窗口、浏览器、数据/日志/程序目录，复制地址与退出；壳输出写 `server.log`（`LEGADO_LOG_FILE` 可改，5MB 轮转）。
- 裸 jar 默认 `8080`；启动脚本与桌面版默认 `1234`。

## 4. 启动、停止与数据目录

```bash
node start.mjs                 # 起服务并开浏览器
node start.mjs --no-open       # 只起服务（后台、不占窗口）
node start.mjs --port 1235     # 换端口
node start.mjs --host 0.0.0.0 --allow-external-bind   # 换绑定地址（非回环必须显式放行）
node stop.mjs                  # 按端口停进程（换过端口还没重启时会按 jar 兜底找）
start.cmd                      # 双击用：没跑就起、等就绪再开界面；已在跑就直接开界面
```

安装根 = 脚本自己所在目录，整个文件夹可以改名或搬盘。数据与文件都从它派生：

| 位置 | 内容 |
| :--- | :--- |
| `data/legado.sqlite`（+ `-wal` / `-shm`） | 唯一那份库；`LEGADO_DATABASE` 可单独指 |
| `data/covers/` | 封面与正文图片的磁盘缓存（含 `GET /api/covers/proxy` 代取的外域封面） |
| `data/local_books/` | 导入的 TXT/EPUB |
| `data/backup_kept/` | 备份包里"原样收下"的个性化条目（不建表，可下载） |
| `tmp/` | JVM 临时目录（`LEGADO_TMP_DIR`）；不设会每次启动往系统盘 `Temp` 解一份 SQLite 原生库 |
| `server.log` | 运行日志（`LEGADO_LOG_FILE`）；界面里「我的 → 运行日志」读的是库里的 `log_entry` |
| `port.txt` | 界面上改过一次端口之后就有了 |

**迁移 = 把整个安装根搬走**（含 `data/`），或者只搬 `data/` 再用 `.env` 指过去。备份另有一条路：界面「备份」页导出/导入。

## 5. 跨设备用之前

服务**不设身份**，绑定地址就是唯一的门。默认只绑回环。
`LEGADO_HOST=0.0.0.0` 之后，同一张网里任何设备都能读改这个库（书源、书架、登录凭据）——
同源闸门只挡"别人网页里的脚本借你的浏览器动手"，挡不住直连。
启动脚本会直接拒绝非回环地址；确认要暴露时加 `--allow-external-bind`（或设 `LEGADO_ALLOW_EXTERNAL_BIND=1`），
它只表示"我知道风险"，不提供任何保护。要认真做就在前面放一层带鉴权的反向代理，或者走隧道。
反代还需要：`X-Accel-Buffering: no` 别被吞（朗读是长音频流）、别缓冲 SSE 进度通道。

## 6. 升级之后"界面还是旧版"

九成是 Service Worker 预缓存。当前策略是 **autoUpdate**：新 SW 自己 `skipWaiting` + `clientsClaim`，
不会停在 waiting 态，也没有"发现新版本 → 点立即更新"这一步；接管后页面在空闲时自动刷新。
三层兜底都在 `web/src/components/PwaManager.tsx`：注册成功后立刻 `reg.update()`；页面 `focus` /
`visibilitychange` 与每 5 分钟主动检查；`controllerchange` 时如果用户正在输入或搜索在飞，推迟到空闲再刷。
注册只有 PwaManager 一个入口（VitePWA 的 `injectRegister: null`，不再注入 `/registerSW.js`）。

自查三步：`curl -s http://127.0.0.1:<端口>/ | grep assets/index-` 看哈希 → 对一下 `web/dist/index.html` →
不一致就是产物旧（回 §2 重打）；一致而界面还旧就是 SW，让用户 DevTools → Application → Service Workers → 注销 + 清站点数据，
或者开无痕窗口。

## 7. 部署后验收

```bash
node tools/verify/version-check.mjs    # gradle / 清单 / /healthz / 顶栏 / 日志顶部 五处同号
node tools/verify/selfcheck.mjs        # 搜索 → 详情 → 目录 → 正文 → 净化 一条链跑通
curl -s http://127.0.0.1:<端口>/healthz
```

门禁一律**串行**跑（多个门禁会抢同一个 profile 与同一个实例的探针数据），且默认打 `1234`；
对着隔离实例跑就设 `LEGADO_BASE_URL=http://127.0.0.1:<端口>`。判据红了先问"是判据旧了、探针脏了、
机器被自己占满了，还是产品坏了"。

## 8. Docker 的两件事实

- 镜像**必须本地构建**，流水线里的镜像发布还没通（`docker.yml` 那条）。
- 数据卷挂到 `/data`（`ENV LEGADO_DATA_DIR=/data`），宿主用 `./ls_data:/data`；`compose.yml` 里已经这么写。
  容器里 `LEGADO_HOST=0.0.0.0` 是必需的（否则宿主机映射接不上），也意味着容器网络里谁都能访问 —— 别直接把 8080 暴露到公网。

## 9. 匿名反馈通道（可选）

「关于」页可以直接提交建议。默认不依赖 Supabase：未配置中转时，提交接口返回
`409 feedback_not_configured`，界面自动切回原来的 GitHub Issue 流程，用户仍能反馈。
启用后浏览器只访问本机 Ktor，由服务端转发到 Supabase；这样没有浏览器直连 Supabase 的
CORS 问题，以后要限流也有统一入口。

### 9.1 建表与权限

1. 在 Supabase SQL Editor 执行一次仓库里的 [`../../docs/feedback-supabase.sql`](../../docs/feedback-supabase.sql)。
2. 确认 `public.feedback` 已启用 RLS，并且只有两条策略：`anon insert` 与 `select own only`。
3. 不要新增 `update` / `delete` 策略；脚本已显式收回匿名角色的这两种权限。

表只保存提交字段与随机令牌的 SHA-256 哈希，不保存 IP、User-Agent、设备 ID 或邮箱。
`contact` 是用户自愿填写的联系方式；为空时不会发送。浏览器本地随机令牌不会上传，也不会写进
日志；服务端只接收 64 位十六进制哈希。查询「我的建议」时把同一哈希放进
`x-feedback-token`，RLS 只返回与之匹配的行，缺少或错误的令牌返回空数组。

### 9.2 配置与上线

只在运行 legadoQ 的服务器上设置下面两项，然后重启服务：

```bash
LEGADO_SUPABASE_URL=https://<project-ref>.supabase.co
LEGADO_SUPABASE_ANON_KEY=<anon-key>
```

也可以放进安装根目录的 `.env`，但**不要把真实 `.env` 或 anon key 提交到 Git**。
本部署要求 anon key 只留在服务端，不进入前端 bundle；数据权限由 Supabase RLS 负责，
不是靠 anon key 保密。日志统一脱敏 `apikey`、`Authorization` 与 `x-feedback-token`，反馈正文不写日志。

### 9.3 验收

在「关于」页提交一条建议，再点「查看我的建议」，应能看到刚提交的编号、时间、分类与内容。
随后用错误的哈希查询，应返回空数组；直接尝试更新或删除，应被 RLS 拒绝。最后清空两项
环境变量并重启，界面应重新提供 GitHub 回退，且公开 Issue 正文不包含自愿填写的联系方式。

首版不加 CAPTCHA。先观察真实垃圾提交；如果出现滥用，优先在 Ktor 中转层加限流，
不要改成让浏览器绕过服务端直写 Supabase。
