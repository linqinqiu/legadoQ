import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「类名挂着、样式表里没有这条规则」= 控件按浏览器默认长相渲染。
 * 2026-10-03 全面审计时一次抓出六个：`.modal-card` / `.modal-header` / `.close-button`
 * 被书源体检与批量分组两个弹窗用着而样式表里 0 命中（于是标题栏没有内边距、`h2` 吃 UA 的 2em 粗体、
 * 关闭键是一颗没有尺寸的裸按钮），`.icon-btn` 同理（替换规则三处关窗键），
 * `.shelf-remove`、`.source-login-footer` 也一样；`.secondary-button` 与 `.rules-setting-btn`
 * 只在某个作用域里定义过，换个地方用就变成裸文字。
 *
 * 这里不做"每个 className 都必须有规则"的全量断言 —— 项目里有纯标记用的类名（给测试或
 * 父选择器用），全量判会逼着人往样式表里塞空规则来消红。判的是**这一批已经确认坏过的**，
 * 它们删掉就会立刻回到裸样式。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
const hasRule = (name: string) => new RegExp(`\\.${name}\\s*[,{:\\s]`).test(css)

test('浮层那一档有真实规则（不是靠 UA 默认长相）：一档外壳 / 一条遮罩 / 一颗关闭键 / 一行页头', () => {
  for (const name of ['dialog-shell', 'dialog-head', 'overlay-close', 'overlay-backdrop', 'icon-btn', 'shelf-remove', 'source-login-footer']) {
    assert.ok(hasRule(name), `.${name} 在 styles.css 里没有规则 —— 用它的那个控件会退回浏览器默认外观`)
  }
  // 壳的规则要真的带几何值，光有个类名等于没写
  const shell = /^\.dialog-shell \{([^}]*)\}/m.exec(css)?.[1] ?? ''
  for (const prop of ['max-height', 'border-radius', 'box-shadow', 'overflow']) {
    assert.match(shell, new RegExp(prop), `.dialog-shell 少了 ${prop}`)
  }
  // 宽度只能从令牌取，不许再写第五档像素值
  assert.match(shell, /width: min\(var\(--dw-m\), 94vw\)/, '.dialog-shell 的中间档没走 --dw-m 令牌')
  // 关闭键：30×30、无边框、不伸缩 —— §3.3 那一颗
  const close = /^\.overlay-close \{([^}]*)\}/m.exec(css)?.[1] ?? ''
  assert.match(close, /width: 30px/)
  assert.match(close, /height: 30px/)
  assert.match(close, /border: 0/)
  assert.match(close, /flex: none/)
  // 遮罩的底色只有一档令牌
  const backdrop = /^\.overlay-backdrop \{([^}]*)\}/m.exec(css)?.[1] ?? ''
  assert.match(backdrop, /background: var\(--backdrop\)/, '.overlay-backdrop 的底色要走 --backdrop 令牌')
  assert.match(/:root \{[\s\S]*?--backdrop: rgba\(0, 0, 0, \.45\)/.exec(css)?.[0] ?? '', /--backdrop/,
    '--backdrop 这一档不见了')
})

test('按钮档位都有全局基础档（换一处用不会变成裸文字）', () => {
  for (const name of ['primary-button', 'subtle-button', 'ghost-button', 'danger-button', 'secondary-button', 'rules-setting-btn']) {
    // 允许出现在选择器组里（`.a, .b {`），所以不能要求行首
    assert.ok(
      new RegExp(`(^|\\})\\s*[^{}]*\\.${name}\\s*[,{:]`).test(css),
      `.${name} 没有全局规则 —— 只在某个作用域里定义过的话，别处用它就是无框无底的裸文字`,
    )
  }
})

test('朗读悬浮条：挂载时就夹回视口，且不给底部导航让位的那条路已封住', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/reader/ttsBarPosition.ts'), 'utf8')
  // 存进去的坐标可能来自另一块屏；只监听 resize 的话手机上打开会留在屏幕外（连抓手一起）
  assert.match(src, /clampNow\(\)\s*\r?\n\s*window\.addEventListener\('resize'/,
    '挂载时必须先夹一次，而不是只等 resize')
  assert.match(src, /function bottomReserve/, '下边界要按移动端底部导航的实测高度留位')
  assert.match(src, /window\.innerHeight - size\.height - bottomReserve\(\)/)
  const css2 = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
  const bar = /\.tts-floating-bar \{([\s\S]*?)\n\}/.exec(css2)?.[1] ?? ''
  const z = Number(/z-index:\s*(\d+)/.exec(bar)?.[1] ?? '9999')
  const drawer = Number(/\.reader-drawer \{[\s\S]*?z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
  const backdrop = Number(/\.overlay-backdrop \{[^}]*z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
  assert.ok(z < drawer && z < backdrop,
    `朗读条压在抽屉与弹窗之上（bar ${z} / drawer ${drawer} / modal ${backdrop}）`)
})

test('页面级浮层都在挡片之下（弹窗开着时顶栏与批量条不能还亮着）', () => {
  const zIndex = (selector: string) => {
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const value = /z-index:\s*(\d+)/.exec(block)?.[1]
    assert.ok(block && value !== undefined, `${selector} 找不到带 z-index 的规则`)
    return Number(value)
  }
  const backdrop = zIndex('.overlay-backdrop')
  // 同值是"DOM 顺序决胜"的别名：今天恰好挡片在后，加一个 portal 就会翻过去
  for (const name of ['.app-page-header', '.source-batch-bar', '.tts-floating-bar']) {
    assert.ok(zIndex(name) < backdrop, `${name} 的 z 不小于挡片（${backdrop}）—— 弹窗会挡不住它`)
  }
})

test('体检弹窗不把"清单还没取到"写成"0 个书源"', () => {
  const modal = fs.readFileSync(path.resolve(import.meta.dirname, '../src/sources/SourceHealthModal.tsx'), 'utf8')
  // 0.8.2 拆组：传 sourcesState 的那个"父组件"就是书源页（pages/SourcesPage.tsx），断言逐字不变
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../src/pages/SourcesPage.tsx'), 'utf8')
  // 空数组有两种成因，只有一种该报数字
  assert.match(modal, /sourcesState: 'loading' \| 'ready' \| 'failed'/, '弹窗得知道清单到没到手')
  assert.match(page, /sourcesState=\{sourcesState\}/, '父组件得把它传进来')
  assert.match(page, /setSourcesState\('failed'\)/, '取失败要记成 failed，不能停在 loading 上装"还在读"')
  assert.match(modal, /disabled=\{running \|\| busyAction !== null \|\| sourcesState !== 'ready'/,
    '没取到之前那颗「开始体检」不能点着')
  const countLine = /sourcesState !== 'ready'[\s\S]{0,200}开始体检/.exec(modal)
  assert.ok(countLine, '数量那句话得先看过 sourcesState')
})

test('移动端底部导航的列数与真实按钮数对得上', () => {
  const reader = fs.readFileSync(path.resolve(import.meta.dirname, '../src/reader/ReaderScreen.tsx'), 'utf8')
  const nav = /<nav className="mobile-reader-nav">([\s\S]*?)<\/nav>/.exec(reader)?.[1] ?? ''
  const buttons = (nav.match(/<button/g) ?? []).length
  assert.ok(buttons > 0, '要真的取到那段导航（取空的话下面那条断言恒真）')
  const columns = Number(/\.mobile-reader-nav \{[\s\S]*?grid-template-columns: repeat\((\d+)/.exec(css)?.[1] ?? '0')
  assert.equal(columns, buttons, `导航渲染 ${buttons} 颗但样式只给 ${columns} 列 —— 多出来的会被固定高度裁掉`)
})

/**
 * 「TSX 挂着类名、样式表 0 命中」从人工发现变成常驻扫描（PROPOSAL-018 §5.3）。
 *
 * 2026-10-03 一次审计抓出 29 个，其中六个是真坏（弹窗标题吃 UA 的 2em、关闭键没有尺寸）。
 * 这类东西不会报错，只会安静地按浏览器默认长相画出来，所以必须每次跑。
 *
 * 只取**字符串字面量**里的 token：数组写法 `className={['a', cond && 'b']}` 里 `cond` 是标识符不是类名，
 * 模板串里的 `${…}` 会被换掉，剩下的尾带 `-` 的是动态前缀（真实类名要拼上去），按前缀查样式表。
 * 这两条不处理的话，扫描器会报出一堆 `.index`、`.value`、`.swatch-` 这种根本不存在的类名 ——
 * 一条会误报的判据，最后就是被人整体关掉。
 */
const MARKER_CLASSES: Record<string, string> = {
  'menu-header-title': '顶栏「我的」菜单里那行状态文字，版本门禁 version-check 按它定位',
  'health-stop-btn': '体检弹窗的「停止体检」，source-health-check 按它点键',
  'health-grouping-apply': '体检结论那三行「打标签」的按钮，source-health-check 按它点（删掉它门禁会点到空处）',
  'health-grouping-undo': '同一行的「撤销」，source-health-check 按它点',
  'source-login-entry-btn': '书源编辑器里那颗「登录」入口，source-editor-check 与 webview-login-probe 按它定位',
  'reader-flow-tail': '滚动模式章末提示条，reader-transition-check 按它判断"接不上下一章时有没有给提示"',
  // W2 并档之后，这些页面类名不再声明几何（宽高/圆角/阴影/动画都在 `.dialog-shell` 那一档），
  // 但门禁靠它们定位"是哪一张弹窗"。和上面几条同一个道理：没有样式 ≠ 没有用处。
  'book-detail-modal': '书籍详情弹窗的根节点，book-detail / explore-detail 两条门禁按它定位（16 处）',
  'customize-dialog': '「自定义」弹窗根节点，ui-shell-check 与 CustomizeSkin 按它定位',
  'toc-rules-modal': '「本地书分章规则」弹窗根节点，ui-shell-check 与 toc-rule-check 按它定位',
  'logs-modal': '运行日志弹窗根节点，logs-ui-check 按它定位（19 处）',
  'logs-modal-header': '日志弹窗那一行页头，logs-ui-check 按它取「自动跟随 / 导出」那排按钮',
  'shortcut-modal': '「快捷键」表弹窗根节点，shortcut-check 与 ui-shell-check 按它定位',
  'source-health-modal': '体检弹窗根节点，source-health-check 与 e2e 脚本按它定位',
  'source-group-modal': '批量分组弹窗根节点，source-health-check 按它定位',
  'book-manage-sheet': '「书籍管理」那张卡的根节点，shelf-layout-check 与 ui-shell-check 按它定位',
  'source-login-dialog': '书源登录弹窗根节点，source-login-check 按它定位',
  'source-webview-dialog': '内置浏览器弹窗根节点，source-editor-check 按它定位',
}

/**
 * 浮层的四件事实（PROPOSAL-018 W1 + W2）：弹窗挡片必须接 Esc、必须有 `role="dialog"` 与名字、
 * 必须套一档 `.dialog-shell` 外壳，而且这一档的宽高不许由 inline style 现场压。
 * 抽成纯函数是为了能被**注入反扫** —— 一条永远为真的判据等于没有判据（这条判据自己坏过一次：`rows > 0` 那种空判）。
 *
 * 两类挡片不算弹窗：`.is-menu`（顶栏「我的」菜单，语义是"点别处就关"）、
 * `.is-viewer`（正文配图的看图画布，整屏都是它的内容）。
 */
function dialogBackdropCount(src: string) {
  return [...src.matchAll(/className="(overlay-backdrop[^"]*)"/g)]
    .filter(match => !/is-menu|is-viewer/.test(match[1])).length
}

/** 元素串里用 inline style 压了弹窗宽高的处数（§3.3「禁止 inline style 覆盖宽高」）。 */
function inlineShellSizes(src: string) {
  const hits: string[] = []
  for (const match of src.matchAll(/className="[^"]*(dialog-shell|overlay-backdrop)[^"]*"[\s\S]{0,160}?\/?>/g)) {
    const tag = match[0]
    const style = /style=\{\{([^}]*)\}\}/.exec(tag)?.[1]
    if (style && /\b(width|maxWidth|minWidth|height|maxHeight|minHeight)\s*:/.test(style)) hits.push(style.trim())
  }
  return hits
}

function auditOverlays(files: { name: string; src: string }[]) {
  const problems: string[] = []
  for (const { name, src } of files) {
    const layers = dialogBackdropCount(src)
    if (layers === 0) continue
    const hooks = (src.match(/useEscapeClose\(/g) ?? []).length
    if (hooks === 0) problems.push(`${name}：${layers} 层挡片却一次 Esc 都没接（Esc 关不掉）`)
    const shells = (src.match(/className="[^"]*\bdialog-shell\b[^"]*"/g) ?? []).length
    if (shells < layers) problems.push(`${name}：${layers} 层弹窗挡片只有 ${shells} 个 .dialog-shell 外壳（第 ${shells + 1} 套几何就是这么长回来的）`)
    const dialogs = (src.match(/role="dialog"/g) ?? []).length
    if (dialogs < layers) problems.push(`${name}：${layers} 层挡片只有 ${dialogs} 处 role="dialog"（读屏软件找不到这一层）`)
    for (const match of src.matchAll(/role="dialog"[\s\S]{0,200}/g)) {
      if (!/aria-label[=:]|aria-labelledby/.test(match[0])) {
        problems.push(`${name}：有一处 role="dialog" 在 200 字内没有 aria-label（弹窗没有名字）`)
        break
      }
    }
    const inline = inlineShellSizes(src)
    if (inline.length > 0) problems.push(`${name}：${inline.length} 处用 inline style 压弹窗宽高（${inline.join(' / ')}）—— 宽度只有 --dw-s/m/l 三档`)
  }
  return problems
}

/**
 * 样式表侧的并档判据：外壳几何、遮罩、关闭键各自只许一档。
 * 判的是"这条规则声明了什么"，不是"类名叫什么" —— 改版前 17 套外壳里有一半名字并不像外壳。
 */
function shellRulesOf(bare: string) {
  const rules: { selector: string; body: string }[] = []
  for (const match of bare.matchAll(/([^}{}]+)\{([^}]*)\}/g)) {
    const selector = match[1].trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
    // 只看"一个类名本身"的规则：`.a b {}`、`.a, .b > c {}` 这类是内容样式，不是外壳
    if (!/^(\.[a-zA-Z][\w-]*)(,\s*\.[a-zA-Z][\w-]*)*$/.test(selector)) continue
    rules.push({ selector, body: match[2] })
  }
  return rules
}

function auditOverlayLayers(bare: string) {
  const problems: string[] = []
  const shells = shellRulesOf(bare).filter(({ body }) =>
    /max-height:/.test(body) && /border-radius:/.test(body) && /box-shadow:/.test(body))
    .map(({ selector }) => selector)
    .filter(selector => !SHELL_WHITELIST.has(selector.split(',')[0].trim()))
  if (shells.length > 0) problems.push(`又长出一套弹窗外壳几何：${shells.join('、')} —— 外壳只许 .dialog-shell 一档`)
  const backdrops = shellRulesOf(bare).filter(({ body }) =>
    /position: fixed/.test(body) && /inset: 0/.test(body) && /(rgba\(0, 0, 0|var\(--backdrop\))/.test(body))
    .map(({ selector }) => selector.split(',')[0].trim())
  if (backdrops.length > 2) problems.push(`遮罩有 ${backdrops.length} 档（${backdrops.join('、')}）—— §5.2 只许弹窗挡片 + 抽屉挡片两条`)
  const closes = shellRulesOf(bare).filter(({ body }) =>
    /width: 30px/.test(body) && /height: 30px/.test(body) && /border: 0/.test(body) && /place-items: center/.test(body))
    .map(({ selector }) => selector.split(',')[0].trim())
    .filter(selector => /close/i.test(selector))
  if (closes.length > 1 || (closes.length === 1 && closes[0] !== '.overlay-close')) {
    problems.push(`关闭键又分成几档（${closes.join('、') || '没有 .overlay-close'}）—— 只许 .overlay-close 一颗`)
  }
  return problems
}

/** 抽屉与悬浮条按 §3.3 保留自己的几何档（它们不是弹窗），所以在这三档里豁免。 */
const SHELL_WHITELIST = new Set(['.dialog-shell', '.reader-drawer', '.tts-floating-bar'])

test('浮层尺寸只有一处来源：菜单不许在 TSX 里写像素，夹取算式不许各写一份', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  // 只扫代码：注释里写"以前是 210 / 34，样式表是 196 / 32+2"是这段历史唯一的去处，
  // 判据若把它也算成违规，下一次就没人肯写注释了。
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const menu = code(fs.readFileSync(path.join(dir, 'components', 'ContextMenu.tsx'), 'utf8'))
  const select = code(fs.readFileSync(path.join(dir, 'components', 'Select.tsx'), 'utf8'))
  const geo = fs.readFileSync(path.join(dir, 'lib', 'overlayGeometry.ts'), 'utf8')

  // 菜单的宽高由样式表定（min-width:196 / 行 32 + 间隙 2），位置由挂载后量出来的真实矩形夹
  assert.match(menu, /useClampOverlay/, '右键菜单要用量出来的矩形夹进视口，不能再估宽高')
  assert.ok(!/\b(?:19[0-9]|2[0-9]{2}|3[0-9]{2})\b/.test(menu.replace(/z-index[^\n]*/g, '')),
    'ContextMenu.tsx 里不许出现像素常量 —— 原来写着 width=210、行=34，与样式表的 196 / 32+2 互相矛盾')
  assert.match(select, /clampOverlay\(/, 'Select 的夹取要走同一份算式')
  assert.match(geo, /OVERLAY_EDGE = 8/, '视口留白这一档只许在 overlayGeometry.ts 出现一次')
  assert.ok(!/Math\.max\(8, Math\.min\(/.test(select), 'Select 不能再手写一份"夹进 8px"')
  // 这三对是**同一件事的两个名字**：JS 里算的档，样式表又写了一遍。
  // 逐对查选择器与属性，不能拿"任何 .ui-select* 的 34px"去判 —— 触发器那一档本来就是 34px，与选项行高无关。
  assert.deepEqual(duplicateOverlayGeometry(css, select), [],
    'Select 的行高/上限档在 TSX 与样式表各写了一份 —— 这就是改版前"两份数值互相矛盾"的形状')
})

/** JS 常量与样式表里同一档像素的重复清单（抽成纯函数是为了能被注入反扫）。 */
function duplicateOverlayGeometry(cssText: string, selectText: string) {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const bare = code(selectText)
  const owned: [string, string, string][] = [
    ['MENU_MAX_HEIGHT', '.ui-select-menu', 'max-height'],
    ['LIST_MAX_H', '.ui-select-options', 'max-height'],
    ['ROW_H', '.ui-select-option', 'min-height'],
  ]
  const problems: string[] = []
  for (const [name, selector, prop] of owned) {
    const value = Number(new RegExp(`const ${name} = (\\d+)`).exec(bare)?.[1])
    if (!value) { problems.push(`${name} 在 Select.tsx 里没有定义`); continue }
    const block = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(cssText)?.[1]
    if (block === undefined) { problems.push(`样式表里找不到 ${selector} 这一档`); continue }
    if (new RegExp(`${prop}: ${value}px`).test(block)) {
      problems.push(`${selector} 写了 ${prop}: ${value}px，与 Select.tsx 的 ${name} 是同一件事的两份数值`)
    }
  }
  return problems
}

test('几何重复判据会红：把 340 塞回样式表，必须报出 MENU_MAX_HEIGHT 这一对', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const select = fs.readFileSync(path.join(dir, 'components', 'Select.tsx'), 'utf8')
  const injected = css.replace('.ui-select-menu { position: fixed;', '.ui-select-menu { max-height: 340px; position: fixed;')
  const problems = duplicateOverlayGeometry(injected, select)
  assert.ok(problems.some(p => p.includes('.ui-select-menu') && p.includes('MENU_MAX_HEIGHT')),
    '注入一份重复数值而判据不红，等于这条判据不存在')
  assert.deepEqual(duplicateOverlayGeometry(css, select), [], '把注入撤掉之后应当是干净的')
})


test('每个弹窗都接了 Esc、套了 .dialog-shell、有 role="dialog" 与名字，且不用 inline style 压宽高', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(n => n.endsWith('.tsx'))
    .map(n => ({ name: n, src: fs.readFileSync(path.join(dir, n), 'utf8') }))
  assert.deepEqual(auditOverlays(files), [],
    '浮层的 Esc / 外壳 / role / 名字 / inline 宽高不许再靠自觉（PROPOSAL-018 W1 ②④ + W2 §3.3）')
})

test('浮层并档之后：样式表里只剩一档外壳、两条遮罩、一颗关闭键', () => {
  assert.deepEqual(auditOverlayLayers(bareCss), [],
    '并完档又长回来 —— W2 收的就是这三档（17 套外壳 / 4 套遮罩 / 11 种关闭键）')
})

test('并档判据自己会红：注入第 17 套外壳、第三条遮罩、第二颗关闭键、一处 inline 宽高，四条都要报出来', () => {
  // 反向对照：这四样就是改版前的四种病。注入一样判据不红，等于那条判据不存在。
  const injected = `${bareCss}
.seventeenth-shell { max-height: 88vh; border-radius: 14px; box-shadow: 0 20px 50px rgba(0, 0, 0, .25); }
.third-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .3); }
.second-close { width: 30px; height: 30px; border: 0; display: grid; place-items: center; }`
  const problems = auditOverlayLayers(injected)
  assert.ok(problems.some(p => p.includes('第 17 套') || p.includes('seventeenth-shell')), '多一套外壳几何必须报')
  assert.ok(problems.some(p => p.includes('third-backdrop')), '多一条遮罩必须报')
  assert.ok(problems.some(p => p.includes('second-close')), '多一颗关闭键必须报')
  assert.deepEqual(auditOverlayLayers(bareCss), [], '撤掉注入之后应当是干净的')
})

test('浮层判据自己会红：缺 Esc、缺外壳、缺 role、缺名字、inline 压宽高，五条都要报出来', () => {
  const synthetic = [
    { name: 'NoEsc.tsx', src: '<div className="overlay-backdrop"><div className="dialog-shell" role="dialog" aria-modal="true" aria-label="x">' },
    { name: 'NoRole.tsx', src: '<div className="overlay-backdrop" onClick={onClose}><div className="dialog-shell" onClick={stop} /></div>', },
    { name: 'Unnamed.tsx', src: '<div className="overlay-backdrop"><div className="dialog-shell" role="dialog" aria-modal="true">useEscapeClose(onClose)', },
    { name: 'NoShell.tsx', src: '<div className="overlay-backdrop"><div className="legacy-shell" role="dialog" aria-label="x">useEscapeClose(onClose)', },
    { name: 'Inline.tsx', src: '<div className="overlay-backdrop"><div className="dialog-shell" style={{ width: \'min(820px, 94vw)\', maxHeight: \'90vh\' }} role="dialog" aria-label="x">useEscapeClose(onClose)', },
  ]
  const problems = auditOverlays(synthetic)
  assert.ok(problems.some(p => p.includes('NoEsc') && p.includes('Esc')), '缺 Esc 必须报')
  assert.ok(problems.some(p => p.includes('NoRole')), '缺 role="dialog" 必须报')
  assert.ok(problems.some(p => p.includes('Unnamed') && p.includes('aria-label')), '缺名字必须报')
  assert.ok(problems.some(p => p.includes('NoShell') && p.includes('dialog-shell')), '不套 .dialog-shell 必须报')
  assert.ok(problems.some(p => p.includes('Inline') && p.includes('inline style')), 'inline 压弹窗宽高必须报')
})

/** 样式表去掉块注释之后的正文（注释里写历史数值是给下一次改的人看的，不算违规）。 */
const bareCss = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 门禁用的类名必须真的长在界面上（PROPOSAL-018 W1 ③ 的配套判据）。
 *
 * 这一条是自己踩出来的：把"样式表 0 命中"的类名当死代码删掉时，`health-grouping-apply` /
 * `health-grouping-undo` 一起删了 —— 它们没有样式是对的，但 `source-health-check` 一直靠它们
 * 点「打标签 / 撤销」，于是 5 条判据当场红在探针上而不是产品上。
 * **"没有样式"不等于"没有用处"**：还有一类用处是当定位锚点。
 *
 * 三条口径不然这条判据就是一堆假红（第一版就是这么报了 28 个）：
 * ① 选择器串里的**逗号是"或"** —— `.a, .b` 命中一个就有效，必须整串一起判；
 * ② `next-*` 那两份门禁打的是**另一个仓库**（qingyue 的新骨架），不许拿旧界面的源码判它；
 * ③ v2 外壳回滚后 ui-shell-check 是在**断言那些类名不存在**，那种锚点天生该找不到，逐条写清是谁在钉。
 */
const GATE_ANCHOR_EXEMPT: Record<string, string> = {
  'app-rail': 'v2 侧栏外壳已整体回滚，ui-shell-check 判的是"它不许存在"',
  'page-bar': '同上（回滚钉桩）',
  'app-frame': '同上（回滚钉桩）',
  'rail-tabs': '同上（回滚钉桩）',
  'rail-item': '同上（回滚钉桩）',
  'shelf-density': '书架密度切换器已删，shelf-layout-check 断言 densityControl === false',
  'explore-search': '发现页那格"在这个源里搜书名"已按用户要求删除，source-picker-check 断言它不许回来',
  'ui-select-more': '选项截断提示已随虚拟滚动删除，source-picker / source-scale 两条都写成"没有也算过"',
  'source-webview-viewport-picker': '内置浏览器的手机/平板/铺满切换器已删，source-editor-check 断言 picker === false',
  'shelf-card-read-track': '封面下沿的阅读进度条已删（用户 2026-10-03），shelf-layout-check 判的是"它不许回来"',
  'shelf-card-read-fill': '同上（那条带的填充）',
}

/** 只报数不判红的一次性审计脚本 —— 它们不是门禁，选择器过期不会让任何人误判产品 */
const AUDIT_ONLY = /^(overlay-audit|controls-audit|uiaudit|icon-square-census|index-selector-census|context-dialect-census|replace-regex-census|.*-measure|.*-census)$/

function gateAnchorProblems(gates: { name: string; src: string }[], appText: string) {
  const missing: string[] = []
  for (const { name, src } of gates) {
    const bare = name.replace(/\.mjs$/, '')
    if (AUDIT_ONLY.test(bare)) continue
    // 只认引号里的选择器串：querySelector('...') / waitForSelector('...') / $('...') / clickByText('...')
    for (const match of src.matchAll(/(?:querySelector(?:All)?|waitForSelector|\$+|clickByText)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      const alternatives = match[1].split(',').map(part => part.trim()).filter(Boolean)
      // 整串里只要有一档整体活着，这条锚点就还有效
      if (alternatives.some(part => segmentGaps(part, appText).length === 0)) continue
      for (const part of alternatives) {
        for (const token of segmentGaps(part, appText)) {
          if (GATE_ANCHOR_EXEMPT[token]) continue
          missing.push(`${name} 的「${match[1].trim()}」这一档 .${token} 在界面源码与样式表里都没有`)
        }
      }
    }
  }
  return [...new Set(missing)]
}

/** 一个候选里"这一档找不到"的类名；一档全都有就返回空数组。 */
function segmentGaps(selector: string, appText: string): string[] {
  const gaps: string[] = []
  for (const segment of selector.split(/[\s>+~]+/).filter(Boolean)) {
    const tokens = classesIn(segment)
    if (tokens.length === 0) continue
    const alive = tokens.find(token => appText.includes(token))
    if (!alive) gaps.push(...tokens.filter(token => !appText.includes(token)))
  }
  return [...new Set(gaps)]
}

function classesIn(selector: string): string[] {
  return (selector.match(/\.[a-z][a-z0-9_-]{2,}/gi) ?? []).map(c => c.slice(1)).filter(t => !t.includes('$'))
}

test('门禁里的选择器锚点都还长在界面上（删类名要先查门禁）', () => {
  const verifyDir = path.resolve(import.meta.dirname, '../../tools/verify')
  // next-* 打的是 qingyue 那份新骨架（另一个仓库），env/zip-make/… 是工具不是门禁
  const gates = fs.readdirSync(verifyDir).filter(n => n.endsWith('.mjs') && !AUDIT_ONLY.test(n) && !/^(next-|env|multipart|zip-make|make-ico|render-icons|preview|snapshot|commit-pending|extract-|testreport|test-failure|chaincheck|archive-verify|md-table-check|frame-metrics)/.test(n))
    .map(n => ({ name: n, src: fs.readFileSync(path.join(verifyDir, n), 'utf8') }))
  const dir = path.resolve(import.meta.dirname, '../src')
  const appText = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(n => /\.(ts|tsx|css)$/.test(n))
    .map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n')
  assert.deepEqual(gateAnchorProblems(gates, appText), [],
    '门禁点的东西在旧界面里不存在 —— 要么是被当死类名删了，要么是界面改了口而门禁没跟')
})

test('回滚钉桩的豁免不腐：每一项都还得真的被某份门禁引着', () => {
  const verifyDir = path.resolve(import.meta.dirname, '../../tools/verify')
  const all = fs.readdirSync(verifyDir).filter(n => n.endsWith('.mjs')).map(n => fs.readFileSync(path.join(verifyDir, n), 'utf8')).join('\n')
  for (const token of Object.keys(GATE_ANCHOR_EXEMPT)) {
    assert.ok(all.includes(token), `豁免里的 .${token} 已经没有任何门禁引用了，条目该删`)
  }
})

test('锚点判据自己会红：抹掉 anchor 必须报，逗号备选里还剩一个就不许报', () => {
  const probe = [{ name: 'x-check.mjs', src: "page.waitForSelector('.health-grouping-apply')" }]
  assert.deepEqual(gateAnchorProblems(probe, '完全没有那个类名的源码'),
    ['x-check.mjs 的「.health-grouping-apply」这一档 .health-grouping-apply 在界面源码与样式表里都没有'])
  assert.deepEqual(gateAnchorProblems(probe, '<button className="health-grouping-apply">'), [])
  // 逗号是"或"：一个候选没了、另一个还在，选择器照样有效 —— 这条不处理就是 28 个假红里的 majority
  const either = [{ name: 'y-check.mjs', src: "document.querySelector('.gone-anchor, .explore-tab')" }]
  assert.deepEqual(gateAnchorProblems(either, '.explore-tab { color: red }'), [])
  assert.deepEqual(gateAnchorProblems(either, '两个候选都没有'), [
    'y-check.mjs 的「.gone-anchor, .explore-tab」这一档 .gone-anchor 在界面源码与样式表里都没有',
    'y-check.mjs 的「.gone-anchor, .explore-tab」这一档 .explore-tab 在界面源码与样式表里都没有',
  ])
})

function classNamesIn(src: string): string[] {
  const patterns = [
    /className="([^"]*)"/g,
    /className=\{`([^`]*)`\}/g,
    /className=\{\[([\s\S]*?)\]\.join/g,
  ]
  const tokens: string[] = []
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      const arrayForm = pattern === patterns[2]
      const cleaned = match[1].replace(/\$\{[^}]*\}/g, ' ')
      // 数组写法只认引号里的内容：引号外的是表达式标识符（`index === active ? 'active' : ''` 里的 index 不是类名）
      const text = arrayForm
        ? (cleaned.match(/['"`]([^'"`]*)['"`]/g) ?? []).map(s => s.slice(1, -1)).join(' ')
        : cleaned
      tokens.push(...text.split(/[\s,]+/).filter(Boolean))
    }
  }
  return tokens
}

test('界面类名不再有"挂着而样式表 0 命中"的新增项', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const used = new Map<string, string>()
  for (const file of fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith('.tsx'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const token of classNamesIn(src)) {
      if (!/^[a-z][a-z0-9_-]*$/i.test(token)) continue
      if (!used.has(token)) used.set(token, file)
    }
  }
  const offenders: string[] = []
  for (const [token, file] of used) {
    if (MARKER_CLASSES[token]) continue
    // 动态前缀（`swatch-`、`tier-`）：真实类名是拼出来的，按前缀查
    const hit = token.endsWith('-')
      ? css.includes(`.${token}`)
      : hasRule(token)
    if (!hit) offenders.push(`.${token}（${file}）`)
  }
  assert.deepEqual(offenders, [], `这些类名挂在界面上而样式表里一条规则都没有，控件会退回浏览器默认长相：\n  ${offenders.join('\n  ')}`)
})

test('标记类白名单不腐：每一项都还要被界面用着，并且真的有门禁在引它', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const srcTokens = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(n => n.endsWith('.tsx'))
    .flatMap(n => classNamesIn(fs.readFileSync(path.join(dir, n), 'utf8')))
  const gatesDir = path.resolve(import.meta.dirname, '../../tools/verify')
  const testsDir = path.resolve(import.meta.dirname, './')
  const gates = [gatesDir, testsDir].flatMap(folder => fs.readdirSync(folder)
    .filter(n => /\.(mjs|ts)$/.test(n))
    .map(n => fs.readFileSync(path.join(folder, n), 'utf8'))).join('\n')
  for (const token of Object.keys(MARKER_CLASSES)) {
    assert.ok(srcTokens.includes(token), `白名单里的 .${token} 已经没人用了，条目和那个类名都该删`)
    assert.ok(gates.includes(token), `.${token} 没有任何门禁引用，它不是锚点就是死类名 —— 应该补样式或直接删掉`)
  }
})


// ———— 复选框的可访问名字（AI-2 任务 C·模块 4「书源管理 UI」）————

/**
 * 扫一个 JSX 源里的每个 `type="checkbox"`，判它有没有可访问名字。
 * 算有名字只有两种：输入标签自己带 `aria-label`，或包住它的 `<label>` 里真有文字
 * （`<label><input/>{计数}</label>` 这种只有插值的，读屏念出来是空的）。
 */
function checkboxSites(source: string): Array<{ line: number; named: boolean }> {
  const found: Array<{ line: number; named: boolean }> = []
  const re = /<input\b[^>]*type="checkbox"[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const tag = match[0]
    const before = source.slice(Math.max(0, match.index - 260), match.index)
    let named = /aria-label\s*=/.test(tag)
    if (!named) {
      const labelStart = before.lastIndexOf('<label')
      if (labelStart >= 0) {
        const tail = source.slice(match.index + tag.length, match.index + tag.length + 400)
        const end = tail.indexOf('</label>')
        const labelText = (end >= 0 ? tail.slice(0, end) : tail).replace(/\{[^{}]*\}/g, '')
        named = /[\u4e00-\u9fa5A-Za-z]{2,}/.test(labelText)
      }
    }
    found.push({ line: source.slice(0, match.index).split('\n').length, named })
  }
  return found
}

test('判据自证：这颗扫描器能认出"空 label 包住复选框"这种没名字的形状', () => {
  const sample = [
    '<label><input type="checkbox" checked />只看能读的</label>',
    '<label className="x"><input',
    '  type="checkbox"',
    '  checked={v}',
    '/></label>',
    '<input type="checkbox" aria-label={`选择《${v}》`} checked />',
  ].join('\n')
  const sites = checkboxSites(sample)
  assert.equal(sites.length, 3, `扫出 ${sites.length} 处，应当是 3 处`)
  assert.deepEqual(sites.map(s => s.named), [true, false, true],
    '第 2 处（label 里除了输入什么都没有）必须被判成没名字，否则整条判据是空判')
})

test('web/src 里每颗粒复选框都要有可访问名字', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'src')
  const unnamed: string[] = []
  let total = 0
  for (const file of fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith('.tsx'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const site of checkboxSites(source)) {
      total += 1
      if (!site.named) unnamed.push(`${file}:${site.line}`)
    }
  }
  assert.ok(total >= 13, `全站复选框只扫到 ${total} 处，太少说明扫描器没跟上新代码`)
  assert.deepEqual(unnamed, [], `这些复选框读屏念得出"复选框"却念不出它是干什么的：${unnamed.join('、')}`)
})

/**
 * 浮层之间跳转后**关得回去**（真机门禁 `ui-shell-check` 抓到的回归）。
 *
 * 场景：「关于」页上有「更新日志」「快捷键」两个按钮。点进去之后 `openModal` 变成目标浮层，
 * 关于被卸载；再关掉目标浮层时，如果只做 `setOpenModal(null)`，用户被**扔回主界面** ——
 * 而不是回到刚才那个「关于」。
 *
 * 实测路径（`ui-shell-check` 的 ③ 段）：
 *   关于 → 快捷键 → 关闭 → 期望回到关于，实际 `.about-actions` 已经没了 → 后续点「更新日志」失败。
 *
 * 判据：从浮层内部跳到另一个浮层必须走 `openModalFrom`（记来源），
 * 且关闭统一走 `closeModal`（有来源先回来源），不能再用 `setOpenModal(null)`。
 */
test('浮层内跳转要记来源，关闭要能回到上一层的浮层', () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')

  // 1) 必须存在"记来源"与"回退"这两个函数
  assert.match(main, /const openModalFrom = \(next: AppModal, from: AppModal\)/, '缺少 openModalFrom（浮层内跳转要记来源）')
  assert.match(main, /const closeModal = \(\) =>/, '缺少 closeModal（关闭时要能回退）')

  // 2) closeModal 必须有"有来源先回来源"的分支，不能直接 setOpenModal(null)
  const closeBody = /const closeModal = \(\) => \{([\s\S]*?)\n  \}/.exec(main)?.[1] ?? ''
  assert.ok(closeBody.length > 40, '取不到 closeModal 的函数体（取空串下面断言对什么都成立）')
  assert.match(closeBody, /if \(modalBackTo\)/, 'closeModal 必须先判有没有来源')
  assert.match(closeBody, /setOpenModal\(back\)/, 'closeModal 有来源时要回到来源浮层')

  // 3) 关于浮层里的两个跳转必须走 openModalFrom，而不是直接 setOpenModal
  assert.match(main, /onOpenChangelog=\{\(\) => openModalFrom\('changelog', 'about'\)\}/,
    '关于 → 更新日志 必须记来源')
  assert.match(main, /onOpenShortcuts=\{\(\) => openModalFrom\('shortcuts', 'about'\)\}/,
    '关于 → 快捷键 必须记来源')

  // 4) 所有浮层的 onClose 统一走 closeModal —— 留一个 setOpenModal(null) 就是留一个"回不去"的坑
  const rawNullCloses = [...main.matchAll(/onClose=\{\(\) => setOpenModal\(null\)\}/g)]
  assert.deepEqual(rawNullCloses.map(m => m[0]), [],
    '这些浮层关闭时没走 closeModal，从别的浮层跳进来就回不去了')
})

/**
 * 从**主界面**打开浮层必须清空返回栈。
 *
 * 反例：上一次"关于 → 快捷键"留下 `modalBackTo = 'about'`；用户关掉后回到主界面，
 * 再从设置页打开快捷键 —— 若不清空，关掉时会凭空跳回「关于」。
 */
test('从主界面打开浮层要清空返回栈（否则会凭空跳回上一次的来源）', () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  assert.match(main, /const openModalDirect = \(next: AppModal\) =>/, '缺少 openModalDirect')
  const body = /const openModalDirect = \(next: AppModal\) => \{([\s\S]*?)\n  \}/.exec(main)?.[1] ?? ''
  assert.match(body, /setModalBackTo\(null\)/, 'openModalDirect 必须先清空返回栈')

  // 设置页/顶栏那些入口都该走 openModalDirect
  for (const entry of ['openShortcuts', 'openOfflineCache', 'openCustomize', 'openBackup', 'openLogs', 'openServerPort', 'openAiConnections']) {
    assert.match(main, new RegExp(`${entry}: \\(\\) => openModalDirect\\('`),
      `${entry} 应从主界面打开（走 openModalDirect 清空返回栈）`)
  }
})
