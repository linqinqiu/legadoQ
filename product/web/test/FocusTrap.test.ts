import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 弹层焦点锁（2026-11-10 前端审计 A6）。
 *
 * `role="dialog"` + `aria-modal="true"` 只是"说明"，键盘不会自己遵守：没有这道锁，
 * Tab 会从浮层一路跑到背后的阅读器/书架上，读屏用户也会读到背景内容。
 * 这类不变量在 node:test 里跑不了真 DOM，所以钉的是**接线与关键分支**。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('hook 本身：只在弹层里循环 Tab，关闭时还焦点', () => {
  const hook = read('../src/lib/useFocusTrap.ts')
  assert.match(hook, /event\.key !== 'Tab'/, '只拦 Tab，其它键不抢')
  assert.match(hook, /document\.addEventListener\('keydown', onKeyDown, true\)/, '挂 document 捕获阶段：焦点跑出去也能拽回来')
  assert.match(hook, /previous\?\.focus/, '关闭时把焦点还给打开它的那个元素')
  assert.match(hook, /setAttribute\('tabindex', '-1'\)/, '没有可聚焦子元素时，容器自己接住焦点')
  assert.match(hook, /preventScroll: true/, '移焦点不该顺带把背景页滚走')
  assert.match(hook, /offsetParent !== null/, '隐藏元素（折叠区里的按钮）不进 Tab 循环')
})

test('嵌套弹层：只有最上层处理 Tab，关闭后出栈', () => {
  const hook = read('../src/lib/useFocusTrap.ts')
  assert.match(hook, /const activeTraps: symbol\[\] = \[\]/, '要有打开的弹层栈')
  assert.match(hook, /activeTraps\.push\(token\)/, '打开时入栈')
  assert.match(hook, /activeTraps\[activeTraps\.length - 1\] === token/, '只认栈顶')
  assert.match(hook, /if \(!isTopmost\(\)\) return/, '父层不能把焦点从子弹层里拽回去')
  assert.match(hook, /activeTraps\.splice\(index, 1\)/, '关闭时出栈，别留下假活锁')
})

test('三处弹窗真的接上了：共用壳 + 书籍详情 + 替换规则', () => {
  for (const file of ['PageDialog.tsx', 'BookDetailModal.tsx', 'ReplaceRulesModal.tsx']) {
    const src = read('../src/components/' + file)
    assert.match(src, /useFocusTrap\(shellRef/, `${file} 要接上焦点锁`)
    assert.match(src, /ref=\{shellRef\}/, `${file} 的对话框壳要带 ref`)
  }
})

test('新增接线过的真弹层也进了守护清单（分类：真正阻断 Tab 的是 dialog + overlay）', () => {
  // 不把所有带 aria-modal 的文件都塞进来 —— 许多是抽屉/面板（不阻断 Tab），盲接会抢焦点。
  // 这里列的是「根元素就是 dialog + aria-modal」的真弹层，逐个接上。
  for (const file of [
    'BrandModal.tsx',
    'LogsModal.tsx',
    'OfflineCacheModal.tsx',
    'ServerPortModal.tsx',
    'SourceSwitchModal.tsx',
    'TocRulesModal.tsx',
  ]) {
    const src = read('../src/components/' + file)
    assert.match(src, /useFocusTrap\(shellRef/, `${file} 要接上焦点锁`)
    assert.match(src, /ref=\{shellRef\}/, `${file} 的对话框壳要带 ref`)
  }
  const readerDialogs = [
    '../src/features/reader/dialogs/RefreshChaptersModal.tsx',
    '../src/features/reader/dialogs/BookSearchDialog.tsx',
  ]
  for (const file of readerDialogs) {
    const src = read(file)
    assert.match(src, /useFocusTrap\(shellRef/, `${file} 要接上焦点锁`)
    assert.match(src, /ref=\{shellRef\}/, `${file} 的对话框壳要带 ref`)
  }
})

test('替换规则：hook 在早退之前无条件调用，否则 React 会报 hook 数量变化', () => {
  const src = read('../src/components/ReplaceRulesModal.tsx')
  const hookAt = src.indexOf('useFocusTrap(shellRef')
  const earlyReturn = src.indexOf('if (!isOpen) return null')
  assert.ok(hookAt > 0 && earlyReturn > 0, '两处都要存在')
  assert.ok(hookAt < earlyReturn, 'hook 必须在 `if (!isOpen) return null` 之前')
  assert.match(src, /useFocusTrap\(shellRef, isOpen\)/, '关着的时候不该抢焦点')
})
