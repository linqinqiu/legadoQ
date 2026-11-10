import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 裸 `fetch` 收口（2026-11-10 前端审计：11 处绕过统一客户端）。
 *
 * 绕过 `lib/api/client.ts` 的请求没有统一超时、没有性能采集、错误体各解析一套；
 * 出问题时症状是「界面永远转圈」或「只显示 HTTP 500」，而不是服务端那句能照做的话。
 * 这里把例外压到两个文件，新增调用必须走 `request*` 或显式登记理由。
 */
const ALLOWED = new Map<string, string>([
  ['lib/performance.ts', '性能采集器本身就是 fetch 的包装层，不能自己调自己'],
  ['main.tsx', '/healthz 探活：只为判断后端在不在，不该混进 API 慢请求统计'],
])

test('src 里除统一传输层与探活外，不许再出现裸 fetch', () => {
  const root = path.resolve(import.meta.dirname, '../src')
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(name => /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => name.replaceAll('\\', '/'))
  const problems: string[] = []
  for (const name of files) {
    if (ALLOWED.has(name)) continue
    const lines = fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      // 注释里写「以前这里裸 fetch」是历史记录，不是调用点。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/\bfetch\(/.test(line) && !/fetchWithMetrics/.test(line)) {
        problems.push(`${name}:${index + 1}：${line.trim()}`)
      }
    })
  }
  assert.deepEqual(problems, [],
    '新增请求请走 lib/api/client.ts 的 request / requestText / requestBlob / requestArrayBuffer；确需例外请在 ALLOWED 里写清理由')
})

test('例外清单里的文件真的还在用裸 fetch，理由不会烂掉', () => {
  const root = path.resolve(import.meta.dirname, '../src')
  for (const name of ALLOWED.keys()) {
    const src = fs.readFileSync(path.join(root, name), 'utf8')
    assert.match(src, /\bfetch\(/, `${name} 已经不用裸 fetch 了，把它从例外清单里删掉`)
  }
})
