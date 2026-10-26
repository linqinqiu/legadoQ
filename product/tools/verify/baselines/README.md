# 基线（必须进版本库）

这里放"判据要对比的参照物"。它们原先躺在 `tools/verify/out/`，而 `out/` 是 gitignore 的 ——
清一次目录，"与基线逐条比对 = 零回归"这句话就再也无法验证了。所以参照物单独放这里、进版本库。

| 文件 | 谁在用 | 是什么 |
| --- | --- | --- |
| `server-test-failures-47.txt` | `:app:test` 回归判定（AGENTS §3） | 本机长期固定的 47 条失败**集合**（Windows 删不掉被占用的 SQLite）。判回归只比集合，不比数量 |
| `frame-frozen-20261003.json` | `frame-metrics.mjs` | 书库等 9 页 × 3 视口的版面实测值。**书库那一组是冻结基准**，PROPOSAL-018 要求它改版后零漂移 |
