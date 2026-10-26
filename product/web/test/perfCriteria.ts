import assert from 'node:assert/strict'

/**
 * 性能用例的判据（任务 #51）。
 *
 * 原来九条断言写的是"5,000 条目录过滤必须 < 30ms"这种**绝对毫秒**。它测的不是代码，
 * 是"这台机器此刻有多闲"：同一份代码，空载绿、被另一轮门禁压着就红，而且每次红的不是同一条 ——
 * 这种门禁教给人的习惯是"红了就重跑一遍"，那它等于没有。
 *
 * 换成两件事，都跟负载无关：
 * ① **复杂度比值**：同一轮里背靠背测 n 与 k·n 两个规模。线性算法比值 ≈ k，
 *    退化成平方就是 k²。中间留 `slack` 倍余量，机器被压慢是**两条一起慢**，比值不动。
 * ② **灾难上限**：一个宽松到不可能误报的绝对值（默认 2 秒），只挡"死循环 / 意外全量重渲染"
 *    这一级事故，不挡抖动。
 * 实测数字一律照常打印，回归看得见但不靠它判红绿。
 */
export type ScaleVerdict = {
  name: string
  smallMs: number
  bigMs: number
  dataFactor: number
  ratio: number
  bound: number
  ceilingMs: number
}

/** 规模太小到测不出可信比值时的下限：低于这个值，比值全是计时噪声。 */
const MIN_MEASURABLE_MS = 0.5

/**
 * 断言"工作量翻 dataFactor 倍，时间不许按超线性涨"。
 *
 * @param smallMs n 规模的耗时
 * @param bigMs   n × dataFactor 规模的耗时
 * @param slack   允许的超线性余量（默认 3 倍：线性 4 倍数据 → 允许到 12 倍时间）
 */
export function assertScalesLinearly(input: {
  name: string
  smallMs: number
  bigMs: number
  dataFactor: number
  slack?: number
  ceilingMs?: number
}): ScaleVerdict {
  const { name, smallMs, bigMs, dataFactor } = input
  const slack = input.slack ?? 3
  const ceilingMs = input.ceilingMs ?? 2000
  const ratio = smallMs >= MIN_MEASURABLE_MS ? bigMs / smallMs : Number.POSITIVE_INFINITY
  const bound = dataFactor * slack

  console.log(`  INFO 性能 ${name}：n=${smallMs.toFixed(3)}ms · ${dataFactor}n=${bigMs.toFixed(3)}ms · 比值 ${Number.isFinite(ratio) ? ratio.toFixed(2) : '不可测'}（上限 ${bound}×，灾难线 ${ceilingMs}ms）`)

  assert.ok(bigMs <= ceilingMs, `${name}：${dataFactor}n 规模用了 ${bigMs.toFixed(1)}ms，超过 ${ceilingMs}ms 灾难上限（不是抖动，是卡住了）`)
  if (smallMs >= MIN_MEASURABLE_MS) {
    assert.ok(ratio <= bound,
      `${name}：数据 ${dataFactor}× 之后时间涨了 ${ratio.toFixed(1)}×（线性应在 ${bound}× 内，small=${smallMs.toFixed(3)}ms big=${bigMs.toFixed(3)}ms）—— 这是复杂度回归，不是机器忙`)
  } else {
    // 小规模测不出可信比值时只说清楚，不假装"通过了一条没测的判据"
    console.log(`  NOTE 性能 ${name}：n 规模仅 ${smallMs.toFixed(3)}ms，比值不可信，本轮只按灾难上限判`)
  }
  return { name, smallMs, bigMs, dataFactor, ratio, bound, ceilingMs }
}

/**
 * 断言"这一类操作的绝对开销不是主要矛盾"：只给灾难上限。
 * 用于那些**结构性不变量才是真判据**的场景（例如"开一本书只该发 3 次请求"由别的断言管）。
 */
export function assertWithinCeiling(name: string, elapsedMs: number, ceilingMs = 2000): void {
  console.log(`  INFO 性能 ${name}：${elapsedMs.toFixed(3)}ms（灾难上限 ${ceilingMs}ms）`)
  assert.ok(elapsedMs <= ceilingMs, `${name}：${elapsedMs.toFixed(1)}ms 超过 ${ceilingMs}ms —— 不是抖动`)
}

/** 预热几轮，避开 V8 冷编译把第一次测量抬高的噪声。 */
export function warmUp(run: () => void, times = 3): void {
  for (let index = 0; index < times; index++) run()
}
