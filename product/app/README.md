# Legado Server（`app/`）

Ktor + Kotlin JVM 的无头书源引擎与 HTTP 服务：解析并执行 Legado 书源规则（Jsoup / JSONPath / XPath / Rhino JS 沙箱）、
多书源并发搜索、离线缓存、封面缓存、RSS 与订阅同步，数据落在一个 SQLite 文件里。
前端在 `../web`，构建产物由 `processResources` 烤进 jar，所以**一个 jar 就是一个完整应用**。

## 本机跑起来

```bash
npm --prefix web run build                       # 产出 web/dist
./gradlew :app:fatJar                         # 产出 app/build/libs/legado-<版本>-all.jar
java -jar app/build/libs/legado-<版本>-all.jar
```

打开 `http://127.0.0.1:1234`。环境变量（`ServerConfig.kt` 读取）：

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `LEGADO_HOST` | `127.0.0.1` | 监听地址。默认只绑回环（本机自用）；**要局域网/公网访问才显式设 `0.0.0.0`** 并自担其责——Dockerfile 与计算巢模板已代为设成 `0.0.0.0` |
| `LEGADO_PORT` | `8080` | 监听端口（`start.mjs` / `.env` 里默认 1234） |
| `LEGADO_DATA_DIR` | `./data`（当前目录下） | 数据目录；裸跑落在启动目录的 `data/`，不写系统盘、不需要 root（Docker 里是 `/data`） |
| `LEGADO_DATABASE` | `<数据目录>/legado.sqlite` | SQLite 文件位置 |
| `LEGADO_BROWSER_PATH` | 自动探测 | 外部真浏览器登录用的 Chrome / Edge 可执行文件 |

## 安全边界（读代码前先看这条）

**这个服务不设身份**：没有账号、密码、登录页、会话与 CSRF。写操作只有一道对本机用户无感的同源闸门
（`Guard.kt`：非安全方法的 `Origin` 主机与端口必须等于 `Host`，命令行与不带 Origin 的客户端放行）。

因此**绑定地址就是唯一的门**。把它绑到 `0.0.0.0` 或放进公网，等于把整个库（书源、书架、按域共享的登录凭据）
交给能访问该地址的所有人 —— 跨站页面驱动不了它，但同网段与公网直连可以。要对外提供服务，请在前面自己加
反向代理鉴权、IP 白名单或隧道。

## 测试

```bash
./gradlew :app:test                                   # 单测（Windows 上有一批删不掉被占用 SQLite 的既有失败，判回归要比失败集合）
node tools/verify/selfcheck.mjs                          # 部署后的端到端自检
node tools/verify/version-check.mjs                      # 版本号单一来源与前端产物一致性
```
