# 安全策略（指向权威版）

> 权威版（英文，GitHub「Security」页展示）在仓库根 [`../../.github/SECURITY.md`](../../.github/SECURITY.md)。
> 本文件只保留中文读者需要的**部署安全基线要点**，口径以权威版为准。

## 部署安全基线

- **不要**把服务直接绑到 `0.0.0.0` 或暴露到公网而不加鉴权。
- 对外访问一律走 Nginx / Caddy 反向代理：TLS 终止 + Basic Auth / OAuth + IP 白名单，并只放行到反向代理那一个来源。
- 数据目录（`LEGADO_DATA_DIR`，默认 `<安装根>/data`）放在可信文件系统上，别放共享盘 / 网盘同步目录。
- 及时跟到最新版本：「关于 → 检查更新」能看有没有更新。
- 拿不准就先只绑回环，用 SSH 隧道或本地端口转发访问。
- 漏洞请走 GitHub 私密报告通道（见仓库根 [`../../.github/SECURITY.md`](../../.github/SECURITY.md)），不要用公开 issue。
