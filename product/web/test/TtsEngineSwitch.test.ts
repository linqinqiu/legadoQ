import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultReaderSettings, effectiveTtsVoice, loadReaderSettings, ttsSessionKey } from '../src/reader/readerSettings'
import { TtsSettingsModal } from '../src/reader/TtsSettingsModal'

/**
 * 「朗读引擎在使用中切换会重音，都启动」+「小说阅读过程中章节之间的过渡没有做好」
 * （用户 2026-09-30 的清单里最后两条，当时一条没落地）。
 *
 * 重音的根因是**换引擎没有任何东西去停旧引擎**：`TtsSettingsModal` 换引擎只写 settings，
 * 而旧引擎的回调链（WebSpeech 的 utterance.onEnd / HTTP 音频流的分片 onEnd）还在推进
 * `currentChunkIndex`，于是新引擎接着出声，两条声音叠在一起。
 * 修法是把"什么算同一场朗读"收成一处判据（`ttsSessionKey`），播放中它一变就停旧起新。
 *
 * 白闪的根因相反：切章时把**已经到手的**正文清掉了（`setContent('')`），
 * 而且清完要等一帧 passive effect 才填回来 —— 预载命中的下一章也被换成骨架屏闪一下。
 * 这两条各有一组判据，其中四条是源码级的：它们盯的是"别再被改回去"，
 * 因为 AGENTS.md 里那条"切章必须清 content 才能防误读"的老办法看起来同样有理，很容易被抄回来。
 */

const readerSource = readFileSync(fileURLToPath(new URL('../src/reader/ReaderScreen.tsx', import.meta.url)), 'utf8')
// 0.8.2 结构重排：朗读集群（状态 + 9 个回调 + 2 个 effect）抽进了 useReaderTts.ts。
// 判"阅读器这一面"时读两份拼起来的整体 —— 不是放水：只读一处会漏掉另一处，
// 而拼起来之后任何一侧长回旧写法都会被下面的 match/doesNotMatch 逮住。
const readerTtsSource = readFileSync(fileURLToPath(new URL('../src/reader/useReaderTts.ts', import.meta.url)), 'utf8')
const readerSurface = readerSource + '\n' + readerTtsSource

/** 取某个 `const 名字 = ...` 声明到它自己的依赖数组收尾（`\n  }, [`）为止。 */
function sourceOf(fnName: string, expectContains: string): string {
  const start = readerSource.indexOf(`const ${fnName} = `)
  assert.ok(start >= 0, `找不到 ${fnName}（改名了就把这条判据一起改掉，别让它空转）`)
  const end = readerSource.indexOf('\n  }, [', start)
  assert.ok(end > start, `${fnName} 的依赖数组收尾没找到，判据范围不可信`)
  const block = readerSource.slice(start, end)
  // 先确认截到的确实是这个函数体，否则"里面没有 X"这种断言只是空转。
  assert.ok(block.includes(expectContains), `${fnName} 的截取范围里没有 ${expectContains}，范围判据不可用`)
  return block
}

const settingsWith = (over: Partial<typeof defaultReaderSettings>) => ({ ...defaultReaderSettings, ...over })

/**
 * 静态渲染朗读设置弹窗。`Select` 的浮层只在打开时才 portal 到 body，静态渲染走的是关闭态，
 * 所以这里能安全量到触发器（.ui-select-trigger）而不会碰到 react-dom/server 不支持的 portal。
 */
function renderModal(settings: typeof defaultReaderSettings): string {
  const previous = (globalThis as any).window
  if (previous === undefined) (globalThis as any).window = {}
  try {
    return renderToStaticMarkup(React.createElement(TtsSettingsModal, {
      settings,
      onChange: () => {},
      sleepTimer: 'off' as const,
      onSleepTimerChange: () => {},
      remainingSeconds: null,
      onClose: () => {},
    }))
  } finally {
    if (previous === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previous
  }
}

test('朗读引擎 - 自定义源用它自己填的发音人，不继承微软的音色 id', () => {
  const custom = settingsWith({
    ttsEngine: 'custom',
    ttsVoice: 'zh-CN-XiaoxiaoNeural',
    ttsCustomVoice: 'my-piper-zh',
  })
  assert.equal(effectiveTtsVoice(custom), 'my-piper-zh')

  // 用户没填自定义发音人时就留空：把 zh-CN-XiaoxiaoNeural 发给自建 TTS 服务是错的，
  // 那正是以前 createChunkRequest 的 `settings.ttsVoice || 'zh-CN-XiaoxiaoNeural'` 干的事。
  assert.equal(effectiveTtsVoice(settingsWith({ ...custom, ttsCustomVoice: '   ' })), '')

  // 另外两个引擎仍用音色表选出来的那个
  assert.equal(effectiveTtsVoice(settingsWith({ ttsEngine: 'edge', ttsVoice: 'zh-CN-YunxiNeural' })), 'zh-CN-YunxiNeural')
  assert.equal(effectiveTtsVoice(settingsWith({ ttsEngine: 'webSpeech', ttsVoice: 'Microsoft Huihui' })), 'Microsoft Huihui')
  assert.equal(
    effectiveTtsVoice(settingsWith({ ttsEngine: 'edge', ttsVoice: '   ' })),
    defaultReaderSettings.ttsVoice,
    'Edge 引擎下音色被清空要回落到默认，不能发一个空串过去',
  )
})

test('朗读会话身份 - 换引擎/音色/自定义参数都算换会话', () => {
  const base = ttsSessionKey(settingsWith({ ttsEngine: 'edge' }))
  assert.notEqual(ttsSessionKey(settingsWith({ ttsEngine: 'webSpeech' })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsEngine: 'custom', ttsCustomVoice: 'v' })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsVoice: 'zh-CN-YunxiNeural' })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsSpeed: 1.5 })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsPitch: 1.2 })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsCustomUrl: 'http://127.0.0.1:5000/tts' })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsCustomMethod: 'POST' })), base)
  assert.notEqual(ttsSessionKey(settingsWith({ ttsCustomBody: '{"t":"{{speakText}}"}' })), base)
  // 附加请求头也是会话身份：换了 API key 等于换了一个上游
  assert.notEqual(ttsSessionKey(settingsWith({ ttsCustomHeader: '{"Authorization":"Bearer b"}' })), base)
})

test('朗读会话身份 - 排版与主题改动不该打断正在读的这一句', () => {
  const base = ttsSessionKey(settingsWith({ ttsEngine: 'edge' }))
  assert.equal(ttsSessionKey(settingsWith({ theme: 'dark', fontSize: 24, lineHeight: 1.5, pageMode: 'paginate' })), base)
  assert.equal(ttsSessionKey(settingsWith({ ttsAutoNextChapter: !defaultReaderSettings.ttsAutoNextChapter })), base)
  assert.equal(ttsSessionKey(settingsWith({ ttsFilterSymbols: !defaultReaderSettings.ttsFilterSymbols })), base)
})

test('朗读引擎与 ttsEngine.ts 用的是同一套会话判据（两套名字迟早漂移）', () => {
  const engineSource = readFileSync(fileURLToPath(new URL('../src/reader/ttsEngine.ts', import.meta.url)), 'utf8')
  assert.match(engineSource, /return ttsSessionKey\(settings\)/, 'HttpAudioTtsEngine.getSettingsKey 必须直接引 ttsSessionKey')
  assert.ok(
    !/settings\.ttsVoice\s*\|\|\s*'zh-CN-XiaoxiaoNeural'/.test(engineSource),
    '发出去的 voice 不许再硬回退成微软音色 id，自定义引擎会被它污染',
  )
})

test('朗读引擎 - 播放中换设置必须停旧起新，暂停中则让下一分片自己换会话', () => {
  assert.match(
    readerSurface,
    /const ttsVoiceKey = ttsSessionKey\(settings\)[\s\S]{0,700}if \(!ttsActive \|\| ttsPlayState !== 'playing'\) return[\s\S]{0,160}playTtsChunkRef\.current\(currentChunkIndex, 'replace'\)/,
    '换引擎时没有"停掉旧引擎 + 用新引擎重读当前分片"这条路，重音就还会回来',
  )
})

test('阅读设置新增的两个自定义字段 - 类型不对就当没填', () => {
  const previous = (globalThis as any).window
  const store = new Map<string, string>([
    ['legado-reader-settings-v2', JSON.stringify({ ttsEngine: 'custom', ttsCustomVoice: 42, ttsCustomHeader: { a: 1 } })],
  ])
  ;(globalThis as any).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} } }
  try {
    const loaded = loadReaderSettings()
    assert.equal(loaded.ttsCustomVoice, '', '数字不是发音人标识，回落到空')
    assert.equal(loaded.ttsCustomHeader, '', '对象不是 JSON 文本，回落到空')
    assert.equal(loaded.ttsEngine, 'custom')
  } finally {
    if (previous === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previous
  }
})

test('朗读设置弹窗 - 自定义引擎的两个新入口在界面上（服务端早就支持，界面没有入口等于没有）', () => {
  const html = renderModal(settingsWith({ ttsEngine: 'custom' }))
  assert.match(html, /发音人标识/, '自定义源要能填自己的发音人（填进 {{speakVoice}}）')
  assert.match(html, /附加请求头/, '第三方 TTS 基本都要一个 key，界面上必须有一栏')
  assert.match(html, /speakPitch/, '语调对自定义源也要有占位符，否则那个滑杆是空的')
  assert.ok(!/<select/.test(html), '弹窗里不许再留原生 select：字号/选中态/滚动条都跟系统走，和全站控件不同形')
  assert.match(html, /ui-select-trigger/, '用的是站内 Select')
})

test('朗读设置弹窗 - 系统没有本地音色时直说，而不是摆一个空下拉', () => {
  const html = renderModal(settingsWith({ ttsEngine: 'webSpeech' }))
  assert.match(html, /系统没有交回任何本地音色/, '空列表要给出原因和下一步（用 Edge 或自定义源）')
  assert.ok(!/<select/.test(html))
})

test('章节过渡 - 切章不许再把已经到手的正文清成骨架屏', () => {
  const block = sourceOf('changeChapter', 'setChapterIndex(nextIndex)')
  assert.ok(
    !block.includes("setContent('')"),
    'changeChapter 里再出现 setContent(\'\') 就是回到"先白一闪"的老行为（用户 2026-09-30）',
  )
  assert.ok(
    !block.includes("setLoadedChapterUrl('')"),
    'loadedChapterUrl 与 content 成对描述"屏幕上挂的是哪一章"，只清一个会让旧正文当场消失',
  )
})

test('章节过渡 - 预载命中要在绘制前换好正文，朗读管线只认到位的那一章', () => {
  assert.match(
    readerSource,
    /useLayoutEffect\(\(\) => \{\s*\n\s*let cancelled = false\s*\n\s*setLoading\(true\)/,
    '正文加载 effect 必须是 useLayoutEffect：passive effect 会让浏览器先画一帧骨架屏',
  )
  assert.match(
    readerSurface,
    // 第一个参数（章名）后来会过一层简繁转换的 `convert(...)`，所以这里只钉"喂进去的是 ttsParagraphs"
    /processChapterForTts\([^\n]*ttsParagraphs/,
    '朗读必须吃 ttsParagraphs（过渡期间为空），否则会一路读进上一章剩下的段落 —— 这是当年"切章就清 content"的真实理由',
  )
  assert.match(
    readerSurface,
    /const ttsParagraphs = useMemo\(\(\) => \(isCurrentChapterLoaded \? paragraphs : \[\]\)/,
    'ttsParagraphs 的判据必须是"当前章已到位"，不能退回到看 content 有没有',
  )
})
