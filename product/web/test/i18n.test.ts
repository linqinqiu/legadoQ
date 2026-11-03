import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { zh } from '../src/i18n/zh.ts'

/**
 * i18n 骨架判据（③ 字符串集中 · 分批）。
 *
 * 1) 字典值不许漂（「关闭」仍是那句，拼错键由 tsc 当场拦，这里只兜值）。
 * 2) 已迁移的文件必须真的用 zh.common.close，不许假迁移。
 * 3) 棘轮：仓库里残留的裸 aria-label="关闭" 只许越来越少，不许新增——逼后续批次继续搬，
 *    而不是把已集中的价值又漏回字面量。当前基线 = 迁移 PageDialog 后剩余的站点数。
 */
const SRC = path.resolve(import.meta.dirname, '../src')
const tsFiles = (): string[] => fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter(name => /\.(tsx|ts)$/.test(name) && !name.includes(`${path.sep}i18n${path.sep}`))
  .map(name => path.join(SRC, name))

test('zh.common.close 是那句「关闭」', () => {
  assert.equal(zh.common.close, '关闭')
})

test('PageDialog 已从集中字典取关闭标签，不再内联', () => {
  const src = fs.readFileSync(path.join(SRC, 'components/PageDialog.tsx'), 'utf8')
  assert.match(src, /from '\.\.\/i18n\/zh'/, 'PageDialog 应 import 字典')
  assert.match(src, /aria-label=\{zh\.common\.close\}/, 'PageDialog 应引用 zh.common.close')
  assert.doesNotMatch(src, /aria-label="关闭"/, 'PageDialog 不应再内联「关闭」')
})

test('残留的裸 aria-label="关闭" 不得超过当前基线（棘轮）', () => {
  const RATCHET = 26 // ③ 批次 1 后实测：全仓 `aria-label="关闭"` 还剩 26 处（PageDialog 已集中），后续批次压低它
  const bare = tsFiles().reduce((sum, file) => {
    const n = (fs.readFileSync(file, 'utf8').match(/aria-label="关闭"/g) ?? []).length
    return sum + n
  }, 0)
  assert.ok(bare <= RATCHET, `裸「关闭」字面量还有 ${bare} 处，超过棘轮基线 ${RATCHET}；要么继续迁移，别把它加回来`)
})
