import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书源编辑器的 JSON 栏（用户 2026-11-07：「json 怎么回事不全还怎么的」）。
 *
 * 实际查下来内容是全的（21 个字段 / 2944 字符都在），难看成"不全"的是三件事：
 *  ① 库里存的是**压缩成一行**的 JSON，两千多字符铺进去就是一团；
 *  ② 文本框只有 356px 高，47 行要在一个小窗口里内滚；
 *  ③ 界面上没有任何地方能回答"到底有几个字段"。
 *
 * 这份判据盯这三点，不判具体像素。
 */
const here = import.meta.dirname
const panel = fs.readFileSync(path.resolve(here, '../src/features/source-editor/SourceEditorPanel.tsx'), 'utf8')
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

test('打开就格式化，压缩成一行的原文不再直接铺进编辑框', () => {
  assert.match(panel, /function prettyJson\(raw: string\): string/, '要有格式化函数')
  assert.match(panel, /JSON\.stringify\(JSON\.parse\(raw\), null, 2\)/, '缩进 2 格')
  assert.match(panel, /setText\(prettyJson\(value\.json\)\)/, '读源时要走格式化')

  // 解析不了就原样给出：坏 JSON 不能被格式化函数吞掉（下面的报错条要能看见原文）。
  const fn = /function prettyJson\(raw: string\): string \{([\s\S]*?)\n\}/.exec(panel)?.[1] ?? ''
  assert.match(fn, /catch \{\s*return raw/, '解析失败要原样返回')
})

test('文本框按行数长高，不再固定高度内滚', () => {
  assert.match(panel, /rows=\{Math\.min\(52, Math\.max\(14, text\.split\('\\n'\)\.length \+ 1\)\)\}/,
    'rows 要跟着行数走，并且封顶')
  const rule = /\.source-editor textarea\.source-editor-raw \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.ok(rule, '找不到 JSON 编辑框的高度规则')
  assert.match(rule, /min-height: clamp\(320px, 55vh, 640px\)/, '矮屏也要有下限，别缩成一条')
})

test('栏里要能直接回答「全不全」：字段数与行数', () => {
  assert.match(panel, /className="source-json-facts"/, '要有这行说明')
  assert.match(panel, /共 \{Object\.keys\(json\)\.length\} 个字段/, '报字段数')
  assert.match(panel, /\{text\.split\('\\n'\)\.length\} 行/, '报行数')
  assert.match(css, /\.source-json-facts \{/, '这行说明要有自己的样式（否则类名判据会红）')
})
