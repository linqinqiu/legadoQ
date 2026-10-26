/// <reference lib="webworker" />
/**
 * 布局 Worker 入口（标准 Web Worker）。
 *
 * 主线程用 `new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' })`
 * 加载，因此这里只管监听消息、调用纯函数 layout 并把结果 postMessage 回去，
 * 不需要（也不能）碰 DOM。保持为纯 TS，Vite 会按 worker 方式编译。
 */

import { layout } from './layoutEngine'
import type { TypesetParams } from './typesetParams'

export type LayoutRequest = {
  type: 'layout'
  id: number
  bookId: string
  chapterUrl: string
  text: string
  params: TypesetParams
  contentHash: string
}

export type LayoutResponse = {
  type: 'layoutResult'
  id: number
  result: ReturnType<typeof layout>
}

self.onmessage = (event: MessageEvent<LayoutRequest>): void => {
  const data = event.data
  if (!data || data.type !== 'layout') return
  const result = layout(data.text, data.params)
  const response: LayoutResponse = { type: 'layoutResult', id: data.id, result }
  self.postMessage(response)
}
