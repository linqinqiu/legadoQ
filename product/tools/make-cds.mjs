// make-cds.mjs —— 生成 CDS（Class Data Sharing）类归档，给启动器省冷启动时间。
//
// 为什么需要它：这台机器上冷启动的 ~5.5 秒里，绝大部分是 **31MB fat jar 的类加载**
// （JVM 自身只 ~0.4 秒）。CDS 把"这次运行加载过的类"存成一份归档，下次直接从归档映射，
// 不再逐个从 jar 里读 + 校验。
//
// 归档是**跟这一份 jar 绑定的**：jar 一重建就得重新生成。所以每次 `:app:fatJar` 之后跑一次本脚本。
//
// 跑法：node tools/make-cds.mjs [--port N]
//   产物：app/build/cds/app.jsa   （start.mjs / start.cmd 会自动带上它）
//   `--port`：后台重建时用 —— 正在跑的服务占着默认端口，重建这一次得换一个。
//
// 生成时服务会真的起来一次（`--cds-dump`），脚本趁这 8 秒预热几个接口 —— 请求路径的类
// （规则引擎 / Jsoup / JsonPath）是懒加载的，不预热就进不了归档。然后进程自己正常退出，
// 归档由 JVM 的 shutdown hook 写盘。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { newestFatJar, resolveRuntime } from '../scripts/runtime.mjs';

const runtime = resolveRuntime();

/** `--port N`：覆盖监听端口（默认跟 start.mjs 同源）。 */
function portArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') return Number(argv[++i]);
    if (argv[i].startsWith('--port=')) return Number(argv[i].slice('--port='.length));
  }
  return null;
}
const override = portArg(process.argv.slice(2));
const port = Number.isInteger(override) && override > 0 ? override : runtime.port;

// 与 start.mjs 挑同一个包：归档给 A 包、启动跑 B 包的话，CDS 就只是白占磁盘。
const picked = newestFatJar(runtime.libs);
if (!picked) {
  console.error(`没有 ${runtime.libs}\\*-all.jar，先跑 gradle :app:fatJar`);
  process.exit(1);
}
const jar = path.join(runtime.libs, picked);
const outDir = path.join(runtime.root, 'app', 'build', 'cds');
mkdirSync(outDir, { recursive: true });
const archive = path.join(outDir, 'app.jsa');

const browseHost = runtime.host === '0.0.0.0' || runtime.host === '::' ? '127.0.0.1' : runtime.host;
const base = `http://${browseHost}:${port}`;
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';

console.log(`用 ${path.basename(jar)} 生成 CDS 归档（端口 ${port}）…`);
const child = spawn(
  java,
  [`-XX:ArchiveClassesAtExit=${archive}`, `-Djava.io.tmpdir=${runtime.tmpDir}`, '-jar', jar, '--cds-dump'],
  {
    env: {
      ...process.env,
      LEGADO_HOST: runtime.host,
      LEGADO_PORT: String(port),
      LEGADO_DATA_DIR: runtime.dataDir,
      LEGADO_DATABASE: runtime.database,
    },
    stdio: 'ignore',
  },
);

const hit = async (p) => {
  try {
    const res = await fetch(base + p, { signal: AbortSignal.timeout(20000) });
    return res.status;
  } catch { return 0; }
};

// 等就绪（端口 listen 不代表能服务）
let ready = false;
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if ((await hit('/healthz')) === 200) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!ready) { console.error('服务没起来，放弃'); child.kill(); process.exit(1); }

// 预热请求路径：规则引擎 / Jsoup / JsonPath / 路由与序列化那批类都是懒加载的。
const warm = ['/api/sources', '/api/bookshelf', '/api/bookshelf/groups', '/api/explore/sources',
  '/api/books/toc-rules', '/api/subscriptions', '/api/rss/sources', '/api/logs', '/api/about', '/api/changelog'];
for (const p of warm) await hit(p);
console.log(`已预热 ${warm.length} 个接口，等服务自己退出（--cds-dump 约 8 秒）…`);

await new Promise((resolve) => child.on('exit', resolve));
if (!existsSync(archive)) {
  console.error('归档没生成 —— 进程可能不是正常退出的');
  process.exit(1);
}
console.log(`归档已生成：${archive}（${(statSync(archive).size / 1048576).toFixed(1)}MB）`);
