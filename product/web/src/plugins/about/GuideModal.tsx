import React from 'react'
import { FeatureGuide } from '../../pages/FeatureGuide'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「功能说明」浮层：从「关于」进，与更新日志、快捷键同一层级。
 *
 * 正文只有 `docs/功能说明.md` 一份，由 FeatureGuide 拆节渲染 —— 这里只负责外壳。
 */
export function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="功能说明" onClose={onClose}>
      <FeatureGuide />
    </PageDialog>
  )
}
