/**
 * 全局壁纸：设置模型、本地上传图片的 IndexedDB 存取，以及设置本身的 localStorage 持久化。
 *
 * 借鉴 deepseek-harness-background 的壁纸能力（固定层 + 主题自适应遮罩 + 不透明度/模糊/填充），
 * 但这里是 legadoQ 自己的实现：只改前端、不引依赖、不碰后端。
 *
 * 三层数据各归各的：
 * ① 设置（开关 / 来源 / 地址 / 不透明度 / 遮罩 / 模糊 / 填充）—— 小、常改，存 localStorage；
 * ② 本地上传的图片二进制 —— 动辄几 MB，localStorage 只存字符串且总配额约 5MB，所以存 IndexedDB；
 * ③ 内存快照 —— 壁纸层与设置分区都订阅同一份，改一处两处同时刷新（见 `subscribeWallpaper`）。
 *
 * 失败策略与 `fontLibrary.ts` 一致：读设置 / 读图片拿不到就当"没有"（界面回落默认外观），
 * 只有"写入这张图片"失败才抛给界面提示 —— 那是用户刚做的动作，不能悄悄吞掉。
 */

/** 填充方式：`cover` 铺满并裁剪，`contain` 完整显示并留白。 */
export type WallpaperFill = 'cover' | 'contain'

/** 壁纸来源：本地上传（图在 IndexedDB）或图片地址（直接存设置）。 */
export type WallpaperSource = 'upload' | 'url'

/** 壁纸设置。全部只存在这台机器的浏览器里，不进备份包、不上传服务端。 */
export type WallpaperSettings = {
  /** 总开关：关掉后壁纸层整层不渲染，背景回到原来的画布色。 */
  enabled: boolean
  /** 当前用哪一份图：本地上传还是图片地址。 */
  source: WallpaperSource
  /** 图片地址（`source === 'url'` 时生效）。 */
  url: string
  /** 图片不透明度，0..1。 */
  opacity: number
  /** 图片上方的可读性纱帘浓度，0..1；浅色主题白纱、深色主题黑纱。 */
  mask: number
  /** 图片自身的模糊半径，px（0..60）。 */
  blur: number
  /** 面板不透明度，0..1：顶栏、卡片、设置分区这些「浮在壁纸上的表面」的底色浓度。 */
  panelOpacity: number
  /** 毛玻璃模糊，px（0..40）：面板背后的 backdrop-filter 半径。 */
  glassBlur: number
  /** 填充方式。 */
  fill: WallpaperFill
  /** 阅读器也使用这张壁纸（关掉时阅读器保留自己的阅读背景，即「分开用」）。 */
  readerFollow: boolean
}

/** 默认设置：关闭、未选图、不透明度满、遮罩 25%（与参考实现同一档观感）、无模糊、面板半透明、铺满裁剪。 */
export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: false,
  source: 'upload',
  url: '',
  opacity: 1,
  mask: 0.25,
  blur: 0,
  panelOpacity: 0.72,
  glassBlur: 8,
  fill: 'cover',
  readerFollow: false,
}

/** 设置存 localStorage 的键。改键名等于丢掉用户已经调好的值，非必要不动。 */
const SETTINGS_KEY = 'legado-wallpaper-v1'

/** 图片地址的长度上限：超长的串只会是坏数据，挡在设置模型这一层。 */
const MAX_URL_LENGTH = 2048

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 把任意来源（localStorage 里的旧数据、用户手改、未来版本）解析成一份合法的壁纸设置。
 *
 * 越界值一律夹回合法区间而不是丢弃整份设置：用户调过的滑杆位置比"严格"更值钱。
 *
 * @param raw 待解析的原始值
 * @returns 一份字段齐全、取值合法的设置
 */
export function parseWallpaperSettings(raw: unknown): WallpaperSettings {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_WALLPAPER_SETTINGS }
  const record = raw as Record<string, unknown>
  const source: WallpaperSource = record.source === 'url' ? 'url' : 'upload'
  const fill: WallpaperFill = record.fill === 'contain' ? 'contain' : 'cover'
  const url = typeof record.url === 'string' ? record.url.trim().slice(0, MAX_URL_LENGTH) : ''
  return {
    enabled: record.enabled === true,
    source,
    url,
    opacity: clamp(finiteNumber(record.opacity, DEFAULT_WALLPAPER_SETTINGS.opacity), 0, 1),
    mask: clamp(finiteNumber(record.mask, DEFAULT_WALLPAPER_SETTINGS.mask), 0, 1),
    blur: Math.round(clamp(finiteNumber(record.blur, DEFAULT_WALLPAPER_SETTINGS.blur), 0, 60)),
    panelOpacity: clamp(finiteNumber(record.panelOpacity, DEFAULT_WALLPAPER_SETTINGS.panelOpacity), 0, 1),
    glassBlur: Math.round(clamp(finiteNumber(record.glassBlur, DEFAULT_WALLPAPER_SETTINGS.glassBlur), 0, 40)),
    fill,
    readerFollow: record.readerFollow === true,
  }
}

/**
 * 从 localStorage 读设置。没有存储、隐私模式、旧数据损坏都回落默认值 —— 启动不能被壁纸卡住。
 *
 * @returns 当前设置
 */
export function loadWallpaperSettings(): WallpaperSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WALLPAPER_SETTINGS }
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_WALLPAPER_SETTINGS }
    return parseWallpaperSettings(JSON.parse(raw))
  } catch {
    // 存储不可用或 JSON 坏了：当没设置过，界面用默认外观继续跑
    return { ...DEFAULT_WALLPAPER_SETTINGS }
  }
}

/**
 * 把设置写回 localStorage。写失败（隐私模式 / 配额满）只影响"下次打开还在不在"，
 * 本次会话的内存快照仍然生效，所以这里不向界面报错。
 *
 * @param settings 要保存的设置
 */
export function saveWallpaperSettings(settings: WallpaperSettings): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // 存储写不进去：本次会话照常生效，刷新后回到上一次成功保存的值
  }
}

/**
 * 内存快照：设置 + 图片版本号。
 *
 * 为什么要 `imageVersion`：重新上传一张图时设置的字段可能一个都没变（还是 `source: 'upload'`），
 * 只看设置的话壁纸层不会重新读 IndexedDB，界面就停在旧图。换图/清图时把版本号 +1，
 * 订阅者据此重读二进制。
 */
export type WallpaperSnapshot = {
  settings: WallpaperSettings
  imageVersion: number
}

let snapshot: WallpaperSnapshot = { settings: loadWallpaperSettings(), imageVersion: 0 }
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * 订阅壁纸快照变化（配合 `useSyncExternalStore`）。
 *
 * @param listener 快照变化时被调用
 * @returns 取消订阅的函数
 */
export function subscribeWallpaper(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 读当前快照。引用只在真的变化时替换，`useSyncExternalStore` 才能稳定比较。 */
export function getWallpaperSnapshot(): WallpaperSnapshot {
  return snapshot
}

function sameSettings(a: WallpaperSettings, b: WallpaperSettings): boolean {
  return a.enabled === b.enabled
    && a.source === b.source
    && a.url === b.url
    && a.opacity === b.opacity
    && a.mask === b.mask
    && a.blur === b.blur
    && a.panelOpacity === b.panelOpacity
    && a.glassBlur === b.glassBlur
    && a.fill === b.fill
    && a.readerFollow === b.readerFollow
}

/**
 * 改一部分设置：先按 `parseWallpaperSettings` 归一化，再更新快照、写 localStorage、通知订阅者。
 *
 * @param patch 要改的字段
 * @returns 归一化后的新设置
 */
export function updateWallpaperSettings(patch: Partial<WallpaperSettings>): WallpaperSettings {
  const settings = parseWallpaperSettings({ ...snapshot.settings, ...patch })
  if (sameSettings(settings, snapshot.settings)) return snapshot.settings
  snapshot = { settings, imageVersion: snapshot.imageVersion }
  saveWallpaperSettings(settings)
  notify()
  return settings
}

/** 图片换了（上传 / 清除）：版本号 +1，订阅者据此重读 IndexedDB 里的二进制。 */
function bumpImageVersion(): void {
  snapshot = { settings: snapshot.settings, imageVersion: snapshot.imageVersion + 1 }
  notify()
}

/* ------------------------------------------------------------------ *
 * 本地上传图片：IndexedDB（单个记录，id 固定为 current）
 * ------------------------------------------------------------------ */

const DB_NAME = 'legado-wallpaper'
const DB_VERSION = 1
const STORE = 'images'
/** 只存一张图：换图就是覆盖同一条记录，库里不会堆积死图片。 */
const RECORD_ID = 'current'

/** 一条上传记录：图片二进制 + MIME。 */
export type WallpaperRecord = {
  id: string
  blob: Blob
  mime: string
  addedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Node / 无头环境没有 IndexedDB：直接 reject，交给上层按"没有图"降级
      reject(new Error('当前环境没有 IndexedDB，壁纸只能本次会话生效'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // 只在不存在时建 store：升级路径不碰既有数据
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onblocked = () => {
      if (dbPromise === promise) dbPromise = null
      reject(new Error('壁纸库升级被其它标签页占用，请关闭旧标签页后重试'))
    }
    request.onsuccess = () => {
      const db = request.result
      // 别的标签升级 / 浏览器回收连接时清空缓存，下次重开新连接
      db.onversionchange = () => { db.close(); if (dbPromise === promise) dbPromise = null }
      db.onclose = () => { if (dbPromise === promise) dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { if (dbPromise === promise) dbPromise = null; reject(request.error) }
  })
  dbPromise = promise
  return promise
}

/**
 * 保存一张本地上传的壁纸（覆盖旧图）。
 *
 * @param blob 图片二进制
 * @param mime 图片 MIME；没传就取 Blob 自带的 type
 * @throws IndexedDB 不可用或写入失败时抛出，由界面提示用户
 */
export async function saveWallpaper(blob: Blob, mime?: string): Promise<void> {
  const db = await openDb()
  const record: WallpaperRecord = {
    id: RECORD_ID,
    blob,
    mime: (mime || blob.type || 'image/png').slice(0, 128),
    addedAt: Date.now(),
  }
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  bumpImageVersion()
}

/**
 * 读当前保存的上传图片。
 *
 * @returns 记录；从没存过时返回 null
 * @throws IndexedDB 不可用时抛出，调用方按"没有图"处理
 */
export async function loadWallpaper(): Promise<WallpaperRecord | null> {
  const db = await openDb()
  return new Promise<WallpaperRecord | null>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID)
    request.onsuccess = () => resolve((request.result as WallpaperRecord | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

/**
 * 清掉本地上传的图片。没有库 / 没有记录都算清除成功 —— 目的是"回到没有图"，
 * 已经在那个状态就不必报错。
 */
export async function clearWallpaper(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(RECORD_ID)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    // 库里本来就没有图（或 IndexedDB 不可用）：清除的目标已经达成
  } finally {
    bumpImageVersion()
  }
}
