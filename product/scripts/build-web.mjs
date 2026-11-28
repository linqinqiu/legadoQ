// Windows 的共享 TEMP 可能拒绝 esbuild 删除大块 transform 输入。
// 为每次构建隔离临时目录，只传给构建子进程，保留标准 Vite 编译参数。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webRoot = path.join(productRoot, 'web');

export function runWebBuild({
  fallback = false,
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  log = console,
} = {}) {
  let temporaryDirectory;
  const temporaryRoot = path.join(productRoot, '..', 'tmp');
  try {
    let buildEnv = env;
    if (platform === 'win32') {
      mkdirSync(temporaryRoot, { recursive: true });
      temporaryDirectory = mkdtempSync(path.join(temporaryRoot, 'web-build-'));
      buildEnv = { ...env, TEMP: temporaryDirectory, TMP: temporaryDirectory };
      log.log(`[web-build] 临时目录：${temporaryDirectory}`);
    }
    const steps = [
      [path.join(webRoot, 'node_modules/typescript/bin/tsc'), '-b'],
      [path.join(webRoot, 'node_modules/vite/bin/vite.js'), 'build',
        ...(fallback ? ['--target', 'esnext', '--minify', 'terser'] : [])],
    ];
    for (const args of steps) {
      const result = spawn(process.execPath, args, { cwd: webRoot, env: buildEnv, stdio: 'inherit' });
      if (result.error || result.status !== 0) {
        if (result.error) log.error(`[web-build] ${result.error.message}`);
        return result.status ?? 1;
      }
    }
    return 0;
  } finally {
    if (temporaryDirectory) {
      // 只删除本次 mkdtemp 创建、且位于仓库 tmp 内的直接子目录。
      if (path.dirname(path.resolve(temporaryDirectory)) !== path.resolve(temporaryRoot)
          || !path.basename(temporaryDirectory).startsWith('web-build-')) {
        throw new Error(`拒绝清理范围外的构建目录：${temporaryDirectory}`);
      }
      try {
        rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        log.warn(`[web-build] 临时目录清理失败，已保留 ${temporaryDirectory}：${error.message}`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runWebBuild({ fallback: process.argv.includes('--fallback') });
}
