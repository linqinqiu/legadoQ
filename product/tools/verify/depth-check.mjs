// 目录深度门禁：把「不要太深」变成机器可判的红线，防结构回潮。
//
// 为什么需要它：本项目在包/目录深度上反复重构（0.8.2 路由重排、server→app），
// 历来靠人盯。约定不进门禁等于没有约定——所以用脚本钉死当前已验证的浅结构：
//   - 后端：io/legado 下每个域包平铺文件，不建子子包（io/legado/<域>/<文件>.kt）
//   - 前端：web/src 下最多 src/<分区>/<子目录>/<文件>，不再往下嵌
//     （如 reader/settingsPanel/TypographyTab.tsx 是上限；components/ 类目录也只放一层文件）
//
// 阈值按 2026-10-25 实测标定：后端 86 个 .kt 最深 1 层目录；前端 137 个 ts/tsx 最深 2 层目录。
// 当前全绿；只有新增更深的文件才会红。要放宽就改这两个常量并在此说明理由。
//
// 用法：node tools/verify/depth-check.mjs   （退出码非 0 即有过深文件）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 标定值：目录层数（不含文件名）
const MAX_BACKEND_PKG_DIRS = 1;   // io/legado/<域>/File.kt
const MAX_FRONTEND_DIRS = 2;      // web/src/<分区>/<子目录>/File.tsx

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

function report(label, base, files, max, exts) {
  const depth = f => relDirs(f, base);
  const observed = files.reduce((m, f) => Math.max(m, depth(f)), 0);
  const bad = files.filter(f => depth(f) > max);
  console.log(`${label}：${files.length} 个 ${exts.join('/')}，最深 ${observed} 层目录（上限 ${max}）`);
  for (const f of bad) console.log(`  ✗ 过深：${path.relative(ROOT, f)}`);
  return bad.length;
}

let fail = 0;

// 后端：io/legado 域包平铺
const BE_BASE = path.join(ROOT, 'app/src/main/kotlin/io/legado');
const beFiles = walk(BE_BASE, ['.kt'], []);
fail += report('后端 io/legado', BE_BASE, beFiles, MAX_BACKEND_PKG_DIRS, ['.kt']);

// 前端：web/src 限深（.d.ts 声明文件扁平，除外）
const FE_BASE = path.join(ROOT, 'web/src');
const feFiles = walk(FE_BASE, ['.ts', '.tsx'], []).filter(f => !f.endsWith('.d.ts'));
fail += report('前端 web/src', FE_BASE, feFiles, MAX_FRONTEND_DIRS, ['.ts', '.tsx']);

if (fail > 0) {
  console.error(`\n[depth-check] ${fail} 个文件超过目录深度上限——请扁平化（域内平铺 / 提到 shared/）后再提交。`);
  process.exit(1);
}
console.log('\n[depth-check] OK：目录深度都在上限内。');
