import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { HEALTH_TAGS } from '../src/lib/sourceGrouping.ts'

/**
 * 体检标签的词表前后端各存一份，必须逐字一致。
 *
 * 前端（`sourceGrouping.ts`）负责把体检结论写进 `bookSourceGroup`；
 * 后端（`SourcesDao.kt` 的 `HEALTH_GROUP_TAGS`）负责在「导入备份覆盖分组」时
 * 把这些标签捞回来。两边只要漂一个字，捞回来的就是另一批词 ——
 * 表现是「导完备份，体检结论又没了」，而且不会报任何错。
 *
 * 这份判据就是那条防漂移的线：不判实现，只比词表。
 */
const here = import.meta.dirname
const kotlin = fs.readFileSync(
  path.resolve(here, '../../app/src/main/kotlin/io/legado/data/SourcesDao.kt'),
  'utf8',
)

test('体检标签：前端 HEALTH_TAGS 与后端 HEALTH_GROUP_TAGS 逐字一致', () => {
  const literal = /HEALTH_GROUP_TAGS = listOf\(([\s\S]*?)\)/.exec(kotlin)?.[1] ?? ''
  assert.ok(literal, '找不到后端词表 HEALTH_GROUP_TAGS')
  const backend = [...literal.matchAll(/"([^"]+)"/g)].map(match => match[1])
  const frontend = Object.values(HEALTH_TAGS)

  assert.ok(backend.length > 0, '后端词表解析出来是空的')
  assert.deepEqual(
    [...backend].sort(),
    [...frontend].sort(),
    `两边词表不一致：后端 ${backend.join('、')} / 前端 ${frontend.join('、')}`,
  )
})

test('四档标签都在，缺一档就等于那一档的结论导完备份会丢', () => {
  const frontend = Object.values(HEALTH_TAGS)
  for (const tier of ['体检可用', '体检待确认', '未配搜索', '体检异常']) {
    assert.ok(frontend.includes(tier), `前端缺 ${tier}`)
    assert.ok(kotlin.includes(`"${tier}"`), `后端缺 ${tier}`)
  }
})
