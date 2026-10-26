import React from 'react'
import { ChangelogPage } from '../../pages/ChangelogPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「更新日志」独立浮层。
 *
 * 从顶栏版本号、深链 `#changelog` 直达。
 * 版本号从 `/healthz` 拿，自己不写死（判据 `HeaderMenu.test.ts` 守着）。
 */
export function ChangelogModal({
  onClose,
  serverVersion,
}: {
  onClose: () => void
  serverVersion?: string
}) {
  return (
    <PageDialog title="更新日志" onClose={onClose}>
      <ChangelogPage serverVersion={serverVersion ?? ''} />
    </PageDialog>
  )
}
