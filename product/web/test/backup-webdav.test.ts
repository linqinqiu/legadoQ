import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BackupWebDavPanel } from '../src/plugins/backup/BackupWebDavPanel'
import { backup } from '../src/lib/api/domains/backup'

test('WebDAV 页面明确公网手动迁移与隐私边界 默认不能发起空地址请求', () => {
  const html = renderToStaticMarkup(React.createElement(BackupWebDavPanel, {
    disabled: false, onFile: async () => true, onBusyChange: () => undefined,
  }))
  for (const text of ['手动 WebDAV 迁移', '公网 HTTPS', 'NAS 私网', '不会自动同步或自动恢复', '不在应用中保存', '64 MiB', '不能认证备份来源']) assert.ok(html.includes(text), text)
  assert.match(html, /type="password"/)
  assert.match(html, /disabled=""[^>]*>刷新远端列表/)
  assert.match(html, /disabled=""[^>]*>上传迁移包并校验/)
  const blocked = renderToStaticMarkup(React.createElement(BackupWebDavPanel, {
    disabled: true, onFile: async () => true, onBusyChange: () => undefined,
  }))
  assert.match(blocked, /<fieldset disabled="">/)
})

test('WebDAV 三条 API 使用同源 POST JSON 凭据不进请求地址 拉取返回原始字节', async () => {
  const original = globalThis.fetch
  const seen: string[] = []
  const config = { url: 'https://dav.example.com/private/', username: 'fixture', password: 'fixture-password' }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    seen.push(url)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.password, config.password)
    assert.equal(body.url, config.url)
    assert.ok(!url.includes('fixture'))
    if (url.endsWith('/pull')) {
      assert.equal(body.name, 'fixture.zip')
      return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': 'application/zip' } })
    }
    return new Response(JSON.stringify(url.endsWith('/list') ? [] : { verified: true }))
  }
  try {
    assert.deepEqual(await backup.webDavList(config), [])
    assert.equal((await backup.webDavUpload(config)).verified, true)
    assert.deepEqual([...new Uint8Array(await (await backup.webDavPull({ ...config, name: 'fixture.zip' })).arrayBuffer())], [80, 75, 3, 4])
    assert.deepEqual(seen, ['/api/backup/webdav/list', '/api/backup/webdav/upload', '/api/backup/webdav/pull'])
  } finally { globalThis.fetch = original }
})

test('WebDAV 拉取错误保持服务端稳定错误 不当成 ZIP 预览', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'webdav_verify_failed', message: '校验不一致' }), { status: 502 })
  try {
    await assert.rejects(backup.webDavPull({ url: 'https://dav.example.com/', name: 'fixture.zip' }), /校验不一致/)
  } finally { globalThis.fetch = original }
})
