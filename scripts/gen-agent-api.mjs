// 脚本：gen-agent-api.mjs
// 校验/补全 agent-api.json 契约文件的内部一致性。
//
// 职责（三重）：
// 1. 补全 count 字段：agent-api.json 内的 endpoints 数量写入 count。
// 2. 字段完整性：每个 endpoint 必须带 method/path/write/purpose/response/group。
// 3. 版本钉死：agent-api.json 的 version 必须与 app/build.gradle 的 version 一致。
//
// 与 web/test/ApiCatalog.test.ts 互为双锁：这里负责契约文件自身的内部一致性，
// 前端测试负责契约与代码路由的双向核对。
//
// 用法：
//   node scripts/gen-agent-api.mjs          # 只校验，不改文件
//   node scripts/gen-agent-api.mjs --fix    # 补全 count，并写回 agent-api.json

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CATALOG_PATH = path.join(ROOT, 'product', 'app', 'src', 'main', 'resources', 'agent-api.json');
const BUILD_GRADLE = path.join(ROOT, 'product', 'app', 'build.gradle');

const FIX = process.argv.includes('--fix');

let errors = 0;
function err(msg) {
  console.error(`[gen-agent-api] ERROR: ${msg}`);
  errors += 1;
}

// ---------- 1. 读取 agent-api.json ----------
let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
} catch (e) {
  err(`无法读取 ${CATALOG_PATH}: ${e.message}`);
  process.exit(1);
}

if (!catalog || !Array.isArray(catalog.endpoints)) {
  err('agent-api.json 缺少 endpoints 数组');
  process.exit(1);
}

const declaredVersion = catalog.version;
const declaredEndpoints = catalog.endpoints;

// ---------- 2. 版本钉死：与 app/build.gradle 一致 ----------
let gradleVersion = null;
try {
  const gradleText = fs.readFileSync(BUILD_GRADLE, 'utf8');
  const m = /^\s*version\s*=\s*['"]([^'"]+)['"]/m.exec(gradleText);
  if (m) gradleVersion = m[1];
} catch {
  // 文件不存在时忽略
}
if (gradleVersion && declaredVersion !== gradleVersion) {
  err(`版本不一致：agent-api.json version=${declaredVersion}，app/build.gradle version=${gradleVersion}`);
}

// ---------- 3. 每个 endpoint 的字段完整性 ----------
const requiredFields = ['method', 'path', 'write', 'purpose', 'response', 'group'];
for (const e of declaredEndpoints) {
  const key = `${e.method} ${e.path}`;
  for (const f of requiredFields) {
    if (!(f in e) || e[f] === undefined || e[f] === null) {
      err(`${key} 缺少必填字段：${f}`);
    }
  }
  if (e.purpose && e.purpose.trim().length < 8) {
    err(`${key} 的 purpose 过短，请写清用途`);
  }
  if (e.response && e.response.trim().length < 8) {
    err(`${key} 的 response 过短，请写清回包形状`);
  }
  if (!e.group || e.group.trim().length < 2) {
    err(`${key} 缺少分组（group）`);
  }
}

// ---------- 4. 生成/补全 count ----------
const endpointCount = declaredEndpoints.length;
const groupCount = new Set(declaredEndpoints.map(e => e.group)).size;

if (FIX) {
  catalog.count = endpointCount;
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`[gen-agent-api] 已写入 count=${endpointCount} 到 ${CATALOG_PATH}`);
}

// ---------- 5. 报告 ----------
console.log(`[gen-agent-api] 端点总数：${endpointCount}`);
console.log(`[gen-agent-api] 分组数：${groupCount}`);
console.log(`[gen-agent-api] 声明版本：${declaredVersion}${gradleVersion ? `（build.gradle: ${gradleVersion}）` : ''}`);
console.log(`[gen-agent-api] 发现问题：${errors} 个`);

if (errors > 0) {
  process.exit(1);
}
console.log('[gen-agent-api] 契约一致性检查通过');
