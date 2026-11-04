/**
 * <ExtensionSlot>：UI 中的 Slot 占位组件。
 *
 * 用法：
 *   <ExtensionSlot name="reader.sidebar" />
 *
 * 它订阅 `useAttachmentStore` 中对应 Slot 的 attachment 列表，
 * 渲染已挂载的 Extension 组件。页面代码不需要知道谁挂了什么，
 * 实现“运行时注册，无需重新编译”。
 */

import React, { Suspense, useCallback } from 'react'
import { useAttachmentStore } from './attachmentStore'
import { getExtension } from './extensionRegistry'

export interface ExtensionSlotProps {
  name: string
  /** 透传给 Extension 组件的 props（可选）。 */
  props?: Record<string, unknown>
  /** 没有 Extension 挂载时的 fallback 内容。 */
  fallback?: React.ReactNode
}

export function ExtensionSlot({ name, props, fallback }: ExtensionSlotProps) {
  const { attachmentsForSlot } = useAttachmentStore()
  const attachments = attachmentsForSlot(name)

  const renderExtension = useCallback(
    (extId: string) => {
      const reg = getExtension(extId)
      if (!reg) return null
      const Component = reg.component
      return <Component key={extId} {...(props ?? {})} />
    },
    [props],
  )

  if (attachments.length === 0) {
    return <>{fallback}</>
  }

  return (
    <div className="extension-slot" data-slot={name}>
      {attachments.map((a) => (
        <Suspense key={a.extensionId} fallback={null}>
          {renderExtension(a.extensionId)}
        </Suspense>
      ))}
    </div>
  )
}
