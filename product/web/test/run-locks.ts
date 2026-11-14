/**
 * 契约门禁的**子集入口**（contract.yml frontend-gate 用）。
 *
 * 只载两把锁：ApiCatalog（端点契约 ↔ 代码路由双向核对）与 ArchitectureBoundary
 * （依赖方向零基线 + 扫描器有效性守卫）。全量套件由 ci.yml web-check 负责，
 * 这里不重复跑 —— 同一 PR 前端全量跑三遍是 CI 分钟浪费（目录审计 S-18）。
 *
 * 纪律：**不要往这里加别的测试**。要加锁先问它是不是契约级；普通判据进全量。
 * 文件名不带 .test.ts，discover.ts 不会把它当测试重复计数。
 */
export {}
await import('./ApiCatalog.test.ts')
await import('./ArchitectureBoundary.test.ts')