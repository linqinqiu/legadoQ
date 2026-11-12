import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as ui from '../src/ui/index'
import {
  applyDynamicTheme,
  composeDynamicCss,
  composeSpringCss,
  DYNAMIC_CLASS,
  DYNAMIC_SELECTOR,
  isSeedWorthApplying,
  removeDynamicTheme,
} from '../src/ui/theme/apply'
import {
  clearDynamicTheme,
  getDynamicTheme,
  resetDynamicThemeForTest,
  setDynamicTheme,
  subscribeDynamicTheme,
} from '../src/ui/theme/store'

/**
 * `src/ui/` 设计内核的门面与状态机判据（2026-11-12）。
 *
 * 为什么需要它：这一层是**跨 feature 的地基**，改坏了不是一处界面难看，而是所有页面的
 * 配色一起错。此前配色只有一条路（styles.css 里的 `.theme-*`），错了肉眼能看出；
 * 现在多了一条"按封面算出来的覆盖层"，它只能在运行时算，静态读代码看不出来 ——
 * 所以把三件事钉成判据：
 * 1. 门面导出不许缺（调用点只认 `ui/index.ts`）；
 * 2. 状态机不许把"非法 seed"当有效主题（否则界面会留一个没有颜色的覆盖层）；
 * 3. `ui/**` 不许反向依赖业务（一旦依赖，这层就无法单独替换/删除）。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')

test('门面导出：颜色 / 动效 / 材质 / 主题四组都在', () => {
  for (const name of [
    'COLOR_ROLES', 'buildDynamicTheme', 'normalizeSeed', 'skinCss', 'rolesToSkinVars', 'LEGACY_VARS',
    'seedFromPixels', 'scoreSeeds',
    'SPRINGS', 'springDurationMs', 'springEasing', 'springSample', 'springVars',
    'glassStyle', 'glassClassName',
    'applyDynamicTheme', 'applySpringVars', 'composeDynamicCss', 'composeSpringCss',
    'getDynamicTheme', 'setDynamicTheme', 'clearDynamicTheme', 'subscribeDynamicTheme',
  ]) {
    assert.ok(name in ui, `ui/index 少了导出：${name}`)
  }
})

test('状态机：set 归一化、clear 归零、同值不重复通知', () => {
  resetDynamicThemeForTest()
  assert.equal(getDynamicTheme().active, false)

  let notified = 0
  const unsubscribe = subscribeDynamicTheme(() => { notified += 1 })

  setDynamicTheme({ seed: '#6750A4', label: '某本书', origin: 'cover', bookId: 'b1' })
  assert.deepEqual(
    { active: getDynamicTheme().active, seed: getDynamicTheme().seed, origin: getDynamicTheme().origin },
    { active: true, seed: '#6750a4', origin: 'cover' },
  )
  const afterFirst = notified

  // 同一份 seed 再写一次：阅读器重渲染很频繁，重算一次配色就是每帧掉一次帧。
  setDynamicTheme({ seed: '#6750a4', label: '某本书', origin: 'cover', bookId: 'b1' })
  assert.equal(notified, afterFirst, '同值写入不应通知')

  // 换书：bookId 变了要通知（界面上的"颜色来自哪本书"文案要跟着改）。
  setDynamicTheme({ seed: '#6750a4', label: '另一本', origin: 'cover', bookId: 'b2' })
  assert.equal(notified, afterFirst + 1)
  assert.equal(getDynamicTheme().bookId, 'b2')

  clearDynamicTheme()
  assert.equal(getDynamicTheme().active, false)
  assert.equal(getDynamicTheme().seed, '')
  unsubscribe()
})

test('状态机：非法 seed 一律忽略，界面保持原皮肤', () => {
  resetDynamicThemeForTest()
  for (const bad of ['', '#fff', 'red', '#6750a', '#6750a4ff', 'javascript:alert(1)']) {
    setDynamicTheme({ seed: bad })
    assert.equal(getDynamicTheme().active, false, `${bad} 不该被当成有效主题`)
  }
})

test('覆盖层 CSS：只有 active 且 seed 合法才产出规则，选择器必须比 .theme-* 更具体', () => {
  const css = composeDynamicCss({ active: true, seed: '#6750a4', label: '', origin: 'cover', bookId: null }, { dark: false })
  assert.match(css, new RegExp(DYNAMIC_SELECTOR.replace('.', '\\.')))
  assert.match(css, /--canvas:\s*#[0-9a-f]{6}/i)
  assert.doesNotMatch(css, /NaN|undefined|null/, '产物里出现 NaN/undefined 说明色值算漏了')

  // 特异性硬约束：html + 类（0,1,1）才压得住运行时追加的自定义皮肤（0,1,0）。
  assert.equal(DYNAMIC_SELECTOR, 'html.theme-dynamic')
  assert.equal(DYNAMIC_CLASS, 'theme-dynamic')

  const inactive = composeDynamicCss({ active: false, seed: '', label: '', origin: 'none', bookId: null }, { dark: false })
  assert.equal(inactive, '')

  // 深浅两套必须真的不同：否则夜读皮肤下会挂浅色覆盖层。
  const light = composeDynamicCss({ active: true, seed: '#c62828', label: '', origin: 'manual', bookId: null }, { dark: false })
  const dark = composeDynamicCss({ active: true, seed: '#c62828', label: '', origin: 'manual', bookId: null }, { dark: true })
  assert.notEqual(light, dark)
})

test('种子上限闸：纯白/纯黑/灰封面不覆盖皮肤，彩封面才覆盖', () => {
  assert.equal(isSeedWorthApplying('#ffffff'), false)
  assert.equal(isSeedWorthApplying('#000000'), false)
  assert.equal(isSeedWorthApplying('#7f7f7f'), false, '灰图不该给出灰主题')
  assert.equal(isSeedWorthApplying('#c62828'), true)
  assert.equal(isSeedWorthApplying('#6750a4'), true)
  assert.equal(isSeedWorthApplying('not-a-color'), false)
})

test('弹簧令牌：五档齐全、写在 :root、且是 linear() 真弹簧', () => {
  const css = composeSpringCss()
  assert.match(css, /^:root\{/)
  for (const name of Object.keys(ui.SPRINGS)) {
    // CSS 自定义属性用小写连字符：pageTurn → page-turn。运行期写进 :root 的名字
    // 必须与 styles.css 末尾那份 cubic-bezier 兜底逐字一致，否则「JS 没跑时」那条兜底没人读。
    const kebab = name.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)
    assert.ok(css.includes(`--spring-${kebab}:`), `缺 --spring-${kebab}`)
  }
  assert.match(css, /linear\(/)
})

test('DOM 侧：没有 document 时 apply/remove 一律静默', () => {
  // node:test 里没有 DOM；这两个函数必须不抛 —— 否则任何在 Node 侧 import 门面
  // 的脚本（构建期工具、判据）都会因为"顺手引了 ui/index"而挂掉。
  assert.doesNotThrow(() => applyDynamicTheme({ active: true, seed: '#6750a4', label: '', origin: 'manual', bookId: null }, { dark: true }))
  assert.doesNotThrow(() => removeDynamicTheme())
})

test('分层：ui/** 不许 import features / components / app / plugins / lib', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(SRC, 'ui'))
  assert.ok(files.length >= 6, `ui/ 下只扫到 ${files.length} 个源文件，扫描面异常`)

  const offenders: string[] = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1]
      if (!spec.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(file), spec)
      const rel = path.relative(SRC, resolved).split(path.sep).join('/')
      if (/^(features|components|app|plugins|lib)\//.test(rel)) {
        offenders.push(`${path.relative(SRC, file)} → ${rel}`)
      }
    }
  }
  assert.deepEqual(offenders, [], '地基不许依赖业务层：' + offenders.join(' / '))
})

test('styles.css：弹簧兜底与「减少动态效果」降级还在', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  for (const name of ['responsive', 'gentle', 'snappy', 'bouncy', 'page-turn']) {
    assert.ok(css.includes(`--spring-${name}:`), `styles.css 缺 --spring-${name} 的 CSS 兜底`)
  }
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /html\.theme-dynamic/)
})
