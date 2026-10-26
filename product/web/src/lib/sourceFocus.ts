// 「在书源页中定位」的握手变量（0.8.2 结构重排从 main.tsx 挪出）。
//
// SourcesPage 是按页签条件挂载的（page === 'sources' 才存在），所以从别的页面跳过去时，
// 它一定是一次新挂载 —— 用模块变量把目标带过去，比把 query 状态提升到 App 再传回来简单，
// 也不会为此给三层组件各加一个 prop。消费后立即清空，避免下次进书源页还带着旧目标。
// 跨文件写回只能走 take/set（ESM 的导入绑定是只读的），所以这里给访问器而不是裸变量。
let pendingSourceFocus: string | null = null

/** 换源候选右键「在书源页中定位」按下时调用。 */
export function setPendingSourceFocus(name: string): void {
  pendingSourceFocus = name
}

/** SourcesPage 挂载时取走目标并清空（没设置过就返回 null）。 */
export function takePendingSourceFocus(): string | null {
  const value = pendingSourceFocus
  pendingSourceFocus = null
  return value
}
