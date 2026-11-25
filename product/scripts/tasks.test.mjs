import assert from 'node:assert/strict';
import test from 'node:test';

const tasksUrl = new URL('./tasks.mjs', import.meta.url).href;

test('tasks module imports safely and preserves build/test behavior', async () => {
  const { getTaskSteps, taskNames } = await import(tasksUrl);
  assert.deepEqual(taskNames, ['build', 'test', 'pr', 'full', 'release:check']);
  const build = getTaskSteps('build', {}).map((step) => step.command);
  assert.equal(build.length, 4);
  assert.match(build[0], /^npm --prefix web run build$/);
  assert.match(build[1], /tools\/verify\/dist-check\.mjs/);
  assert.match(build[2], /:app:fatJar/);
  assert.match(build[3], /tools\/verify\/bundled-ui-check\.mjs/);
  assert.equal(getTaskSteps('build', { LEGADO_WEB_BUILD: 'fallback' })[0].command, 'npm --prefix web run build:fallback');
  const checks = getTaskSteps('test', {}).map((step) => step.command);
  assert.equal(checks.length, 3);
  assert.match(checks[0], /scripts\/changelog\.mjs --check/);
  assert.match(checks[1], /^npm --prefix web test$/);
  assert.match(checks[2], /:app:test/);
});

test('pr runs protocol, docs, changelog, version, frontend and backend checks once', async () => {
  const { getTaskSteps } = await import(tasksUrl);
  const steps = getTaskSteps('pr', {});
  assert.deepEqual(steps.map((step) => step.label), [
    '1/9 工具协议一致',
    '2/9 API 文档与路由一致',
    '3/9 更新日志没漏记',
    '4/9 版本号一致',
    '5/9 交付契约',
    '6/9 工具脚本用例',
    '7/9 前端类型',
    '8/9 前端用例',
    '9/9 服务端用例',
  ]);
  assert.match(steps[0].command, /scripts\/protocol\.mjs --check/);
  assert.match(steps[1].command, /scripts\/gen-api-reference\.mjs --check/);
  assert.match(steps[2].command, /scripts\/changelog\.mjs --check/);
  assert.match(steps[3].command, /scripts\/version-check\.mjs/);
  assert.equal(steps[4].command, `"${process.execPath}" tools/verify/delivery-check.mjs`);
  assert.match(steps[5].command, /--test scripts\/\*\.test\.mjs$/);
  assert.match(steps[6].command, /^npm --prefix web run check$/);
  assert.match(steps[7].command, /^npm --prefix web test$/);
  assert.match(steps[8].command, /:app:test/);
  assert.equal(steps.filter((step) => step.command.endsWith(':app:test')).length, 1);
});

test('full builds before testing and verifies the packaged UI after tests', async () => {
  const { getTaskSteps } = await import(tasksUrl);
  const steps = getTaskSteps('full', {});
  assert.equal(steps.length, 15);
  assert.deepEqual(getTaskSteps('release:check', {}), steps);
  assert.equal(steps.filter((step) => step.command === 'npm --prefix web test').length, 1);
  assert.equal(steps.filter((step) => step.command === 'npm --prefix web run check').length, 1);
  assert.equal(steps.filter((step) => step.command === 'npm --prefix web run build').length, 1);
  assert.equal(steps.filter((step) => step.command.endsWith(':app:fatJar')).length, 1);
  assert.equal(steps.filter((step) => step.command.endsWith(':app:test')).length, 1);
  const buildIndex = steps.findIndex((step) => step.command === 'npm --prefix web run build');
  const frontendTestIndex = steps.findIndex((step) => step.command === 'npm --prefix web test');
  const backendTestIndex = steps.findIndex((step) => step.command.endsWith(':app:test'));
  assert.ok(buildIndex < frontendTestIndex && buildIndex < backendTestIndex, '必须先构建再跑随包测试');
  assert.match(steps[7].command, /tools\/verify\/dist-check\.mjs/);
  assert.match(steps[9].command, /tools\/verify\/bundled-ui-check\.mjs/);
  assert.match(steps.at(-2).command, /tools\/verify\/ui-tests-ran-check\.mjs/);
  assert.match(steps.at(-1).command, /tools\/verify\/bundle-budget-check\.mjs/);
  assert.equal(steps.filter((step) => step.command.endsWith('delivery-check.mjs')).length, 1);
  assert.equal(steps.filter((step) => step.command.endsWith('--test scripts/*.test.mjs')).length, 1);
});

test('runTask stops at the first failed step and propagates its exit code', async () => {
  const { runTask } = await import(tasksUrl);
  const calls = [];
  const status = runTask('pr', {
    cwd: '/product',
    spawn(command, options) {
      calls.push({ command, options });
      return { status: calls.length === 2 ? 9 : 0 };
    },
    log: { log() {}, error() {} },
  });
  assert.equal(status, 9);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, { cwd: '/product', stdio: 'inherit', shell: true });
});

test('unknown task returns usage exit code without spawning', async () => {
  const { runTask } = await import(tasksUrl);
  assert.equal(runTask('unknown', { spawn: () => assert.fail('must not spawn') }), 2);
});
