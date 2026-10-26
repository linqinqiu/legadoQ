import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书源页统计带的诚实性（PROPOSAL-023 的 C 档）。
 *
 * 依据是量出来的，不是印象：本机 5,574 份书源里 **`mainJs` 连键都没有（0 份）**，
 * 上游 `legado-out/upstream` 全仓 `mainJs` **0 命中**（`BookSource.kt` 那 27 个 `var` 里没有它），
 * 而**任一规则字段带 `@js:` / `js:` / `<js>` 的有 2,105 份（37.8%）**。
 * 所以"JS 书源 0"不是"你的库里没有 JS 源"，是那一档量了一个真实世界不存在的字段 ——
 * 一个恒为 0 的统计比没有这个统计更坏。`isJsSource` 与 `mainJs` 那条线留在服务端（它有测试、
 * 是显式支持的写法），这里只管让界面不再说谎。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
/** 只扫**会画到屏幕上**的那部分：注释里当然可以解释"为什么这一档被拿掉了"。 */
const codeOnly = (text: string) => text.split(/\r?\n/)
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('统计带只有数得出东西的四档，没有恒为 0 的那一档', () => {
  // 0.8.2 拆组：书源页在 pages/SourcesPage.tsx，sourceStats 那段跟着它走
  const main = read('..', 'src', 'pages', 'SourcesPage.tsx')
  const block = /const sourceStats = useMemo\(\(\) => \(\{([\s\S]*?)\}\)/.exec(main)
  assert.ok(block, '解析不到 sourceStats 那一段，这条判据在演空戏')
  const fields = [...block[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1])
  assert.deepEqual(fields, ['total', 'enabled', 'login', 'groups'],
    `统计带的档位变了：${fields.join('/')} —— 加一档之前先问"它在真库里会不会永远是 0"`)
})

test('界面上不再出现「JS 书源」这个说法', () => {
  // 反向断言：扫得更广才更严（拆出来的书源/书库/书架页与两个弹窗也一并进面）
  const files = ['main.tsx', path.join('pages', 'SourcesPage.tsx'), path.join('pages', 'LibraryPage.tsx'), path.join('pages', 'ShelfPage.tsx'), path.join('components', 'SourceChoiceList.tsx'), path.join('components', 'BookDetailModal.tsx'), path.join('sources', 'SourceEditorPanel.tsx'), path.join('lib', 'api.ts')]
  for (const name of files) {
    const text = codeOnly(read('..', 'src', ...name.split(path.sep)))
    assert.ok(!text.includes('JS 书源'), `${name} 里还写着「JS 书源」`)
  }
})

test('分组那一栏只说分组的事，不许拿"是不是 JS 源"去顶「未分组」', () => {
  // 0.8.2 拆组：分组栏那两行在 pages/SourcesPage.tsx（splitSourceGroups 也随它引自 sourceGrouping）
  const main = codeOnly(read('..', 'src', 'pages', 'SourcesPage.tsx'))
  const rows = main.split(/\r?\n/).filter(line => /splitSourceGroups\(source\.group\)[^<]*\|\|/.test(line))
  assert.ok(rows.length >= 2, `只解析到 ${rows.length} 处分组栏，这条在演空戏`)
  for (const row of rows) {
    assert.ok(/\|\| '未分组'/.test(row), `这一行还在用别的东西顶「未分组」：${row.trim().slice(0, 90)}`)
  }
  assert.ok(!/source\.isJsSource/.test(main), 'main.tsx 不该再读 isJsSource（它量的是 mainJs，真库里 0 份）')
  // 反向对照：老写法必须被上面那两条逮住
  const oldShape = `<small>{splitSourceGroups(source.group).join(' · ') || (source.isJsSource ? 'JS 书源' : '未分组')}</small>`
  assert.equal(/\|\| '未分组'/.test(oldShape), false, '反扫失效：老写法会被放过')
  assert.equal(/source\.isJsSource/.test(oldShape), true, '反扫失效：逮不住引用 isJsSource 的写法')
})

test('编辑器摘要的入参形状与统计带同源', () => {
  const panel = read('..', 'src', 'sources', 'SourceEditorPanel.tsx')
  const type = /summary\?: \{([^}]*)\}/.exec(panel)
  assert.ok(type, '解析不到 summary 的类型，这条在演空戏')
  const keys = [...type[1].matchAll(/(\w+):/g)].map(m => m[1]).sort()
  assert.deepEqual(keys, ['enabled', 'groups', 'login', 'total'], `摘要字段与统计带不同源：${keys.join('/')}`)
})
