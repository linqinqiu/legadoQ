// 生成 `docs/API-REFERENCE.md`：把随包的端点契约 `app/src/main/resources/agent-api.json`
// 摊成一份人看的 Markdown。
//
// 为什么要一个生成器而不是手写：这份清单有 139 条端点、19 个分组，手写必然与
// `agent-api.json` 漂移 —— 而后者才是 `/api/catalog` 真正吐出去的东西。漂移的代价
// 是「照着文档接进来，跑出来是 404」。所以正文由脚本产出，人不在这里改端点。
//
// 与双向闸门的关系：`web/test/ApiCatalog.test.ts` 钉的是「代码里的路由 ↔ agent-api.json」，
// 本脚本钉的是「agent-api.json ↔ 这份 Markdown」。三层同源，谁改了都有一层会红。
//
// 路径注意：`docs/API-REFERENCE.md` 属于**父仓库**（产品本体在 legado/，对外文档在上一级）。
// 脚本用相对路径找到父仓库，所以从 legado/ 里跑；不要把它挪到别的位置。
//
// 用法：
//   node scripts/gen-api-reference.mjs            # 写回 ../docs/API-REFERENCE.md
//   node scripts/gen-api-reference.mjs --check     # 只比对，不一致就退出码 1（CI 用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                       // legado/
const PARENT = path.dirname(ROOT);                     // 父仓库（docs/ 的所在）
const SOURCE = path.join(ROOT, 'app/src/main/resources/agent-api.json');
const TARGET = path.join(PARENT, 'docs/API-REFERENCE.md');

const checkOnly = process.argv.includes('--check');

const doc = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const endpoints = doc.endpoints ?? [];

if (endpoints.length === 0) {
  console.error(`[gen-api-reference] ${SOURCE} 里没有 endpoints 数组，契约空了？`);
  process.exit(1);
}

// 分组顺序沿用契约里的出现顺序（目录在最前，AI 自定义接入在最后），
// 不按字母排 —— 现在的顺序是「先系统、再业务面、最后扩展点」，重排会伤阅读。
const groups = [];
const byGroup = new Map();
for (const ep of endpoints) {
  const name = ep.group ?? '未分组';
  if (!byGroup.has(name)) {
    byGroup.set(name, []);
    groups.push(name);
  }
  byGroup.get(name).push(ep);
}

// 表格单元格里不能出现裸竖线，会把 Markdown 表格拆坏。
const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

// 生成时间只影响首行那一个字段。`--check` 若把它算进去，文档隔天就会"不一致"，
// 于是门禁天天红、天天要重跑一次生成器 —— 那等于没有门禁。
//
// 但**只能归一化日期那一段，不许把整行剔掉**：上一版写的就是"过滤掉这一行再比"，
// 而那一行同时带着「版本：x.y.z」与「端点数：N」—— 整行剔除等于这两项也不比了。
// 实测后果：把 agent-api.json 的版本从 0.8.5 改成 0.8.6，`--check` 照样报"文档一致"，
// 而文档还写着 0.8.5 —— 这正是本项目反复栽过的"全绿但文档骗人"，只是这次骗人的是门禁自己。
const GENERATED_AT_DATE = /生成时间：\d{4}-\d{2}-\d{2}/;
const normalizeGeneratedAt = (text) => text.replace(GENERATED_AT_DATE, '生成时间：<日期>');

const lines = [];
lines.push('# legadoQ API 参考');
lines.push('');
lines.push(`> 版本：${doc.version ?? 'dev'} · 端点数：${endpoints.length} · 生成时间：${new Date().toISOString().slice(0, 10)}`);
lines.push('> 本文由 `node scripts/gen-api-reference.mjs` 从 `app/src/main/resources/agent-api.json` 生成；');
lines.push('> 那份 JSON 就是 `GET /api/catalog` 吐出去的契约，以此为准，不要在手写正文里改端点。');
lines.push('');
lines.push('## 连接');
lines.push('');
lines.push('- Base URL：`http://127.0.0.1:1234`');
lines.push('- 认证：本服务不设身份：绑定地址就是唯一的门。写操作（write=true）从浏览器发起必须带与 Host 同源的 Origin 头；本机脚本或 AI 客户端直接调用即可（不带 Origin 就放行），不需要令牌。唯一反向例外是 WebSocket：那条把「没有 Origin」当作跨站拒掉。把 LEGADO_HOST 改成 0.0.0.0 等于把整个库的写权限交给局域网。');
lines.push('- Content-Type：`application/json; charset=utf-8`');
lines.push('- 错误：失败一律是非 2xx + {"code":..., "message":...}；message 是给人看的一句中文，可以直接显示或据此改动作');
lines.push('');
lines.push('## 端点分组');
lines.push('');
lines.push('| 分组 | 条数 |');
lines.push('|---|---:|');
for (const name of groups) {
  lines.push(`| ${name} | ${byGroup.get(name).length} |`);
}
lines.push(`| **合计** | **${endpoints.length}** |`);
lines.push('');

// query / body 在 agent-api.json 里是对象（形如 { "group": "可选：分组" }），
// 不能直接拼字符串 —— 上一版文档里那 89 处 `[object Object]` 就是这么来的。
// 拍平成 `group=可选：分组` 这样的键值串，读的人才知道该传什么。
const flat = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('，');
};

for (const name of groups) {
  lines.push(`## ${name}（${byGroup.get(name).length}）`);
  lines.push('');
  lines.push('| 方法 | 路径 | 写门 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const ep of byGroup.get(name)) {
    const method = ep.method ?? '';
    const path_ = ep.path ?? '';
    const write = ep.write ? '是' : '否';
    // 说明列：purpose 是主文案；有 query/body 时补一句，省得接进来的人漏传参数。
    let purpose = ep.purpose ?? '';
    const query = flat(ep.query);
    const body = flat(ep.body);
    if (query) purpose += `；query：${query}`;
    if (body) purpose += `；请求体：${body}`;
    lines.push(`| ${cell(method)} | \`${cell(path_)}\` | ${write} | ${cell(purpose)} |`);
  }
  lines.push('');
}

// 行尾按仓库标准走 LF：`.gitattributes` 里 `*.md … eol=lf`，committed blob 就是 LF。
// 上一版硬写 CRLF 再逐字节比对，结果是**只在 CI 红**——Linux runner 检出的是 LF，
// 生成的却是 CRLF；Windows 本地那份工作副本本来就是 CRLF，所以本地一直是绿的。
// 现在两边先归一到 LF 再比，写出也用 LF，跨平台同一结论。
const toLf = (text) => text.replaceAll('\r\n', '\n');
const output = toLf(lines.join('\n') + '\n');
const existing = fs.existsSync(TARGET) ? toLf(fs.readFileSync(TARGET, 'utf8')) : null;

if (checkOnly) {
  if (normalizeGeneratedAt(existing ?? '') !== normalizeGeneratedAt(output)) {
    console.error('[gen-api-reference] docs/API-REFERENCE.md 与 agent-api.json 不一致，重跑 `node scripts/gen-api-reference.mjs`');
    process.exit(1);
  }
  console.log(`[gen-api-reference] OK：${endpoints.length} 条端点，${groups.length} 个分组，文档一致`);
} else {
  fs.writeFileSync(TARGET, output);
  console.log(`[gen-api-reference] 已写出 ${path.relative(ROOT, TARGET)}：${endpoints.length} 条端点 / ${groups.length} 个分组`);
}
