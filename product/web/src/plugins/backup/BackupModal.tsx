import React from 'react'
import { BackupPage } from '../../pages/BackupPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「备份与恢复」浮层。
 *
 * 浮层标题是「备份包」不是「备份与恢复」—— 用户 2026-09-30 的原话：
 * 「手机恢复这个名词解释有些难听，咱们这是电脑啊」，主语是包，不是手机也不是动作。
 * 判据 `source-editor-check` 盯着这个标题。
 */
export function BackupModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="备份包" onClose={onClose}>
      <BackupPage />
    </PageDialog>
  )
}
