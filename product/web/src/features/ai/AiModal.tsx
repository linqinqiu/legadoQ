import React from 'react'
import { AiConnectionsModal } from './AiConnectionsModal'
import type { UiContext } from '../../lib/uiContext'

/**
 * 「AI 接入」浮层 —— **独立一类**，既不是实验室、也不是插件。
 *
 * 三类的边界（用户口径）：
 * - **实验室**：准备在基础框架上加入的、**待定**的功能；
 * - **插件**：用户自定义的扩展，可装可卸；
 * - **AI 接入**：单独一类 —— 已定型、是产品决定要有的，不是实验室里的待定项。
 *
 * 所以它有自己的浮层，不占实验室的条目位。
 *
 * 直接用 `AiConnectionsModal` 的非 embedded 形态：它自带 overlay + dialog-shell + 关闭键，
 * 再包一层 PageDialog 就是"弹窗套弹窗"（两层遮罩、两颗关闭键，UiContract 判据会红）。
 *
 * **识别界面内容**：`uiContext` 会传给面板，随对话一起发给模型 ——
 * 问"这本书讲了什么"时模型才知道"这本书"是哪本。
 */
export function AiModal({
  onClose,
  uiContext,
}: {
  onClose: () => void
  uiContext?: UiContext
}) {
  return <AiConnectionsModal onClose={onClose} uiContext={uiContext} />
}
