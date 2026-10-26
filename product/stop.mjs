import { execFileSync } from 'node:child_process';
import { resolveRuntime } from './scripts/runtime.mjs';

/** `node stop.mjs [--port N]`：按端口找本项目的 java 进程停掉。端口默认与 start.mjs 同源。 */
function portArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') return Number(argv[++i]);
    if (arg.startsWith('--port=')) return Number(arg.slice('--port='.length));
  }
  return null;
}

const override = portArg(process.argv.slice(2));
const { port: defaultPort } = resolveRuntime();
const port = Number.isInteger(override) && override > 0 ? override : defaultPort;

/** 这个端口上正在听的那些 PID。 */
function pidsOnPort(target) {
  const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter((line) => new RegExp(`:${target}\\s`).test(line) && /LISTENING/i.test(line));
  return [...new Set(lines.map((line) => line.trim().split(/\s+/).pop()))];
}

/**
 * 按 jar 找本项目进程（不认端口）。**换了端口之后靠它兜底**：
 * 在界面上把端口从 1234 改成 1235 之后、还没重启时，服务其实仍在 1234 上跑，
 * 而配置里的端口已经是 1235 —— 只按端口找会"找不到"，于是以为没在跑。
 */
function projectPids() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -match 'legado-.*-all\\.jar' } | ForEach-Object { $_.ProcessId }`,
  ], { encoding: 'utf8' });
  return [...new Set(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

let pids = pidsOnPort(port);
if (!pids.length) {
  pids = projectPids();
  if (pids.length) console.log(`端口 ${port} 上没有服务；按 jar 找到 ${pids.length} 个本项目进程`);
}
if (!pids.length) { console.log('没有在跑的 legadoQ 服务'); process.exit(0); }

for (const pid of pids) {
  // 只认命令行里确实是本项目 jar 的进程：按 PID 盲杀过一次，教训写在这儿。
  const info = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1 | ForEach-Object { $_.Name + '|' + $_.CommandLine })`,
  ], { encoding: 'utf8' }).trim();
  const [name, cmd = ''] = info.split('|');
  if (!/java\.exe/i.test(name || '') || !/legado-.*-all\.jar/.test(cmd)) {
    console.log(`跳过 PID ${pid}：不是本项目的服务进程（${name || '未知'}）`);
    continue;
  }
  execFileSync('taskkill', ['/PID', pid, '/F']);
  console.log(`已停止 PID ${pid}（${name}）`);
}
