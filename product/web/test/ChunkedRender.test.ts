import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SIZE, CHUNK_THRESHOLD, ensureLimit, growLimit, shouldChunk } from '../src/features/reader/content/chunkedRender'

/**
 * 超大章节分块渲染（STATUS 缺口：「整章挂 DOM」）。
 *
 * 这套判据盯的是**边界**：什么章节才分块、补块怎么对齐、跳到很后面要补多少。
 * 普通章节必须完全不受影响 —— 分块是给"整本书塞进一章"的源兜底，不是新的默认路径。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('只有滚动模式 + 超过阈值才分块，普通章节原样整章渲染', () => {
  assert.equal(shouldChunk('scroll', CHUNK_THRESHOLD), false, '刚好 400 段仍整章渲染')
  assert.equal(shouldChunk('scroll', CHUNK_THRESHOLD + 1), true)
  assert.equal(shouldChunk('paginate', 5000), false, '分页要量整章成列，不能缺段')
  assert.equal(shouldChunk('scroll', 40), false)
})

test('补一块就多一块，到底就停', () => {
  assert.equal(growLimit(CHUNK_SIZE, 1000), CHUNK_SIZE * 2)
  assert.equal(growLimit(900, 1000), 1000, '最后一块按剩余补齐，不越界')
  assert.equal(growLimit(1000, 1000), 1000)
})

test('跳到很后面：按块对齐补，不把中间几百段一起挂上', () => {
  assert.equal(ensureLimit(CHUNK_SIZE, 10, 5000), CHUNK_SIZE, '目标已挂出来就不动')
  assert.equal(ensureLimit(CHUNK_SIZE, 200, 5000), 300, '第 200 段落在第二块 → 补到 300')
  assert.equal(ensureLimit(CHUNK_SIZE, 301, 5000), 450, '按块对齐，不是 index + 1')
  assert.equal(ensureLimit(CHUNK_SIZE, 4999, 5000), 5000, '越界夹到总数')
})

test('接线：滚动区只渲染前 N 段并带补挂入口，分页区仍是整章', () => {
  const screen = read('../src/features/reader/ReaderScreen.tsx')
  assert.match(screen, /const chunked = shouldChunk\(settings\.pageMode, paragraphs\.length\)/)
  assert.match(screen, /shownParagraphs = chunked \? paragraphs\.slice\(0, renderLimit\) : paragraphs/)
  assert.match(screen, /className="reader-chunk-more"/, '要有补挂入口（observer 不可用时靠它）')
  assert.match(screen, /rootMargin: '800px 0px'/, '滚到这一块末尾前就补，别等真见底')
  // 分页那一处必须仍然是 paragraphs（整章），否则量出来的页数会少。
  assert.match(screen, /isMangaMode \? renderMangaContent\(\) : paragraphs\.map\(/, '分页区保持整章渲染')
  assert.match(screen, /isMangaMode \? renderMangaContent\(\) : shownParagraphs\.map\(/, '滚动区按块渲染')
  assert.match(screen, /revealParagraph\(index\)/, '跳笔记 / 搜索命中要先补块再滚')
  assert.match(screen, /revealParagraph\(activeParagraphIndex\)/, '朗读跟读也要先补块')
})
