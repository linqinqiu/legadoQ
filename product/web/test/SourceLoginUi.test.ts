import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 登录界面本地解析（书源自己的 loginUi）：判据钉的是"上游 APK 能做、我们不许退化"的几处形状。
 *
 * 1. 书源界面是第三个页签，凭据路径仍然只有真浏览器 / 粘贴 Cookie 两条；
 * 2. V1 动作走 /login-action（带 browserCompleted + browserBody），V2 走 /login-ui/action，
 *    状态变化后必须重新 /login-ui/render，不能拿旧 rows 硬撑；
 * 3. `java.startBrowserAwait(data:text/html;…)` 那一页要能显示、能整页回传，且 iframe 不能带 same-origin；
 * 4. Esc 在页面浮层打开时先关浮层，不能连登录浮层一起关掉。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8')

test('登录浮层把书源界面接成第三个页签，自动推荐与顶栏行为跟着走', () => {
  const modal = read('sources', 'SourceLoginModal.tsx')
  assert.match(modal, /function hasLocalLoginUi/, 'URL-only 的按钮不算本地界面，判定要单独成函数')
  assert.match(modal, /const hasLocalUi = hasLocalLoginUi\(uiResponse\)/, '页签与顶栏共用同一判定')
  assert.match(modal, /\{hasLocalUi && tab\('form', '书源界面'\)\}/, '本地界面页签要在')
  assert.match(modal, /setMethod\(hasLocalLoginUi\(res\) \? 'form'/, '有本地界面时默认落到书源界面')
  assert.match(modal, /await panelRef\.current\.submitLogin\(\)/, '顶栏「保存并登录」要复用界面的当前字段')
  assert.match(modal, /if \(panelRef\.current\?\.hasInlinePage\(\)\) return/, 'Esc 先让浮层处理')

  const panel = read('sources', 'SourceLoginUiPanel.tsx')
  assert.match(panel, /renderSourceLoginUi/, 'V2 的 state 变化要重新渲染')
  assert.match(panel, /executeSourceLoginUiAction/, 'V2 动作走 login-ui/action')
  assert.match(panel, /executeSourceLoginAction\(/, 'V1 动作走 login-action')
  assert.match(panel, /browserCompleted: true,\s*browserBody: html/s, '整页回传后要带着 HTML 重跑同一动作')
  assert.match(panel, /deliverRef\.current\(page\.action/, '回传必须用最新闭包，不能拿首帧的 loginState')
  assert.match(panel, /busyRef\.current/, 'busy 用 ref 兜住同轮动作')
})

test('本地页面 iframe：脚本能跑、表单能用，但不给 same-origin，并只认自己的消息', () => {
  const panel = read('sources', 'SourceLoginUiPanel.tsx')
  assert.match(panel, /sandbox="allow-scripts allow-forms allow-popups allow-modals"/,
    '登录/设置页要能跑脚本和表单，但禁止 allow-same-origin')
  assert.doesNotMatch(panel, /sandbox="[^"]*allow-same-origin/, '同源会让页面能碰父窗口')
  assert.match(panel, /__legadoInlineRequest/, '父窗口要能请求整页 HTML')
  assert.match(panel, /__legadoInline: true/, '只处理带标记的回包')
  assert.match(panel, /captureTimerRef/, '回包超时要有兜底提示')
  assert.match(panel, /setInline\(null\)[\s\S]{0,80}void continueInline\(inline, data\.html\)/, '拿到整页后关浮层并继续动作')
})

test('行类型覆盖上游 RowUi：无 action 的按钮当分隔标题，按钮支持倒计时', () => {
  const panel = read('sources', 'SourceLoginUiPanel.tsx')
  assert.match(panel, /if \(!row\.action\)/, '没有 action 的按钮是分隔标题')
  assert.match(panel, /countdowns\[row\.action\]/, '按钮倒计时来自 countdown')
  assert.match(panel, /row\.type === 'toggle'/, '开关')
  assert.match(panel, /row\.type === 'select'/, '下拉')
  assert.match(panel, /layout_flexBasisPercent/, '上游按百分比排的按钮要尊重宽度')

  const css = read('styles.css')
  assert.match(css, /\.source-login-form-grid/, '表单网格样式要在')
  assert.match(css, /\.source-login-inline-frame/, '本地页面 iframe 样式要在')
  assert.match(css, /\.source-login-form-scroll \{ max-height: min\(52vh, 480px\)/, '长表单要能滚，不把浮层撑爆')
})
