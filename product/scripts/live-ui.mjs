import { createHash } from 'node:crypto';

/** 检查实际响应字节；总时限包含读取响应体，避免头已返回、正文挂起时卡住启动。 */
export async function verifyLiveUi(baseUrl, expected, { timeoutMs = 15000 } = {}) {
  if (!expected || !Object.hasOwn(expected, 'index.html')) {
    return { ok: false, reachable: false, checked: 0, failures: ['index.html:missing-expected'] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failures = [];
  let checked = 0;
  let reachable = false;
  const files = Object.keys(expected).sort();
  async function check(file) {
    try {
      const resource = file === 'index.html' ? '' : file.split('/').map(encodeURIComponent).join('/');
      const url = `${baseUrl.replace(/\/$/, '')}/${resource}`;
      const response = await fetch(url, {
        signal: controller.signal, cache: 'no-store', redirect: 'manual',
      });
      reachable = true;
      if (response.status !== 200) {
        failures.push(`${file}:http=${response.status}`);
        await response.body?.cancel();
        return;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      // 品牌名称/图标由服务端动态改写；manifest 验证可读及基本结构，其余文件逐字节比较。
      if (file === 'manifest.webmanifest') {
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.icons)) {
          failures.push(`${file}:invalid-manifest`);
        }
        return;
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== expected[file]) failures.push(`${file}:hash`);
    } catch {
      failures.push(`${file}:${controller.signal.aborted ? 'timeout' : 'unreachable'}`);
    } finally {
      checked += 1;
    }
  }
  try {
    // 首页先检，未监听时不再逐个尝试所有资源。
    await check('index.html');
    if (failures.length) return { ok: false, reachable, checked, failures };
    let next = 0;
    const assets = files.filter((file) => file !== 'index.html');
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
      while (next < assets.length) await check(assets[next++]);
    }));
    return { ok: failures.length === 0, reachable, checked, failures: failures.sort() };
  } finally {
    clearTimeout(timer);
  }
}
