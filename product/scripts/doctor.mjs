#!/usr/bin/env node
// 启动环境只读体检：不安装依赖、不构建、不创建目录，也不启动服务。
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProductRoot } from './bootstrap.mjs';
import { declaredVersion, newestFatJar, resolveRuntime } from './runtime.mjs';

const MAJOR = /(?:version\s+")?(\d+)(?:\.\d+)?/i;
const number = (value) => Number(String(value ?? '').match(MAJOR)?.[1] ?? 0);
const isFile = (file) => existsSync(file) && statSync(file).isFile();
const isDirectory = (dir) => existsSync(dir) && statSync(dir).isDirectory();

function probeCommand(command, args, env) {
  if (command === 'npm') {
    // npm 在 Windows 上是 .cmd；优先用当前 npm 的 JS 入口，避免 shell 与路径空格问题。
    if (env.npm_execpath && isFile(env.npm_execpath)) {
      return spawnSync(process.execPath, [env.npm_execpath, ...args], { encoding: 'utf8' });
    }
    if (process.platform === 'win32') {
      return spawnSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { encoding: 'utf8' });
    }
    return spawnSync('npm', args, { encoding: 'utf8' });
  }
  if (command === 'java' && env.JAVA_HOME) {
    const java = path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (isFile(java)) return spawnSync(java, args, { encoding: 'utf8' });
  }
  return spawnSync(command, args, { encoding: 'utf8' });
}

function probePort(port, host) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ available: false, error: `无效端口 ${port}` });
      return;
    }
    const server = net.createServer();
    server.once('error', (error) => resolve({ available: false, error: error.code || error.message }));
    server.listen(port, host, () => server.close(() => resolve({ available: true })));
  });
}

/**
 * 只读检查并返回结构化报告。注入项用于测试公开行为，不影响默认 CLI。
 * required=fail 决定非零退出；端口占用/数据目录未创建只是可自动恢复的告警。
 */
export async function runDoctor(options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? resolveRuntime();
  const root = options.productRoot ?? runtime.root ?? defaultProductRoot;
  const runCommand = options.runCommand ?? ((command, args) => probeCommand(command, args, env));
  const checkPort = options.probePort ?? probePort;
  const log = options.log ?? console;
  const checks = [];
  const add = (name, ok, detail, { required = true, warn = false } = {}) => {
    checks.push({ name, status: ok ? 'pass' : warn ? 'warn' : 'fail', required, detail });
  };

  let engines = { node: '>=20.0.0', npm: '>=10.0.0' };
  try { engines = { ...engines, ...JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines }; } catch { /* 使用已知最低版本 */ }
  const nodeMajor = number(process.versions.node);
  const nodeMin = number(engines.node);
  add('Node', nodeMajor >= nodeMin, `${process.versions.node}（要求 ${engines.node}）`);

  let npmVersion = '';
  try {
    const ran = runCommand('npm', ['--version']);
    npmVersion = String(ran.stdout || '').trim();
    const npmMin = number(engines.npm);
    const npmOk = ran.status === 0 && number(npmVersion) >= npmMin;
    add('npm', npmOk, npmOk ? npmVersion : `${npmVersion || ran.error?.message || '无法读取版本'}（要求 ${engines.npm}）`);
  } catch (error) {
    add('npm', false, error.message);
  }

  try {
    const ran = runCommand('java', ['-version']);
    const output = `${ran.stdout || ''}\n${ran.stderr || ''}`.trim();
    const javaMajor = number(output.match(/(?:openjdk|java)\s+version\s+"(\d+)/i)?.[1] ?? output.match(/version\s+"(\d+)/i)?.[1]);
    add('JDK 17+', ran.status === 0 && javaMajor >= 17, `${output.split(/\r?\n/)[0] || ran.error?.message || '无法读取版本'}（要求 17+）`);
  } catch (error) {
    add('JDK 17+', false, error.message);
  }

  const wrapperFiles = [
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
    'gradle/wrapper/gradle-wrapper.jar',
    'gradle/wrapper/gradle-wrapper.properties',
  ];
  const missingWrapper = wrapperFiles.filter((relative) => !isFile(path.join(root, relative)));
  add('Gradle wrapper', missingWrapper.length === 0, missingWrapper.length ? `缺少 ${missingWrapper.join(', ')}` : 'wrapper 脚本与 jar 齐全');

  let dependencies = [];
  try {
    const webPackage = JSON.parse(readFileSync(path.join(root, 'web', 'package.json'), 'utf8'));
    dependencies = Object.keys({ ...webPackage.dependencies, ...webPackage.devDependencies });
  } catch (error) {
    add('web dependencies', false, `无法读取 web/package.json：${error.message}`);
  }
  if (dependencies.length) {
    const missing = dependencies.filter((name) => !isFile(path.join(root, 'web', 'node_modules', ...name.split('/'), 'package.json')));
    add('web dependencies', missing.length === 0, missing.length ? `缺少 ${missing.join(', ')}；运行 npm --prefix web install` : `${dependencies.length} 项已安装`);
  }

  const distIndex = path.join(root, 'web', 'dist', 'index.html');
  const distReady = isFile(distIndex) && statSync(distIndex).size > 0;
  add('web/dist', distReady, distReady ? distIndex : '缺少非空 web/dist/index.html，请先构建');

  const version = declaredVersion(root);
  const libs = runtime.libs ?? path.join(root, 'app', 'build', 'libs');
  const jar = version ? newestFatJar(libs, version) : null;
  add('current fatJar', Boolean(jar), jar ? `${jar}（声明版本 ${version}）` : version ? `缺少 legado-${version}-all.jar` : '无法确定声明版本');

  try {
    const port = await checkPort(runtime.port, runtime.host);
    add('port', port.available !== false, port.available === false
      ? `${runtime.host}:${runtime.port} 已占用或不可绑定${port.error ? `（${port.error}）` : ''}；启动器会尝试其它端口`
      : `${runtime.host}:${runtime.port} 可用`, { required: false, warn: true });
  } catch (error) {
    add('port', false, `无法探测端口：${error.message}`, { required: false, warn: true });
  }

  const dataDir = runtime.dataDir ?? path.join(root, 'data');
  if (!existsSync(dataDir)) {
    add('data directory', false, `${dataDir} 尚未创建；首次启动会自动创建`, { required: false, warn: true });
  } else if (!isDirectory(dataDir)) {
    add('data directory', false, `${dataDir} 不是目录`);
  } else {
    try {
      accessSync(dataDir, constants.W_OK);
      add('data directory', true, dataDir);
    } catch (error) {
      add('data directory', false, `${dataDir} 不可写：${error.message}`);
    }
  }

  const summary = Object.fromEntries(['pass', 'warn', 'fail'].map((status) => [status, checks.filter((check) => check.status === status).length]));
  return { ok: summary.fail === 0, productRoot: root, checks, summary };
}

export function formatDoctorReport(report, json = false) {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const labels = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  return [
    `legadoQ doctor — ${report.productRoot}`,
    ...report.checks.map((check) => `${labels[check.status]}  ${check.name}: ${check.detail}`),
    `结果：${report.summary.pass} 通过，${report.summary.warn} 告警，${report.summary.fail} 失败`,
  ].join('\n') + '\n';
}

/** CLI 入口也作为可测试的公开 helper；返回退出码而不自行退出。 */
export async function doctorMain(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    (options.write ?? ((text) => process.stdout.write(text)))('用法：node scripts/doctor.mjs [--json]\n只读检查启动环境，不安装、不构建。\n');
    return 0;
  }
  const unknown = argv.find((arg) => arg !== '--json');
  if (unknown) {
    (options.log ?? console).error(`未知参数：${unknown}（可用：--json）`);
    return 2;
  }
  const report = await runDoctor(options);
  (options.write ?? ((text) => process.stdout.write(text)))(formatDoctorReport(report, argv.includes('--json')));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await doctorMain();
}
