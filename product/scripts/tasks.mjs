// 一条命令跑完跨栈的活儿。前端是 npm、后端是 Gradle，中间夹一步"把 web/dist 烤进 jar"，
// 原来靠文档串三步，容易漏、也容易把顺序弄反（先打 jar 会把旧界面烤进去）。
//
// 命令统一在这里按平台组装；Gradle 在 Windows 下必须走 gradlew.bat。
// 用法：node scripts/tasks.mjs <build | test | pr | full | release:check>
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function commandContext(env) {
  const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  // process.execPath 不依赖 PATH；整串命令交给 shell，因此路径可能带空格时必须加引号。
  const node = `"${process.execPath}"`;
  const webBuild = env.LEGADO_WEB_BUILD === 'fallback'
    ? 'npm --prefix web run build:fallback'
    : 'npm --prefix web run build';
  return { gradle, node, webBuild };
}

const buildSteps = (env) => {
  const { gradle, node, webBuild } = commandContext(env);
  return [
    // 顺序不能倒：processResources 是在 fatJar 那一步把 web/dist 拷进 jar 的。
    ['1/4 前端 → web/dist', webBuild],
    ['2/4 校验 web/dist 是完整界面', `${node} tools/verify/dist-check.mjs`],
    ['3/4 后端 fatJar（内嵌 web/dist）', `${gradle} :app:fatJar`],
    ['4/4 校验 jar 里的前端与 web/dist 一致', `${node} tools/verify/bundled-ui-check.mjs`],
  ];
};

const testSteps = (env) => {
  const { gradle, node } = commandContext(env);
  return [
    // 先查最容易遗漏、也最快的日志门禁，失败信息不会被后面的测试输出盖掉。
    ['0/3 更新日志没漏记', `${node} scripts/changelog.mjs --check`],
    ['1/3 前端用例', 'npm --prefix web test'],
    ['2/3 服务端用例', `${gradle} :app:test`],
  ];
};

const qualitySteps = (env) => {
  const { node } = commandContext(env);
  return [
    ['1/6 工具协议一致', `${node} ../scripts/protocol.mjs --check`],
    ['2/6 API 文档与路由一致', `${node} scripts/gen-api-reference.mjs --check`],
    ['3/6 更新日志没漏记', `${node} scripts/changelog.mjs --check`],
    ['4/6 版本号一致', `${node} scripts/version-check.mjs`],
    ['5/6 交付契约', `${node} tools/verify/delivery-check.mjs`],
    ['6/6 工具脚本用例', `${node} --test scripts/*.test.mjs`],
  ];
};

const typedTestSteps = (env) => {
  const { gradle } = commandContext(env);
  return [
    ['前端类型', 'npm --prefix web run check'],
    ['前端用例', 'npm --prefix web test'],
    ['服务端用例', `${gradle} :app:test`],
  ];
};

const prSteps = (env) => {
  const tests = typedTestSteps(env);
  return [
    ...qualitySteps(env).map(([label, command], index) => [`${index + 1}/9 ${label.replace(/^\d+\/\d+\s+/, '')}`, command]),
    ...tests.map(([label, command], index) => [`${index + 7}/9 ${label}`, command]),
  ];
};

/** 返回某一任务的步骤副本；纯函数，导入本模块不会执行任何命令。 */
export function getTaskSteps(name, env = process.env) {
  if (name === 'build') return buildSteps(env).map(([label, command]) => ({ label, command }));
  if (name === 'test') return testSteps(env).map(([label, command]) => ({ label, command }));
  if (name === 'pr') return prSteps(env).map(([label, command]) => ({ label, command }));
  if (name === 'full' || name === 'release:check') {
    const combined = [
      ...qualitySteps(env),
      ...buildSteps(env),
      ...typedTestSteps(env),
      ['随包 UI 用例确实跑过', `${commandContext(env).node} tools/verify/ui-tests-ran-check.mjs`],
      ['前端产物体积预算', `${commandContext(env).node} tools/verify/bundle-budget-check.mjs`],
    ];
    return combined.map(([label, command], index) => ({
      label: `${index + 1}/${combined.length} ${label.replace(/^\d+\/\d+\s+/, '')}`,
      command,
    }));
  }
  return null;
}

export const taskNames = Object.freeze(['build', 'test', 'pr', 'full', 'release:check']);

/** 执行任务；可注入 runner 做公开行为测试。返回退出码，不直接终止调用方。 */
export function runTask(name, {
  cwd = ROOT,
  env = process.env,
  spawn = spawnSync,
  log = console,
} = {}) {
  const steps = getTaskSteps(name, env);
  if (!steps) return 2;
  for (const { label, command } of steps) {
    log.log(`\n[${name}] ${label}\n[${name}] $ ${command}`);
    const ran = spawn(command, { cwd, stdio: 'inherit', shell: true });
    if (ran.error || ran.status !== 0) {
      log.error(`\n[${name}] 失败：${label}（退出码 ${ran.status ?? 'null'}）`);
      return ran.status ?? 1;
    }
  }
  log.log(`\n[${name}] 完成`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!taskNames.includes(name)) {
    console.error(`用法：node scripts/tasks.mjs <${taskNames.join(' | ')}>`);
    process.exit(2);
  }
  process.exit(runTask(name));
}
