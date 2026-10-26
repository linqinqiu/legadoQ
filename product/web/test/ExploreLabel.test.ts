import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { exploreLabel, labelExploreTabs } from '../src/lib/exploreLabel'
import type { ExploreTab } from '../src/lib/api'

/**
 * 发现页的分栏名清洗（`lib/exploreLabel.ts`）。
 *
 * 依据是量出来的，不是印象：本机 5,574 个书源里静态 `exploreUrl` 的分栏名去重后 7,321 个，
 * 其中 **1,550 个混着 emoji 与花饰**（`💮 穿越文`、`🔸连载`、`【完结】`、`~»最近更新«~`）。
 * 以前直接画原文，界面上是一排方框（截图里那一行「￼»最近更新￼«~」就是）。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('装饰字形洗掉，词本身留着', () => {
  assert.equal(exploreLabel('💮 穿越文'), '穿越文')
  assert.equal(exploreLabel('🔸连载'), '连载')
  assert.equal(exploreLabel('【完结】'), '完结')
  assert.equal(exploreLabel('~»最近更新«~'), '最近更新')
  assert.equal(exploreLabel('★ 玄幻 ★'), '玄幻')
  assert.equal(exploreLabel('  都市  '), '都市')
  assert.equal(exploreLabel('男生视野·玄幻奇幻武侠同人'), '男生视野·玄幻奇幻武侠同人', '词中间的间隔号是内容，不是花饰')
  assert.equal(exploreLabel('首页（不要删这个）'), '首页（不要删这个）', '成对括号里写着话，不能当装饰吃掉')
  assert.equal(exploreLabel('完結済み'), '完結済み', '日文汉字与假名不是装饰字形')
  assert.equal(exploreLabel('18 禁'), '18 禁')
  assert.equal(exploreLabel('TOP100·男频'), 'TOP100·男频')
})

test('整条都是装饰时退回原文：宁可难看，不给一个空按钮', () => {
  assert.equal(exploreLabel('💯'), '💯')
  assert.equal(exploreLabel('〓〓'), '〓〓')
  assert.equal(exploreLabel(''), '')
})

test('重名分栏编号，而且编号按清洗后的名字算', () => {
  const tab = (title: string, url: string): ExploreTab => ({ title, url })
  const named = labelExploreTabs([tab('推荐', 'https://a/1'), tab('完结', 'https://a/2'), tab('【完结】', 'https://a/3')])
  assert.deepEqual(named.map(item => item.label), ['推荐', '完结 ·1', '完结 ·2'],
    '清洗后同名的两栏必须一起编号 —— 只按原文去重的话，「完结」与「【完结】」在界面上是两个一模一样的按钮')
  assert.deepEqual(named.map(item => item.url), ['https://a/1', 'https://a/2', 'https://a/3'], '地址一个字都不许动')
  assert.deepEqual(labelExploreTabs([]), [])
})

test('清洗真的接在发现页上，原文不再直接上屏', () => {
  const page = read('../src/pages/ExplorePage.tsx')
  assert.match(page, /labelExploreTabs\(tabs\)/, '发现页没在用那份清洗 + 编号')
  assert.doesNotMatch(page, /tab\?\.title/, '分栏标题还在直接画原文 —— 那一排方框会回来')
  assert.match(page, /\{activeLabel\}/, '面板标题也要跟着用清洗后的名字')
})

test('RSS 的栏目走同一份清洗；那句"不依赖外部服务"的谎话已经改掉', () => {
  const rss = read('../src/pages/RssPanel.tsx')
  assert.match(rss, /\{exploreLabel\(item\.title\)\}/, 'RSS 栏目名与发现分栏是同一类东西（源自己写的标题），不能只洗一处')
  assert.doesNotMatch(rss, /不依赖任何外部服务|点开即读/,
    '条目是现取上游站点的 —— 这两句把"列表在本机"说成了"读起来不靠网络"，而门禁里就有一条在验取不到时的说明')
})
