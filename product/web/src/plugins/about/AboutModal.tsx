import React from 'react'
import { AboutPage } from '../../pages/AboutPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「关于」浮层：版本、许可、免责声明，以及去更新日志、快捷键与功能说明的入口。
 */
export function AboutModal({
  onClose,
  onOpenChangelog,
  onOpenShortcuts,
  onOpenGuide,
}: {
  onClose: () => void
  onOpenChangelog: () => void
  onOpenShortcuts: () => void
  onOpenGuide: () => void
}) {
  return (
    <PageDialog title="关于" onClose={onClose}>
      <AboutPage
        onOpenChangelog={onOpenChangelog}
        onOpenShortcuts={onOpenShortcuts}
        onOpenGuide={onOpenGuide}
      />
    </PageDialog>
  )
}
