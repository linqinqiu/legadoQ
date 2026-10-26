import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSyncError, looksLikeFailure } from '../src/lib/syncErrors'

// 这些签名对应的是服务端真实抛出的文案（SubscriptionService / NetworkSecurity）
// 加 JDK HttpClient 的英文异常，不是随手编的例子。

test('syncErrors - 域名解析失败给一行结论和可照做的修法', () => {
  const info = describeSyncError('legado-sub.example.com:80: Name or service not known')
  assert.equal(info.recognized, true)
  assert.equal(info.headline, '域名解析不到')
  assert.ok(info.hint.includes('订阅地址'), `提示要指向地址本身：${info.hint}`)
})

test('syncErrors - UnknownHostException 的英文原文也认得', () => {
  const info = describeSyncError('java.net.UnknownHostException: no.such.host.invalid')
  assert.equal(info.headline, '域名解析不到')
})

test('syncErrors - HTTP 状态码按码给结论', () => {
  assert.equal(describeSyncError('订阅上游返回 HTTP 404').headline, '订阅地址不存在（HTTP 404）')
  assert.equal(describeSyncError('订阅上游返回 HTTP 403').headline, '上游拒绝访问（HTTP 403）')
  assert.equal(describeSyncError('订阅上游返回 HTTP 503').headline, '站点侧出错（HTTP 503）')
  assert.ok(describeSyncError('订阅上游返回 HTTP 404').hint.includes('重新复制'))
})

test('syncErrors - 返回网页而不是 JSON 时说得清下一步', () => {
  const info = describeSyncError('订阅内容不是有效 JSON')
  assert.equal(info.headline, '返回的内容不是书源 JSON')
  assert.ok(info.hint.includes('网页'), `要点出常见原因是地址打开的是网页：${info.hint}`)
})

test('syncErrors - 内网拦截与协议限制不误报成网络故障', () => {
  assert.equal(describeSyncError('拒绝访问内网或本机地址').headline, '服务端不抓取内网地址')
  assert.equal(describeSyncError('仅允许 HTTP(S) 订阅地址').headline, '地址协议不支持')
  assert.equal(describeSyncError('无法解析 订阅域名: a.b.c (DNS解析失败)').headline, '域名解析不到')
})

test('syncErrors - 连不上、超时、证书各自有结论', () => {
  assert.equal(describeSyncError('Failed to connect to sub.example.com/93.184.216.34:80').headline, '连不上这台站点')
  assert.equal(describeSyncError('java.net.http.HttpTimeoutException: request timed out').headline, '请求超时')
  assert.equal(describeSyncError('javax.net.ssl.SSLHandshakeException: Remote host closed connection').headline, 'HTTPS 证书握手失败')
})

/**
 * 「握手上了但请求被中途掐断」不是"连不上"，也不是超时：这台机器上实测到的签名是
 * JDK 的 `Connection reset`（2026-10-01 订阅探针同步失败那一行就是它），Windows 那侧另有中文说法。
 * 补之前界面上糊的是英文原文，用户读不出下一步 —— 判据在 `tools/verify/subscription-check.mjs`
 * 里要求"说清原因"，那条当时红的是产品，不是探针。
 */
test('syncErrors - 连接被中途断开单独有一句结论（不糊英文原文，也不误并报成证书问题）', () => {
  for (const raw of [
    'java.net.SocketException: Connection reset',
    'Connection reset by peer',
    'java.io.IOException: 远程主机强迫关闭了一个现有的连接。',
  ]) {
    const info = describeSyncError(raw)
    assert.equal(info.recognized, true, `这条必须认得：${raw}`)
    assert.ok(info.headline.startsWith('连不上'), `结论要落在"连不上"这一类：${info.headline}`)
    assert.ok(info.headline.includes('中途'), `要说清是中途断的，不是端口不通：${info.headline}`)
    assert.ok(info.hint.includes('代理') || info.hint.includes('反爬'), `提示要给出可照做的原因：${info.hint}`)
    assert.ok(!/[A-Za-z]{8,}/.test(info.headline), `结论里不许残留英文异常名：${info.headline}`)
  }
  assert.equal(looksLikeFailure('java.net.SocketException: Connection reset'), true)
})

test('syncErrors - 认不出的原文不硬编结论，首行原样当结论', () => {
  const raw = '某种没见过的失败\n第二行不会被显示'
  const info = describeSyncError(raw)
  assert.equal(info.recognized, false)
  assert.equal(info.headline, '某种没见过的失败')
  assert.equal(info.hint, '')
})

test('syncErrors - 成功提示不会被当成错误排版', () => {
  assert.equal(looksLikeFailure('同步完成：新增 3，更新 1，跳过 0'), false)
  assert.equal(looksLikeFailure('订阅已保存，等下一次自动同步或点「立即同步」'), false)
  assert.equal(looksLikeFailure('全部同步完成：成功 0，失败 2（原因看每条订阅下面那行）'), true)
  assert.equal(looksLikeFailure('订阅上游返回 HTTP 500'), true)
  assert.equal(looksLikeFailure(''), false)
})
