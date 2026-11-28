import test from 'node:test'
import assert from 'node:assert/strict'
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderPage, type PageContext } from '../src/app/pages'
import { RssPage } from '../src/features/rss/RssPage'
import { SourceSubscriptionPanel } from '../src/features/rss/SourceSubscriptionPanel'
import { defaultReaderSettings } from '../src/features/reader/settingsPanel/readerSettings'
import { createSourceCatalog } from '../src/lib/sourceCatalog'
import type { SourceSummary } from '../src/lib/api/types'

type PanelElement = ReactElement<ComponentProps<typeof SourceSubscriptionPanel>>

function findPanel(node: ReactNode): PanelElement | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined
  if (node.type === SourceSubscriptionPanel) return node as PanelElement
  for (const child of Children.toArray(node.props.children)) {
    const panel = findPanel(child)
    if (panel) return panel
  }
  return undefined
}

function subscriptionPage(refreshSources: () => void) {
  const context: PageContext = {
    sources: [],
    selected: null,
    settings: defaultReaderSettings,
    settingsSections: [],
    tocRulesSignal: 0,
    refreshSources,
    onSelectSource: () => undefined,
    openBook: () => undefined,
    openShelfItem: () => undefined,
    openExploreDetail: async () => undefined,
    onSettingsChange: () => undefined,
    openModal: () => undefined,
    openPageDialog: () => undefined,
    openTocRules: () => undefined,
  }
  const page = renderPage('subscriptions', context)
  assert.ok(isValidElement<ComponentProps<typeof RssPage>>(page))
  const panel = findPanel(RssPage(page.props))
  assert.ok(panel, '订阅路由应渲染书源订阅面板')
  return panel
}

function source(id: string): SourceSummary {
  return {
    id, name: id, url: `https://example.com/${id}`, enabled: true,
    isJsSource: false, hasLogin: false, updatedAt: 1, version: 1,
  }
}

test('订阅成功通知穿过路由与页面，刷新已就绪的共享书源清单', async () => {
  let serverItems = [source('old')]
  let requests = 0
  const catalog = createSourceCatalog(async () => {
    requests += 1
    return [...serverItems]
  })
  await catalog.load()
  const published: string[][] = []
  const unsubscribe = catalog.subscribe(() => {
    if (catalog.getSnapshot().status === 'ready') {
      published.push(catalog.getSnapshot().items.map(item => item.id))
    }
  })
  try {
    const panel = subscriptionPage(() => { void catalog.invalidate() })
    serverItems = [...serverItems, source('new')]
    panel.props.onSourcesChange()
    await catalog.load()

    assert.equal(requests, 2, '同步后必须重新请求，不能复用已就绪的旧快照')
    assert.deepEqual(catalog.getSnapshot().items.map(item => item.id), ['old', 'new'])
    assert.deepEqual(published, [['old', 'new']], '书源与搜索范围的订阅者应收到新清单')
  } finally {
    unsubscribe()
  }
})

test('订阅后清单刷新失败保留旧数据，重新进入书源页可重试', async () => {
  let requests = 0
  const catalog = createSourceCatalog(async () => {
    requests += 1
    if (requests === 2) throw new Error('清单请求失败')
    return requests === 1 ? [source('old')] : [source('old'), source('new')]
  })
  await catalog.load()
  const panel = subscriptionPage(() => { void catalog.invalidate().catch(() => undefined) })
  panel.props.onSourcesChange()
  await assert.rejects(catalog.load(), /清单请求失败/)
  assert.equal(catalog.getSnapshot().status, 'failed')
  assert.deepEqual(catalog.getSnapshot().items.map(item => item.id), ['old'])

  assert.deepEqual((await catalog.load()).map(item => item.id), ['old', 'new'])
  assert.equal(requests, 3)
  assert.equal(catalog.getSnapshot().status, 'ready')
})
