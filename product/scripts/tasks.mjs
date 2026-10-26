// 一条命令跑完跨栈的活儿。前端是 npm、后端是 Gradle，中间夹一步"把 web/dist 烤进 jar"，
// 原来靠文档串三步，容易漏、也容易把顺序弄反（先打 jar 会把旧界面烤进去）。
//
// 为什么不直接在 package.json 里写 `./gradlew`：npm 在 Windows 上是用 cmd 跑 scripts 的，
// `./gradlew` 那种写法在 cmd 里不认。所以 gradle 的调用统一收在这里，按平台挑
// `gradlew.bat` / `./gradlew`。
//
// 每条都拼成一整串命令再交给 shell（而不是 `spawnSync(cmd, args, {shell:true})`）：
// 后者会触发 Node 的 DEP0190 —— shell 模式下参数不做转义、只做拼接，容易埋注入。
// 这里的命令全是本文件写死的常量，没有外部输入，但少一条警告总是好的。
//
// 用法（根 package.json 已转成这几条）：
//   npm run build   # 前端 → web/dist，再 :app:fatJar（把 web/dist 烤进 jar）
//   npm test        # 前端用例 + 服务端用例
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
// 命令都交给 shell 跑（见文件头那条 DEP0190 的说明），所以这里必须用**当前这个 node 进程自己的
// 可执行文件路径**而不是写字面量 `node`：PATH 上没有 node 时（某些 Windows 装法、CI 的
// 非 nvm 环境）写字面量会直接"找不到命令"，而 process.execPath 永远指得回来。
// 路径可能带空格（`C:\Program Files\nodejs\node.exe`），所以整串里要加引号。
const node = `"${process.execPath}"`;

const tasks = {
  // 顺序不能倒：processResources 是在 fatJar 那一步把 web/dist 拷进 jar 的。
  // 第三步不是可选项：fatJar 没被真正执行时（只跑了 :app:jar，或被判定 UP-TO-DATE），
  // 前两步照样"成功"，于是一个装着旧前端的 jar 就带着绿色退出码上线了 ——
  // 2026-10-26 那次"重启了但界面还是旧的"就是这么过去的。这一步专门盯
  // "包里的前端 == 磁盘上的前端 == 运行中的前端"。
  build: [
    ['1/3 前端 → web/dist', 'npm --prefix web run build'],
    ['2/3 后端 fatJar（内嵌 web/dist）', `${gradle} :app:fatJar`],
    ['3/3 校验 jar 里的前端与 web/dist 一致', `${node} tools/verify/bundled-ui-check.mjs`],
  ],
  test: [
    // 顺序有意：先查"有没有该记的改动没进日志"。它最快（读几行 git 输出），
    // 而且失败信息是**给人看的下一步动作**（跑一次 node scripts/changelog.mjs），
    // 放在两端用例之后就会被一堆测试输出盖掉。
    ['0/3 更新日志没漏记', `${node} scripts/changelog.mjs --check`],
    ['1/3 前端用例', 'npm --prefix web test'],
    ['2/3 服务端用例', `${gradle} :app:test`],
  ],
};

const name = process.argv[2];
if (!tasks[name]) {
  console.error(`用法：node scripts/tasks.mjs <${Object.keys(tasks).join(' | ')}>`);
  process.exit(2);
}

for (const [label, command] of tasks[name]) {
  console.log(`\n[${name}] ${label}\n[${name}] $ ${command}`);
  const ran = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (ran.status !== 0) {
    console.error(`\n[${name}] 失败：${label}（退出码 ${ran.status ?? 'null'}）`);
    process.exit(ran.status ?? 1);
  }
}
console.log(`\n[${name}] 完成`);
