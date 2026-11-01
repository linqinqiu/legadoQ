# 发布记录

对外语义版本 ← 内部构建号 ← commit 的映射表。`npm run release` 在打 tag 时自动追加一行，**不要手改**。

- **对外版本**的唯一真源是 `product/app/build.gradle` 的 `version`，经 Gradle 清单注入 `BuildInfo`，`/healthz`、About 页、界面显示的同一个数。
- **内部构建号**是 `BUILD_NUMBER`，每完成一项改动 `npm run build:bump` 递增一次，与对外版本完全解耦；一个对外版本可以对应多个构建号（只有对外发布那一刻才打 tag 并落一行）。

| 对外版本 | 构建号 | Commit |
|---|---|---|
| 0.2.10 | 2 | c3189a63b87f |
