import React from 'react'
import { AiPanel } from './AiPanel'
import { AiToolsSection } from './AiToolsSection'

/**
 * 「AI 工具」浮层：勾选模型能调用哪一组能力。
 *
 * 开关本身住在 `settings/AiToolsSection.tsx`（悬浮球那一侧也读同一份偏好），这里只是
 * 给它一档独立入口 —— 从前它埋在「AI 接入」那一大屏中间，想关掉一组能力得先滚过
 * 连接表单、提示词和技能列表。
 */
export function AiToolsModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="AI 工具" icon="list" onClose={onClose}>
      <section className="ai-section">
        <h3>AI 工具</h3>
        <p className="ai-section-hint">
          关掉某一组，模型就看不到那一组能力；组里还可以逐条停用。
        </p>
        <AiToolsSection />
      </section>
    </AiPanel>
  )
}
