// 目录深度门禁：把「不要太深」变成机器可判的红线，防结构回潮。
//
// 为什么需要它：本项目在包/目录深度上反复重构（0.8.2 路由重排、server→app），
// 历来靠人盯。约定不进门禁等于没有约定——所以用脚本钉死已验证的浅结构：
//   - 后端：io/legado 下每个域包平铺文件，不建子子包（io/legado/<域>/<文件>.kt）
//   - 前端：web/src 下最多 src/<分区>/<域>/<组>/<文件>，不再往下嵌
//     （如 reader/tts/TtsPlayerBar.tsx 是上限；<组> 只用来收拢同一件事的文件）
//
// ⚠️ 2026-11 更正：本文件原先只有硬阈值、没有基线，而阈值按 2026-10-25 的 86 个 .kt 标定。
// 仓库随后长到 125 个 .kt，前端也从 137 个 ts/tsx 长到 160+，出现了 27 个**合法的子系统**目录
// （data/db/、rules/processor/、http/system/、reader/{typeset,settingsPanel,dict}/、lib/api/domains/）
// —— 它们不是事故，是正常生长。
//
// 这不是猜测，是门禁自己留下的存档说的（tools/verify/out/gates-*.json）：
//   - 2026-10-30T17-52-44：`前端 146 个 .ts/.tsx，最深 2 层目录（上限 2）` → **OK**
//   - 2026-10-30T18-25-48：同上 → **OK**
//   - 2026-11-04T18-50-56：`27 个文件超过目录深度上限` → **FAIL**，此后一直是这 27 个
// 也就是说：门禁确实抓到了这次生长，但因为**退出码恒为 1**、又没有"已接受"清单，
// 它从那天起就退化成了每日噪音 —— 几天之内，红就不再意味着任何事。
//
// 一个永远红的门禁等于没有门禁：它既拦不住新违规（退出码恒为 1，CI 无从判断），
// 又让整条门禁链的信号失真（分不清「新问题」和「那 27 个已知的」）。
//
// 所以改成仓库自己既有的做法——**显式基线 + 只许单调缩小**
// （同 RULES_CONCRETE_BASELINE、ENGINE_TO_INFRA_BASELINE、前端 ArchitectureBoundary.test.ts）：
//   - 基线外出现新的过深文件       → 红（这才是真正要拦的东西）
//   - 基线条目被扁平化却没删掉基线 → 红（防止基线退化成长期豁免）
// 阈值本身**不放宽**：它仍然是"目标结构"，只是不再把 27 个既定现实当成每日噪音。
//
// 用法：node tools/verify/depth-check.mjs   （退出码非 0 = 有新过深文件，或基线该缩没缩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 标定值：目录层数（不含文件名）——目标结构，不放宽
const MAX_BACKEND_PKG_DIRS = 1;   // io/legado/<域>/File.kt
// 前端目标结构：web/src/<分区>/<域>/<组>/File.tsx（2026-11-06 由 2 改 3）。
// 改的理由不是"嫌麻烦"，是 2 层逼着把一个域的所有文件平铺：`features/reader` 因此长到
// 50 个文件 9.9k 行，屏、TTS、排版、点按区、笔记、浮层全挤在一层，靠文件名猜归属。
// 第 3 层只允许**组**（tts/ interaction/ content/ notes/ dialogs/），第 4 层仍然禁止；
// 后端阈值不动。
const MAX_FRONTEND_DIRS = 3;      // web/src/<分区>/<域>/<组>/File.tsx

// 已知过深文件基线（ROOT 相对、正斜杠）。**只许缩小**：扁平化掉一个就从这里删一条。
// 分后端/前端两块只是为了报告可读，判定是合并后统一比对的。
const KNOWN_DEEP = new Set([
  // ---- 后端 11：data/db（连接池/迁移/Schema/Cookie 存储）、rules/processor（四种规则引擎实现
  //      + demo/）、http/system（系统路由组）—— 都是按子系统收拢，不是随手嵌深 ----
  'app/src/main/kotlin/io/legado/data/db/ConnectionPool.kt',
  'app/src/main/kotlin/io/legado/data/db/CookieUtil.kt',
  'app/src/main/kotlin/io/legado/data/db/Migration.kt',
  'app/src/main/kotlin/io/legado/data/db/Schema.kt',
  'app/src/main/kotlin/io/legado/http/system/SystemRoutes.kt',
  'app/src/main/kotlin/io/legado/rules/processor/JsonPathProcessor.kt',
  'app/src/main/kotlin/io/legado/rules/processor/JsoupProcessor.kt',
  'app/src/main/kotlin/io/legado/rules/processor/RhinoProcessor.kt',
  'app/src/main/kotlin/io/legado/rules/processor/XPathProcessor.kt',
  'app/src/main/kotlin/io/legado/rules/processor/demo/DemoHelloProcessor.kt',
  'app/src/main/kotlin/io/legado/rules/processor/demo/DemoMarkdownProcessor.kt',

  // ---- 前端：2026-11-06 上限改到 3 层后，原来的 16 条（lib/api/domains、reader/{typeset,settingsPanel,dict}）
  //      全部落进合法区间，基线清空。往后再出现过深文件，就是真的新嵌深。----
]);

function walk(dir, exts, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, exts, out);
    } else if (exts.includes(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

// 相对 base 的目录层数（去掉文件名那一段）
function relDirs(file, base) {
  return path.relative(base, file).split(path.sep).length - 1;
}

// 返回该扫描面下过深文件的 ROOT 相对路径（统一正斜杠，跨平台可比）
function collect(label, base, files, max, exts) {
  const depth = f => relDirs(f, base);
  const observed = files.reduce((m, f) => Math.max(m, depth(f)), 0);
  const deep = files
    .filter(f => depth(f) > max)
    .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
  console.log(
    `${label}：${files.length} 个 ${exts.join('/')}，最深 ${observed} 层目录（目标上限 ${max}），过深 ${deep.length} 个`,
  );
  return deep;
}

const BE_BASE = path.join(ROOT, 'app/src/main/kotlin/io/legado');
const FE_BASE = path.join(ROOT, 'web/src');

const beFiles = walk(BE_BASE, ['.kt'], []);
const feFiles = walk(FE_BASE, ['.ts', '.tsx'], []).filter(f => !f.endsWith('.d.ts'));

const deep = new Set([
  ...collect('后端 io/legado', BE_BASE, beFiles, MAX_BACKEND_PKG_DIRS, ['.kt']),
  ...collect('前端 web/src', FE_BASE, feFiles, MAX_FRONTEND_DIRS, ['.ts', '.tsx']),
]);

// 空转哨兵：若两个扫描面都扫不到文件，"无新违规"就是假绿。
if (beFiles.length < 50 || feFiles.length < 50) {
  console.error(
    `\n[depth-check] 扫描面异常：后端 ${beFiles.length} 个 .kt、前端 ${feFiles.length} 个 ts/tsx，明显偏少。` +
      `\n  此时「无新过深文件」不可信——请先确认 ROOT 与两个 BASE 路径有效。`,
  );
  process.exit(1);
}

const fresh = [...deep].filter(f => !KNOWN_DEEP.has(f)).sort();
const shrunk = [...KNOWN_DEEP].filter(f => !deep.has(f)).sort();

let fail = 0;
if (fresh.length) {
  fail++;
  console.error(`\n[depth-check] 出现 ${fresh.length} 个**新的**过深文件——请扁平化（域内平铺 / 提到 shared/）后再提交：`);
  for (const f of fresh) console.error(`  ✗ ${f}`);
}
if (shrunk.length) {
  fail++;
  console.error(
    `\n[depth-check] 基线里有 ${shrunk.length} 个文件已经不再过深——请把它们从 KNOWN_DEEP 删掉：`,
  );
  for (const f of shrunk) console.error(`  ✓ ${f}`);
  console.error('  基线只允许单调缩小；留着过期条目，就看不出还剩多少深度债。');
}

if (fail > 0) process.exit(1);
console.log(`\n[depth-check] OK：无新的过深文件（基线内 ${KNOWN_DEEP.size} 个，只许缩小）。`);
