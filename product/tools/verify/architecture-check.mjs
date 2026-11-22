// 架构依赖门禁 G1–G8：把 21_PHASE1_ARCHITECTURE_DESIGN.md §3 的依赖规则变成可执行红线。
//
// 为什么需要它：08 提案的 R1–R6、09 路线的 G1–G6 都只写在文档里，而本项目已经付过两次学费——
//   GuardedHttpClient.kt:19 的注释承诺「只能从 NetworkSecurity 签发」却挡不住 6 处裸构造；
//   ApiCatalog.test.ts 的正则写窄了，门禁绿着漏了 8 条端点。
//   结论（08 §1.1）：写在注释/文档里的纪律等于没有纪律。所以这里做成机器判据。
//
// 模式照抄 depth-check.mjs（同仓、已验证有效）：
//   - 显式基线 Set（只许单调缩小）：基线外新增 → 红；基线内已消失却没删条目 → 也红；
//   - 空转哨兵：扫描面文件数异常偏少时，「无新违规」是假绿，直接失败；
//   - 末尾打印各门禁基线数量，让「缩小」可量化。
//
// 与 ArchitectureBoundaryTest.kt 的分工：那是 Kotlin 侧包边界判据（改代码后随 :app:test 跑）；
//   本脚本是纯文本/目录判据（gates.yml 的 tools/verify/*-check.mjs 通配自动收编，无需编译）。
//   两边不重复：G6 端点目录一致性由 ApiContractTest 承载，这里只做存在性 NOTE。
//
// 基线标定：2026-11-20 @ refactor/rebuild（21 §3.1 实测），基于审计基线 771b311 前进 32 commit。
// 用法：node tools/verify/architecture-check.mjs   （退出码非 0 = 有新违规，或基线该缩没缩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KT_BASE = path.join(ROOT, 'app/src/main/kotlin/io/legado');
const WEB_BASE = path.join(ROOT, 'web/src');

// ---------------------------------------------------------------- 工具
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const ktFiles = walk(KT_BASE, ['.kt']);

// 剥掉行注释，避免注释里的关键词（如 GuardedHttpClient.kt:19）被当成真违规。
function codeLines(file) {
  const lines = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trimEnd();
    if (line.trim()) lines.push({ text: line, no: lines.length + 1 });
  }
  return lines;
}

// 每个门禁的扫描结果 + 基线。fail 累加；最后统一打印基线数量。
const results = [];
let fail = 0;

// fresh/shrunk 双向判定：observed 与 baseline 都是「文件相对路径」或「文件:行」指纹集合。
function compare(name, observed, baseline, note) {
  const fresh = [...observed].filter(x => !baseline.has(x)).sort();
  const shrunk = [...baseline].filter(x => !observed.has(x)).sort();
  if (fresh.length) {
    fail++;
    console.error(`\n[G${name}] 出现 ${fresh.length} 个**新的**违规${note}：`);
    for (const x of fresh) console.error(`  ✗ ${x}`);
  }
  if (shrunk.length) {
    fail++;
    console.error(`\n[G${name}] 基线里有 ${shrunk.length} 条已消失却没删——基线只许单调缩小：`);
    for (const x of shrunk) console.error(`  ✓ ${x}`);
  }
  if (!fresh.length && !shrunk.length) {
    console.log(`  G${name}: OK（基线 ${baseline.size} 条）`);
  }
  results.push({ gate: name, baseline: baseline.size, observed: observed.size });
}

// ---------------------------------------------------------------- G1 kernel 不许反向依赖域
// 目标态 kernel/ 尚不存在；当前以 rules/ 作过渡扫描面（21 §2.3 迁移期双基线）。
const DOMAIN_PKGS = 'source|shelf|reading|search|explore|localbook|media|backup|rss|tts|login';
const g1Re = new RegExp(`import\\s+io\\.legado\\.(${DOMAIN_PKGS})\\b`);
const g1 = new Set();
for (const f of walk(path.join(KT_BASE, 'rules'), ['.kt'])) {
  for (const { text } of codeLines(f)) if (g1Re.test(text)) g1.add(rel(f));
}
compare(1, g1, new Set(), '（kernel/规则层 import 域包）');

// ---------------------------------------------------------------- G2 只有 data/ 能拼 SQL
const sqlRe = /executeQuery|prepareStatement|createStatement/;
const g2 = new Set();
for (const f of ktFiles) {
  if (f.includes(`${path.sep}data${path.sep}`)) continue;
  for (const { text } of codeLines(f)) if (sqlRe.test(text)) g2.add(rel(f));
}
compare(2, g2, new Set(), '（data/ 之外出现 SQL 执行）');

// ---------------------------------------------------------------- G3 只有 app/ + kernel/fetch 能建 HTTP 客户端
// R2b 的允许面原文是「只有 app/ + kernel/fetch 能建 HTTP 客户端」：
//   - kernel/fetch 的当前载体 = NetworkSecurity.kt（出站抓取唯一签发点）；
//   - app/ 的当前载体 = 组合根（DesktopLauncher / Application / StaticWeb）；
//   - 例外只开给本机控制面与自定义 TTS，两者都必须自带地址策略。
// 组合根里的两处是**回环健康探测**（1.2s / 2s 探 /healthz），不是出站抓取面，按规则本就不该计入。
// 按**文件**登记（行号会漂移，文件稳定），与 depth-check.mjs 同款稳健模式。
// 块注释里的 `HttpClient.newBuilder` 字样（如 GuardedHttpClient.kt:19 的类注释）不是代码，
// 所以扫描前先剥块注释——只剥 `//` 会把 KDoc 当违规，逼着人为了消红去改注释。
const G3_ALLOWED_ROOT = new Set(['DesktopLauncher.kt', 'Application.kt', 'StaticWeb.kt']);
// 合法签发点只有三个，且都必须自带闸门：
//   - NetworkSecurity.kt（目标态 kernel/fetch）：出站抓取，过 SSRF + PinnedProxy；
//   - LocalControlClient.kt：本机控制面（Chromium DevTools），只放回环；
//   - CustomTtsClient.kt：用户填的自定义 TTS，放本机/局域网，封链路本地与元数据段。
const G3_ISSUERS = new Set(['NetworkSecurity.kt', 'LocalControlClient.kt', 'CustomTtsClient.kt']);
const g3 = new Set(); // 2026-11-22 清零：EdgeTtsService 已拆成 wssClient + customClient
const g3Observed = new Set();
for (const f of ktFiles) {
  if (G3_ISSUERS.has(path.basename(f))) continue; // 合法签发点
  if (G3_ALLOWED_ROOT.has(path.basename(f))) continue; // 组合根：R2b 明确允许
  const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const text of code.split(/\r?\n/)) {
    if (/HttpClient\.newBuilder\(\s*\)/.test(text) || /=?\s*HttpClient\.newBuilder\s*\(/.test(text)) {
      g3Observed.add(rel(f));
      break;
    }
  }
}
compare(3, g3Observed, g3, '（NetworkSecurity 与组合根之外 new HttpClient）');

// ---------------------------------------------------------------- G4 禁止手动 autoCommit
// 注意：代码用 `db.autoCommit = false/true` 赋值形式，不是 setAutoCommit() 方法——
// 按后者写正则会永远绿（假绿）。Database.kt 是事务门面（目标态 kernel/db），其内部合法。
const g4 = new Set(); // 2026-11-21 阶段 3.3 收口后清零（原 4 条：Shelf/Sources/SourceHealth/Cache）
const g4Observed = new Set();
for (const f of ktFiles) {
  if (f.endsWith('Database.kt')) continue; // 门面内合法
  for (const { text } of codeLines(f)) {
    if (/\.autoCommit\s*=/.test(text)) { g4Observed.add(rel(f)); break; }
  }
}
compare(4, g4Observed, g4, '（事务门面之外手动 autoCommit）');

// ---------------------------------------------------------------- G5 DTO 只允许在 model/
const g5 = new Set(); // 2026-11-22 阶段 3.2 收尾后清零（原 10 个文件全部归位 model/）
const g5Observed = new Set();
for (const f of ktFiles) {
  if (f.includes(`${path.sep}model${path.sep}`)) continue;
  for (const { text } of codeLines(f)) {
    if (/@Serializable/.test(text)) { g5Observed.add(rel(f)); break; }
  }
}
compare(5, g5Observed, g5, '（model/ 之外定义 @Serializable DTO）');

// ---------------------------------------------------------------- G6 端点目录与代码一致
// 由 Kotlin 侧 ApiContractTest + web/test/ApiCatalog.test.ts + docs:api-check 三层同源承载（08 D-4）。
// 这里不重复实现，只做存在性 NOTE——判据文件在，就 PASS；不在，才提示。
const g6Files = [
  'app/src/test/kotlin/io/legado/ApiContractTest.kt',
  'web/test/ApiCatalog.test.ts',
];
const g6Missing = g6Files.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (g6Missing.length) {
  fail++;
  console.error(`\n[G6] 端点目录判据文件缺失：${g6Missing.join(', ')}`);
} else {
  console.log('  G6: OK（由 ApiContractTest + ApiCatalog.test.ts 承载，端点数/分组数判据在那两层）');
}
results.push({ gate: 6, baseline: 2, observed: g6Files.length });

// ---------------------------------------------------------------- G7 域之间只走对方 api/，不 import 对方 data/
// 当前实测 0（21 §3.1）；目标态随域模块落地。硬红。
const g7Re = new RegExp(`import\\s+io\\.legado\\.(${DOMAIN_PKGS})\\.data\\b`);
const g7 = new Set();
for (const f of ktFiles) {
  const inData = f.includes(`${path.sep}data${path.sep}`);
  for (const { text } of codeLines(f)) {
    if (g7Re.test(text) && !inData) { g7.add(rel(f)); break; }
  }
}
compare(7, g7, new Set(), '（跨域直接 import 对方 data/ 包）');

// ---------------------------------------------------------------- G8 新样式不进全局 CSS（行数只许单调下降）
const STYLE_CAP = 6760; // 2026-11-22：品牌预设样式迁到 components/brand.css 后实测 6,760；目标单调下降
const styleFile = path.join(WEB_BASE, 'styles.css');
const styleLines = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, 'utf8').split(/\r?\n/).length : 0;
if (styleLines < 50) { fail++; console.error(`\n[G8] styles.css 扫描异常（${styleLines} 行），假绿。`); }
else if (styleLines > STYLE_CAP) {
  fail++;
  console.error(`\n[G8] styles.css 涨到 ${styleLines} 行，超过上限 ${STYLE_CAP}——新样式必须进令牌/组件样式。`);
} else {
  console.log(`  G8: OK（styles.css ${styleLines} 行 ≤ 上限 ${STYLE_CAP}，目标单调下降）`);
}
results.push({ gate: 8, baseline: STYLE_CAP, observed: styleLines });

// ---------------------------------------------------------------- 空转哨兵 + 汇总
if (ktFiles.length < 50) {
  fail++;
  console.error(`\n[architecture-check] 扫描面异常：后端仅 ${ktFiles.length} 个 .kt，「无新违规」不可信。`);
}

console.log('\n──────── G1–G8 基线汇总（只许单调缩小）────────');
for (const r of results) {
  console.log(`  G${r.gate}: 基线 ${r.baseline} / 当前 ${r.observed}`);
}
if (fail > 0) {
  console.error(`\n[architecture-check] FAIL：${fail} 条门禁未通过。`);
  process.exit(1);
}
console.log('\n[architecture-check] OK：G1–G8 全部通过，无新违规、无过期基线。');
