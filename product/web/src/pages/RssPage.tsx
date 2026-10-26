import React from 'react'
import { RssPanel } from './RssPanel'
import { SourceSubscriptionPanel } from '../sources/SourceSubscriptionPanel'

/**
 * 「订阅」页 —— 这里放**两件不同的事**，各占一块、各有标题，不让用户猜：
 *
 * 1. **书源订阅**（上游 `RuleSub` / `sourceSub.json`）：一条「返回书源 JSON 的直链」，
 *    每 6 小时同步一次，产物是**书源**。
 * 2. **RSS 订阅源**（上游 `RssSource`）：一个站点或栏目的文章流，产物是**可读的文章**。
 *
 * 以前书源订阅挂在「书源」页里（因为它同步出来的东西是书源），结果是书源页右栏被订阅面板撑长、
 * 用户也觉得「订阅地址」跑错了地方。现在统一收到「订阅」页：两件事并列，一眼能分清。
 */
export function RssPage({ onOpenBackup }: { onOpenBackup: () => void }) {
  return (
    <main className="rss-page">
      <header className="page-title">
        <div>
          <h1>订阅</h1>
          <p>两类订阅：书源订阅（同步远程书源 JSON，产物是书源）与 RSS 文章源（读文章，产物是文章）。</p>
        </div>
      </header>

      {/* 一、书源订阅：产物是书源 */}
      <section className="subscription-block" aria-label="书源订阅">
        <SourceSubscriptionPanel onSourcesChange={() => undefined} />
      </section>

      {/* 二、RSS 文章源：产物是文章 */}
      <section className="subscription-block" aria-label="RSS 文章源">
        <RssPanel onOpenBackup={onOpenBackup} />
      </section>
    </main>
  )
}
