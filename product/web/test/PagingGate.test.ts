import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「下一页」这颗按钮不许挂在不吃页码的栏目上（PROPOSAL-022 P1）。
 *
 * 判定在服务端一处（`app/…/rules/PagingRule.kt`：只看规则写法，绝不执行书源 JS），
 * 界面只消费 `tab.supportsPaging`。本机 25,290 条静态栏目地址里有 **4,368 条（17%）**
 * 不含任何翻页写法 —— 以前每一击都是一次白发请求，然后靠"第二页全是重复"事后算到底。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('旗标从服务端一路带到界面，只有一份判据', () => {
  const api = read('..', 'src', 'lib', 'api.ts')
  assert.ok(/ExploreTab = \{[^}]*supportsPaging\?: boolean/.test(api), 'ExploreTab 没带上 supportsPaging')
  const models = read('..', '..', 'app', 'src', 'main', 'kotlin', 'io', 'legado', 'model', 'Models.kt')
  assert.ok(/data class ExploreTab\([^)]*supportsPaging: Boolean = true/.test(models), '服务端 ExploreTab 没有这个字段')
  // 前端不许自己再写一份"能不能翻页"的判断
  for (const name of [path.join('pages', 'ExplorePage.tsx'), path.join('pages', 'RssPanel.tsx')]) {
    const text = read('..', 'src', ...name.split(path.sep))
    assert.ok(!/page=\{\{/.test(text) && !/<\[\^>\]*,/.test(text), `${name} 里不该出现按规则文本猜翻页的写法`)
  }
})

test('发现页：不吃页码的栏目不挂「加载更多」，翻页函数自己也拦一道', () => {
  const page = read('..', 'src', 'pages', 'ExplorePage.tsx')
  assert.ok(/tab\?\.supportsPaging !== false && hasMore &&/.test(page), '「加载更多」没按旗标收')
  assert.ok(/supportsPaging === false/.test(page.split('const loadMore')[1] ?? ''), 'loadMore 里没有对应的守卫（只收按钮，函数还是能被别处调到）')
  // 反向对照：老写法（只看 hasMore）必须被这两条逮住
  const oldShape = `{hasMore && (\n  <button>加载更多</button>\n)}`
  assert.equal(/tab\?\.supportsPaging !== false && hasMore &&/.test(oldShape), false, '反扫失效：老写法会被放过')
})

test('RSS 那一页同一条纪律', () => {
  const panel = read('..', 'src', 'pages', 'RssPanel.tsx')
  assert.ok(/tab\?\.supportsPaging !== false/.test(panel), 'RSS 的「下一页」没按旗标收')
})
