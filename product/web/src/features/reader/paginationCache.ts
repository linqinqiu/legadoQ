/**
 * 分页结果 IndexedDB 缓存
 *
 * 配合无 DOM 布局引擎，把"同一本书、同一章、同一正文、同一套排版参数"算出来的分页结果
 * （LayoutResult）存进 IndexedDB，避免改字号 / 旋转屏幕等场景下的重复分页计算，
 * 并支撑改字号时的阅读位置保持（命中缓存即可直接还原 startOffsets）。
 *
 * 为什么不复用 offlineStorage.ts：它只暴露章节离线缓存这一条业务链路（chapters store 的
 * 增删查 + 几张统计索引），openDb 与事务都是私有实现，没有"任意 store 名 + 通用 get/put/
 * delete/count/getAll"的出口。要往它的库里塞 pagination_cache 就必须改 offlineStorage.ts
 * 的升级逻辑（升版本、加 onupgradeneeded 分支），而本次任务要求只新增两个文件、不动其它文件。
 * 故这里新建一个同风格的轻量封装：独立数据库 legado-reader、store 名 pagination_cache、
 * keyPath 用 key 字符串，避免与离线库耦合也避免两套离线段落。
 *
 * 所有对外函数都是 async 且各自 try/catch：IndexedDB 在某些 Node / 无头环境下不可用，
 * 此时 getPagination 静默返回 null，putPagination / evictIfNeeded 静默 no-op，
 * 绝不抛错影响阅读器主流程。
 *
 * 排版参数与布局结果类型来自并行的 typeset agent，按其契约导入，不在此重复定义：
 *   TypesetParams / LayoutResult / serializePaginationKey / hashContent
 */

import type { TypesetParams, LayoutResult } from './typeset/typesetParams'
import { serializePaginationKey } from './typeset/typesetParams'

const DB_NAME = 'legado-reader'
const DB_VERSION = 1
const STORE = 'pagination_cache'

/** 一条缓存记录：key 之外存结果与被写入时间戳（淘汰按 cachedAt 升序）。 */
interface PaginationRecord {
  key: string
  result: LayoutResult
  cachedAt: number
}

/** 模块级单连接，与 offlineStorage 的 dbPromise 同款缓存策略。 */
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Node / 无头环境没有 indexedDB：直接 reject，交给上层 try/catch 静默降级。
      reject(new Error('IndexedDB 在当前环境不可用'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // 只在不存在时建 store：升级路径不碰既有数据，避免把别的版本的记录误删或重键。
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    request.onblocked = () => {
      // 被其它标签页的旧连接挡住升级：显式 reject，而不是让 Promise 永远挂起。
      if (dbPromise === promise) dbPromise = null
      reject(new Error('IndexedDB 升级被其它连接占用，请关闭旧标签页后重试'))
    }
    request.onsuccess = () => {
      const db = request.result
      // 别的标签触发升级或浏览器回收连接时，本连接会失效：关掉并清空缓存，
      // 下次 openDb 重开新连接，避免后续事务对着 stale 连接抛 InvalidStateError。
      db.onversionchange = () => { db.close(); if (dbPromise === promise) dbPromise = null }
      db.onclose = () => { if (dbPromise === promise) dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { if (dbPromise === promise) dbPromise = null; reject(request.error) }
  })
  dbPromise = promise
  return dbPromise
}

/**
 * 命中缓存返回 LayoutResult，未命中返回 null。
 * 任何 IDB 异常（不可用 / 事务失败 / 解析失败）都静默降级为 null。
 */
export async function getPagination(
  bookId: string,
  chapterUrl: string,
  contentHash: string,
  params: TypesetParams,
): Promise<LayoutResult | null> {
  const key = serializePaginationKey(bookId, chapterUrl, contentHash, params)
  try {
    const db = await openDb()
    return await new Promise<LayoutResult | null>((resolve) => {
      try {
        const store = db.transaction(STORE, 'readonly').objectStore(STORE)
        const req = store.get(key)
        req.onsuccess = () => {
          const rec = req.result as PaginationRecord | undefined
          resolve(rec ? rec.result : null)
        }
        // 读失败也当未命中，绝不向外抛。
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

/**
 * 写入一条分页结果（含 cachedAt），写完后顺带跑一次淘汰。
 * 写失败 / 淘汰失败 / IDB 不可用都静默 no-op，不影响阅读器。
 */
export async function putPagination(
  bookId: string,
  chapterUrl: string,
  contentHash: string,
  params: TypesetParams,
  result: LayoutResult,
): Promise<void> {
  const key = serializePaginationKey(bookId, chapterUrl, contentHash, params)
  try {
    const db = await openDb()
    const record: PaginationRecord = { key, result, cachedAt: Date.now() }
    await new Promise<void>((resolve) => {
      try {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
        const req = store.put(record)
        req.onsuccess = () => resolve()
        req.onerror = () => resolve() // 写不进也别抛
      } catch {
        resolve()
      }
    })
    // 写入后再淘汰；evictIfNeeded 自身已吞掉所有异常。
    await evictIfNeeded()
  } catch {
    // 静默 no-op
  }
}

/**
 * 按数量上限淘汰：用 count 判断是否超出 maxEntries，超出则把最旧（cachedAt 升序）的若干条删掉。
 * 默认上限 200 条。所有异常静默 no-op。
 */
export async function evictIfNeeded(maxEntries = 200): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      try {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
        const countReq = store.count()
        countReq.onsuccess = () => {
          const total = countReq.result
          if (total <= maxEntries) { resolve(); return }
          const overflow = total - maxEntries
          const allReq = store.getAll()
          allReq.onsuccess = () => {
            const records = (allReq.result as PaginationRecord[])
              .sort((a, b) => a.cachedAt - b.cachedAt)
              .slice(0, overflow)
            if (records.length === 0) { resolve(); return }
            // 在同一条事务里接着删：count -> getAll -> delete 全部同步串在回调里，
            // 事务在还有挂起请求时不会提前提交，删完即提交。
            let pending = records.length
            for (const rec of records) {
              const del = store.delete(rec.key)
              del.onsuccess = () => { if (--pending === 0) resolve() }
              del.onerror = () => { if (--pending === 0) resolve() }
            }
          }
          allReq.onerror = () => resolve()
        }
        countReq.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  } catch {
    // 静默 no-op
  }
}
