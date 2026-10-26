// 运行时位置解析：start.mjs 与 stop.mjs 共用一份，避免两边端口/路径各写一遍而飘掉。
// 优先级：.env 文件 > 进程环境变量 > 默认值。默认值全部落在安装目录内，一个字节都不写 C 盘。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 安装目录：脚本自己所在目录，所以整个文件夹可以随意改名/搬盘；LEGADO_HOME 可显式指定。 */
export const installRoot = process.env.LEGADO_HOME
  ?? dirname(dirname(fileURLToPath(import.meta.url)));

export function readEnvFile(root = installRoot) {
  const file = process.env.LEGADO_ENV ?? join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)).filter(Boolean)
      .map((match) => [match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]),
  );
}

/** 安装根下的 `port.txt`：界面上改端口时写的就是它（一行数字）。 */
export function readPortFile(root = installRoot) {
  const file = join(root, 'port.txt');
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function resolveRuntime() {
  const file = readEnvFile();
  const pick = (name, fallback) => file[name] ?? process.env[name] ?? fallback;
  const root = installRoot;
  const dataDir = pick('LEGADO_DATA_DIR', join(root, 'data'));
  // 端口优先级：命令行 `--port`（start.mjs 自己覆盖）> `port.txt`（界面里改的那个）> `.env` / 环境变量 > 1234。
  // port.txt 排在 .env 前面：它是**使用者在界面上最后改的那一下**，比一份可能早就不记得的 .env 更算数。
  const portFromFile = readPortFile(root);
  const port = portFromFile ?? Number(pick('LEGADO_PORT', '1234'));
  return {
    root,
    libs: join(root, 'app', 'build', 'libs'),
    envFileUsed: process.env.LEGADO_ENV ?? join(root, '.env'),
    host: pick('LEGADO_HOST', '127.0.0.1'),
    port,
    portFromFile,
    dataDir,
    database: pick('LEGADO_DATABASE', join(dataDir, 'legado.sqlite')),
    // 日志与 JVM 临时目录以前一个写死在仓库根、一个默认落到系统临时目录（Windows 上是 C:\Users\<用户>\AppData\Local\Temp），装到哪都会往系统盘写；现在两者都相对安装根、可 env 覆盖。
    logFile: pick('LEGADO_LOG_FILE', join(root, 'server.log')),
    tmpDir: pick('LEGADO_TMP_DIR', join(root, 'tmp')),
    // 免登录：服务端还要求绑定地址本身就是回环，改成 0.0.0.0 会自动失效。
  };
}

export function childEnvironment(runtime) {
  return {
    ...process.env,
    ...readEnvFile(),
    // 服务端靠这个知道"安装根在哪"，界面改端口时才知道该把 port.txt 写到哪。
    LEGADO_HOME: runtime.root,
    LEGADO_HOST: runtime.host,
    LEGADO_PORT: String(runtime.port),
    LEGADO_DATA_DIR: runtime.dataDir,
    LEGADO_DATABASE: runtime.database,
  };
}

export function ensureDirectories(runtime) {
  for (const dir of [runtime.dataDir, runtime.tmpDir, dirname(runtime.logFile)]) {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * 当前声明的版本号：安装根上一级的 `VERSION` 优先，回落 `app/build.gradle` 的 `version`。
 * 读不到返回空串（例如只拷走 jar 的部署环境），调用方据此退化。
 */
export function declaredVersion(root = installRoot) {
  const outer = join(root, '..', 'VERSION');
  if (existsSync(outer)) {
    const v = readFileSync(outer, 'utf8').replace(/^v/i, '').trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  }
  const gradle = join(root, 'app', 'build.gradle');
  if (existsSync(gradle)) {
    const m = /^\s*version\s*=\s*['"](\d+\.\d+\.\d+)['"]/m.exec(readFileSync(gradle, 'utf8'));
    if (m) return m[1];
  }
  return '';
}

/**
 * 挑出**该跑的那一份** fat jar，返回文件名；没有则 null。
 *
 * 规则是"先对上当前声明版本，同版本再按 mtime 取最近构建的那一份"，不是"取版本号最大的"。
 * 2026-10-26 归零版本时踩过：`legado-0.0.0-all.jar` 已经打出来了，按最高版本挑却选中
 * 旧的 `legado-0.8.7-all.jar` —— 于是门禁报"包内前端不是当前那份"、启动的还是旧界面。
 * 版本回退、跳号、同版本重打这三种情况，都只有"版本 + mtime"能选对。
 *
 * 读不到声明版本（只拷 jar 的部署环境）才退回旧行为：最高版本、同版本取 mtime。
 *
 * 收口成一处还有第二层原因：`start.mjs`、`tools/make-cds.mjs`、
 * `tools/verify/bundled-ui-check.mjs` 必须挑同一个包，否则门禁绿而跑的是另一个。
 */
export function newestFatJar(libsDir, wantVersion = declaredVersion()) {
  if (!existsSync(libsDir)) return null;
  const names = readdirSync(libsDir).filter((name) => name.endsWith('-all.jar'));
  if (!names.length) return null;
  const versionOf = (name) => (name.match(/(\d+)\.(\d+)\.(\d+)/) || [, '0', '0', '0']).slice(1).join('.');
  const byMtime = (a, b) => statSync(join(libsDir, b)).mtimeMs - statSync(join(libsDir, a)).mtimeMs;
  if (wantVersion) return names.filter((name) => versionOf(name) === wantVersion).sort(byMtime)[0] ?? null;
  const highest = names.slice().sort((a, b) => (versionOf(a) > versionOf(b) ? 1 : versionOf(a) < versionOf(b) ? -1 : 0)).pop();
  return names.filter((name) => versionOf(name) === versionOf(highest)).sort(byMtime)[0] ?? null;
}

/**
 * 从一份 `index.html` 里取出 Vite 生成的主 bundle 文件名（带内容哈希，等于构建指纹）。
 *
 * 放共享层是因为有两处要说同一句话：`start.mjs` 的启动后自检（"跑着的前端 == 磁盘上的前端"）
 * 与 `tools/verify/bundled-ui-check.mjs`（"jar 里的 == dist == 运行中的"）。
 * 取不到（不是 Vite 产物、或页面还没引 bundle）返回空串，由调用方决定跳过还是判失败。
 */
export function bundleAssetName(html) {
  return (html || '').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? '';
}

/**
 * 读出 jar（zip）里某个条目的文本；读不到返回 null。
 *
 * 不引第三方 zip 库：Windows 走自带的 .NET，类 Unix 走 `unzip`。
 * 用途是**按内容判新鲜度** —— mtime 会假阳性：Vite 每次重发 `web/dist` 都刷新时间戳，
 * 而 Gradle 在内容没变时把 `fatJar` 判为 UP-TO-DATE、包时间戳停在上一轮，
 * 只看 mtime 就会把"内容完全一致的当前包"误判成旧包。
 */
export function readJarEntry(jarPath, entry = 'static/index.html') {
  if (!existsSync(jarPath)) return null;
  try {
    if (process.platform === 'win32') {
      const ps = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;' +
        `$z=[System.IO.Compression.ZipFile]::OpenRead('${jarPath.replace(/'/g, "''")}');` +
        `$e=$z.Entries | Where-Object { $_.FullName -replace '\\\\','/' -eq '${entry}' };` +
        'if ($e) { $s=New-Object System.IO.StreamReader($e.Open()); $s.ReadToEnd(); $s.Close() };' +
        '$z.Dispose()';
      return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 24 });
    }
    return execFileSync('unzip', ['-p', jarPath, entry], { encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch {
    return null;
  }
}
