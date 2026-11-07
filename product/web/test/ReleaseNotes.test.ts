import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 发行说明必须说两件事：**这版改了什么**、**怎么用起来**。
 *
 * 以前 Release 正文是写死在 workflow 里的一段「本 Release 由 Actions 自动生成」，
 * 用户点进 Releases 页只看到 commit 哈希和产物名，不知道这一版加了什么，
 * 也不知道下下来之后怎么跑（用户 2026-11-08：「发布发行版要有更新日志更新内容和使用简介」）。
 *
 * 现在正文由 workflow 从 `product/CHANGELOG.md` 摘当前版本那一段，再拼上使用简介生成，
 * 写进 `release-body.md` 交给 action。这份判据盯的就是这条链路还在。
 */
const here = import.meta.dirname
const repo = path.resolve(here, '../../..')
const workflow = fs.readFileSync(path.resolve(repo, '.github/workflows/build-jar.yml'), 'utf8')

test('发布正文从 CHANGELOG 摘，而不是再写一份手抄日志', () => {
  assert.match(workflow, /name: Compose release notes/, '要有拼装发布说明的步骤')
  assert.match(workflow, /product\/CHANGELOG\.md/, '更新内容要取自 CHANGELOG')
  assert.match(workflow, /awk -v needle="\[\$VERSION\]"/, '按版本号定位那一段')
  assert.match(workflow, /release-body\.md/, '要落成一个正文文件')
})

test('action 用 body_path 读正文，不内联 body', () => {
  assert.match(workflow, /body_path: release-body\.md/, '要用 body_path')
  assert.doesNotMatch(workflow, /^\s+body: \|/m, '正文不该再内联在 workflow 里（两处会漂移）')
})

test('正文里有使用简介：这是什么 / 怎么用 / 产物 / 升级', () => {
  for (const heading of ['## 这是什么', '## 怎么用', '## 产物', '## 从旧版升级']) {
    assert.ok(workflow.includes(heading), `发布正文缺少「${heading}」`)
  }
  assert.match(workflow, /java -jar legado\.jar/, '要给出启动命令')
  assert.match(workflow, /127\.0\.0\.1:1234/, '要给出访问地址')
})

test('滚动构建（latest）没有版本段落时有兜底说明', () => {
  assert.match(workflow, /main 的滚动构建：下面是最近一版的更新记录/, 'latest 要说明"这不是本版专属"')
})
