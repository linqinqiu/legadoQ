import React from 'react'
import guideMarkdown from '../../../docs/功能说明.md?raw'

/**
 * 「功能说明」浮层（2026-10-28 从「关于」页里拆出来）。
 *
 * 用户原本点「关于」里的「功能说明」，十四个小节直接插在用户协议与开源许可之间：
 * 一段展开把底下的法律文本全顶走，关掉还要再翻回去。说明是一份完整的文档，
 * 就该自己占一层 —— 与更新日志、快捷键表同样从「关于」进，各自一个浮层。
 *
 * 内容仍然只有 `docs/功能说明.md` 一份：改文档就是改这里，不在组件里另写一套文案。
 */

type GuideSection = { title: string; lines: string[] }

/** 把「功能说明」的 Markdown 拆成「## 一节 + 正文行」；文档的 `#` 大标题由浮层头承担。 */
export function parseGuide(markdown: string): GuideSection[] {
  const sections: GuideSection[] = []
  let current: GuideSection | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('# ')) continue
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      current = { title: '', lines: [] }
      sections.push(current)
    }
    current.lines.push(line)
  }
  return sections
}

const GUIDE_SECTIONS = parseGuide(guideMarkdown)
/** 第一个 `##` 之前的段落是整份说明的总述。 */
const GUIDE_INTRO = GUIDE_SECTIONS.find(section => !section.title)?.lines ?? []
const GUIDE_GROUPS = GUIDE_SECTIONS.filter(section => section.title)

/** 按行渲染说明正文：`###` 作小标题、`- ` 聚成列表，其余作段落。 */
function GuideBody({ lines }: { lines: string[] }) {
  const nodes: React.ReactNode[] = []
  let bullets: string[] = []
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return
    nodes.push(
      <ul key={key} style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 'var(--t-sm)', lineHeight: 1.85 }}>
        {bullets.map((item, index) => <li key={index}>{item}</li>)}
      </ul>,
    )
    bullets = []
  }
  lines.forEach((line, index) => {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2))
      return
    }
    flushBullets(`guide-list-${index}`)
    if (line.startsWith('### ')) nodes.push(<h3 key={index}>{line.slice(4)}</h3>)
    else nodes.push(<p key={index}>{line}</p>)
  })
  flushBullets('guide-list-end')
  return <>{nodes}</>
}

export function FeatureGuide() {
  return (
    <section className="about-page guide-page">
      {GUIDE_INTRO.map((line, index) => <p key={index} className="page-lead">{line}</p>)}
      {/* 目录用按钮而不是 `#anchor`：这一站的 `#` 是路由，点一个锚点会被当成换页。
          锚点按节序编号，不用标题拼 —— 标题里有空格（「Cookie 与登录」）。 */}
      <nav className="guide-toc" aria-label="功能说明目录">
        {GUIDE_GROUPS.map((section, index) => (
          <button
            key={section.title}
            type="button"
            className="guide-toc-link"
            onClick={() => document.getElementById(`guide-${index}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          >
            {section.title}
          </button>
        ))}
      </nav>
      {GUIDE_GROUPS.map((section, index) => (
        <section key={section.title} id={`guide-${index}`} className="about-section">
          <h2>{section.title}</h2>
          <div className="about-section-body">
            <GuideBody lines={section.lines} />
          </div>
        </section>
      ))}
    </section>
  )
}
