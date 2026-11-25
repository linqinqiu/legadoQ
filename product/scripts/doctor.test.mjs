import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctorMain, runDoctor } from './doctor.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'legado-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'app/build.gradle': "version = '1.2.3'\n",
    'app/build/libs/legado-1.2.3-all.jar': 'jar',
    'gradlew': 'wrapper',
    'gradlew.bat': 'wrapper',
    'gradle/wrapper/gradle-wrapper.jar': 'jar',
    'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=gradle',
    'web/package.json': JSON.stringify({ dependencies: { react: '19' }, devDependencies: { typescript: '5' } }),
    'web/node_modules/react/package.json': '{}',
    'web/node_modules/typescript/package.json': '{}',
    'web/dist/index.html': '<html>ready</html>',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  mkdirSync(path.join(root, 'data'));
  return {
    root,
    runtime: {
      root,
      libs: path.join(root, 'app/build/libs'),
      dataDir: path.join(root, 'data'),
      host: '127.0.0.1',
      port: 1234,
    },
  };
}

function commands(javaVersion = 'openjdk version "17.0.12"') {
  return (command) => {
    if (command === 'java') return { status: 0, stderr: javaVersion, stdout: '' };
    if (command === 'npm') return { status: 0, stderr: '', stdout: '10.9.0' };
    return { status: null, error: new Error('ENOENT') };
  };
}

const quietLog = { log() {}, warn() {}, error() {} };

test('doctor --json emits a readable machine report and exits zero when requirements pass', async (t) => {
  const { root, runtime } = fixture(t);
  let output = '';
  const status = await doctorMain(['--json'], {
    productRoot: root,
    runtime,
    env: {},
    runCommand: commands(),
    probePort: async () => ({ available: true }),
    write: (text) => { output += text; },
    log: quietLog,
  });
  const report = JSON.parse(output);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.productRoot, root);
  assert.deepEqual(report.checks.map((check) => check.name), [
    'Node', 'npm', 'JDK 17+', 'Gradle wrapper', 'web dependencies', 'web/dist', 'current fatJar', 'port', 'data directory',
  ]);
  assert.ok(report.checks.every((check) => check.status === 'pass'));
});

test('doctor fails for an unsupported JDK without installing or building anything', async (t) => {
  const { root, runtime } = fixture(t);
  const report = await runDoctor({
    productRoot: root,
    runtime,
    env: {},
    runCommand: commands('openjdk version "11.0.2"'),
    probePort: async () => ({ available: true }),
    log: quietLog,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'JDK 17+').status, 'fail');
});

test('doctor reports a missing Java executable as a required failure', async (t) => {
  const { root, runtime } = fixture(t);
  const report = await runDoctor({
    productRoot: root,
    runtime,
    env: {},
    runCommand: (command) => command === 'java'
      ? { status: null, error: new Error('spawnSync java ENOENT') }
      : commands()(command),
    probePort: async () => ({ available: true }),
    log: quietLog,
  });
  const jdk = report.checks.find((check) => check.name === 'JDK 17+');
  assert.equal(jdk.status, 'fail');
  assert.match(jdk.detail, /ENOENT/);
});

test('occupied port and not-yet-created data directory are warnings, not failures', async (t) => {
  const { root, runtime } = fixture(t);
  rmSync(runtime.dataDir, { recursive: true });
  const report = await runDoctor({
    productRoot: root,
    runtime,
    env: {},
    runCommand: commands(),
    probePort: async () => ({ available: false }),
    log: quietLog,
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.name === 'port').status, 'warn');
  assert.equal(report.checks.find((check) => check.name === 'data directory').status, 'warn');
});

test('doctor reports every missing required artifact and returns nonzero', async (t) => {
  const { root, runtime } = fixture(t);
  rmSync(path.join(root, 'web/dist'), { recursive: true });
  rmSync(path.join(root, 'web/node_modules'), { recursive: true });
  rmSync(path.join(root, 'app/build/libs'), { recursive: true });
  rmSync(path.join(root, 'gradle/wrapper/gradle-wrapper.jar'));
  let output = '';
  const status = await doctorMain(['--json'], {
    productRoot: root,
    runtime,
    env: {},
    runCommand: (command) => command === 'java'
      ? { status: 0, stderr: 'openjdk version "17.0.12"' }
      : { status: null, error: new Error('ENOENT') },
    probePort: async () => ({ available: true }),
    write: (text) => { output += text; },
    log: quietLog,
  });
  const report = JSON.parse(output);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  for (const name of ['npm', 'Gradle wrapper', 'web dependencies', 'web/dist', 'current fatJar']) {
    assert.equal(report.checks.find((check) => check.name === name).status, 'fail', name);
  }
});

test('doctor treats an existing data file as a hard error', async (t) => {
  const { root, runtime } = fixture(t);
  rmSync(runtime.dataDir, { recursive: true });
  writeFileSync(runtime.dataDir, 'not a directory');
  const report = await runDoctor({
    productRoot: root,
    runtime,
    env: {},
    runCommand: commands(),
    probePort: async () => ({ available: true }),
    log: quietLog,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'data directory').status, 'fail');
});
