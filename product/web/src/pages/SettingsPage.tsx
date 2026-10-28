import React, { useState } from 'react'
import { filterSettingsSections } from '../settings/settingsSections'

/**
 * 「设置」（用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化之类的放进去」，
 * 并拍板「设置页收纳，原处只留快捷入口」）。
 *
 * 这一页**不重复实现任何编辑器**：每一行只是"它是什么 + 在哪儿改"，点下去仍然打开
 * 原来那个弹窗/页面（同一份实现，两个入口）。所以这里没有 settings prop、没有第二份数据状态 ——
 * 摆两个都能改的地方迟早会各改各的。
 *
 * 它有一个 `useState`，装的是**搜索框里的字**：那是这一页自己的界面态，不是任何设置的值。
 * 分区表与筛选算式都在 `settings/settingsSections.ts`，这里只管画。
 *
 * 从前这里还有第二套分区来源（`features/builtinSettings.ts` 的「自带分区」），唯一的内容是
 * 「界面偏好」：两个开关把值写进浏览器本地存储后没有任何地方读，描述的还是 0.8.4 就删掉的浮动窗口。
 * 说谎控件连同那套注册表一起删了 —— 设置项只有 `settingsSections` 一个来源。
 */
/**
 * 行的形状与分区类型都住在 `settings/settingsSections.ts`（数据权威源那侧），
 * 这里只重导出，`pages.tsx` 等既有 `from '../pages/SettingsPage'` 的引用不受影响。
 * 从前这两份类型定义在本文件里，`settingsSections.ts` 反过来 import 页面 ——
 * 等于让数据表依赖它的渲染者，与仓库「内容 → 框架」的单向纪律相反。
 */
export type { SettingsRow, SettingsSection } from '../settings/settingsSections'
import type { SettingsSection } from '../settings/settingsSections'

export function SettingsPage({ sections }: {
  sections: SettingsSection[]
}) {
  const [query, setQuery] = useState('')
  const shown = filterSettingsSections(sections, query)
  const searching = query.trim() !== ''
  const nothingMatched = searching && shown.length === 0
  return (
    <main className="settings-page">
      <header className="page-title">
        <div>
          <h1>设置</h1>
          {/* 这一句说的是这一页的逻辑：分类只是入口，不是第二份设置。 */}
          <p>按类别找到要改的项；点开仍是原来那个编辑器。</p>
        </div>
      </header>
      <div className="settings-search-row">
        {/* type=search 是刻意的：`/` 与 Ctrl/⌘+F 找"这一页的搜索框"就认这个选择器（见 main.tsx 的 focusSearch） */}
        {/* 关掉浏览器自动填充：Chrome 会把这个孤零零的输入框当成"联系邮箱"，
            点开设置就被塞进账号邮箱，然后报「没有匹配」。搜索框只该收用户自己敲的字。 */}
        <input
          type="search"
          className="settings-search"
          placeholder="搜设置项或分组"
          aria-label="搜设置项"
          name="settings-search"
          autoComplete="off"
          data-form-type="other"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        {searching && <button type="button" className="link-button" onClick={() => setQuery('')}>清空</button>}
      </div>
      {nothingMatched ? (
        <p className="settings-no-match">
          {`没有匹配「${query.trim()}」的设置项。`}
          <button type="button" className="link-button" onClick={() => setQuery('')}>清空搜索</button>
        </p>
      ) : shown.map(section => (
        <section key={section.title} className="settings-section">
          <h2>{section.title}</h2>
          {/* 控件直接长在这一档里的分区（壁纸与 Cookie）：实现只有一份，见 settingsSections 的说明 */}
          {section.content?.()}
          {section.rows.length > 0 && (
            <div className="settings-rows">
              {section.rows.map(row => (
                <div key={row.title} className="settings-row">
                  <div className="settings-row-main">
                    <strong>{row.title}</strong>
                    <small>{row.hint}</small>
                  </div>
                  <button type="button" className="subtle-button" onClick={row.onClick}>{row.action}</button>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </main>
  )
}
