import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { bundleAssetName, childEnvironment, declaredVersion, ensureDirectories, newestFatJar, readJarEntry, resolveRuntime } from './scripts/runtime.mjs';
import { pickPort } from './scripts/port-select.mjs';

/**
 * 启动 legadoQ：后台拉起服务，等端口真的能连上了再打开浏览器。
 *
 * 命令行（借鉴 workbuddy-switch 的 `serve --port N --no-open`）：
 *   node start.mjs                 # 默认端口（.env / LEGADO_PORT / 1234），起来后自动开浏览器
 *   node start.mjs --port 1235     # 换端口
 *   node start.mjs --no-open       # 只起服务，不开浏览器
 *   node start.mjs --host 0.0.0.0  # 换绑定地址（默认只绑回环；非回环须显式放行）
 *   node start.mjs --host 0.0.0.0 --allow-external-bind  # 局域网/容器场景，风险自担
 * 传进来的值优先于 .env / 环境变量 / 默认值。
 */
function parseArgs(argv) {
  const out = { port: null, host: null, open: true, help: false, allowExternalBind: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--allow-external-bind') out.allowExternalBind = true;
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') out.host = argv[++i];
    else if (arg.startsWith('--host=')) out.host = arg.slice('--host='.length);
    else if (arg.startsWith('-')) { console.error(`未知参数：${arg}（可用：--port N / --host H / --no-open / --allow-external-bind）`); process.exit(2); }
    // 位置参数（如 `serve`）直接忽略，方便把它当子命令用
  }
  if (out.port !== null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    console.error(`--port 需要一个 1..65535 的整数，收到「${out.port}」`);
    process.exit(2);
  }
  return out;
}

/** 与界面、服务端用同一套判定：这些写法只在本机可达。 */
function isLoopbackHost(host) {
  const value = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1' || value === 'localhost';
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node start.mjs [--port N] [--host H] [--no-open] [--allow-external-bind]');
  console.log('  默认端口来自 .env / LEGADO_PORT，缺省 1234；起来后自动打开浏览器。');
  console.log('  默认只绑 127.0.0.1。绑非回环地址（如 0.0.0.0）必须加 --allow-external-bind，');
  console.log('  同一网络中的其它设备会因此能访问本服务。只在可信网络中临时使用。');
  process.exit(0);
}

const runtime = resolveRuntime();
if (args.port) runtime.port = args.port;
if (args.host) runtime.host = args.host;

const jar = newestFatJar(runtime.libs);
if (!jar) {
  const want = declaredVersion();
  console.error(want
    ? `没有 legado-${want}-all.jar（当前声明版本 ${want}）。先重建：node stop.mjs && npm run build`
    : `没有 ${runtime.libs}\\*-all.jar，先跑 gradle :app:fatJar`);
  process.exit(1);
}

/**
 * 启动前守卫：**包里的前端必须就是磁盘上刚构建的那一份**，否则不起。
 *
 * 判据用**内容指纹**（jar 内 `static/index.html` 的主 bundle 名 vs `web/dist/index.html`），
 * 不用 mtime —— Vite 每次重发 `web/dist` 都会刷新时间戳，而 Gradle 在内容没变时把
 * `fatJar` 判为 UP-TO-DATE、包的时间戳停在上一轮，只看 mtime 会把"内容完全一致的当前包"
 * 误判成旧包（2026-10-26 归零版本后第一次重建就撞上了）。
 *
 * 要拦的是 2026-10-26 那次真实事故：只重建了普通 jar、`fatJar` 没跑，`-all.jar` 停在三小时前，
 * `start.mjs` 只看文件名不看内容，于是旧界面又"成功启动"了一次。
 * （顺带修正一个容易误判的点：Windows 上 JVM 并不会锁死运行中的 jar，实测 `fatJar` 能就地覆盖，
 * 所以问题不在文件锁，在**没人调用 fatJar**。）
 *
 * 逃生口 `LEGADO_ALLOW_STALE_JAR=1`：故意跑旧包做回滚验证时用。
 */
const distIndex = path.join(runtime.root, 'web', 'dist', 'index.html');
if (existsSync(distIndex)) {
  const jarPath = path.join(runtime.libs, jar);
  const distAsset = bundleAssetName(readFileSync(distIndex, 'utf8'));
  const jarAsset = bundleAssetName(readJarEntry(jarPath) || '');
  const stale = !jarAsset
    // 读不到包内条目（没有 PowerShell/unzip，或包里没有 index.html）→ 退回旧的 mtime 判断
    ? statSync(distIndex).mtimeMs > statSync(jarPath).mtimeMs + 1000
    : distAsset !== jarAsset;
  if (stale && !process.env.LEGADO_ALLOW_STALE_JAR) {
    console.error(`这个 jar 里没有当前界面，拒绝启动。`);
    console.error(`  jar   ${jar}  包内前端 ${jarAsset || '(读不到，退回按时间判断)'}`);
    console.error(`  dist  web/dist  ${distAsset || '(读不到)'}`);
    console.error(`先重建（顺序不能反，运行中的进程加载的是旧包）：`);
    console.error(`  node stop.mjs && npm run build && node start.mjs`);
    console.error(`确实要跑这个旧包（回滚验证）：LEGADO_ALLOW_STALE_JAR=1 node start.mjs`);
    process.exit(1);
  }
  if (distAsset) console.log(`界面指纹 ${distAsset}${jarAsset && jarAsset !== distAsset ? `（jar 内是 ${jarAsset}，靠 LEGADO_ALLOW_STALE_JAR 放行）` : ''}`);
}
// 用 let：端口在下面可能因“默认端口被别的程序占了”而改，环境变量要跟着重算一次。
let env = childEnvironment(runtime);
if (args.allowExternalBind) env.LEGADO_ALLOW_EXTERNAL_BIND = '1';

/**
 * 绑定地址的启动前防呆（用户要求：对 LEGADO_HOST 的修改强警告确认）。
 *
 * 服务端也有同一道闸门（`requireLoopbackBind`），但等 Java 起来才拒绝，用户会先盯两分钟
 * "正在启动"；这里在 spawn 之前就说清楚，并给出两条明确的路：留在本机，或显式放行。
 * `--allow-external-bind` 只是把同一个环境变量交出去，不是第二套开关。
 */
if (!isLoopbackHost(runtime.host)) {
  if (env.LEGADO_ALLOW_EXTERNAL_BIND !== '1') {
    console.error(`拒绝绑定到 ${runtime.host}：这不是回环地址。`);
    console.error('同一网络中的其它设备将能访问本服务及其全部接口（没有登录口令）。');
    console.error('仅本机使用：去掉 --host，或设置 LEGADO_HOST=127.0.0.1。');
    console.error(`确实要从其它设备访问：node start.mjs --host ${runtime.host} --allow-external-bind`);
    console.error('（等价于 LEGADO_ALLOW_EXTERNAL_BIND=1；只在可信网络中临时使用。）');
    process.exit(1);
  }
  console.warn(`⚠️ 正在绑定非回环地址 ${runtime.host}：同一网络中的设备可以访问本服务的全部接口。`);
  console.warn('   请确认处在可信网络；不需要对外时，改用默认的 127.0.0.1 重启。');
}

ensureDirectories(runtime);

/** 浏览器地址：绑 0.0.0.0 时用回环地址访问自己。 */
const browseHost = runtime.host === '0.0.0.0' || runtime.host === '::' ? '127.0.0.1' : runtime.host;
let url = `http://${browseHost}:${runtime.port}`;

/** 服务是否已经就绪（/healthz 能答）。端口 listen 不代表能服务：冷启动要十几秒。 */
async function isReady(target) {
  try {
    const res = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

/** 等 /healthz 真的能答 —— 起来之前打开浏览器只会看到"正在打开阅读空间…"。 */
async function waitForHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就只打印地址，不是致命错误 */ }
}

/** 指定端口能不能绑：`pickPort` 的探测回调（绑上立刻放掉，不占端口）。 */
function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** 找一个空闲端口：后台重建 CDS 时用（刚起来的服务占着默认那个）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * CDS 归档过期/缺失时**在后台重建**：这次照常起、只是没享受到那几秒，重建完下次启动就快了。
 * 用另一个端口 + detached，不挡这次启动、也不和刚起来的服务抢端口。
 */
async function rebuildCds() {
  try {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [path.join(runtime.root, 'tools', 'make-cds.mjs'), '--port', String(port)],
      { cwd: runtime.root, detached: true, stdio: 'ignore' },
    );
    child.unref();
    console.log('CDS 归档已过期 —— 正在后台重建（这次先用不着它，下次启动会更快）');
  } catch (error) {
    console.log(`CDS 归档已过期，后台重建没起来：${error instanceof Error ? error.message : error}`);
  }
}

/** 端口上正在监听的 PID。 */
function pidsOnPort(target) {
  try {
    const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
      .filter((line) => new RegExp(`:${target}\\s`).test(line) && /LISTENING/i.test(line));
    return [...new Set(lines.map((line) => line.trim().split(/\s+/).pop()))];
  } catch { return []; }
}

/**
 * 端口上"跑着本项目 jar、且启动时间早于当前 jar 的 mtime"的 PID —— 也就是需要重启的陈旧实例。
 *
 * 为什么按"进程启动时间 vs jar 的 mtime"而不是直接看 jar 文件：jar 被重建覆盖时，旧进程仍持有
 * 旧内容（Windows 允许覆盖被打开的文件），磁盘上 jar 的 mtime 已经是新的 —— 只看文件看不出陈旧。
 * 只有"进程启动早于 jar 的 mtime"才说明它加载的是重建前的那一份。
 *
 * **三态返回，不要退化成空数组。** 曾经这里所有失败路径都 `return []`，调用方把"空"读成
 * "没有陈旧实例"，于是打印「legadoQ 已在运行」并退出 —— 而真相是"我根本没查清"。
 * 提权进程的 `CommandLine` 读不到（`Get-CimInstance` 返回空）正好落进这个陷阱：端口被一个
 * 旧实例占着、界面是白屏，启动器却报"已在运行"，用户和代理都拿不到任何修复入口。
 * 所以：查不清就报 unknown，让调用方明确告知并给出可执行的下一步。
 *
 * @returns {{kind: 'none'|'stale'|'unknown', pids: string[], reason?: string}}
 */
function staleRunningPids(target, jarPath) {
  // 非 Windows 没有这条检测通道。这不影响正确性（那边没有"覆盖被打开的 jar"的语义），
  // 但必须标明是"不适用"而不是"已检查且干净"。
  if (process.platform !== 'win32') return { kind: 'none', pids: [], reason: '非 Windows 平台不适用' };
  let jarMtime;
  try { jarMtime = statSync(jarPath).mtimeMs; } catch (error) {
    // 连当前 jar 都 stat 不到，就无法判断谁新谁旧。
    return { kind: 'unknown', pids: [], reason: `读不到当前 jar 的 mtime（${jarPath}）` };
  }
  const portPids = pidsOnPort(target);
  // 端口上没人监听：不是"陈旧"，是"可以干净启动"。
  if (!portPids.length) return { kind: 'none', pids: [] };
  let rows;
  try {
    rows = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | ForEach-Object { $_.ProcessId.ToString() + '|' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + '|' + $_.CommandLine }`,
    ], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return { kind: 'unknown', pids: portPids, reason: `进程清单查询失败（${error instanceof Error ? error.message : error}）` };
  }
  const stale = [];
  // 端口上有监听者、但进程清单里一个都没匹配到 —— 典型的"进程信息读不全"（提权进程
  // 的 CommandLine 对非提权调用方不可见），绝不能当成"没有陈旧实例"。
  let sawPortPid = false;
  for (const row of rows) {
    const [pid, ms, ...rest] = row.split('|');
    if (!portPids.includes(pid)) continue;
    sawPortPid = true;
    if (!/legado-.*-all\.jar/.test(rest.join('|'))) continue;
    const start = Number(ms);
    if (Number.isFinite(start) && start > 0 && start < jarMtime) stale.push(pid);
  }
  if (!sawPortPid) {
    return {
      kind: 'unknown',
      pids: portPids,
      reason: `端口 ${target} 被 PID ${portPids.join(',')} 占用，但查不到该进程的命令行（常见于提权运行的实例）`,
    };
  }
  return stale.length ? { kind: 'stale', pids: stale } : { kind: 'none', pids: [] };
}

// 幂等 + 防陈旧：已经在跑时，若它跑的是比磁盘上这份 jar 更老的构建（jar 重建过、旧进程还占着端口），
// 先停旧再起新；否则只开界面 —— 重复点图标不该报"端口被占"，也不该再起第二个实例。
if (await isReady(url)) {
  const probe = staleRunningPids(runtime.port, path.join(runtime.libs, jar));
  if (probe.kind === 'unknown') {
    // 查不清就别假装"没事"。端口被占着、旧实例在应答，但我们不知道它跑的是哪个构建 ——
    // 这时说「legadoQ 已在运行」会让人以为一切正常，实际可能是一个界面已经对不上磁盘 jar 的旧进程。
    // 直接把现状 + 可执行的下一步交给用户（提权实例那条命令是实测能用的）。
    console.error(`无法确认端口 ${runtime.port} 上那个 legadoQ 是不是当前构建。`);
    console.error(`  原因：${probe.reason}`);
    console.error(`  地址：${url}（/healthz 仍在应答，说明是旧实例占着端口）`);
    console.error('');
    console.error('  下一步任选其一：');
    console.error(`    1) 换个端口起一个新的：node start.mjs --port ${runtime.port + 1}`);
    console.error(`    2) 结束占用者 PID ${probe.pids.join(',') || '(未知)'}，再重新运行本命令。`);
    console.error('       普通权限结束不掉时（提权实例），在本机开一个 PowerShell 执行：');
    for (const pid of (probe.pids.length ? probe.pids : ['<PID>'])) {
      console.error(`       (Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}').Terminate()`);
    }
    process.exit(1);
  }
  if (probe.kind === 'none') {
    console.log(`legadoQ 已在运行 ${url}`);
    if (args.open) openBrowser(url);
    process.exit(0);
  }
  console.log('运行中的实例比当前 jar 更旧（jar 重建过）—— 先停旧实例再起新的');
  for (const pid of probe.pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/F']); console.log(`已停止旧实例 PID ${pid}`); }
    catch (error) { console.log(`停止 PID ${pid} 失败：${error instanceof Error ? error.message : error}`); }
  }
  // 等端口真的空出来（进程退出 + 内核回收需要一点时间），否则下面的探针会误判"端口被占"
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (await isReady(url))) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * 默认端口被**别的程序**占着时，自己往上找一个能用的（用户 2026-11-12：
 * 「当前固定的 1234 是否不好，应该让其自己找合适的端口」）。
 *
 * 与上面那段的关系：上面处理的是「占端口的就是本项目的一个实例」——
 * 那属于"已经开着了"，要嘛直接开界面、要嘛先停旧的。走到这里说明端口上
 * 是我们不认识的东西（另一个阅读器、某个 dev server、系统服务），
 * 硬失败会让用户以为 legadoQ 坏了。
 *
 * 找的时候**不写 port.txt**：那是"用户选的端口"，被一次临时占用改掉，
 * 下次启动就再也回不到 1234 了。临时选中的端口只在本进程里有效，
 * 并明确告诉用户怎么固定下来。
 */
if (!(await canListen(runtime.port, runtime.host))) {
  const requested = runtime.port;
  const fallback = await pickPort(requested, (port) => canListen(port, runtime.host), { limit: 20 });
  if (!fallback) {
    console.error(`端口 ${requested} 被占用，往后 20 个端口也都不可用。`);
    console.error('先确认这台机器上是不是有别的程序在大量占端口，或显式指定一个空闲端口：');
    console.error('  node start.mjs --port 1300');
    process.exit(1);
  }
  runtime.port = fallback;
  url = `http://${browseHost}:${runtime.port}`;
  // env 里带着 LEGADO_PORT，必须跟着改，否则 Java 仍去绑那个被占的端口。
  env = childEnvironment(runtime);
  if (args.allowExternalBind) env.LEGADO_ALLOW_EXTERNAL_BIND = '1';
  console.warn(`端口 ${requested} 被别的程序占用了 —— 这次改用 ${fallback}。`);
  console.warn(`  地址：${url}`);
  console.warn(`  想固定在这个端口：停掉后 node start.mjs --port ${fallback}` +
    `（或在界面「设置 → 服务端口」里改成它，会写进 port.txt）。`);
}

const probe = net.createServer();
probe.once('error', (err) => {
  console.error(`端口 ${runtime.port} 不可用（${err.code}）：可能已有一个 legadoQ 在跑 —— 先 node stop.mjs，或换端口 node start.mjs --port ${runtime.port + 1}。`);
  process.exit(1);
});
probe.listen(runtime.port, runtime.host, () => {
  probe.close(async () => {
    const log = openSync(runtime.logFile, 'a');
    const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javaBin) : javaBin;
    const jvmArgs = [
      // JDK 18+ 控制台编码默认跟随系统 ANSI（这里是 GBK），中文日志会乱码 → 显式 UTF-8。
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      // 不指定的话 JVM 临时目录是 C:\Users\<用户>\AppData\Local\Temp，装到哪都会往系统盘写。
      `-Djava.io.tmpdir=${runtime.tmpDir}`,
      // 堆上限：不写就是「物理内存的 1/4」。服务本身一直没 OOM 过（server.log 无记录），
      // 但一台机器上常常同时跑着门禁（headless Chrome），默认值会让两者抢内存。
      // 给一个明确上限，并用 LEGADO_MAX_HEAP 留出调大/调小的口子。
      `-Xmx${process.env.LEGADO_MAX_HEAP || '1g'}`,
      // OOM 时直接退出而不是让 JVM 半死不活：启动脚本能据此报错，比留一个半死的进程可诊断。
      '-XX:+ExitOnOutOfMemoryError',
      // 崩溃日志跟着运行日志走，而不是当前工作目录。注：仓库根那 30 份 hs_err 全部来自
      // Gradle 构建链（见 gradle.properties 的 jvmargs 注释），与服务进程无关；这一行是
      // 防止将来服务真崩时又往 cwd 里散文件。
      `-XX:ErrorFile=${path.join(path.dirname(runtime.logFile), 'hs_err_pid%p.log')}`,
    ];
    // CDS 类归档（tools/make-cds.mjs 生成）：冷启动实测 ~8.3s → ~5.3s。
    // 归档是跟这一份 jar 绑定的 —— 过期/缺失就不带它（这次慢一点），起完在后台重建给下次用。
    const cdsArchive = path.join(runtime.root, 'app', 'build', 'cds', 'app.jsa');
    const jarPath = path.join(runtime.libs, jar);
    const cdsFresh = existsSync(cdsArchive) && statSync(cdsArchive).mtimeMs >= statSync(jarPath).mtimeMs;
    if (cdsFresh) jvmArgs.push(`-XX:SharedArchiveFile=${cdsArchive}`);
    // detached + unref：服务作为独立进程存活，不随调用方退出而被回收。
    const child = spawn(java, [...jvmArgs, '-jar', path.join(runtime.libs, jar)], {
      env, stdio: ['ignore', log, log], detached: true, windowsHide: true,
    });
    child.unref();
    console.log(`正在启动 ${url}  PID=${child.pid}`);
    console.log(`安装目录 ${runtime.root}`);
    console.log(`数据目录 ${runtime.dataDir}`);
    console.log(`日志     ${runtime.logFile}`);
    console.log(`临时目录 ${runtime.tmpDir}`);

    const ready = await waitForHealth();
    if (!ready) {
      console.error(`等了很久服务 ${url} 还没就绪，看看日志：${runtime.logFile}`);
      process.exit(1);
    }
    console.log(`服务已就绪 ${url}`);

    /**
     * 启动后自检：**运行实例在发的 bundle** 必须等于 **磁盘上的 web/dist**。
     *
     * 光看进程起来没有用 —— 2026-10-26 那次就是"重启成功、界面还是三天前的"。这一步把
     * 结论变成一句能印在终端上的话；不一致时**不开浏览器**（开了就是让人再看一遍旧界面），
     * 服务本身继续跑，只把退出码给成 1，脚本调用方能据此判断。
     */
    if (existsSync(distIndex)) {
      const want = bundleAssetName(readFileSync(distIndex, 'utf8'));
      try {
        const html = await fetch(`${url}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text());
        const got = bundleAssetName(html);
        if (want && got && want !== got) {
          console.error(`界面不一致：运行中的是 ${got}，磁盘上构建出来的是 ${want}。`);
          console.error(`这个 jar 里没有当前前端。修复：node stop.mjs && npm run build && node start.mjs`);
          process.exit(1);
        }
        if (want && got) console.log(`界面已对上 ${got}`);
      } catch (error) {
        console.log(`（启动后自检没跑成：${error instanceof Error ? error.message : error}）`);
      }
    }

    if (!cdsFresh) void rebuildCds();
    if (args.open) openBrowser(url);
    else console.log('（--no-open：没有打开浏览器）');
  });
});
