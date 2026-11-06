import { useEffect, useRef } from 'react'

/**
 * HLS（m3u8）播放器：Chrome/Firefox 原生不认 m3u8，用 hls.js 动态加载（不进首屏包）。
 *
 * 服务端 `/api/book/media` 已把播放列表里的分片、密钥、初始化段都改写成同源代理地址，
 * 所以这里直接把代理地址交给 hls.js 即可；Safari 这类原生支持 HLS 的浏览器走 `canPlayType` 分支。
 */
export function HlsVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = ref.current
    if (!video || !src) return
    let hls: { destroy(): void } | null = null
    let cancelled = false

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }

    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return
      if (!Hls.isSupported()) {
        video.src = src
        return
      }
      const instance = new Hls({ enableWorker: true })
      hls = instance
      instance.loadSource(src)
      instance.attachMedia(video)
    }).catch(() => {
      if (!cancelled) video.src = src
    })

    return () => {
      cancelled = true
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [src])

  return <video ref={ref} controls playsInline data-media-type="video" />
}
