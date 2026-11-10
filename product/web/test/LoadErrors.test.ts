import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describeLoadError } from '../src/lib/loadErrors'

/**
 * 正文加载失败的翻译层（2026-11-11，借 `HapeLee/legado-with-MD3` 的 `LocalNetworkBlockedNotifier`）。
 *
 * 修之前 `ReaderBody` 把 `message` 原样糊在正文位置：内网被拦、要登录、站点挂了
 * 三种情况看到的是同一句"书源执行失败"，而修法完全不同（改源 / 登录 / 等）。
 *
 * 这里钉两件事：
 *   1) 三类必须分出不同的结论与下一步；
 *   2) 翻译用的签名必须**与后端真的会发的那几句一致** —— 所以有一条用例直接读
 *      `http/Routes.kt` 的 `classifyRuleFailure`，把前缀抄错的情况当场抓出来。
 */

test('LoadErrors - 内网/本机被拦：说清是"被拦下"，并指向改书源地址', () => {
  const info = describeLoadError('书源指向被拒绝的地址（内网或本机）：拒绝访问内网或本机地址')
  assert.equal(info.recognized, true)
  assert.match(info.headline, /内网或本机地址/, '结论要点明是地址被拦')
  assert.match(info.headline, /拦下|拒绝/, '要让用户知道这是"被拒绝"，不是"网站坏了"')
  assert.match(info.hint, /书源/, '下一步要指向书源配置，而不是查网络')
})

test('LoadErrors - 要登录 / 地址失效 / 站点挂了 三类分开', () => {
  const auth = describeLoadError('上游返回 HTTP 403')
  assert.equal(auth.recognized, true)
  assert.match(auth.headline, /登录/, '403 要提示去登录')

  const gone = describeLoadError('上游返回 HTTP 404')
  assert.match(gone.headline, /不存在/)
  assert.match(gone.hint, /刷新目录/, '404 先刷目录再重试')

  const down = describeLoadError('上游返回 HTTP 503')
  assert.match(down.headline, /出错/)
  assert.match(down.hint, /一会儿|过一段时间|稍后/, '5xx 是对方的问题，让用户等')
})

test('LoadErrors - 服务内部错误给固定文案，不回显内部细节', () => {
  const info = describeLoadError('书源执行时服务内部出错，详情已写入日志')
  assert.equal(info.recognized, true)
  assert.match(info.hint, /日志/, '要告诉用户详情在日志里')
  // 兜底文案里不许出现 SQL / 文件路径这类东西的痕迹
  assert.doesNotMatch(info.headline, /SELECT|\.kt|\\|Exception/)
})

test('LoadErrors - 网络类签名（域名/连接/超时/证书）都能认出', () => {
  for (const raw of [
    '无法解析 example.invalid 域名',
    'java.net.UnknownHostException: example.invalid',
    'Connection refused',
    'java.net.ConnectException: Connection refused',
    'connection reset',
    'Read timed out',
    'javax.net.ssl.SSLHandshakeException: PKIX path building failed',
  ]) {
    const info = describeLoadError(raw)
    assert.equal(info.recognized, true, `应当认出：${raw}`)
    assert.ok(info.headline.length > 0)
  }
})

test('LoadErrors - 认不出的原文当结论，不假装我们懂它', () => {
  const info = describeLoadError('某个没人见过的错误')
  assert.equal(info.recognized, false)
  assert.equal(info.headline, '某个没人见过的错误')
  assert.equal(info.hint, '', '没把握就别给建议')

  const empty = describeLoadError('   ')
  assert.equal(empty.recognized, false)
  assert.equal(empty.headline, '读取失败')
})

test('LoadErrors - 翻译签名与后端 classifyRuleFailure 的原文一致', () => {
  // 后端那句固定文案是前端翻译的唯一依据；两边各写一份必然漂移，
  // 所以直接把 Kt 源码读出来比对，而不是抄在测试里。
  const routes = fs.readFileSync(
    path.join(import.meta.dirname, '../../app/src/main/kotlin/io/legado/http/Routes.kt'),
    'utf8',
  )
  assert.ok(
    routes.includes('书源指向被拒绝的地址'),
    '后端 classifyRuleFailure 仍在用「书源指向被拒绝的地址」这个前缀',
  )
  assert.ok(
    routes.includes('书源执行时服务内部出错'),
    '后端兜底文案仍是「书源执行时服务内部出错」',
  )
  // 前端必须对这两句都认得出来
  assert.equal(describeLoadError('书源指向被拒绝的地址（内网或本机）：x').recognized, true)
  assert.equal(describeLoadError('书源执行时服务内部出错，详情已写入日志').recognized, true)
})

test('LoadErrors - 接线：ReaderBody 两处错误位都走翻译，且带 hint', () => {
  const body = fs.readFileSync(
    path.join(import.meta.dirname, '../src/features/reader/ReaderBody.tsx'),
    'utf8',
  )
  assert.match(body, /import \{ describeLoadError \} from '\.\.\/\.\.\/lib\/loadErrors'/)
  assert.match(body, /const loadError = describeLoadError\(message\)/)
  assert.doesNotMatch(body, /\{message\}\s*\n\s*<button type="button" className="reader-error-retry"/,
    '错误位不该再直接回显 message')
  const wired = body.match(/\{loadError\.headline\}/g) || []
  assert.equal(wired.length, 2, '分页与滚动两种模式各有一处错误位，都要翻译')
  assert.equal((body.match(/\{loadError\.hint && /g) || []).length, 2, '两处都要给下一步')
})