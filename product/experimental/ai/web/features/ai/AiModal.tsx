import React from 'react'
import { AiChatModal } from './AiChatModal'
import type { UiContext } from '../../lib/uiContext'

/**
 * 「AI 对话助手」浮层。
 *
 * 这一档以前叫「AI 接入」，里面堆着六块（连接、工具、技能、提示词、书源校验、对话），
 * 打开就是一屏滚不到底。现在按能力各自一档，都挂在设置「服务与接入」下：这里只剩**用**。
 *
 * 外壳由 `AiChatModal` → `AiPanel` 自带（遮罩 + 一档 dialog-shell + 一颗关闭键 + Esc），
 * 不再多包一层弹窗 —— 弹窗套弹窗就是两层遮罩、两颗关闭键。
 *
 * **识别界面内容**：`uiContext` 随对话一起发给模型 —— 问"这本书讲了什么"时它才知道
 * "这本书"是哪本。没有模型连接时，`onOpenConnections` 给一颗直接去登记的按钮。
 */
export function AiModal({
  onClose,
  uiContext,
  onOpenConnections,
}: {
  onClose: () => void
  uiContext?: UiContext
  onOpenConnections?: () => void
}) {
  return <AiChatModal onClose={onClose} uiContext={uiContext} onOpenConnections={onOpenConnections} />
}
