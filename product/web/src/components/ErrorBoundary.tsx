import React, { Component } from 'react'
import type { ErrorInfo } from 'react'

/**
 * 渲染期崩掉的兜底。
 *
 * 为什么要有：全站原来一处错误边界都没有。任何一个组件在渲染期抛错（正文结构异常、
 * 分栏算术越界、localStorage 在隐私模式抛 SecurityError…），React 会把**整棵树**卸载 ——
 * 用户看到的是白屏，连「返回书架」的按钮都没了，而他那本书的进度其实好好地存在服务器上。
 * 0.6.23 那轮就记过 `saveReaderSettings` 在隐私模式"炸整棵树"的同形状事故。
 *
 * 两处用法（`main.tsx`）：阅读器那一支单独包一层（崩了只丢正文，外壳/书架/进度都不受影响），
 * 根挂载再包一层当最后兜底。
 */

type Props = {
  /** 出现在界面与人话里的那块区域名，例："阅读器" */
  region: string
  /** 「返回书架」这一类的出口；不传就不画那颗按钮 */
  onExit?: () => void
  children: React.ReactNode
}

type State = { message: string | null }

/** 把各种各样的 throw 值收成一句能给人看的话。 */
export function boundarySummary(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  // 不是 Error 也不是字符串：`throw undefined`、`throw 0`、被裁剪过的构建里都出现过
  return '界面在这里抛了一个没有信息的错误'
}

export function BoundaryFallback({ region, message, onRetry, onExit }: {
  region: string
  message: string
  onRetry: () => void
  onExit?: () => void
}) {
  return (
    <div className="error-boundary" role="alert">
      <h2>{region}崩了</h2>
      <p>这一块没能画出来。你的书架、阅读进度与缓存都没有被这次错误改动 —— 换个入口进来或重试都还在。</p>
      <p className="error-boundary-detail">{message}</p>
      <div className="error-boundary-actions">
        <button type="button" className="primary-button" onClick={onRetry}>重试这一块</button>
        {onExit && <button type="button" className="secondary-button" onClick={onExit}>返回书架</button>}
      </div>
      <p className="error-boundary-hint">细节已经打进浏览器控制台（F12 → Console），提 issue 时带上那一行更有用。</p>
    </div>
  )
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: boundarySummary(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 界面只给一句人话，完整堆栈留在这儿：没有这条，用户报"点了没反应"时我们什么都没有
    console.error(`[青阅] ${this.props.region}渲染失败`, error, info.componentStack)
  }

  private retry = () => { this.setState({ message: null }) }

  render() {
    if (this.state.message === null) return this.props.children
    return (
      <BoundaryFallback
        region={this.props.region}
        message={this.state.message}
        onRetry={this.retry}
        onExit={this.props.onExit}
      />
    )
  }
}
