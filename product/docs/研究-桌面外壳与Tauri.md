# 桌面外壳：现状与 Tauri + Sidecar 方案评估

> 2026-10-28。结论基于当前 `main`（0.1.7）源码与本机实测；行号会随代码变化，以文件与函数名为准。

## 一、现在的桌面版是什么

两条命令、一条链路：`scripts/package-desktop.mjs` 先用 jlink 裁一份 16 个模块的 JRE（复用
`dist/legadoq-<版本>/runtime`，没有就重裁），再把 fat jar 交给 jpackage 打 app-image，最后用脚本自带的 ZIP 写入器
压成 `dist/legadoq-desktop-<版本>.zip`（0.1.7：约 55.8 MB / 178 条 / 顶层 `legadoq/`）。

壳本身（`app/src/main/kotlin/io/legado/DesktopLauncher.kt`）只做三件事：探测端口与单实例、带
`LEGADO_*` 起引擎、服务就绪后开窗口并在托盘留守。窗口不是自绘 webview，而是系统里那套
Edge / Chrome 的 `--app=<url>`（找不到才退回默认浏览器）；因为界面始终从
`http://127.0.0.1:<端口>` 加载，同源写闸门（`http/Guard.kt`）照旧成立。

数据默认落在 `<镜像根>/data`，壳日志 `<镜像根>/server.log`（5 MB 轮转），临时目录
`<镜像根>/tmp`；`user.dir` 钉在镜像根，从开始菜单、桌面快捷方式、资源管理器双击都落同一处。

门禁 `tools/verify/desktop-check.mjs`：干净 PATH（不含任何 Java）起壳 → `/healthz` 200、同源写 200、
反向的非同源写 403、第二个实例不起监听并自行退出、退出后端口释放、遵守 `LEGADO_DATA_DIR`、
真实书架快照可读、端口被占时顺延并写回 `port.txt`。

## 二、Tauri + Sidecar 的四个前提逐条核对

**①「摆脱用户环境里的 JDK」——这一条已经做到了，不是待办。**
jlink 把 JRE 裁进安装包，`desktop-check.mjs` 就是用清空的 PATH 跑通的（`开始启动 → /healthz 200`），
用户机器上不需要任何 Java。Tauri 也不会去掉 JVM —— Ktor 仍然跑在 JVM 里，只是换个壳去管它。

**②`bundle.externalBin` 只接受单个可执行文件。**
Tauri v2 的外链二进制要求按 target triple 命名（`legadoq-x86_64-pc-windows-msvc.exe`），
而 jpackage 的 app-image 是一棵目录树（`legadoq.exe` + `runtime/` + `app/legado-<版本>-all.jar`）。
要么把 app-image 打成一个 zip 放进 resources、首启解压到应用数据目录再执行，要么只塞 `legadoq.exe`
——后者丢了同目录的 `runtime/` 与 jar，起不来。两种做法都要在 Rust 里另写一套"解压 / 校验 / 首启"。

**③「前端不用改，Tauri 直接加载打包好的静态文件」——这条不成立，而且是最硬的一条。**
前端的每个请求都是相对路径 `/api/...`（`web/src/lib/api.ts`）；在 `tauri://localhost` 下它们会落到
Tauri 的资源协议上，不是后端。更关键的是同源写闸门：`Guard.kt` 比对请求的 `Origin` 与服务自身身份，
界面一旦由 `tauri://` 提供，**所有写操作都是跨源 → 403**（书架、设置、书源导入全部失效）。
Hash 路由（`/#shelf`）确实天然兼容，但解决不了上面这两条。
绕法只有两个：把界面指回 `http://127.0.0.1:<端口>`（那 Tauri 就退化成和现在一样的"浏览器壳"，
只多了 WebView2 依赖），或者放宽闸门（等于删掉 CSRF 防线）。

**④「几乎不用改 Kotlin」——省下的正是壳的活儿。**
端口顺延、单实例、健康等待、关窗口收服务、托盘菜单、日志落盘现在都在 `DesktopLauncher.kt` 里，
换 Tauri 要再用 Rust 写一遍，并且同时维护 jpackage 与 Tauri 两条打包链。

## 三、其他两条备选

- **GraalVM native-image**：不是零改动。Ktor + kotlinx.serialization + Jsoup + Rhino 的反射/资源
  配置、SQLite JDBC 的原生库、构建时长与产物体积都是成本；规则里的 `@js:` 段跑在 Rhino 上，
  native-image 下需要额外处理。换来的是"没有 JVM"，而我们已经有 jlink。
- **Kotlin/Native**：只能用 `embeddedServer` + CIO，且没有 `staticResources` —— 前端静态托管与路由
  都要改，违背"源码不大变"的前提。
- **Electron**：等于把 Ktor 的接口逻辑用 JS 重写一遍，工作量最大。

## 四、Tauri 真正能带来的与代价

能带来：原生菜单/托盘、更细的窗口控制、内置 updater、壳体积小（几 MB 级）。
代价：Rust MSVC 工具链（本机现在只有 GNU）、WebView2 运行时、第二条打包与签名链；
渲染交给 WebView2（版本随系统，当前用的是用户自己的 Chrome/Edge，渲染与浏览器完全一致）；
失去"一个 jar 就是一个产品"——现在同一个 fat jar 既能 `java -jar` 裸跑，也能进容器，还能被桌面壳拉起。

## 五、结论

**维持 jpackage + jlink**。0.1.7 把壳的体验补齐了：启动画面、完整托盘菜单（打开窗口 / 浏览器打开 /
数据目录 / 日志目录 / 程序目录 / 复制地址 / 退出）、按屏幕自适应的窗口尺寸、`server.log` 落盘与轮转、
启动失败弹窗带日志路径、`?desktop=1` 让前端不弹 PWA 安装条。

如果以后确实需要原生窗口或自动更新，最小改动路线是**薄 Tauri 壳**：只创建窗口并加载
`http://127.0.0.1:<端口>?desktop=1`，后端仍由打包好的 app-image 启动；绝不把前端静态文件塞进
`tauri://` 托管，也不放宽同源闸门。

## 六、0.1.7 的验收证据

- `tools/verify/desktop-check.mjs`：12/12 PASS，含"指向真实书架快照读到 5598 个源"
- 前端 `web/test/run-all.ts`：787/787；后端 `./gradlew :app:test`：绿
- `version-check` 17/17、`ui-shell-check` 62/62、`agreement-check` 6/6、`shortcut-check` 16/16、
  `source-login-check` 32/32
- 窄屏 390×844（真 Chrome）：安装条 `top=765`、悬浮球 `bottom=760`、最后一节 `bottom=708`，
  `.app-shell` 底部余量 92px；`?desktop=1` 下不出现安装条
- `stalled-client-check` 仍然红：这是引擎层的旧账（任务 #36），0.1.6 同样红，
  实测台阶在 10 个停读对端上下；调大 `Dispatchers.IO` 并行度不解决，详见
  [`gates-guide.md`](gates-guide.md) §6.3.1。与桌面壳无关，不挡桌面包。
