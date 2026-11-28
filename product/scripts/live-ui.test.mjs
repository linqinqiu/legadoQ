import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { verifyLiveUi } from './live-ui.mjs';

const files = {
  'index.html': '<script src="/assets/index-current.js"></script>',
  'assets/index-current.js': 'console.log("current")',
  'assets/index-current.css': 'body{color:green}',
  'sw.js': 'self.skipWaiting()',
};
const hashes = Object.fromEntries(Object.entries(files).map(([name, text]) => [
  name, createHash('sha256').update(text).digest('hex'),
]));

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('live UI verifies all bytes including CSS and service worker', async (t) => {
  const base = await serve(t, (req, res) => res.end(files[req.url === '/' ? 'index.html' : req.url.slice(1)]));
  assert.deepEqual(await verifyLiveUi(base, hashes), {
    ok: true, reachable: true, checked: 4, failures: [],
  });
});

test('matching HTML with missing JS or changed CSS/SW fails', async (t) => {
  const base = await serve(t, (req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (file.endsWith('.js') && file !== 'sw.js') res.writeHead(404).end();
    else res.end(file === 'index.html' ? files[file] : 'outdated');
  });
  const result = await verifyLiveUi(base, hashes);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'assets/index-current.css:hash', 'assets/index-current.js:http=404', 'sw.js:hash',
  ]);
});

test('HTML fallback for missing asset is rejected by its bytes', async (t) => {
  const base = await serve(t, (_req, res) => res.end(files['index.html']));
  const result = await verifyLiveUi(base, hashes);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('assets/index-current.js:hash'));
});

test('redirects do not turn a missing asset into a pass', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/') res.end(files['index.html']);
    else res.writeHead(302, { Location: '/index.html' }).end();
  });
  assert.equal((await verifyLiveUi(base, hashes)).ok, false);
});

test('a redirecting homepage is reachable and must fail the deployment gate', async (t) => {
  const base = await serve(t, (_req, res) => res.writeHead(302, { Location: '/login' }).end());
  assert.deepEqual(await verifyLiveUi(base, hashes), {
    ok: false, reachable: true, checked: 1, failures: ['index.html:http=302'],
  });
});

test('a response body that never ends obeys the total deadline', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/') res.end(files['index.html']);
    else { res.writeHead(200); res.write('partial'); }
  });
  const started = Date.now();
  const result = await verifyLiveUi(base, hashes, { timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.reachable, true);
  assert.ok(result.failures.every((failure) => failure.endsWith(':timeout')));
  assert.ok(Date.now() - started < 5000, '正文读取也须可取消');
});

test('unreachable server and missing expected index fail closed', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  const result = await verifyLiveUi(base, hashes);
  assert.equal(result.ok, false);
  assert.equal(result.reachable, false);
  assert.equal(result.checked, 1);
  assert.equal((await verifyLiveUi(base, null)).ok, false);
  assert.equal((await verifyLiveUi(base, {})).ok, false);
});

test('runtime brand manifest may change but must remain a manifest', async (t) => {
  let content = JSON.stringify({ name: '个人阅读器', icons: [{ src: '/brand/icon' }] });
  const base = await serve(t, (req, res) => {
    res.end(req.url === '/manifest.webmanifest' ? content : files[req.url === '/' ? 'index.html' : req.url.slice(1)]);
  });
  const expected = { ...hashes, 'manifest.webmanifest': 'bundled-default-brand' };
  assert.equal((await verifyLiveUi(base, expected)).ok, true);
  content = '<html>fallback</html>';
  assert.equal((await verifyLiveUi(base, expected)).ok, false);
  content = '{}';
  assert.deepEqual((await verifyLiveUi(base, expected)).failures, ['manifest.webmanifest:invalid-manifest']);
});
