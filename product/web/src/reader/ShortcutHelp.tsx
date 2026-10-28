// 这张表在 `web/test` 里是被 `renderToStaticMarkup` 静态渲染的，那条链路走 classic JSX
// （`React.createElement`），Vite 构建才走 automatic runtime。删掉这行"没在用的导入"
// 只会让套件里这一条红，页面与构建都看不出问题（AGENTS §5，PageBar/Notice 撞过同一坑）。
import React from 'react'
import { SHORTCUT_TABLES } from './shortcuts'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「快捷键」这张表（用户 2026-10-02：「加入一些快捷键快捷方式」）。
 *
 * 内容直接渲染 `shortcuts.ts` 那一份表 —— 处理器查的也是它，所以界面上写着的键
 * 与真的能按的键不可能各说一套。
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  return <div className="overlay-backdrop" onClick={onClose}>
    <div className="dialog-shell size-m shortcut-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="快捷键">
      <div className="dialog-head">
        <h2>快捷键</h2>
        <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭快捷键表"><Icon name="close" /></button>
      </div>
      <div className="drawer-scroll-content">
        {SHORTCUT_TABLES.map(table => {
          const groups = [...new Set(table.items.map(item => item.group))]
          return <section key={table.scope} className="setting-section">
            <span className="setting-label">{table.title}</span>
            {groups.map(group => <dl key={group} className="shortcut-list">
              <dt className="shortcut-group">{group}</dt>
              {table.items.filter(item => item.group === group).map(item => <div key={item.action} className="shortcut-row">
                <dd><kbd>{item.display}</kbd>{item.label}</dd>
              </div>)}
            </dl>)}
          </section>
        })}
        <p className="setting-hint">输入框里打字不会触发快捷键；带修饰键的条目只有表里写着的这几条 —— Ctrl / ⌘ + F（阅读器里让给浏览器）、Ctrl / ⌘ + 滚轮与 Alt + ← / →，其余组合都交给浏览器。</p>
      </div>
    </div>
  </div>
}
