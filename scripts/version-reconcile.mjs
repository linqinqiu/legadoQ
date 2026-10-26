#!/usr/bin/env node
/**
 * version-reconcile.mjs
 * ---------------------------------------------------------------------------
 * 青阅（QingYue）版本对账脚本（只读、无第三方依赖）。
 *
 * 目标：把"应用版本"在各处的表象对账一遍，找出与**唯一真源**（Gradle 构建文件里的
 * `version`，位于 E:\legado\product）不一致的漂移。它不修改任何文件、不打 Tag、不 bump。
 *
 * 检查项：
 *   1. Gradle 构建文件里的 version  （真源，位于 E:\legado\product 下）
 *   2. E:\legado\VERSION            （父仓库手写版本文件）
 *   3. E:\legado\product\CHANGELOG.md 顶部版本条目
 *   4. 最新 Git Tag                 （主仓库 E:\legado\product 与父仓库 E:\legado 都查）
 *   5. http://127.0.0.1:1234/healthz 返回版本（仅当服务可达时）
 *
 * 仅使用 Node 内置模块 + child_process 调 git。
 * ---------------------------------------------------------------------------
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---- 路径配置 --------------------------------------------------------------
const REPO_EMBEDDED = resolve('E:/legado/product'); // 应用仓库（含 Gradle 真源）
const REPO_PARENT = resolve('E:/legado'); // 父仓库（含 VERSION）
const VERSION_FILE = join(REPO_PARENT, 'VERSION');
const CHANGELOG_EMBEDDED = join(REPO_EMBEDDED, 'CHANGELOG.md');
const HEALTHZ_URL = 'http://127.0.0.1:1234/healthz';
const HEALTHZ_TIMEOUT_MS = 1500;

// ---- 小工具 ----------------------------------------------------------------
const log = (...a) => console.log(...a);

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 运行 git 命令，返回 stdout（trimmed），失败返回 null。 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** 递归查找 Gradle 构建文件（build.gradle / build.gradle.kts）。 */
function findGradleBuildFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === 'build' || name === '.git' || name === 'node_modules') continue;
        walk(full);
      } else if (name === 'build.gradle' || name === 'build.gradle.kts') {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 从 Gradle 构建文件里抓取 project 级别 version 赋值。
 * 匹配行首（允许缩进）的 `version = 'x.y.z'` / `version 'x.y.z'` / `version "x.y.z"`。
 * 特意排除 `toolVersion` / `languageVersion` 之类的相似字段。
 */
function extractGradleVersion(root) {
  const files = findGradleBuildFiles(root);
  const candidates = [];
  const re = /^\s*version\s*[:=]\s*['"]?(\d+\.\d+\.\d+)['"]?/;
  for (const f of files) {
    const text = readText(f);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) candidates.push({ file: f, version: m[1] });
    }
  }
  if (candidates.length === 0) return { version: null, file: null, all: [] };

  // 偏好 app 模块的构建文件（应用版本真源所在），否则取第一个匹配。
  const pref = candidates.find((c) => /[\\/]app[\\/]build\.gradle(?:kts)?$/.test(c.file))
    || candidates.find((c) => /build\.gradle(?:kts)?$/.test(c.file));
  return { version: pref.version, file: pref.file, all: candidates };
}

/** 解析 CHANGELOG 顶部第一个 `## [x.y.z]` 或 `## x.y.z` 版本条目。 */
function extractChangelogTopVersion(p) {
  const text = readText(p);
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/);
    if (m) return m[1];
  }
  return null;
}

/** 取仓库里最新的语义化版本 Tag（忽略 latest 等非 semver 标签）。 */
function latestSemverTag(cwd) {
  const all = git(['tag', '--sort=-version:refname'], cwd);
  if (!all) return null;
  const semver = /^v?\d+\.\d+\.\d+$/;
  for (const t of all.split(/\r?\n/).filter(Boolean)) {
    if (semver.test(t.trim())) return t.trim();
  }
  return null;
}

/** 尝试读取 /healthz，返回其中的 version 字段（若有）。 */
async function fetchHealthzVersion() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEALTHZ_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTHZ_URL, { signal: ac.signal });
    if (!res.ok) return { ok: true, reachable: true, version: null, note: `HTTP ${res.status}` };
    const text = await res.text();
    let version = null;
    // 先按 JSON 解析
    try {
      const json = JSON.parse(text);
      version = json?.version ?? json?.Version ?? json?.appVersion ?? null;
    } catch {
      // 退化：在文本里找 "version" 字段
      const m = text.match(/version["'\s:]+v?(\d+\.\d+\.\d+)/i);
      if (m) version = m[1];
    }
    return { ok: true, reachable: true, version, raw: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, reachable: false, version: null, note: String(e?.name || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 主流程 ----------------------------------------------------------------
async function main() {
  log('══════════════════════════════════════════════════════════════');
  log('  青阅 版本对账  version-reconcile');
  log('══════════════════════════════════════════════════════════════');

  // 1) Gradle 真源
  const gradle = extractGradleVersion(REPO_EMBEDDED);
  // 2) VERSION 文件
  const versionFile = readText(VERSION_FILE)?.trim().replace(/^v/, '') || null;
  // 3) CHANGELOG 顶部
  const changelogTop = extractChangelogTopVersion(CHANGELOG_EMBEDDED);
  // 4) Git Tag（两个仓库）
  const tagEmbedded = latestSemverTag(REPO_EMBEDDED);
  const tagParent = latestSemverTag(REPO_PARENT);
  // 5) /healthz
  const healthz = await fetchHealthzVersion();

  // 真源
  const TRUTH = gradle.version;

  log('');
  log('【真源】Gradle 构建文件 version');
  if (gradle.version) {
    log(`  ✓ ${gradle.version}  ← ${gradle.file}`);
    if (gradle.all.length > 1) {
      log('  （发现多处 version 赋值，已锁定 app 模块为唯一真源；其余为示例/模板模块，不计入应用版本：）');
      for (const c of gradle.all) if (c.file !== gradle.file) log(`     · ${c.version}  ← ${c.file}  (示例模板，非应用版本)`);
    }
  } else {
    log('  ✗ 未找到 Gradle version 字段！');
  }

  const rows = [];
  const add = (label, value, source) => rows.push({ label, value, source });

  add('VERSION 文件', versionFile, VERSION_FILE);
  add('CHANGELOG 顶部条目', changelogTop, CHANGELOG_EMBEDDED);
  add('Git Tag（应用仓库）', tagEmbedded ? tagEmbedded.replace(/^v/, '') : '(无)', REPO_EMBEDDED);
  add('Git Tag（父仓库）', tagParent ? tagParent.replace(/^v/, '') : '(无)', REPO_PARENT);
  if (healthz.reachable) {
    add('/healthz 运行版本', healthz.version ?? '(未含 version 字段)', HEALTHZ_URL);
  }

  log('');
  log('【对账单】以 Gradle version 为真源');
  log('  ' + '项'.padEnd(22) + '值'.padEnd(12) + '一致性');
  log('  ' + '-'.repeat(22) + '-'.repeat(12) + '-'.repeat(10));

  let problems = 0;
  const check = (label, value) => {
    const consistent = TRUTH && value != null && value === TRUTH;
    const mark = value == null ? '?' : consistent ? '✓' : '✗';
    if (value != null && !consistent) problems++;
    log('  ' + label.padEnd(22) + String(value ?? '(缺失)').padEnd(12) + mark);
    return consistent;
  };

  check('VERSION 文件', versionFile);
  check('CHANGELOG 顶部条目', changelogTop);
  check('Git Tag（应用仓库）', tagEmbedded ? tagEmbedded.replace(/^v/, '') : null);
  check('Git Tag（父仓库）', tagParent ? tagParent.replace(/^v/, '') : null);
  if (healthz.reachable) {
    check('/healthz 运行版本', healthz.version);
  } else {
    log('  ' + '/healthz 运行版本'.padEnd(22) + '(不可达)'.padEnd(12) + '⤳ 跳过');
    log('     （未探测到 1234 端口服务，已跳过；需联机时再跑本脚本复核）');
  }

  log('');
  log('【结论】');
  if (!TRUTH) {
    log('  ✗ 致命：未能定位 Gradle 真源版本，请检查构建文件路径。');
    process.exitCode = 2;
    return;
  }
  if (healthz.reachable && healthz.version == null) {
    log('  ⚠ /healthz 可达但未返回 version 字段，需确认 BuildInfo 注入是否正常。');
  }
  if (problems === 0) {
    log('  ✓ 全部已核对项与真源一致（Gradle version = ' + TRUTH + '）。');
  } else {
    log(`  ✗ 发现 ${problems} 处漂移，需处理：`);
    if (versionFile && versionFile !== TRUTH) {
      log(`    - VERSION 文件为 ${versionFile}，应改为 ${TRUTH}（派生，不要手写第二份）。`);
    }
    if (changelogTop && changelogTop !== TRUTH) {
      log(`    - CHANGELOG 顶部条目为 ${changelogTop}，缺 ${TRUTH} 段落（发布前由 CI/工具生成）。`);
    }
    if (tagEmbedded && tagEmbedded.replace(/^v/, '') !== TRUTH) {
      log(`    - 应用仓库最新 Tag 为 ${tagEmbedded}，去掉 v 后 ≠ ${TRUTH}；发布时应打 v${TRUTH}。`);
    }
    if (tagParent && tagParent.replace(/^v/, '') !== TRUTH) {
      log(`    - 父仓库最新 Tag 为 ${tagParent}，去掉 v 后 ≠ ${TRUTH}；需与发布 Tag 对齐。`);
    }
    if (healthz.reachable && healthz.version && healthz.version !== TRUTH) {
      log(`    - 运行版本 ${healthz.version} ≠ ${TRUTH}：产物可能来自旧构建，重打 fatJar。`);
    }
    log('  详见 docs/version-log-governance.md「存量补救」一节。');
    process.exitCode = 1;
  }
  log('══════════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('对账脚本异常：', e);
  process.exitCode = 2;
});
