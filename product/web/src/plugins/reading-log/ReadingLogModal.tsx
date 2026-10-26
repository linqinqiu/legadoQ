import React from 'react'
import { ReadingLogPage } from '../../pages/ReadingLogPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「阅读记录」浮层：按天统计的阅读时长。
 */
export function ReadingLogModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="阅读记录" onClose={onClose}>
      <ReadingLogPage />
    </PageDialog>
  )
}
