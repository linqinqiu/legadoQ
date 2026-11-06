import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { splitByTerm } from '../src/features/reader/searchTerm'

/**
 * 搜索命中「跳过去并高亮」（STATUS 里的已知缺口：只跳到章、不滚到命中处）。
 *
 * 这里钉两件能算错的事：关键词切片（高亮范围）与三处接线（后端给偏移、结果片段高亮、
 * 正文里临时高亮）。真滚动与真渲染由浏览器门禁覆盖，node 里不假装能演。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('切片 - 命中段与非命中段交替，末尾不留空段', () => {
  assert.deepEqual(splitByTerm('前关键词后', '关键词'), [
    { text: '前', hit: false },
    { text: '关键词', hit: true },
    { text: '后', hit: false },
  ])
  assert.deepEqual(splitByTerm('关键词开头', '关键词'), [
    { text: '关键词', hit: true },
    { text: '开头', hit: false },
  ])
  assert.deepEqual(splitByTerm('结尾是关键词', '关键词'), [
    { text: '结尾是', hit: false },
    { text: '关键词', hit: true },
  ])
})

test('切片 - 多次命中都标出来；空词原样返回；没有命中只有一段', () => {
  assert.deepEqual(splitByTerm('a关键词b关键词', '关键词'), [
    { text: 'a', hit: false },
    { text: '关键词', hit: true },
    { text: 'b', hit: false },
    { text: '关键词', hit: true },
  ])
  assert.deepEqual(splitByTerm('原文', '   '), [{ text: '原文', hit: false }])
  assert.deepEqual(splitByTerm('原文', '找不到'), [{ text: '原文', hit: false }])
  assert.deepEqual(splitByTerm('', '词'), [{ text: '', hit: false }])
})

test('接线 - 后端回偏移，结果片段与正文都按它高亮', () => {
  const dao = read('../../app/src/main/kotlin/io/legado/data/ReadingDao.kt')
  assert.match(dao, /idx\.coerceAtLeast\(0\)|BookSearchHit\(chapterUrl, chapterIndex, title, snippet, idx\)/, '命中偏移随结果一起回，没有偏移就只能跳章')
  const model = read('../../app/src/main/kotlin/io/legado/model/Models.kt')
  assert.match(model, /val offset: Int/, '契约里要有 offset 字段')
  const dialog = read('../src/features/reader/dialogs/BookSearchDialog.tsx')
  assert.match(dialog, /onJump: \(hit: BookSearchHit, term: string\)/, '跳转要把关键词一起带出去')
  assert.match(dialog, /splitByTerm\(hit\.snippet/, '结果片段里的关键词要高亮')
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /const jumpToSearchHit = /, '阅读器要接住命中')
  assert.match(screen, /charOffset: hit\.offset/, '落点用后端给的偏移，不是章首')
  assert.match(screen, /className="reader-search-hit"/, '正文里要画临时高亮')
  assert.match(screen, /window\.setTimeout\(\(\) => setSearchFlash\(null\), 6000\)/, '高亮是临时的，会自己消失')
})

test('每章多命中：后端最多 5 条、按位置排，前端标「第 k 处」', () => {
  const dao = read('../../app/src/main/kotlin/io/legado/data/ReadingDao.kt')
  assert.match(dao, /MAX_HITS_PER_CHAPTER = 5/, '一个常用词不该把列表冲成一页同义词')
  assert.match(dao, /while \(emitted < MAX_HITS_PER_CHAPTER\)/, '按出现顺序逐条回，不是只回第一条')
  const dialog = read('../src/features/reader/dialogs/BookSearchDialog.tsx')
  assert.match(dialog, /第 \$\{ordinals\[index\]\} 处/, '同章多条要标第几处，否则几行长得一样')
  assert.match(dialog, /key=\{\`\$\{hit\.chapterUrl\}-\$\{hit\.offset\}\`\}/, 'key 带偏移，同章多条不会撞 key')
})
