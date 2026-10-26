import React, { useState } from 'react'
import { api } from '../lib/api'
import { cleanTitle } from '../lib/searchFilters'

/**
 * 占位封面。网格卡上是 138~153px 宽的一张"书封"，只写两个字等于把封面浪费掉 ——
 * 所以默认封面就是**文字版书封**：书名（可换行）+ 作者，仍只用一种墨色。
 * 46px 以下的小封面（继续阅读、书籍管理）字放不下，且旁边就写着书名作者，才退回两字。
 */
export function CoverFallback({ name, author, compact }: { name: string; author?: string; compact?: boolean }) {
  const title = cleanTitle(name) || name
  if (compact) return <span className="cover-fallback cover-fallback-compact"><span>{title.slice(0, 2)}</span></span>
  return (
    <span className="cover-fallback">
      <span className="cover-fallback-title">{title}</span>
      <span className="cover-fallback-author">{author?.trim() || '佚名'}</span>
    </span>
  )
}

/**
 * 搜索结果封面。源站给的封面地址经常是失效链接或防盗链图，
 * 以前图片报错只是 `visibility:hidden`，留下的就是一块没有字的灰板 —— 这里回落到文字占位。
 * 外域地址一律走服务端代理（0.6.22），浏览器直连外域经常取不到图。
 */
export function SearchCover({ cover, name, author, referer }: { cover: string | null; name: string; author?: string; referer?: string }) {
  const [broken, setBroken] = useState(false)
  if (!cover || broken) return <CoverFallback name={name} author={author} />
  return <img src={api.coverProxy(cover, referer)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
}

/** 本机缓存里的封面（按 coverKey 取）。 */
export function BookCover({ coverKey, name, author, compact }: { coverKey?: string; name: string; author?: string; compact?: boolean }) {
  const [broken, setBroken] = useState(false)
  if (!coverKey || broken) return <CoverFallback name={name} author={author} compact={compact} />
  return <img src={api.cover(coverKey)} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/**
 * 「占位先摆着、图片真加载出来再换上」的远程封面。
 *
 * 用户 2026-10-08：「发现页面没有加载成功的书籍封面，或者没有封面的，先用书架那样的本地书籍封面
 * 代替，当获取到的时候，自动更换」。所以这里**先**渲染文字占位（和书架同一套 `.cover-fallback`），
 * `<img>` 以透明层叠在上面，`onLoad` 才淡入；加载失败就让它一直透明，占位留在原地 ——
 * 不再出现"一块没有字的灰板"。
 */
export function DeferredCover({ cover, name, author, referer }: { cover: string | null; name: string; author?: string; referer?: string }) {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  const showImage = !!cover && !broken
  return (
    <span className="deferred-cover">
      <CoverFallback name={name} author={author} />
      {showImage && (
        <img
          src={api.coverProxy(cover!, referer)}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={loaded ? 'is-loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
      )}
    </span>
  )
}
