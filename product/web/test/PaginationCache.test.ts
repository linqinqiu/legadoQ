/**
 * PaginationCache 判据
 *
 * 两条分支：
 *  1) 若运行环境里 `indexedDB` 可用（例如以后在 web/package.json 加了 fake-indexeddb
 *     并在顶部 `import 'fake-indexeddb/auto'`），就跑真实 IndexedDB 的 get/put 命中、
 *     不同 params 因 key 不同而隔离、evictIfNeeded 淘汰最旧。
 *  2) 否则（当前仓库未引入 fake-indexeddb，也不新增依赖）只测不依赖真实 IDB 的部分：
 *     serializePaginationKey 对参数敏感、hashContent 对同一文本稳定且对改动敏感，
 *     以及 getPagination / putPagination / evictIfNeeded 在 DB 不可用时安全返回 null / no-op（不抛）。
 *
 * 顶部的检测分支让这份判据在"将来补上 fake-indexeddb"时能自动升级到真 IDB 路径，
 * 而当前不会因 import 一个没装的包而整份崩掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializePaginationKey,
  hashContent,
  type TypesetParams,
} from '../src/reader/typeset/typesetParams'
import {
  getPagination,
  putPagination,
  evictIfNeeded,
} from '../src/reader/paginationCache'

/** 构造一份默认的排版参数，便于在用例间微调单个字段做隔离测试。 */
function baseParams(overrides: Partial<TypesetParams> = {}): TypesetParams {
  return {
    fontFamily: 'serif',
    fontSize: 18,
    lineHeight: 1.6,
    paragraphSpacing: 8,
    marginX: 24,
    marginTop: 32,
    marginBottom: 32,
    viewportWidth: 800,
    viewportHeight: 1200,
    columnMode: 'single',
    imagePlaceholderRatio: 0.3,
    ...overrides,
  }
}

const sampleResult = { startOffsets: [0, 120, 240], columnCount: 1, lineCount: 30 }

// ---- 不依赖真实 IndexedDB 的契约性断言（两条分支都跑） ----

test('serializePaginationKey 对排版参数敏感：不同字体生成不同 key', () => {
  const a = serializePaginationKey('book1', 'ch://1', 'h', baseParams({ fontFamily: 'serif' }))
  const b = serializePaginationKey('book1', 'ch://1', 'h', baseParams({ fontFamily: 'sans' }))
  assert.notEqual(a, b)
})

test('serializePaginationKey 对 chapterUrl / contentHash 敏感', () => {
  const a = serializePaginationKey('book1', 'ch://1', 'h1', baseParams())
  const b = serializePaginationKey('book1', 'ch://2', 'h1', baseParams())
  const c = serializePaginationKey('book1', 'ch://1', 'h2', baseParams())
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test('serializePaginationKey 同一入参稳定：多次调用结果一致', () => {
  const p = baseParams()
  const a = serializePaginationKey('book1', 'ch://1', 'h', p)
  const b = serializePaginationKey('book1', 'ch://1', 'h', p)
  assert.equal(a, b)
})

test('hashContent 对同一文本稳定，对改动敏感', () => {
  const t = '第一章 终南捷径'
  assert.equal(hashContent(t), hashContent(t))
  assert.equal(hashContent(t), hashContent(t + '')) // 等价字符串
  assert.notEqual(hashContent(t), hashContent(t + '。'))
})

// ---- 分支选择：真实 IDB 可用则跑真链路，否则跑 DB 不可用安全断言 ----

const idbAvailable = typeof indexedDB !== 'undefined'

if (idbAvailable) {
  test('get/put 命中：写入后能原样取回 result', async () => {
    await putPagination('book1', 'ch://1', 'h', baseParams(), sampleResult)
    const got = await getPagination('book1', 'ch://1', 'h', baseParams())
    assert.deepEqual(got, sampleResult)
  })

  test('不同 params 因 key 不同而相互隔离', async () => {
    await putPagination('book1', 'ch://1', 'h', baseParams({ fontSize: 18 }), sampleResult)
    const other = await getPagination('book1', 'ch://1', 'h', baseParams({ fontSize: 22 }))
    assert.equal(other, null) // 字号不同 = 不同 key，不命中
  })

  test('evictIfNeeded 按 cachedAt 升序淘汰最旧', async () => {
    // 上限 2，先塞 3 条（cachedAt 由 Date.now() 自然递增，最后写的更新）。
    const p = baseParams()
    await putPagination('b', 'c1', 'h', p, sampleResult)
    await putPagination('b', 'c2', 'h', p, sampleResult)
    await putPagination('b', 'c3', 'h', p, sampleResult)
    // c1 最旧应被淘汰；c3 最新应保留。
    assert.equal(await getPagination('b', 'c1', 'h', p), null)
    assert.notEqual(await getPagination('b', 'c3', 'h', p), null)
  })
} else {
  test('DB 不可用时 getPagination 静默返回 null（不抛）', async () => {
    await assert.doesNotReject(async () => {
      const got = await getPagination('book1', 'ch://1', 'h', baseParams())
      assert.equal(got, null)
    })
  })

  test('DB 不可用时 putPagination / evictIfNeeded 静默 no-op（不抛）', async () => {
    await assert.doesNotReject(async () => {
      await putPagination('book1', 'ch://1', 'h', baseParams(), sampleResult)
      await evictIfNeeded(200)
    })
  })
}
