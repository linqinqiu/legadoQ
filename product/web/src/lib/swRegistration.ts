/**
 * Service Worker 注册的单例。
 *
 * `PwaManager` 在「加载页」和「主壳」各挂一次（加载完成会换一支），effect 因此会跑两遍。
 * 浏览器按 scope 去重，registration 仍然只有一个，但 `register()` 会被调两次，
 * 也会挂上两份 update/controllerchange 监听。这里缓存 promise，保证整个页面生命周期
 * 只发起一次注册；失败时清空，允许下一次挂载重试。
 *
 * 单独成模块是为了能直接单测「两次调用只打一次底层 register」——PwaManager 本身依赖
 * 浏览器 API，放在组件里测不到这条。
 */
export type SwRegister = (url: string, options?: RegistrationOptions) => Promise<ServiceWorkerRegistration>

let pending: Promise<ServiceWorkerRegistration> | null = null

/**
 * 失败重试的边界（这不是"自动重试"）：
 *
 * - **只清缓存，不原地重试**：catch 里把 pending 置空，但当前调用仍然 reject。
 *   真正的重试发生在下一次调用 —— PwaManager 下次挂载、或用户下次打开页面。
 *   注册失败通常是"浏览器不支持 / scope 非法 / 被策略禁用"，立刻重试没有意义。
 * - **同一次失败期间共享同一个 rejected promise**：并发调用不会各自去打 register，
 *   避免失败时反而打出一串请求；它们一起 reject，之后缓存才清空。
 * - **成功则永久复用**：加载页 → 主壳换挂不会重复注册。
 */
export function registerServiceWorkerOnce(register: SwRegister): Promise<ServiceWorkerRegistration> {
  if (!pending) {
    pending = register('/sw.js', { scope: '/' }).catch(error => {
      // 清缓存让下一次调用能重试；本次仍把错误抛给调用方，不吞。
      pending = null
      throw error
    })
  }
  return pending
}

/** 测试用：清掉缓存的 promise。生产代码不调用。 */
export function resetServiceWorkerRegistration(): void {
  pending = null
}
