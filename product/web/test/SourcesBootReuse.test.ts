/**
 * 启动时那份书源清单（5,598 条、~1MB）只该取一次。
 *
 * 背景：启动探活一过，main.tsx 就为书库选源/书架取整份清单；如果落点正好是「书源」页，
 * SourcesPage 挂载后又会为同一份数据再取一遍 —— 一次开机两趟 1MB，手机上就是"功能加载慢"。
 * 现在：①宿主把已到手的清单交给书源页，首屏不再重复请求；②仍在路上的请求彼此合流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api } from '../src/lib/api.ts'

const here = import.meta.dirname
const read = (...parts: string[]) => fs.readFileSync(path.resolve(here, '..', ...parts), 'utf8')

test('书源页首屏：宿主把启动时取好的清单交给书源页，挂载后不再为同一份数据跑第二趟', () => {
  const pages = read('src', 'app', 'pages.tsx')
  const mount = /<SourcesPage[\s\S]*?\/>/.exec(pages)?.[0] ?? ''
  assert.match(mount, /sources=\{ctx\.sources\}/, 'pages.tsx 没把宿主已有的书源清单传给 SourcesPage')

  const page = read('src', 'pages', 'SourcesPage.tsx')
  const start = page.indexOf('export function SourcesPage')
  const signature = page.slice(start, start + 700)
  assert.match(signature, /\(\{[\s\S]*?sources:\s*hostedSources/, 'SourcesPage 没接收宿主给的初始清单')
  assert.match(page, /useState<SourceSummary\[\]>\(hostedSources \?\? \[\]\)/, '书源页没有用宿主清单做初始状态')
  assert.match(page, /skipFirstLoad/, '书源页缺少“首屏不重复请求”的跳过逻辑')
  assert.match(
    page,
    /hostedSources && hostedSources\.length > 0 \? 'ready' : 'loading'/,
    '带初始清单进场时清单状态应当是 ready，否则体检弹窗会说“0 个书源”',
  )
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
