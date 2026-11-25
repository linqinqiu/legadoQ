import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleAssetName,
  declaredVersion,
  hashStaticDirectory,
  newestFatJar,
  readJarEntry,
  readJarStaticHashes,
  staticHashDifferences,
} from './runtime.mjs';

export const defaultProductRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function hasBuildSources(root) {
  return ['app/build.gradle', 'web/package.json', 'scripts/tasks.mjs']
    .every((relative) => existsSync(path.join(root, relative)));
}

/** 全量 static 文件哈希一致才认新；只拷 jar 的部署环境没有 dist 时仍允许启动。 */
export function isBundledUiStale(productRoot, jar, libs) {
  const distDirectory = path.join(productRoot, 'web', 'dist');
  const distIndex = path.join(distDirectory, 'index.html');
  if (!existsSync(distIndex)) {
    return { stale: existsSync(path.join(productRoot, 'web', 'package.json')), distAsset: '', jarAsset: '', reason: 'missing-dist' };
  }
  const jarPath = path.join(libs, jar);
  const distAsset = bundleAssetName(readFileSync(distIndex, 'utf8'));
  var jarAsset = '';
  try {
    const jarHashes = readJarStaticHashes(jarPath);
    jarAsset = jarHashes ? bundleAssetName(readJarEntry(jarPath) || '') : '';
    const differences = staticHashDifferences(hashStaticDirectory(distDirectory), jarHashes);
    const stale = differences.missing.length > 0 || differences.changed.length > 0 || differences.extra.length > 0;
    return { stale, distAsset, jarAsset, differences };
  } catch (error) {
    return { stale: true, distAsset, jarAsset, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 确保当前声明版本的 fatJar 可启动。最多自动构建一次，绝不回调 start。
 * @param {object} [options]
 * @returns {{ok: boolean, action: string, jar: string|null, error?: string}}
 */
export function ensureFatJar({
  productRoot = defaultProductRoot,
  env = process.env,
  noBuild = false,
  spawnBuild = (args, options) => spawnSync(process.execPath, args, options),
  jarIsStale = null,
} = {}) {
  const version = declaredVersion(productRoot);
  const libs = path.join(productRoot, 'app', 'build', 'libs');
  jarIsStale ??= (jar) => isBundledUiStale(productRoot, jar, libs);
  let jar = newestFatJar(libs, version);
  let stale = false;
  if (jar) {
    const inspection = jarIsStale(jar);
    stale = typeof inspection === 'object' ? inspection.stale : inspection;
    if (!stale) return { ok: true, action: 'ready', jar };
    if (env.LEGADO_ALLOW_STALE_JAR === '1') return { ok: true, action: 'stale-allowed', jar };
  }

  if (noBuild || env.LEGADO_NO_AUTO_BUILD === '1') {
    return {
      ok: false,
      action: 'disabled',
      jar,
      error: jar ? '自动构建已禁用，但当前 fatJar 的界面已过期。' : '自动构建已禁用，且当前 fatJar 不存在。',
    };
  }
  if (!hasBuildSources(productRoot)) {
    return {
      ok: false,
      action: 'missing-source',
      jar,
      error: jar
        ? '当前 fatJar 的界面已过期，且安装目录没有构建源码。请使用完整克隆或设置 LEGADO_ALLOW_STALE_JAR=1 回滚启动。'
        : '当前 fatJar 不存在，且安装目录没有构建源码（app/build.gradle、web/package.json、scripts/tasks.mjs）。请放入匹配的 fatJar 或使用完整克隆。',
    };
  }
  const ran = spawnBuild(['scripts/tasks.mjs', 'build'], {
    cwd: productRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env, LEGADO_SKIP_LIVE_UI_CHECK: '1' },
  });
  if (ran.error || ran.status !== 0) {
    return {
      ok: false,
      action: 'build-failed',
      jar,
      error: `自动构建失败（退出码 ${ran.status ?? 'null'}）。`,
      exitCode: ran.status ?? 1,
    };
  }
  jar = newestFatJar(libs, version);
  if (!jar) {
    return { ok: false, action: 'missing-after-build', jar: null, error: '自动构建已结束，但没有生成当前声明版本的 fatJar。' };
  }
  const rebuiltInspection = jarIsStale(jar);
  if (typeof rebuiltInspection === 'object' ? rebuiltInspection.stale : rebuiltInspection) {
    return { ok: false, action: 'stale-after-build', jar, error: '自动构建已结束，但 jar 内界面仍与 web/dist 不一致。' };
  }
  return { ok: true, action: stale ? 'rebuilt' : 'built', jar };
}
