/**
 * 启动时那份书源清单（5,598 条、~1MB）只该取一次。
 *
 * 宿主与书源页都订阅同一个 SourceCatalog：启动请求、书源页挂载和后续刷新共用一份
 * 在途请求与缓存，页面不再持有第二份全量清单，也不能把筛选结果回写成全量数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api } from '../src/lib/api.ts'

const here = import.meta.dirname
const read = (...parts: string[]) => fs.readFileSync(path.resolve(here, '..', ...parts), 'utf8')

test('书源页与换源弹窗订阅统一 catalog，宿主不再传第二份清单', () => {
  const pages = read('src', 'app', 'pages.tsx')
  const mount = /<SourcesPage[\s\S]*?\/>/.exec(pages)?.[0] ?? ''
  assert.doesNotMatch(mount, /sources=|onSourcesChange=/, '宿主不应再把书源清单或写回回调传给书源页')

  const page = read('src', 'features', 'source-editor', 'SourcesPage.tsx')
  assert.match(
    page,
    /useSyncExternalStore\(\s*sourceCatalog\.subscribe,\s*sourceCatalog\.getSnapshot,\s*sourceCatalog\.getSnapshot,?\s*\)/,
    '书源页应直接订阅 SourceCatalog',
  )
  assert.doesNotMatch(page, /hostedSources|skipFirstLoad|api\.sources\(|onSourcesChange\(values\)/, '书源页不应保留第二份清单、旧 props 链或按关键词另拉全量数据')

  const switchModal = read('src', 'components', 'SourceSwitchModal.tsx')
  assert.match(
    switchModal,
    /useSyncExternalStore\(\s*sourceCatalog\.subscribe,\s*sourceCatalog\.getSnapshot,\s*sourceCatalog\.getSnapshot,?\s*\)/,
    '换源弹窗也应直接订阅 SourceCatalog',
  )
  assert.doesNotMatch(switchModal, /api\.sources\(|ownSources/, '换源弹窗不应再维护自己的书源清单')
})

test('api.sources 并发请求合流：落地前共用一次，落地后再取会重新发', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const pending: Array<() => void> = []
  const flush = () => { for (const resolve of pending.splice(0)) resolve() }
  globalThis.fetch = async (): Promise<Response> => {
    calls += 1
    await new Promise<void>(resolve => { pending.push(resolve) })
    return new Response(JSON.stringify([{ id: 'a', name: 'A', url: 'a', enabled: true }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const first = api.sources()
    const second = api.sources()
    assert.equal(calls, 1, '同一时刻发起的第二份整表请求应当并到第一份上')
    flush()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a, b, '合流后两个调用方应拿到同一份结果')

    // 落地之后（增删改触发的刷新）必须重新向服务端要，不能读到旧快照
    const third = api.sources()
    assert.equal(calls, 2, '上一次已落地，新的刷新应当重新发请求')
    flush()
    await third

    // 带关键词的搜索是另一份结果，不参与合流
    const q1 = api.sources('凡人')
    const q2 = api.sources('修仙')
    assert.equal(calls, 4, '两次不同关键词的搜索应当各发一次，不能彼此合流')
    flush()
    await Promise.all([q1, q2])
  } finally {
    globalThis.fetch = originalFetch
  }
})
