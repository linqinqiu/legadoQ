import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isDirectMedia, isHlsUrl, sniffMediaKind } from '../src/reader/mediaKind'
import { MediaBlock } from '../src/reader/MediaBlock'

const proxy = (raw: string) => `/api/book/media?url=${encodeURIComponent(raw)}`

test('媒体地址分类：直链 / HLS / 播放页 / 文件', () => {
  assert.equal(sniffMediaKind('https://cdn.example/a.mp4'), 'video')
  assert.equal(sniffMediaKind('https://cdn.example/a.m3u8?token=1'), 'video')
  assert.equal(sniffMediaKind('https://cdn.example/a.m4a'), 'audio')
  assert.equal(sniffMediaKind('https://cdn.example/a.flac'), 'audio')
  assert.equal(sniffMediaKind('https://cdn.example/book.zip'), 'file')
  // 播放页没有媒体后缀，不能被当成直链
  assert.equal(sniffMediaKind('https://jx.example/player/?url=https%3A%2F%2Fcdn%2Fa.mp4'), 'file')
  assert.equal(isDirectMedia('https://jx.example/player/?url=x'), false)
  // 本站代理地址：后缀在 query 里，也要认
  assert.equal(isHlsUrl(proxy('https://cdn.example/live/index.m3u8')), true)
  assert.equal(isDirectMedia(proxy('https://cdn.example/v/1.mp4')), true)
})

test('MediaBlock：播放页地址用 iframe 兜底并留外链', () => {
  const html = renderToStaticMarkup(React.createElement(MediaBlock, {
    mediaSrc: proxy('https://jx.example/player/?url=https%3A%2F%2Fcdn%2Fa.mp4'),
    sourceType: 4,
    onEnded: () => undefined,
  }))
  assert.match(html, /data-media-type="embed"/)
  assert.match(html, /<iframe/)
  assert.match(html, /在浏览器打开/)
})

test('MediaBlock：m3u8 走 HLS 容器，mp4 走原生 video', () => {
  const hls = renderToStaticMarkup(React.createElement(MediaBlock, {
    mediaSrc: proxy('https://cdn.example/live/index.m3u8'),
    sourceType: 4,
    onEnded: () => undefined,
  }))
  assert.match(hls, /data-media-type="video"/)
  assert.match(hls, /<video/)
  const mp4 = renderToStaticMarkup(React.createElement(MediaBlock, {
    mediaSrc: proxy('https://cdn.example/v/1.mp4'),
    sourceType: 3,
    onEnded: () => undefined,
  }))
  assert.match(mp4, /data-media-type="video"/)
})

test('MediaBlock：文件类型给下载链接，并带 download=1 让服务端补文件名', () => {
  const html = renderToStaticMarkup(React.createElement(MediaBlock, {
    mediaSrc: proxy('https://cdn.example/book.zip'),
    sourceType: 3,
    onEnded: () => undefined,
  }))
  assert.match(html, /data-media-type="file"/)
  assert.match(html, /download=1/)
})
