import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书源左栏顶部的密度（用户 2026-11-07：「这个地方拥挤」）。
 *
 * 原来侧栏上半截是六行控件：标题+体检/批量 → 分组 → 筛选 → 新建（整行）→ 导入（整行）
 * → 地址导入（整行）。在 1440×900 上列表只剩三百来像素，5600 个源等于"看不到几条"。
 *
 * 现在压成三行：标题行 → 分组 → 筛选 → 「新建 / 导入」一行；导入面板默认收起，
 * 点开才出现文件选择与地址输入。这份判据盯的是**结构**，不是具体像素。
 */
const here = import.meta.dirname
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
const page = fs.readFileSync(path.resolve(here, '../src/features/source-editor/SourcesPage.tsx'), 'utf8')

test('新建与导入并排一行，不再各占整行', () => {
  const actions = /<div className="source-sidebar-actions">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? ''
  assert.ok(actions, '找不到 .source-sidebar-actions 行容器')
  assert.match(actions, /source-create-btn/, '新建按钮要在这一行里')
  assert.match(actions, /source-import-toggle/, '导入按钮要在这一行里')

  assert.match(css, /\.source-sidebar-actions \{[^}]*display: flex;/, '行容器要横向排')
  assert.match(css, /\.source-create-btn \{[^}]*flex: 1 1 auto;/, '新建吃掉剩余宽度')
  assert.match(css, /\.source-import-toggle \{[^}]*flex: 0 0 auto;/, '导入按内容宽度，不跟新建抢')
})

test('导入面板默认收起，点开才有文件选择与地址输入', () => {
  assert.match(page, /const \[importOpen, setImportOpen\] = useState\(false\)/, '默认必须收起')
  assert.match(page, /aria-expanded=\{importOpen\}/, '展开状态要让读屏知道')
  assert.match(page, /aria-controls="source-import-panel"/)

  // 两块低频控件都要在条件分支里，不能平铺在侧栏上。
  const panel = /\{importOpen && \(([\s\S]*?)\n        \)\}/.exec(page)?.[1] ?? ''
  assert.ok(panel, '找不到导入面板的条件渲染')
  assert.match(panel, /type="file"/, '文件选择在面板里')
  assert.match(panel, /aria-label="从地址导入书源"/, '地址导入在面板里')

  assert.match(css, /\.source-import-panel \{/, '面板要有自己的容器样式')
  assert.match(css, /\.source-import-panel \.import-button \{ margin: 0; \}/, '面板内控件不再自带外边距，否则又撑出一行')
})

test('分组与筛选之间的空隙收紧，别再白占一行高度', () => {
  const groupBar = /\.source-group-filter-bar \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(groupBar, /margin: 8px 16px 0/, '分组条上边距从 10 收到 8')

  const filter = /\.source-filter \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(filter, /margin: 8px 16px 10px/, '筛选框上边距从 18 收到 8')
})

/**
 * 两条都是 2026-11-07 用真浏览器量出来的版面 bug，肉眼只表现为"这行看着怪"：
 * ① 列表项里的 `<small>` 是行内盒，在按钮的 grid 行里被压成 1px（实测 small 高度 = 1px），
 *    于是「体检异常 / 未分组」这一行长期不存在；
 * ② `.source-list` 的隐式列是 max-content，批量模式那几行是 div（不是 width:100% 的 button），
 *    整列被撑到 351px、徽标被侧栏右缘裁掉。
 */
test('分组/体检那一行必须真的占一行高，批量行不许撑破侧栏', () => {
  const small = /\.source-list small \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(small, /display: block/, '<small> 不设 block 就会被 grid 压成 1px')

  const list = /\.source-list \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(list, /grid-template-columns: minmax\(0, 1fr\)/,
    '隐式列是 max-content 时，宽度由最宽的一行决定，批量行会把整列撑破')
})
