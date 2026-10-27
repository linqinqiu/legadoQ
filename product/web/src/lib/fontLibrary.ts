/**
 * 本地字体库（IndexedDB）。
 *
 * 阅读设置里的 `customFont` 只存一个字体族名；字体本身（本地文件二进制或字体直链）存在这里。
 * 刷新后由 `loadAllFonts()` 把库里每条字体重新注册进 `document.fonts`，CSS 的
 * `font-family: <族名>` 才能继续命中 —— 这就是"导入的字体刷新后仍然可用"的全部机制。
 *
 * 为什么不用 localStorage：字体动辄几 MB，localStorage 只存字符串且总配额约 5MB。
 * 为什么 key 用族名：设置里存的就是族名，注册、列表、删除都按这一个标识走。
 *
 * 所有对外函数都不向界面抛"库不可用"这类错误：无 IndexedDB 时列表返回空、启动注册静默跳过，
 * 只有"这条字体真的用不了"（坏文件 / 直链失效 / 跨域）才由 `saveFont` 抛出，让界面提示用户。
 */

const DB_NAME = 'legado-fonts'
const DB_VERSION = 1
const STORE = 'fonts'

/** 一条字体记录：`data` 与 `url` 二选一，`name` 是族名兼主键。 */
export interface FontRecord {
  /** 字体族名，同时是主键；设置里的 customFont 存的就是它。 */
  name: string
  /** 本地文件导入的二进制。 */
  data?: ArrayBuffer
  /** 地址导入的字体直链。 */
  url?: string
  /** 导入时间戳（列表按它倒序）。 */
  addedAt: number
}

/** 列表用的元信息：不带二进制本体，界面只需要名字、来源和大小。 */
export interface FontInfo {
  name: string
  url?: string
  /** 二进制字体的字节数；地址导入的为 0。 */
  bytes: number
  addedAt: number
}

/** 已注册进 `document.fonts` 的 FontFace：删除/重导时要能把旧的摘掉。 */
const registered = new Map<string, FontFace>()

/** 模块级单连接，与 paginationCache / offlineStorage 同款缓存策略。 */
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Node / 无头环境没有 indexedDB：直接 reject，交给上层降级。
      reject(new Error('当前环境没有 IndexedDB，字体只能本次会话生效'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // 只在不存在时建 store：升级路径不碰既有数据。
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' })
      }
    }
    request.onblocked = () => {
      if (dbPromise === promise) dbPromise = null
      reject(new Error('字体库升级被其它标签页占用，请关闭旧标签页后重试'))
    }
    request.onsuccess = () => {
      const db = request.result
      // 别的标签升级 / 浏览器回收连接时清空缓存，下次重开新连接。
      db.onversionchange = () => { db.close(); if (dbPromise === promise) dbPromise = null }
      db.onclose = () => { if (dbPromise === promise) dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { if (dbPromise === promise) dbPromise = null; reject(request.error) }
  })
  dbPromise = promise
  return dbPromise
}

/** 读出全部字体记录（含二进制，调用方按需取字段）。 */
async function readAll(): Promise<FontRecord[]> {
  const db = await openDb()
  return new Promise<FontRecord[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result as FontRecord[])
    request.onerror = () => reject(request.error)
  })
}

/** 写入一条记录（同族名覆盖）。 */
async function putRecord(record: FontRecord): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/** 按族名删除一条记录。 */
async function deleteRecord(name: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function infoOf(record: FontRecord): FontInfo {
  return { name: record.name, url: record.url, bytes: record.data?.byteLength ?? 0, addedAt: record.addedAt }
}

/**
 * 把一条记录注册进 `document.fonts`。
 *
 * 二进制走 `new FontFace(name, arrayBuffer)`，地址走 `new FontFace(name, 'url(...)')`；
 * 两者都要 `await face.load()` 确认真的能解析/下载，失败就抛错（坏文件、直链 404、跨域都会被这一句抓住）。
 *
 * @param record 要注册的字体记录
 * @returns 注册完成的 FontFace
 */
export async function registerFont(record: FontRecord): Promise<FontFace> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('当前环境不支持 FontFace，字体无法注册')
  }
  // 同族名重复注册会让 document.fonts 里堆多份，先摘掉上一次那一份。
  const previous = registered.get(record.name)
  if (previous) {
    document.fonts.delete(previous)
    registered.delete(record.name)
  }
  const source: string | BufferSource = record.data ?? `url(${record.url ?? ''})`
  const face = new FontFace(record.name, source)
  await face.load()
  document.fonts.add(face)
  registered.set(record.name, face)
  return face
}

/**
 * 保存一条字体并立即注册。
 *
 * 先落库再注册：注册失败时把刚写的那条删掉，列表里不留一条"存了但用不了"的字体。
 *
 * 地址来源也把文件取回来存字节，而不是留一条 `url(...)`：直链常被跨域挡住，
 * 而同源代理 `/api/book/media` 能取任意 http(s) 二进制；存下字节之后刷新、断网都还能用。
 *
 * @param name 字体族名（同时是 IndexedDB 主键）
 * @param source 本地文件读出的二进制，或字体直链
 * @returns 列表用的元信息
 */
export async function saveFont(name: string, source: ArrayBuffer | string): Promise<FontInfo> {
  const clean = name.trim()
  if (!clean) throw new Error('字体族名不能为空')
  let data: ArrayBuffer
  let url: string | undefined
  if (typeof source === 'string') {
    url = source.trim()
    if (!url) throw new Error('字体地址不能为空')
    const response = await fetch(`/api/book/media?url=${encodeURIComponent(url)}`)
    if (!response.ok) throw new Error(`取不到字体文件：服务返回 HTTP ${response.status}`)
    data = await response.arrayBuffer()
    if (data.byteLength === 0) throw new Error('取到的字体文件是空的')
  } else {
    data = source
  }
  const record: FontRecord = { name: clean, data, url, addedAt: Date.now() }
  await putRecord(record)
  try {
    await registerFont(record)
  } catch (error) {
    await deleteRecord(clean).catch(() => undefined)
    throw error
  }
  return infoOf(record)
}

/**
 * 列出已导入的字体（新导入的在前）。
 * IndexedDB 不可用时返回空列表，界面照常可用。
 */
export async function listFonts(): Promise<FontInfo[]> {
  try {
    const records = await readAll()
    return records.map(infoOf).sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    // 无 IndexedDB / 库打不开：没有可列的字体，返回空表而不是让设置面板报错。
    return []
  }
}

/**
 * 启动时把库里所有字体注册回 `document.fonts`（刷新后继续可用）。
 * 整个库读不出来就静默跳过；单条字体坏了只跳过它自己，其它字体照常注册。
 */
export async function loadAllFonts(): Promise<void> {
  let records: FontRecord[]
  try {
    records = await readAll()
  } catch {
    // 无 IndexedDB：启动时没有字体可注册，不阻塞应用。
    return
  }
  for (const record of records) {
    try {
      await registerFont(record)
    } catch {
      // 单条字体坏了（文件损坏 / 直链失效 / 跨域）：跳过它，别让一条坏字体拖垮启动。
    }
  }
}

/**
 * 删除一条字体：先从 `document.fonts` 摘掉，再删库里的记录。
 * 不摘旧的会让同族名再导入时堆出第二份 FontFace。
 *
 * @param name 要删除的字体族名
 */
export async function removeFont(name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) return
  const face = registered.get(clean)
  if (face) {
    document.fonts.delete(face)
    registered.delete(clean)
  }
  try {
    await deleteRecord(clean)
  } catch {
    // 库不可用时删不掉：内存里已摘掉，下次刷新这条记录会重新出现，界面不会假装删成功。
  }
}

/**
 * 族名会原样进 CSS 的 `font-family`，所以只留字母 / 数字 / CJK / 空格 / 连字符 / 下划线：
 * 括号、逗号、引号这些会让整条声明作废（逗号还会把名字拆成两个字族）。
 */
function sanitizeFontName(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/** 文件名去扩展名作默认族名：`LXGWWenKai-Regular.ttf` → `LXGWWenKai-Regular`。 */
export function fontNameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim()
  return sanitizeFontName(base) || '自定义字体'
}

/** 从字体直链取默认族名：去掉 query/hash 与扩展名，取最后一段路径。 */
export function fontNameFromUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? ''
  const last = path.split('/').filter(Boolean).pop() ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    // 地址里有坏的百分号转义：保留原串，总比没有名字强。
  }
  return fontNameFromFile(decoded)
}

/**
 * 族名去重：重名时按 `名字 2`、`名字 3`… 追加序号。
 *
 * @param base 默认族名（文件名去扩展名）
 * @param existing 库里已有的族名
 * @returns 不冲突的族名
 */
export function uniqueFontName(base: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  const clean = base.trim() || '自定义字体'
  if (!used.has(clean)) return clean
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${clean} ${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${clean} ${Date.now()}`
}
