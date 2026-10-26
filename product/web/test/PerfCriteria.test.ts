import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { assertScalesLinearly, assertWithinCeiling } from './perfCriteria.ts'

/**
 * 性能判据自身的守卫（任务 #51）。
 *
 * 两件事：① 钉住 helper 的语义 —— 比值超限必须红，机器慢但比值正常必须绿；
 * ② 扫全部前端用例，**不许再出现"耗时 < 某个绝对毫秒"** 这种判据。
 * 第二条是防回流的：这类断言红了大家的反应是"再跑一遍"，等于教团队忽略门禁。
 */

const TEST_DIR = import.meta.dirname

test('判据 - 数据 4 倍、时间也 4 倍：绿（哪怕绝对值很难看）', () => {
  const verdict = assertScalesLinearly({ name: '假想的慢机器', smallMs: 400, bigMs: 1_700, dataFactor: 4, ceilingMs: 2_000 })
  assert.ok(verdict.ratio <= verdict.bound, `比值 ${verdict.ratio} 应在 ${verdict.bound} 内`)
})

test('判据 - 数据 4 倍、时间涨 30 倍：红（这是复杂度回归，不是机器忙）', () => {
  assert.throws(
    () => assertScalesLinearly({ name: '退化成平方', smallMs: 10, bigMs: 300, dataFactor: 4 }),
    /复杂度回归|超过/,
  )
})

test('判据 - 小规模测不出可信比值时只按灾难上限判，并且明说', () => {
  const verdict = assertScalesLinearly({ name: '极快操作', smallMs: 0.02, bigMs: 40, dataFactor: 4 })
  assert.ok(!Number.isFinite(verdict.ratio), '分母低于计时分辨率时比值应视为不可信')
})

test('判据 - 超过灾难上限：红，且理由不是"抖动"', () => {
  assert.throws(() => assertWithinCeiling('卡住的循环', 9_000, 2_000), /不是抖动/)
})

test('前端用例里不许再有"耗时 < 绝对毫秒"这种判据', () => {
  const files = fs.readdirSync(TEST_DIR)
    .filter(name => name.endsWith('.test.ts') && name !== 'perfCriteria.ts' && name !== 'PerfCriteria.test.ts')
  const offenders: string[] = []
  // 只抓"时长变量 < 数字"这一种形状，阈值 < 1000ms。1000ms 以上留给灾难上限
  // （那是有意为之的宽上限，不是"机器此刻多闲"的判据）。
  const pattern = /assert\.ok\(\s*([A-Za-z_$][\w$]*)\s*<\s*(\d{1,3}(?:\.\d+)?)\s*[,)]/
  const looksLikeDuration = (name: string) => /elapsed|duration|latency|\bms\b|ms$|_ms|time/i.test(name)
  for (const name of files) {
    const lines = fs.readFileSync(path.join(TEST_DIR, name), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const match = pattern.exec(line)
      if (match && looksLikeDuration(match[1])) offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`)
    })
  }
  assert.deepEqual(offenders, [],
    '这些断言在测"这台机器此刻有多闲"而不是代码：请改用 assertScalesLinearly（量级比值）或 assertWithinCeiling（灾难上限）\n' + offenders.join('\n'))
})
