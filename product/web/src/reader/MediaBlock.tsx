/**
 * 非文本章节的渲染：音频播放器 / 视频播放器 / 文件下载（`mediaSrc` 为空时返回 null）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只跟媒体地址与书源类型打交道 ——
 * 音频放完自动进下一章由调用方通过 `onEnded` 决定，组件本身不碰翻页状态。
 *
 * 媒体类型判定：
 * - `sourceType === 1` 明确是音频源；`sourceType === 4` 是非标准的视频（保留兼容）。
 * - Legado 没有 4 这个类型，视频/音频通常挂在 `sourceType === 3`（文件）下，
 *   由服务端把媒体地址嗅进 `mediaSrc`。此时不能再无脑给"下载文件"链接，
 *   而要按地址后缀判断到底是音视频还是纯文件，否则电影/音乐源只能下载、不能播。
 */
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|m4v|m3u8?)(\?|$|#)/i
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|oga|wma)(\?|$|#)/i

function sniffMediaKind(src: string): 'audio' | 'video' | 'file' {
  if (VIDEO_EXT.test(src)) return 'video'
  if (AUDIO_EXT.test(src)) return 'audio'
  return 'file'
}

export function MediaBlock({ mediaSrc, sourceType, onEnded }: {
  mediaSrc: string | null
  sourceType: number
  onEnded: () => void
}) {
  if (!mediaSrc) return null
  if (sourceType === 1) {
    return (
      <div className="reader-media" data-media-type="audio">
        <audio src={mediaSrc} controls autoPlay onEnded={onEnded} />
      </div>
    )
  }
  if (sourceType === 4) {
    return (
      <div className="reader-media" data-media-type="video">
        <video src={mediaSrc} controls />
      </div>
    )
  }
  // type 3（文件）或兜底：按地址后缀决定播放器还是下载链接。
  const kind = sniffMediaKind(mediaSrc)
  if (kind === 'audio') {
    return (
      <div className="reader-media" data-media-type="audio">
        <audio src={mediaSrc} controls autoPlay onEnded={onEnded} />
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="reader-media" data-media-type="video">
        <video src={mediaSrc} controls />
      </div>
    )
  }
  return (
    <div className="reader-media" data-media-type="file">
      <a className="reader-media-download" href={mediaSrc} target="_blank" rel="noreferrer" download>下载文件</a>
    </div>
  )
}
