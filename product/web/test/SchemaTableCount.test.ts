import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 表数量在文档里是**手抄的**，而 `Schema.kt` 是唯一真源。
 *
 * 已经漂过一次：2026-11-12 加 `book_shelf_tombstone` 时只改了
 * `ARCHITECTURE.md:178` 一处，另外四处（架构图、数据模型段、5.2 标题、STATUS.md）
 * 仍写 20 —— 读文档的人会以为少一张表，而 5.2 的分组表里也确实漏了它。
 *
 * 这份判据不判实现，只做三件事：
 *   1. `Schema.kt` 的 `create table if not exists` 清单非空、无重名；
 *   2. 文档里每一处「N 张表」都等于实际建表数；
 *   3. 每张表都在 `ARCHITECTURE.md` 出现过 —— 新增表必须补进 5.2 分组，
 *      否则加表的人以为改完代码就完事，下一个人按文档找不到它。
 */
const here = import.meta.dirname
const productRoot = path.resolve(here, '../..')
const repoRoot = path.resolve(productRoot, '..')

const schema = fs.readFileSync(
  path.join(productRoot, 'app/src/main/kotlin/io/legado/data/db/Schema.kt'),
  'utf8',
)
const tables = [...schema.matchAll(/create table if not exists\s+([a-z_][a-z0-9_]*)/gi)].map(
  match => match[1].toLowerCase(),
)

const docs = ['docs/ARCHITECTURE.md', 'docs/STATUS.md'].map(rel => ({
  rel,
  text: fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
}))

test('Schema.kt 建表清单可解析、无重名', () => {
  assert.ok(tables.length >= 10, `只解析出 ${tables.length} 张表 —— 正则或文件结构变了`)
  assert.equal(new Set(tables).size, tables.length, `Schema.kt 里有重复建表：${tables.join('、')}`)
})

test('文档里每一处「N 张表」都等于 Schema.kt 的实际建表数', () => {
  for (const { rel, text } of docs) {
    const claims = [...text.matchAll(/(\d+)\s*张表/g)].map(match => Number(match[1]))
    assert.ok(claims.length > 0, `${rel} 里找不到「N 张表」的说法 —— 判据失去目标，请改判据`)
    for (const claim of claims) {
      assert.equal(
        claim,
        tables.length,
        `${rel} 写「${claim} 张表」，Schema.kt 实际建 ${tables.length} 张`,
      )
    }
  }
})

test('每张表都写进了架构文档（新增表要补 5.2 分组）', () => {
  const architecture = docs[0].text
  const missing = tables.filter(name => !architecture.includes(`\`${name}\``))
  assert.deepEqual(missing, [], `这些表在 docs/ARCHITECTURE.md 里查不到：${missing.join('、')}`)
})
