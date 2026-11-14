# legadoQ 性能监控系统文档

> 写于 2026-11-08，2026-11-14 复核。**范围=采集与报告口径**：数据能取到，但界面化/持久化的产品观测尚未做（见 `docs/STATUS.md` 可观测性缺口）。

## 📊 概述

legadoQ 提供覆盖后端和前端两个维度的性能采集：

| 维度 | 组件 | 功能 |
|------|------|------|
| **后端** | `Metrics.kt` | 按书源/阶段聚合统计 + `/api/diagnostics` 端点 |
| **前端** | `performance.ts` | 页面加载/API/IndexedDB 实时监控 |

---

## 🔧 后端监控 (Metrics)

### API 端点

#### `GET /api/diagnostics`

返回进程内运行指标快照，用于回答：
- "哪个书源在拖慢搜索？"
- "慢在站点响应还是慢在脚本执行？"

**响应体**:

```json
{
  "searchRequests": 1250,
  "truncatedSearchRequests": 3,
  "trackedSources": 57,
  "topSources": [
    {
      "sourceId": "https://book.example.com",
      "calls": 487,
      "failures": 12,
      "timeouts": 5,
      "matched": 423,
      "avgLatencyMs": 856,
      "lastLatencyMs": 1240,
      "updatedAt": 1730985600000
    }
  ],
  "stages": [
    {
      "stage": "http",
      "calls": 487,
      "failures": 12,
      "avgLatencyMs": 720,
      "lastLatencyMs": 1100,
      "maxLatencyMs": 30000
    },
    {
      "stage": "js",
      "calls": 487,
      "failures": 3,
      "avgLatencyMs": 98,
      "lastLatencyMs": 150,
      "maxLatencyMs": 5000
    }
  ]
}
```

**字段说明**:

| 字段 | 含义 |
|------|------|
| `searchRequests` | 总搜索请求数 |
| `truncatedSearchRequests` | 因总量截止被截断的请求数 |
| `trackedSources` | 被追踪的书源数量 |
| `topSources[]` | 前 50 个最活跃书源（按调用次数排序） |
| `stages[]` | 分阶段耗时统计（按平均耗时倒序） |

**阶段名称** (`stage`):

- `search` - 搜索阶段
- `explore` - 发现页阶段  
- `details` - 详情获取阶段
- `toc` - 目录获取阶段
- `content` - 正文获取阶段
- `js` - JS 脚本执行阶段
- `http` - HTTP 网络请求阶段

---

## 🌐 前端监控 (Performance Monitor)

### 核心文件

- [`product/web/src/lib/performance.ts`](../product/web/src/lib/performance.ts) - 核心实现
- [`product/web/test/PerformanceMonitor.test.ts`](../product/web/test/PerformanceMonitor.test.ts) - 单元测试

### 主要功能

#### 1. 页面导航性能

自动收集:
- **Page Load Time**: 从 `fetchStart` 到 `loadEventEnd` 的完整加载时间
- **Time to Interactive (TTI)**: 首次可交互时间

#### 2. 资源加载监控

检测慢资源 (>500ms):
- JavaScript 文件
- CSS 样式表
- 构建产物（包含 `/dist/` 路径的资源）

#### 3. API 请求监控

封装 `fetchWithMetrics()` 替代原生 `fetch`:

```typescript
import { fetchWithMetrics } from './lib/performance';

// 替换所有 API 调用
const response = await fetchWithMetrics('http://127.0.0.1:1234/api/search/stream');

if (response.ok) {
  const data = await response.json();
  // ...处理数据
}
```

特性:
- 自动记录请求耗时
- 标记慢请求 (>300ms) 并输出警告
- 区分成功和失败请求

#### 4. IndexedDB 操作监控

封装 `dbTransaction()` 监控数据库读写:

```typescript
import { dbTransaction } from './lib/performance';

// 替代直接的 IndexedDB 操作
const books = await dbTransaction(
  'legado-reader', 
  ['book_shelf'], 
  async () => {
    // 你的 IndexedDB 操作
    return await getAllBooks();
  }
);
```

特性:
- 记录事务执行时间
- 识别慢查询
- 配合 IndexedDB 缓存命中分析

### 使用示例

#### 在应用中初始化

已在 [`main.tsx`](../product/web/src/main.tsx) 中自动初始化:

```typescript
// 启动时自动调用
performanceMonitor.init()

// 之后所有 API 调用都带有性能埋点
const response = await fetchWithMetrics('/api/books/details')
```

#### 手动报告

```typescript
import { performanceMonitor } from './lib/performance';

const report = performanceMonitor.report();

console.log('Page Load Time:', report.pageLoadTime, 'ms');
console.log('API Requests:', report.apiRequests);
console.log('Bottlenecks:', report.bottlenecks);
```

#### 识别瓶颈

```typescript
const bottlenecks = performanceMonitor.report().bottlenecks;

bottlenecks.forEach(b => {
  console.warn(`Performance bottleneck detected: ${b}`);
});
```

---

## 📈 监控数据采集

### 后端采集周期

- **书源级指标**: 实时累计（每次调用）
- **阶段级指标**: 实时累计（每次请求）
- **重启清零**: 所有指标存储在内存中，服务重启后重置

### 前端采集周期

- **导航事件**: 页面加载时一次性采集
- **资源事件**: 持续监听，实时上报
- **API 请求**: 每次请求后立即记录
- **定时报告**: 每分钟生成一次汇总报告（可选发送到后端）

---

## 🔍 性能优化建议

### 常见瓶颈识别

#### 1. 慢书源 (>1000ms)

```bash
curl http://127.0.0.1:1234/api/diagnostics
```

检查 `topSources[]` 中 `avgLatencyMs > 1000` 的条目:

**原因可能包括**:
- 站点响应慢
- SSRF 校验导致额外延迟
- DNS 解析慢
- 网络不稳定

**解决方案**:
- 体检该源，看是否被标记为 `slow`
- 考虑降低其搜索优先级
- 检查是否可离线缓存

#### 2. 慢规则引擎 (>500ms)

检查 `stages[]` 中的 `js` 阶段:

```json
{
  "stage": "js",
  "avgLatencyMs": 520,  // 超过阈值
  "failures": 12        // 规则执行失败率
}
```

**原因可能包括**:
- 正则表达式复杂
- 死循环
- 内存分配过多

**解决方案**:
- 使用 RuleDebugger 逐阶段调试
- 简化正则表达式
- 移除不必要的脚本逻辑

#### 3. 前端慢资源 (>500ms)

浏览器控制台会输出:

```
[Performance Slow Resource] /dist/assets/index-BU32U2RT.js: 1240ms
```

**原因可能包括**:
- CDN 速度慢
- 本地服务器带宽不足
- 文件过大

**解决方案**:
- Gzip/Brotli 压缩
- 代码分割
- 懒加载

#### 4. 慢 API 请求 (>300ms)

浏览器控制台会输出:

```
[Performance Slow API] /api/search/stream: 890ms
```

**原因可能包括**:
- 多源并发超时
- WebSocket 建立慢
- 数据处理耗时长

**解决方案**:
- 启用结果分页加载
- 减少单次搜索范围
- 使用缓存命中加速

#### 5. 慢 IndexedDB 操作 (>200ms)

```javascript
const result = await dbTransaction(
  'legado-reader',
  ['book_content_cache'],
  async () => {
    // 大量章节数据读取
  }
);
```

如果耗时过长，可能的优化:
- 添加索引
- 分页查询
- 批量操作拆分

---

## 🛠️ 调试工具

### 1. 后端诊断端点

```bash
# 查看当前运行指标
curl http://127.0.0.1:1234/api/diagnostics | jq

# 查看最近的错误日志
curl "http://127.0.0.1:1234/api/logs?limit=100&level=ERROR" | jq
```

### 2. 前端开发者工具

打开浏览器 DevTools Console:

```javascript
// 手动触发性能报告
performanceMonitor.report()

// 清空历史数据
performanceMonitor.reset()

// 查看当前指标
performanceMonitor.metrics
```

### 3. 规则调试器

对于特定的慢书源，使用内置调试器:

```
POST /api/sources/{id}/debug?keyword=小说
```

SSE 流式返回每个阶段的耗时和失败原因。

---

## 📝 最佳实践

### ✅ 推荐做法

1. **定期检查** `/api/diagnostics` - 每周至少一次
2. **启用前端控制台监控** - 开发环境始终开启
3. **设置性能告警阈值** - 例如书源响应>2000ms
4. **记录性能基线** - 新版本发布前后对比
5. **关注趋势而非绝对值** - 渐进恶化比单点故障更危险

### ❌ 避免做法

1. 忽略前端慢资源警告
2. 不检查 `stages[].failures` 累积增长
3. 只在用户投诉后才查看性能数据
4. 过度优化 <100ms 的操作
5. 在生产环境禁用性能监控

---

## 🚀 未来增强

计划中的监控能力:

1. **PROMETHEUS 导出** - 支持 Grafana 可视化
2. **分布式追踪** - Request ID 透传 + span 分析
3. **A/B 性能测试** - 不同配置的基准测试
4. **移动端适配** - PWA 离线模式的特殊监控

---

## 📞 技术支持

如遇到性能问题或需要优化建议:

1. 先查看 `/api/diagnostics` 定位瓶颈
2. 检查浏览器控制台是否有 `[Performance ...]` 警告
3. 使用 RuleDebugger 分析慢规则
4. 对比历史版本基线

---

**最后更新**: 2024-11-XX  
**维护者**: Qoder AI Assistant  
**关联 PR**: #TODO
