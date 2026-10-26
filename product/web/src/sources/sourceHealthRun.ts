import { useSyncExternalStore } from 'react'
import { api, type SourceHealthCheckItem } from '../lib/api'
import { autoTagBatches, diffHealthTiers, HEALTH_TAGS, tierCounts, type HealthTierDiff } from './sourceGrouping'

/**
 * 书源体检的"跑在组件外面"的那一半（用户 2026-10-02：
 * 「除非点击了关闭，其他情况都后台持续体检一直到结束，体检获得的内容在体检的过程中去给不能正常使用的分好组」）。
 *
 * 原来整个循环挂在弹窗组件里：关窗、换页、开别的对话框都会卸载它，
 * 卸载时 `cancelledRef.current = true` —— 于是一次几十分钟的整库体检，
 * 只要用户点一下别的地方就静默作废，结果也没了。这一版把运行状态搬进模块，
 * 组件只是它的一个订阅者：**只有「停止体检」这个显式动作能中止**，收起窗口与换页都让它继续跑。
 *
 * 另一半是"过程中就分组"：每落地一批，就把这一批里判定为「异常 / 待确认」的源打上标签，
 * 不等跑完再让用户去点按钮 —— 用户要的是跑完抬眼就能按分组筛，而不是一屏结论摆在那儿。
 * 只打标签，绝不动启用位（把 4,874 个源停成 2 个那类事故的来源）。
 */

/** 服务端每请求并发 16：一批 128 正好 8 轮，既能让界面逐批显示进度，又不会把请求数炸开。 */
export const HEALTH_CHUNK = 128
/** 攒够这么多待打标的源再写一次库：一个一个打会把手风琴拉成几千次请求。 */
const TAG_FLUSH_AT = 200
/**
 * 上一次体检结论的基线，落在 localStorage：这样跨会话也能比"本次和上次的结论变没变"。
 * 只存 id → statusCategory，体积可控（5,574 个源也就几十 KB 字符串），且不依赖组件/模块存活。
 */
export const HEALTH_BASELINE_KEY = 'legado.health.baseline'

/** 基线只需要 id → 档位这两个字段；用最小结构声明，测试里喂纯数据不用造整个 SourceHealthCheckItem。 */
export type HealthBaselineEntry = { id: string; statusCategory: string }

/**
 * **合并而不是覆盖** —— 这是基线的核心语义，所以单独抽成纯函数，让判据能直接演它。
 *
 * 只重测一个源时 `results` 里就一条；直接覆盖会把之前攒下的五千多条结论整份抹掉，
 * 下一轮全库体检就比不出任何"变化"了（基线退化成单条）。
 * 所以：以旧基线为底，只把这一轮真正测过的 id 更新进去，没测过的原样留着。
 */
export function mergeBaseline(
  previous: Record<string, string>,
  results: readonly HealthBaselineEntry[],
): Record<string, string> {
  const merged: Record<string, string> = { ...previous }
  for (const item of results) merged[item.id] = item.statusCategory
  return merged
}

/**
 * 读回跨会话基线。
 *
 * `storage` 可注入，只是为了**让判据能演"重开浏览器还能接上"**（node 里没有 localStorage）。
 * 生产调用不传，走全局 localStorage —— 行为与改造前一致。
 */
export function loadBaseline(storage?: Storage | null): Record<string, string> {
  try {
    const store = storage === undefined
      ? (typeof localStorage === 'undefined' ? null : localStorage)
      : storage
    if (!store) return {}
    const raw = store.getItem(HEALTH_BASELINE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** 把本轮结论并进基线写回。`storage` 同上，仅为可测性。 */
export function saveBaseline(results: readonly HealthBaselineEntry[], storage?: Storage | null): void {
  try {
    const store = storage === undefined
      ? (typeof localStorage === 'undefined' ? null : localStorage)
      : storage
    if (!store) return
    store.setItem(HEALTH_BASELINE_KEY, JSON.stringify(mergeBaseline(loadBaseline(store), results)))
  } catch {
    // 存不下（隐私模式/超额）就丢：基线只是"下次重测时的对比参照"，缺了顶多少一句变化提示
  }
}

export type HealthRunState = {
  running: boolean
  total: number
  checked: number
  startedAt: number
  durationMs: number
  results: SourceHealthCheckItem[]
  /** 体检过程中自动打上的标签条数 */
  autoTagged: number
  finished: 'done' | 'stopped' | null
  /** 本轮相对上一次次体检基线的结论变化数（只在 finished==='done' 时有意义） */
  baselineChanged: number
  baselineWorse: number
  baselineBetter: number
}

let state: HealthRunState = {
  running: false, total: 0, checked: 0, startedAt: 0, durationMs: 0, results: [], autoTagged: 0, finished: null,
  baselineChanged: 0, baselineWorse: 0, baselineBetter: 0,
}
const listeners = new Set<() => void>()
/**
 * 定时器句柄：浏览器里 `window.setInterval` 返回 number，node 里 `globalThis.setInterval`
 * 返回 Timeout 对象 —— 两种都得能存、都能喂给 `clearInterval`，所以取并集。
 */
type IntervalHandle = ReturnType<typeof setInterval> | number
let timer: IntervalHandle | null = null
let cancelled = false

/**
 * 起一个周期定时器。
 *
 * 浏览器里就是 `window.setInterval`，与改造前逐字一致；`window` 不存在时（node 里跑判据）
 * 退到 `globalThis.setInterval` —— 否则判据一调 `startHealthRun` 就 `window is not defined`，
 * 想演"跑完一轮之后基线是什么"只能靠读源码，那正是这次要替掉的东西。
 */
const schedule = (fn: () => void, ms: number): IntervalHandle =>
  typeof window === 'undefined' ? globalThis.setInterval(fn, ms) : window.setInterval(fn, ms)
export const getHealthRun = () => state
export function useHealthRun(): HealthRunState {
  return useSyncExternalStore(subscribeHealthRun, getHealthRun, getHealthRun)
}
export function subscribeHealthRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function replace(next: HealthRunState) {
  state = next
  listeners.forEach(listener => listener())
}

/**
 * 一批结论落地后，把"不能正常使用"的那些送去打标签。
 * `alreadyTagged` 记的是本轮已经打过的 id：客户端的 sources 要等刷新才是新的，
 * 不自己记账就会每批重复打同一批源。
 */
async function tagFailing(
  batch: SourceHealthCheckItem[],
  groupsOf: () => Record<string, string>,
  alreadyTagged: Set<string>,
  onSourcesChange: () => void,
): Promise<number> {
  const groups = groupsOf()
  const buckets = autoTagBatches(batch, groups, alreadyTagged)
  let written = 0
  for (const { tier, ids } of buckets) {
    ids.forEach(id => alreadyTagged.add(id))
    try {
      await api.batchSources('tag_group', ids, HEALTH_TAGS[tier])
      written += ids.length
    } catch {
      // 打标签失败不能打断体检：结论比标签重要，漏的在最后一批还会再试一次
      ids.forEach(id => alreadyTagged.delete(id))
    }
  }
  if (written > 0) onSourcesChange()
  return written
}

export type HealthRunStart = {
  ids: string[]
  previous?: SourceHealthCheckItem[]
  groupsOf: () => Record<string, string>
  onSourcesChange: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
  /**
   * 基线落到哪儿。生产不传 = 全局 localStorage；判据传一个 fake Storage 来演"跨会话读取"。
   * 之所以做成注入而不是直接读全局：node 里没有 localStorage，不注入就**只能读源码**验证
   * 基线逻辑，而源码断言正是这次要替掉的那类弱判据。
   */
  storage?: Storage | null
}

/**
 * 发起一轮体检。已经在跑就先停掉旧的 —— 同时跑两轮只会互相把结果盖掉。
 *
 * 返回的 Promise 在**这一轮结束**（跑完 / 出错 / 被 stop）时 resolve —— 返回值只是给判据用的，
 * 界面侧照旧 `startHealthRun({...})` 直接调用、不 await（它本来就是后台跑的）。
 * 这样判据可以「喂 fake fetch → await 这一轮 → 断结果」，而不用靠 sleep 猜时序。
 */
export function startHealthRun(options: HealthRunStart): Promise<void> {
  if (state.running) stopHealthRun()
  const merged = new Map((options.previous ?? []).map(item => [item.id, item]))
  // 上一次体检的基线：优先用本次传入的 `previous`（同一次打开、范围一致时最准），
  // 否则回退到 localStorage 里跨会话攒下的那一份（重开后再体检也能比变化）。
  const baseline: Record<string, string> = {}
  if (options.previous && options.previous.length > 0) {
    for (const item of options.previous) baseline[item.id] = item.statusCategory
  } else {
    Object.assign(baseline, loadBaseline(options.storage))
  }
  cancelled = false
  if (timer) clearInterval(timer)
  const startedAt = Date.now()
  replace({
    ...state, running: true, finished: null, total: options.ids.length, checked: 0,
    startedAt, durationMs: 0, results: Array.from(merged.values()),
    baselineChanged: 0, baselineWorse: 0, baselineBetter: 0,
  })
  timer = schedule(() => {
    replace({ ...state, durationMs: Date.now() - startedAt })
  }, 500)

  return (async () => {
    const alreadyTagged = new Set<string>()
    let pendingTag: SourceHealthCheckItem[] = []
    let autoTagged = 0
    try {
      for (let offset = 0; offset < options.ids.length; offset += HEALTH_CHUNK) {
        if (cancelled) return
        const chunk = options.ids.slice(offset, offset + HEALTH_CHUNK)
        const response = await api.healthCheckSources(chunk, 5000)
        for (const item of response.results) merged.set(item.id, item)
        pendingTag = pendingTag.concat(response.results)
        if (pendingTag.length >= TAG_FLUSH_AT) {
          autoTagged += await tagFailing(pendingTag, options.groupsOf, alreadyTagged, options.onSourcesChange)
          pendingTag = []
        }
        replace({
          ...state,
          results: Array.from(merged.values()),
          checked: Math.min(options.ids.length, offset + chunk.length),
          autoTagged,
          // 边测边算：不能等全库跑完（5000+ 个源要一小时）才告诉用户"有源的结论变了"。
          // 每批结论落地就相对基线重算一次，用户跑到一半也能看见变化。
          ...(() => {
            const partial = diffHealthTiers(baseline, Array.from(merged.values()))
            return { baselineChanged: partial.changed, baselineWorse: partial.worse, baselineBetter: partial.better }
          })(),
        })
      }
      if (cancelled) return
      autoTagged += await tagFailing(pendingTag, options.groupsOf, alreadyTagged, options.onSourcesChange)
      const finalResults = Array.from(merged.values())
      // 相对上一次基线比一比："哪些源这次结论和上次不一样"。新出现的源不算变。
      const diff: HealthTierDiff = diffHealthTiers(baseline, finalResults)
      // 把这一轮结论存成新的基线，供下次重测对比。
      saveBaseline(finalResults, options.storage)
      replace({
        ...state, running: false, finished: 'done', checked: options.ids.length, autoTagged,
        durationMs: Date.now() - startedAt,
        results: finalResults,
        baselineChanged: diff.changed, baselineWorse: diff.worse, baselineBetter: diff.better,
      })
      // 结论按本轮点到的那些源算（`merged` 里可能还留着上一轮别的范围的源）。
      // 不再用服务端的 failedCount：它等于 `!ok`，把"没配搜索"和"真连不上"混成一个数。
      const tiers = tierCounts(options.ids.map(id => merged.get(id)).filter(Boolean) as SourceHealthCheckItem[])
      const changeNote = diff.changed > 0
        ? `；对比上一轮体检，${diff.changed} 个源结论变了`
          + (diff.worse > 0 ? `（其中 ${diff.worse} 个变差）` : '')
        : ''
      options.onToast(
        `体检完成：${tiers.good} 个能搜到书，${tiers.bad} 个确认有问题，`
        + `${tiers.pending} 个待确认，${tiers.unconfigured} 个没配搜索地址（没发过请求，不算坏）`
        + (autoTagged > 0 ? `；过程中已给 ${autoTagged} 个分好体检标签` : '')
        + changeNote,
        'info',
      )
    } catch (error) {
      replace({ ...state, running: false, finished: 'stopped' })
      options.onToast(error instanceof Error ? error.message : '体检请求失败', 'error')
    } finally {
      if (timer) { clearInterval(timer); timer = null }
    }
  })()
}

/** 显式停止。这是唯一能提前结束一轮体检的入口。 */
export function stopHealthRun(): void {
  if (!state.running) return
  cancelled = true
  if (timer) { clearInterval(timer); timer = null }
  replace({ ...state, running: false, finished: 'stopped', durationMs: Date.now() - state.startedAt })
}

/** 一轮跑完/停掉之后把结果清掉，让下次打开是干净的。正在跑的时候什么都不做。 */
export function resetHealthRun(): void {
  if (state.running) return
  replace({ running: false, total: 0, checked: 0, startedAt: 0, durationMs: 0, results: [], autoTagged: 0, finished: null, baselineChanged: 0, baselineWorse: 0, baselineBetter: 0 })
}

/**
 * 源被删掉之后把它的结论一并摘掉：留着就是界面上有一排点不动的僵尸条目
 * （它们连 `book_source` 行都没了，重试只会全红）。
 */
export function dropHealthResults(ids: string[]): void {
  const gone = new Set(ids)
  if (!state.results.some(item => gone.has(item.id))) return
  replace({ ...state, results: state.results.filter(item => !gone.has(item.id)) })
}
