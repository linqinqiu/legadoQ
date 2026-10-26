import React, { useCallback, useEffect, useState } from 'react'
import { api, type ChangelogRelease } from '../lib/api'
import { Notice } from '../components/Notice'

/**
 * 应用内的「更新日志」页。
 *
 * 为什么要有这一张（用户 2026-10-01：「你还没有做更新日志」）：版本号在顶栏能看到，
 * 但"这一版改了什么"只在仓库根的 CHANGELOG.md 里 —— 用浏览器读小说的人不会去翻仓库，
 * 于是"更新了"这件事对他是不可见的。服务端把 CHANGELOG.md 随包发出（`GET /api/changelog`），
 * 这里解析成"版本 → 分组 → 条目"渲染。
 *
 * 解析器 `parseChangelog` 单独导出：判据要能离线跑（喂一段已知文本，核对结构），
 * 而不是只能靠"页面上看着有字"。
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let current: ChangelogRelease | null = null
  let group: { title: string; items: string[] } | null = null
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd()
    const heading = /^## \[(.+?)\](?:\s*-\s*(.+))?$/.exec(line.trim())
    if (heading) {
      if (group && current) current.groups.push(group)
      group = null
      current = { version: heading[1].trim(), date: (heading[2] ?? '').trim(), groups: [], preamble: [] }
      releases.push(current)
      continue
    }
    if (!current) {
      // 第一个版本之前的前言（"版本号只有一个来源…"那类说明），留着显示在顶部
      continue
    }
    const sub = /^### (.+)$/.exec(line.trim())
    if (sub) {
      if (group) current.groups.push(group)
      group = { title: sub[1].trim(), items: [] }
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim())
    if (bullet) {
      if (!group) { group = { title: '', items: [] } }
      // 条目里常有续行（缩进两格），把它们并回上一条，不拆成新的条目
      const text = bullet[1].trim()
      if (text) group.items.push(text)
      continue
    }
    if (line.trim().startsWith('>')) {
      // 引用块是一句独立的话（CHANGELOG 里用来写"注意"），不并进上一条
      if (group) group.items.push(line.trim())
      continue
    }
    if (line.trim() && group && group.items.length) {
      // 续行：并回上一条（一条日志常占多行，拆开给用户看就是半截话）。
      // 空格只在两端不都是中日韩字符时补 —— 中文换行本来没有空格，无条件补会在每个
      // 全角括号前留一个洞；反过来 ASCII 标识符被折断时（`a.xml` / \n `b.json`）不补空格就粘成一个词。
      // 注意：**不能**把"以反引号开头的行"当成新条目 —— 那多半正是上一条被换行切断的后半截
      // （实测：「`config.xml` / `videoConfig.xml` /」+「`autoTask.json` …不落盘。」被拆成两条）。
      const cont = line.trim()
      const prev = group.items[group.items.length - 1]
      // 汉字 / 假名 / 中日韩标点 / 全角形式 —— 按码位判，别写成正则字符范围：
      // `[ -〿…]` 那种写法把"空格到 U+303F"当成一个区间，把整个 ASCII 都圈了进去。
      const cjk = (ch: string) => {
        const code = ch.codePointAt(0) ?? 0
        return (code >= 0x3000 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
          || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff65)
      }
      const glued = cjk(prev.slice(-1)) && cjk(cont.charAt(0))
      group.items[group.items.length - 1] = glued ? prev + cont : `${prev} ${cont}`
      continue
    }
    if (line.trim() && !group) current.preamble.push(line.trim())
  }
  if (group && current) current.groups.push(group)
  return releases
}

/** Markdown 的粗体与行内代码：只处理界面里真会出现的三种，不做完整 markdown 渲染。 */
function richText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return <span key={index}>{part}</span>
  })
}

export function ChangelogPage({ serverVersion }: { serverVersion: string }) {
  const [releases, setReleases] = useState<ChangelogRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    api.changelog()
      .then(text => setReleases(parseChangelog(text)))
      .catch(reason => setError(reason instanceof Error ? reason.message : '无法读取更新日志'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <section className="changelog-page">
      {/* 标题由悬浮层头给（0.6.27）。只报"当前跑的是哪一版"这个事实；拿不到就什么都不说，
          不写"版本号以服务端报回的为准"这种讲实现的话。 */}
      {serverVersion && <p className="page-lead">当前运行的是 {serverVersion}。</p>}
      {loading && <p className="changelog-loading">正在读取…</p>}
      {!!error && (
        <Notice
          text={`${error} —— 这个包里没有随包的 CHANGELOG 文本，或读取失败。`}
        />
      )}
      {!loading && !error && releases.length === 0 && (
        <p className="changelog-empty">更新日志是空的。</p>
      )}
      {!loading && !error && releases.length > 0 && (
        <div className="changelog-list">
          {releases.map(release => (
            <section key={release.version} className={`changelog-release ${release.version === serverVersion ? 'current' : ''}`}>
              <header>
                <h2>{release.version}</h2>
                {release.date && <time>{release.date}</time>}
                {release.version === serverVersion && <span className="changelog-flag">当前版本</span>}
              </header>
              {release.preamble.length > 0 && <p className="changelog-preamble">{richText(release.preamble.join(' '))}</p>}
              {release.groups.map((group, groupIndex) => (
                <div key={`${release.version}-${group.title}-${groupIndex}`} className="changelog-group">
                  {group.title && <h3>{group.title}</h3>}
                  <ul>
                    {group.items.map((item, index) => <li key={`${release.version}-${groupIndex}-${index}`}>{richText(item)}</li>)}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
