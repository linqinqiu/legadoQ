// 改动前快照：源码树 + 一致的 SQLite 副本 + 当前构建产物指纹，落到仓库外。
// 用法：node tools/verify/snapshot.mjs [备注]
// 保留最近 5 份；数据副本用 VACUUM INTO（只读语义的一致性快照，不改源库一个字节）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

// 仓库根从脚本自己的位置算，快照落点用环境变量覆盖 —— 这两行原来写死成某个人机器上的
// 盘符路径，所以这个脚本一直进不了版本库；它要随仓库分发，就不能含任何人的目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST_ROOT = process.env.LEGADO_SNAPSHOT_DIR ?? path.join(path.dirname(ROOT), 'legado-server_版本备份');
const KEEP = 5;
/**
 * 文件清单**必须问 git**，不能手抄。
 *
 * 原来这里写死两份列表（SRC_DIRS / SRC_FILES），仓库长到 404 个跟踪文件时它只拷到 354 个，
 * 少的正是 `.github/workflows/*`、LICENSE、README、CHANGELOG、gradle/libs.versions.toml、
 * computenest/、extensions/chrome/、web/public/、docs/实现说明.md 这批 —— 而脚本照样打印"快照完成"。
 * 一份会漏的留存 + 一句"其余都删除"，是这台机器上唯一真正致命的组合。
 */
const trackedFiles = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 1 << 26 }).toString().split('\0').filter(Boolean);
/** 被 .gitignore 忽略、但不可重建的东西（`git archive` 一律拿不到）。`.env` 故意排除：密钥不进备份。 */
const UNTRACKED_UNIQUE = ['init-mirror.gradle', 'local-patches.diff', 'assets'];
const SKIP_DIR = new Set(['out', 'node_modules', 'dist', '.git']);

const note = process.argv.slice(2).join(' ').trim();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const dest = path.join(DEST_ROOT, `${stamp}${note ? '_' + note.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-') : ''}`);
fs.mkdirSync(path.join(dest, 'src'), { recursive: true });

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
const copied = [];

const copyTree = (rel) => {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return false;
  const stack = [[from, path.join(dest, 'src', rel)]];
  while (stack.length) {
    const [srcDir, dstDir] = stack.pop();
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name)) stack.push([path.join(srcDir, entry.name), path.join(dstDir, entry.name)]); continue; }
      const s = path.join(srcDir, entry.name);
      const rel2 = path.relative(ROOT, s).split(path.sep).join('/');
      fs.copyFileSync(s, path.join(dest, 'src', rel2));
      copied.push(rel2);
    }
  }
  return true;
};
const copyOne = (rel) => {
  const s = path.join(ROOT, rel);
  if (!fs.existsSync(s)) return false;
  const d = path.join(dest, 'src', rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  copied.push(rel);
  return true;
};
// 跟踪文件逐个按 git 的清单拷（目录树里多出来的构建产物不会被顺手带进来）
for (const rel of trackedFiles) copyOne(rel);
// 再补被忽略但唯一的那些：可能是目录也可能是单文件，先判类型再分派
// （`!copyOne(rel) && !copyTree(rel)` 那种写法会先拿文件 API 去撞目录，直接 EISDIR 抛死）
const extrasMissing = UNTRACKED_UNIQUE.filter(rel => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return true;
  const ok = fs.statSync(full).isDirectory() ? copyTree(rel) : copyOne(rel);
  return !ok;
});

const db = path.join(ROOT, 'data/legado.sqlite');
const dbCopy = path.join(dest, 'legado.sqlite');
let dbNote = '';
if (fs.existsSync(db)) {
  fs.rmSync(dbCopy, { force: true });
  const conn = new DatabaseSync(db);
  try { conn.prepare('VACUUM INTO ?').run(dbCopy); } finally { conn.close(); }
  dbNote = `${(fs.statSync(dbCopy).size / 1048576).toFixed(1)} MB（VACUUM INTO 一致性副本）`;
}

// 版本号会变，写死就等于永远报"无 jar"。按形状找最新的那个。
const jarDir = path.join(ROOT, 'app/build/libs');
const jar = fs.existsSync(jarDir)
  ? (fs.readdirSync(jarDir).filter(f => /^legado-.+-all.jar$/.test(f)).sort().pop() ?? '')
  : '';
const jarPath = jar ? path.join(jarDir, jar) : '';
const bundleDir = path.join(ROOT, 'web/dist/assets');
const manifest = {
  taken_at: new Date().toISOString(),
  note,
  running_jar: jar || '（无 jar）',
  running_jar_sha256_16: jarPath ? sha256(jarPath) : '（无 jar）',
  served_bundles: fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).filter(f => /^index-.+\.(js|css)$/.test(f)).sort() : [],
  data_copy: dbNote || '（未复制数据库）',
  source_files: copied.length,
  restore: `源码覆盖回 ${ROOT} 对应路径；数据库先 node stop.mjs 再覆盖 data/legado.sqlite 并删除 -wal/-shm，然后 node start.mjs`,
};
fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

// 自证：漏一个就不许说"完成"。原来它拷 354/404 还照样打印成功，
// 而"一份会漏的留存 + 其余都删除"是这台机器上唯一真正致命的组合。
const got = new Set(copied);
const missed = trackedFiles.filter(f => !got.has(f));
console.log(`源码 ${copied.length} 个文件（跟踪 ${trackedFiles.length}）· 数据库 ${dbNote || '未复制'} · jar ${jar || '（无 jar）'}`);
if (extrasMissing.length) console.log('注意：本机没有这些未跟踪件，未进快照 →', extrasMissing.join(', '));
if (missed.length) {
  console.log(`快照不完整，缺 ${missed.length} 个跟踪文件（前 20 个）：`);
  for (const m of missed.slice(0, 20)) console.log('  ', m);
  console.log('结论：不许拿这份留存去删东西');
  process.exit(1);
}
console.log('快照完成 →', dest);

/**
 * 滚动保留只清"自己造的"快照目录（15 位时间戳开头）。
 * 原来这里按"是目录就算"来数，会把同一落点下手工留的完整留存（如 `完整留存_<sha>_<日期>`）
 * 一起滚掉 —— 留存工具反过来删留存，是比漏文件更糟的失败。
 */
const STAMP_DIR = /^\d{8}_\d{6}/;
const all = fs.readdirSync(DEST_ROOT)
  .filter(n => STAMP_DIR.test(n) && fs.statSync(path.join(DEST_ROOT, n)).isDirectory())
  .sort();
for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
  fs.rmSync(path.join(DEST_ROOT, stale), { recursive: true, force: true });
  console.log('已滚动删除旧快照', stale);
}
