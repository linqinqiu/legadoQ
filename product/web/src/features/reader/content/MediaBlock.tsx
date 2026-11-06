/**
 * 非文本章节的渲染：音频 / 视频 / HLS / 播放页 iframe / 文件下载（`mediaSrc` 为空时返回 null）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只跟媒体地址与书源类型打交道 ——
 * 音频放完自动进下一章由调用方通过 `onEnded` 决定，组件本身不碰翻页状态。
 *
 * 类型判定分两层：
 * - `sourceType === 1` 音频、`=== 4` 视频（4 是社区扩展，Legado 只有 0/1/2/3）；
 *   这两个类型下地址不是直链时，多半是**播放页**，用 iframe 兜底（服务端会注入 `<base>`）。
 * - `sourceType === 3` 文件：按地址后缀决定播放器还是下载链接 —— 电影/音乐源常把直链
 *   挂在文件类型下，不能再无脑给"下载文件"。
 */
import { HlsVideo } from './HlsVideo'
import { isHlsUrl, sniffMediaKind } from './mediaKind'

function AudioPlayer({ src, onEnded }: { src: string; onEnded: () => void }) {
  return (
    <div className="reader-media" data-media-type="audio">
      <audio src={src} controls autoPlay onEnded={onEnded} />
    </div>
  )
}

function VideoPlayer({ src }: { src: string }) {
  return (
    <div className="reader-media" data-media-type="video">
      {isHlsUrl(src) ? <HlsVideo src={src} /> : <video src={src} controls playsInline />}
    </div>
  )
}

/**
 * 播放页：服务端代理 HTML 并注入 `<base href="原始地址">`，相对资源才会回到原站加载。
 * sandbox **故意不给 allow-same-origin**：内容来自第三方，若与本站同源就能读父页面。
 * 有些站点仍会拒绝被嵌入，所以下面永远留一条「在浏览器打开」的外链。
 */
function EmbedPlayer({ src }: { src: string }) {
  return (
    <div className="reader-media" data-media-type="embed">
      <iframe
        className="reader-media-embed"
        src={src}
        title="视频播放"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-popups allow-presentation"
      />
      <a className="reader-media-download" href={src} target="_blank" rel="noreferrer">在浏览器打开</a>
    </div>
  )
}

/** 文件下载走代理时带 `download=1`，服务端才会补 `Content-Disposition` 文件名。 */
function downloadHref(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}download=1`
}

export function MediaBlock({ mediaSrc, sourceType, onEnded }: {
  mediaSrc: string | null
  sourceType: number
  onEnded: () => void
}) {
  if (!mediaSrc) return null
  const kind = sniffMediaKind(mediaSrc)

  // 声明为音频/视频：直链就播，不是直链就当播放页。
  if (sourceType === 1 || sourceType === 4) {
    if (kind === 'audio') return <AudioPlayer src={mediaSrc} onEnded={onEnded} />
    if (kind === 'video') return <VideoPlayer src={mediaSrc} />
    return <EmbedPlayer src={mediaSrc} />
  }

  // 文件类型（或兜底）：按地址后缀决定播放器还是下载。
  if (kind === 'audio') return <AudioPlayer src={mediaSrc} onEnded={onEnded} />
  if (kind === 'video') return <VideoPlayer src={mediaSrc} />
  return (
    <div className="reader-media" data-media-type="file">
      <a className="reader-media-download" href={downloadHref(mediaSrc)} target="_blank" rel="noreferrer" download>下载文件</a>
    </div>
  )
}
