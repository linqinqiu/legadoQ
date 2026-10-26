import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scrollTapZone,
  paginateTapZone,
  mobileTapZone,
  isAtTopBoundary,
  isAtBottomBoundary,
  isTapGesture,
  swipeDirection,
  isInteractiveReaderTarget,
  calculatePaginationLayout,
  isDoubleColumnActive,
  contentImageUrl,
  isSameSiteAsset,
} from '../src/reader/readerInteractions.ts'
import {
  clampScrollPosition,
  scrollPosition,
  parseReaderFont,
  parsePageMode,
  parseColumnMode,
  parseMaxWidth,
  loadReaderSettings,
  saveReaderSettings,
  getReaderFontFamily,
  defaultReaderSettings,
} from '../src/reader/readerSettings.ts'

test('reader interactions - tap zones and gestures', () => {
  // Scroll mode tap zones
  assert.equal(scrollTapZone(100, 1000), 'previous') // 10%
  assert.equal(scrollTapZone(500, 1000), 'toggle')   // 50%
  assert.equal(scrollTapZone(900, 1000), 'next')     // 90%
  assert.equal(mobileTapZone(100, 1000), 'previous')

  // Paginated mode tap zones
  assert.equal(paginateTapZone(100, 1000), 'previous') // 10%
  assert.equal(paginateTapZone(500, 1000), 'toggle')   // 50%
  assert.equal(paginateTapZone(900, 1000), 'next')     // 90%

  // Boundaries
  assert.equal(isAtTopBoundary(0), true)
  assert.equal(isAtTopBoundary(5), true)
  assert.equal(isAtTopBoundary(10), false)
  assert.equal(isAtBottomBoundary(980, 2000, 1000, 20), true) // 980 + 1000 = 1980 >= 2000 - 20
  assert.equal(isAtBottomBoundary(500, 2000, 1000, 20), false)

  // Gestures
  assert.equal(isTapGesture(100, 100, 105, 105), true)
  assert.equal(isTapGesture(100, 100, 150, 100), false)

  assert.equal(swipeDirection(200, 100, 100, 100), 'left')
  assert.equal(swipeDirection(100, 100, 200, 100), 'right')
  assert.equal(swipeDirection(100, 100, 110, 100), null) // too short
  assert.equal(swipeDirection(100, 100, 150, 200), null) // vertical diagonal
})

test('reader settings - parsing, math clamping and localStorage persistence', () => {
  assert.equal(clampScrollPosition(0.5), 0.5)
  assert.equal(clampScrollPosition(-1), 0)
  assert.equal(clampScrollPosition(2), 1)
  assert.equal(clampScrollPosition(NaN), 0)

  assert.equal(scrollPosition(500, 1500, 500), 0.5) // 500 / 1000 = 0.5

  assert.equal(parseReaderFont('kai'), 'kai')
  assert.equal(parseReaderFont('invalid-font'), 'song')

  assert.equal(parsePageMode('paginate'), 'paginate')
  assert.equal(parsePageMode('other'), 'scroll')

  assert.equal(parseColumnMode('double'), 'double')
  assert.equal(parseColumnMode('invalid'), 'auto')

  assert.equal(parseMaxWidth(1000), 1000)
  assert.equal(parseMaxWidth(200), 560)
  assert.equal(parseMaxWidth(3000), 1400)
  assert.equal(parseMaxWidth('invalid'), defaultReaderSettings.maxWidth)

  // Fonts
  assert.ok(getReaderFontFamily('kai').includes('Kaiti'))
  assert.ok(getReaderFontFamily('system').includes('system-ui') || getReaderFontFamily('system').includes('-apple-system'))

  // LocalStorage
  const mockStorage: Record<string, string> = {}
  const originalWindow = globalThis.window
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => { mockStorage[key] = val },
    },
  }

  try {
    const loadedDefault = loadReaderSettings()
    assert.equal(loadedDefault.theme, 'light')

    saveReaderSettings({ ...defaultReaderSettings, theme: 'dark', fontSize: 24 })
    const loadedSaved = loadReaderSettings()
    assert.equal(loadedSaved.theme, 'dark')
    assert.equal(loadedSaved.fontSize, 24)
  } finally {
    globalThis.window = originalWindow
  }
})

test('正文配图占位行只认服务端产出的那一种形状', () => {
  assert.equal(contentImageUrl('![图片](https://cdn.example/a.jpg)'), 'https://cdn.example/a.jpg')
  assert.equal(contentImageUrl('  ![图片](http://example.test/b.png)  '), 'http://example.test/b.png')
  // 本地 EPUB 的内嵌插图走站内地址（服务端按 zip entry 回字节），也必须认这一类
  assert.equal(
    contentImageUrl('![图片](/api/books/local/asset?bookId=abc123&path=OEBPS%2Fimages%2Fp1.png)'),
    '/api/books/local/asset?bookId=abc123&path=OEBPS%2Fimages%2Fp1.png',
  )
  assert.ok(isSameSiteAsset('/api/books/local/asset?bookId=abc'), '站内地址不能再过一遍图片代理（那层只收 http(s)）')
  assert.ok(!isSameSiteAsset('https://cdn.example/a.jpg'), '远程图仍然要走代理（防盗链与混合内容）')
  assert.equal(contentImageUrl('![图片](images/p1.png)'), null, '相对路径没有基准可解析，服务端不该产出这种行')
  assert.equal(contentImageUrl('![图片](//evil.test/a.png)'), null, '协议省略写法不认（它会跟着当前协议跑）')
  // 普通段落、被净化规则改坏的半截占位、以及 javascript: 之类协议都不能被当成图片渲染
  assert.equal(contentImageUrl('他低声说：「走吧。」'), null)
  assert.equal(contentImageUrl('![图片](javascript:alert(1))'), null)
  assert.equal(contentImageUrl('![图片](https://example.test/a.jpg'), null)
})
