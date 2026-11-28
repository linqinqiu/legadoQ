// 随机端口、临时空库、复制 jar；验收真实服务及 start.mjs 复用分支，不连接日常实例。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestFatJar, readJarStaticHashes } from '../../scripts/runtime.mjs';
import { verifyLiveUi } from '../../scripts/live-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const libs = path.join(root, 'app/build/libs');
const jar = newestFatJar(libs);
assert.ok(jar, '需要当前 fatJar');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'legado-start-ui-'));
const copiedLibs = path.join(temporary, 'app/build/libs');
mkdirSync(copiedLibs, { recursive: true });
const copiedJar = path.join(copiedLibs, jar);
copyFileSync(path.join(libs, jar), copiedJar);
// 同时验收品牌 manifest 的动态响应。
writeFileSync(path.join(temporary, 'brand.json'), JSON.stringify({ name: '隔离启动验收', shortName: '验收' }));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, LEGADO_HOME: temporary, LEGADO_ENV: path.join(temporary, '.env'),
  LEGADO_PORT: String(port), LEGADO_HOST: '127.0.0.1', LEGADO_ACCESS_TOKEN: '',
  LEGADO_DATABASE: path.join(temporary, 'data/legado.sqlite'), LEGADO_DATA_DIR: path.join(temporary, 'data'),
  LEGADO_NEXT_DIR: path.join(temporary, 'next'), LEGADO_LOG_FILE: path.join(temporary, 'server.log'),
  LEGADO_TMP_DIR: temporary, LEGADO_NO_AUTO_BUILD: '1' };
const java = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const service = spawn(java, ['-Xmx512m', '-Dfile.encoding=UTF-8', `-Djava.io.tmpdir=${temporary}`, '-jar', copiedJar],
  { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serviceLog = '';
let serviceError;
service.on('error', error => { serviceError = error; });
for (const stream of [service.stdout, service.stderr]) stream.on('data', data => { serviceLog = (serviceLog + data).slice(-20000); });
const closed = new Promise(resolve => service.once('close', resolve));
try {
  const deadline = Date.now() + 90000;
  let health;
  while (Date.now() < deadline) {
    if (serviceError) throw serviceError;
    assert.equal(service.exitCode, null, serviceLog);
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* 冷启动等待 */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert.ok(health, `隔离服务未就绪：${serviceLog}`);
  const live = await verifyLiveUi(base, readJarStaticHashes(copiedJar));
  assert.equal(live.ok, true, JSON.stringify(live));
  console.log(`PASS  真实 jar ${live.checked} 个资源检查，包含动态品牌 manifest；${base}`);
  const start = spawn(process.execPath, [path.join(root, 'start.mjs'), '--no-open', '--no-build', '--port', String(port)],
    { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [start.stdout, start.stderr]) stream.on('data', data => {
    output += data;
    process.stdout.write(data);
  });
  const timer = setTimeout(() => start.kill(), 60000);
  let code;
  try { code = await new Promise((resolve, reject) => { start.once('error', reject); start.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  assert.match(output, /界面资源已对上/);
  assert.match(output, /已在运行/);
  console.log('PASS  start.mjs --no-build --no-open 复用真实隔离实例，资源校验后退出 0');
  console.log(JSON.stringify({ version: health.version, jar, files: live.checked, success: true }));
} finally {
  service.kill();
  await closed;
  // 只清理本次 mkdtemp 生成的目录，并校验范围。
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('legado-start-ui-'));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
