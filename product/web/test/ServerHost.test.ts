import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bindAddressLabel, browseHost, isLoopbackHost } from '../src/lib/serverHost'

/**
 * 「服务端口」浮窗现在要如实说出**当前绑定地址**（用户要求：显式展示绑定地址并解释局域网暴露风险）。
 *
 * 这里判两件事：地址分类的纯函数不许把非回环认成回环（那会让风险提示变成一句"仅本机"，
 * 比不提示更糟）；浮窗文案不许只报端口、不报风险。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('回环地址：只认真正只在本机可达的那些写法', () => {
  for (const host of ['127.0.0.1', '  127.0.0.1  ', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'localhost', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应判为回环`)
  }
  for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.20', '10.0.0.5', 'example.local']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不是回环，不能标成「仅本机」`)
  }
})

test('通配地址要用回环地址打开浏览器，其余原样', () => {
  assert.equal(browseHost('0.0.0.0'), '127.0.0.1')
  assert.equal(browseHost('::'), '127.0.0.1')
  assert.equal(browseHost(' 127.0.0.1 '), '127.0.0.1')
  assert.equal(browseHost('192.168.1.20'), '192.168.1.20')
})

test('绑定地址的显示：IPv6 要加方括号，端口未知时不留尾巴', () => {
  assert.equal(bindAddressLabel('127.0.0.1', 1234), '127.0.0.1:1234')
  assert.equal(bindAddressLabel('0.0.0.0', 1234), '0.0.0.0:1234')
  assert.equal(bindAddressLabel('::1', 1234), '[::1]:1234')
  assert.equal(bindAddressLabel('[::1]', 1234), '[::1]:1234')
  assert.equal(bindAddressLabel('::', null), '[::]')
  assert.equal(bindAddressLabel('127.0.0.1', null), '127.0.0.1')
})

test('「服务端口」浮窗报当前绑定地址，并对非回环地址给出局域网风险', () => {
  const modal = read('../src/components/ServerPortModal.tsx')
  assert.match(modal, /bindAddressLabel\(host, current\)/, '要说清这次实际绑在哪，而不是只报端口')
  assert.match(modal, /is-exposed/, '非回环时要换一种警示外观')
  assert.match(modal, /同一网络中的其它设备可以访问/, '要把「局域网能连」说成人话')
  assert.match(modal, /LEGADO_ALLOW_EXTERNAL_BIND=1/, '要指出外部绑定需要显式放行')
  assert.match(modal, /仅回环地址可访问/, '回环时也要说明本机之外连不上')
})

test('启动脚本在拉起 Java 之前就拦下非回环绑定，并给出放行入口', () => {
  const start = read('../../start.mjs')
  assert.match(start, /--allow-external-bind/, '要有显式放行开关，而不是让人去翻文档改环境变量')
  assert.match(start, /拒绝绑定到 \$\{runtime\.host\}/, '非回环且未放行时要当场拒绝')
  assert.match(start, /同一网络中的其它设备将能访问/, '拒绝理由要说明暴露面')
  assert.match(start, /if \(!isLoopbackHost\(runtime\.host\)\)[\s\S]*?process\.exit\(1\)/, '拒绝必须发生在 spawn 之前')
})
