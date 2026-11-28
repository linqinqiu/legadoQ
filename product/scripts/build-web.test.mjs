import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebBuild } from './build-web.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('Windows 构建隔离子进程 TEMP/TMP，保留默认编译参数，结束后清理', () => {
  const env = { TEMP: 'shared-temp', TMP: 'shared-tmp', CUSTOM: 'keep' };
  const directories = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const calls = [];
    assert.equal(runWebBuild({ platform: 'win32', env, log: quiet, spawn(command, args, options) {
      assert.equal(command, process.execPath);
      assert.equal(options.env.TEMP, options.env.TMP);
      assert.equal(path.dirname(options.env.TEMP), fileURLToPath(new URL('../../tmp', import.meta.url)));
      assert.equal(options.env.CUSTOM, 'keep');
      assert.equal(existsSync(options.env.TEMP), true);
      calls.push({ args, temporaryDirectory: options.env.TEMP });
      return { status: 0 };
    } }), 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(1), ['-b']);
    assert.deepEqual(calls[1].args.slice(1), ['build']);
    assert.equal(calls[0].temporaryDirectory, calls[1].temporaryDirectory);
    assert.equal(existsSync(calls[0].temporaryDirectory), false);
    directories.push(calls[0].temporaryDirectory);
  }
  assert.notEqual(directories[0], directories[1]);
  assert.deepEqual(env, { TEMP: 'shared-temp', TMP: 'shared-tmp', CUSTOM: 'keep' });
});

test('类型检查失败立即停止、传递退出码并清理临时目录', () => {
  let count = 0;
  let directory;
  assert.equal(runWebBuild({ platform: 'win32', log: quiet, spawn(command, args, options) {
    count++;
    directory = options.env.TEMP;
    return { status: 7 };
  } }), 7);
  assert.equal(count, 1);
  assert.equal(existsSync(directory), false);
});

test('非 Windows 保留临时环境；fallback 显式传递既有兜底参数及构建失败', () => {
  const env = { TEMP: 'existing' };
  let count = 0;
  assert.equal(runWebBuild({ platform: 'linux', fallback: true, env, log: quiet,
    spawn(command, args, options) {
      assert.equal(options.env, env);
      if (++count === 1) return { status: 0 };
      assert.deepEqual(args.slice(1), ['build', '--target', 'esnext', '--minify', 'terser']);
      return { status: 3 };
    },
  }), 3);
  assert.equal(count, 2);
});
