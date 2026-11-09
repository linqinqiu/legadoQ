/**
 * 前端性能监控模块
 * 
 * 目标:
 * 1. 收集页面加载耗时
 * 2. 记录 API 请求性能
 * 3. 监控 IndexedDB 读写操作
 * 4. 发现前端性能瓶颈
 * 
 * 使用方式:
 * - 启动时自动初始化 (在 main.tsx)
 * - 数据可通过 /api/metrics 发送到后端（可选）
 */

export interface PerformanceMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  value: number;
  category: 'navigation' | 'resource' | 'render' | 'api' | 'indexeddb';
}

export interface PerformanceReport {
  timestamp: number;
  pageLoadTime: number;
  tti: number;
  apiRequests: PerformanceMetric[];
  indexedDbOps: PerformanceMetric[];
  bottlenecks: string[];
}

// 全局指标收集器
class PerformanceCollector {
  private metrics: Map<string, PerformanceMetric> = new Map();
  private readonly reportInterval = 60_000; // 每分钟报告一次
  /** 定期汇报的定时器句柄；`null` 表示没在跑（见 [init] / [dispose]）。 */
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  
  constructor() {
    this.init();
  }
  
  /**
   * 初始化性能监控。
   *
   * **幂等**：重复调用不会再叠第二个定时器。这一点是必需的 —— 模块在导入时就会
   * 构造单例并调到这里，而 HMR / 重复 import 会再走一遍；原实现每走一遍就多一个
   * `setInterval`，攒下来是一串没人清理的定时器。
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    console.log('[Performance] Initializing performance monitor');
    
    // 1. 导航性能埋点
    this.trackNavigation();
    
    // 2. 资源加载监控
    this.trackResources();
    
    // 3. 定时报告（可选发送到后端）
    this.reportTimer = setInterval(() => this.report(), this.reportInterval);
    // Node 下要 unref：这个定时器只为「定期汇报」存在，不该成为
    // 「进程退不出去」的理由 —— 前端测试跑完必须能正常退出，
    // 否则会出现「用例全绿、`npm test` 却挂住」这种最难查的现象。
    ;(this.reportTimer as unknown as { unref?: () => void }).unref?.();
  }
  
  /**
   * 停止监控并释放定时器（测试与热更新用）。
   */
  dispose(): void {
    if (this.reportTimer !== null) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    // 观察器也要断开：`observe()` 在 Node 里是持有事件循环的句柄，
    // 只清定时器不等于把进程放走。
    this.navigationObserver?.disconnect();
    this.resourceObserver?.disconnect();
    this.navigationObserver = null;
    this.resourceObserver = null;
    this.initialized = false;
  }
  
  /**
   * 追踪页面导航性能
   */
  private navigationObserver: PerformanceObserver | null = null;
  private resourceObserver: PerformanceObserver | null = null;

  private trackNavigation(): void {
    // 没有这个 API 就别埋点：`new PerformanceObserver` 在构造期就抛的话，
    // 会让「导入本模块」这一步失败，而性能埋点不该有这种权力。
    if (typeof PerformanceObserver === 'undefined') return;
    // 使用 Performance Observer API
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'navigation') {
          const perf = entry as PerformanceNavigationTiming;
          
          const metric: PerformanceMetric = {
            name: 'page_load',
            startTime: perf.fetchStart,
            duration: perf.loadEventEnd - perf.fetchStart,
            value: perf.loadEventEnd - perf.fetchStart,
            category: 'navigation',
          };
          
          this.metrics.set('page_load', metric);
          
          // TTI (Time to Interactive) - 首次可交互时间
          if (perf.domInteractive) {
            const tti: PerformanceMetric = {
              name: 'tti',
              startTime: perf.fetchStart,
              value: perf.domInteractive - perf.fetchStart,
              category: 'navigation',
            };
            this.metrics.set('tti', tti);
          }
          
          console.log('[Performance]', metric);
        }
      }
    });
    
    try {
      observer.observe({ entryTypes: ['navigation'] });
      this.navigationObserver = observer;
    } catch (e) {
      console.warn('[Performance] Navigation observation not supported');
    }
  }
  
  /**
   * 追踪资源加载性能
   */
  private trackResources(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        // 关注重要资源（JS、CSS、图片等）
        if (entry.initiatorType === 'script' || 
            entry.initiatorType === 'css' ||
            entry.name.includes('/dist/')) {
          
          const metric: PerformanceMetric = {
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            value: entry.duration,
            category: 'resource',
          };
          
          this.metrics.set(entry.name, metric);
          
          // 检测慢资源 (>500ms)
          if (entry.duration > 500) {
            console.warn(`[Performance Slow Resource] ${entry.name}: ${entry.duration.toFixed(0)}ms`);
          }
        }
      }
    });
    
    try {
      observer.observe({ entryTypes: ['resource'] });
      this.resourceObserver = observer;
    } catch (e) {
      console.warn('[Performance] Resource observation not supported');
    }
  }
  
  /**
   * 封装 API 请求性能监控
   */
  async fetchWithMetrics(url: string, options: RequestInit = {}): Promise<Response> {
    const requestId = `${options.method || 'GET'}:${url}`;
    const start = performance.now();
    
    try {
      const response = await fetch(url, options);
      const duration = performance.now() - start;
      
      const metric: PerformanceMetric = {
        name: url,
        startTime: start,
        endTime: performance.now(),
        duration,
        value: duration,
        category: 'api',
      };
      
      this.metrics.set(requestId, metric);
      
      // 标记慢请求 (>300ms)
      if (duration > 300) {
        console.warn(`[Performance Slow API] ${url}: ${duration.toFixed(0)}ms (${response.status})`);
      }
      
      return response;
    } catch (error) {
      const duration = performance.now() - start;
      
      const errorMetric: PerformanceMetric = {
        name: url,
        startTime: start,
        value: duration,
        category: 'api',
      };
      
      this.metrics.set(requestId, errorMetric);
      throw error;
    }
  }
  
  /**
   * 封装 IndexedDB 操作监控
   */
  async dbTransaction<T>(dbName: string, stores: string[], callback: () => Promise<T>): Promise<T> {
    const start = performance.now();
    
    try {
      const result = await callback();
      const duration = performance.now() - start;
      
      const metric: PerformanceMetric = {
        name: `IndexedDB:${stores.join(',')}`,
        startTime: start,
        duration,
        value: duration,
        category: 'indexeddb',
      };
      
      this.metrics.set(metric.name, metric);
      
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      throw error;
    }
  }
  
  /**
   * 生成性能报告
   */
  report(): PerformanceReport {
    const now = Date.now();
    const metricsArray = Array.from(this.metrics.values());
    
    // 分离各类指标
    const apiRequests = metricsArray.filter(m => m.category === 'api');
    const indexedDbOps = metricsArray.filter(m => m.category === 'indexeddb');
    
    // 识别瓶颈（慢请求/操作）
    const bottlenecks: string[] = [];
    metricsArray.forEach(m => {
      if ('duration' in m && m.duration && m.duration > 500) {
        bottlenecks.push(`${m.name}: ${m.duration.toFixed(0)}ms`);
      }
    });
    
    const pageLoadTime = this.metrics.get('page_load')?.value || 0;
    const tti = this.metrics.get('tti')?.value || 0;
    
    return {
      timestamp: now,
      pageLoadTime,
      tti,
      apiRequests,
      indexedDbOps,
      bottlenecks,
    };
  }
  
  /**
   * 清除所有指标（测试用）
   */
  reset(): void {
    this.metrics.clear();
  }
}

// 导出单例
export const performanceMonitor = new PerformanceCollector();

// 便捷方法。
//
// **必须 bind**：`export const { fetchWithMetrics } = performanceMonitor` 解构出来的是
// 未绑定的函数引用，独立调用时 `this` 是 undefined —— 一进来就
// `Cannot read properties of undefined (reading 'metrics')`。
// 原来就是这种解构写法，只是因为没人单独调过它才一直没暴露。
export const fetchWithMetrics = performanceMonitor.fetchWithMetrics.bind(performanceMonitor);
export const dbTransaction = performanceMonitor.dbTransaction.bind(performanceMonitor);
