import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureFatJar } from './bootstrap.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'legado-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'app'), { recursive: true });
  writeFileSync(path.join(root, 'app', 'build.gradle'), "version = '1.2.3'\n");
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'tasks.mjs'), '');
  mkdirSync(path.join(root, 'web'), { recursive: true });
  writeFileSync(path.join(root, 'web', 'package.json'), '{}');
  return root;
}

function jarPath(root, version = '1.2.3') {
  return path.join(root, 'app', 'build', 'libs', `legado-${version}-all.jar`);
}

test('missing current fat jar builds once through tasks.mjs and then launches', (t) => {
  const root = fixture(t);
  const calls = [];
  const result = ensureFatJar({
    productRoot: root,
    env: {},
    jarIsStale: () => false,
    spawnBuild(args, options) {
      calls.push({ args, options });
      mkdirSync(path.dirname(jarPath(root)), { recursive: true });
      writeFileSync(jarPath(root), 'built jar');
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'built');
  assert.equal(result.jar, 'legado-1.2.3-all.jar');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['scripts/tasks.mjs', 'build']);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.env.LEGADO_SKIP_LIVE_UI_CHECK, '1');
});

test('default builder runs the real tasks helper with the current Node executable', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'scripts', 'tasks.mjs'), `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const libs = path.resolve('app/build/libs');
    mkdirSync(libs, { recursive: true });
    writeFileSync(path.join(libs, 'legado-1.2.3-all.jar'), 'built by child');
  `);
  const result = ensureFatJar({ productRoot: root, env: {}, jarIsStale: () => false });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'built');
  assert.equal(result.jar, 'legado-1.2.3-all.jar');
});

test('stale current fat jar rebuilds once and verifies the result', (t) => {
  const root = fixture(t);
  mkdirSync(path.dirname(jarPath(root)), { recursive: true });
  writeFileSync(jarPath(root), 'stale jar');
  let checks = 0;
  const calls = [];
  const result = ensureFatJar({
    productRoot: root,
    env: {},
    jarIsStale() { checks += 1; return checks === 1; },
    spawnBuild(args, options) {
      calls.push({ args, options });
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'rebuilt');
  assert.equal(checks, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['scripts/tasks.mjs', 'build']);
});

test('fresh current jar starts without building', (t) => {
  const root = fixture(t);
  mkdirSync(path.dirname(jarPath(root)), { recursive: true });
  writeFileSync(jarPath(root), 'fresh jar');
  const result = ensureFatJar({
    productRoot: root,
    env: {},
    jarIsStale: () => false,
    spawnBuild: () => assert.fail('fresh jar must not build'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'ready');
});

test('LEGADO_ALLOW_STALE_JAR permits an old jar without building', (t) => {
  const root = fixture(t);
  mkdirSync(path.dirname(jarPath(root)), { recursive: true });
  writeFileSync(jarPath(root), 'rollback jar');
  const result = ensureFatJar({
    productRoot: root,
    env: { LEGADO_ALLOW_STALE_JAR: '1' },
    jarIsStale: () => true,
    spawnBuild: () => assert.fail('explicit rollback must not build'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'stale-allowed');
});

test('build failure stops immediately instead of recursing', (t) => {
  const root = fixture(t);
  let calls = 0;
  const result = ensureFatJar({
    productRoot: root,
    env: {},
    spawnBuild() { calls += 1; return { status: 7 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'build-failed');
  assert.match(result.error, /7/);
  assert.equal(calls, 1);
});

test('jar-only deployment reports missing build sources without invoking npm', (t) => {
  const root = fixture(t);
  rmSync(path.join(root, 'scripts'), { recursive: true });
  rmSync(path.join(root, 'web'), { recursive: true });
  rmSync(path.join(root, 'app', 'build.gradle'));
  const result = ensureFatJar({
    productRoot: root,
    env: {},
    spawnBuild: () => assert.fail('must not build without sources'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'missing-source');
  assert.match(result.error, /完整克隆/);
});

test('--no-build equivalent refuses missing or stale jars without invoking build', (t) => {
  const root = fixture(t);
  mkdirSync(path.dirname(jarPath(root)), { recursive: true });
  writeFileSync(jarPath(root), 'stale jar');
  for (const env of [{}, { LEGADO_NO_AUTO_BUILD: '1' }]) {
    const result = ensureFatJar({
      productRoot: root,
      env,
      noBuild: env.LEGADO_NO_AUTO_BUILD !== '1',
      jarIsStale: () => true,
      spawnBuild: () => assert.fail('disabled auto-build must not spawn'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, 'disabled');
  }
});
