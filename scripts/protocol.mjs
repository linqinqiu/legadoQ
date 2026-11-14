#!/usr/bin/env node
// 单一来源生成 3 份工具入口协议：CLAUDE.md / GEMINI.md / .cursorrules
// 改协议只改 scripts/protocol-template.md，然后 `npm run protocol:sync`。
// `npm run protocol:check` 校验三份是否与模板逐字节一致（防漂移）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(root, 'scripts/protocol-template.md');
const targets = ['CLAUDE.md', 'GEMINI.md', '.cursorrules'];
const check = process.argv.includes('--check');

const template = readFileSync(templatePath, 'utf8');
const drift = [];

// 关键规则双向断言（S-2）：三份入口只钉「==模板」还不够——模板与 AGENTS.md 完整版
// 之间也要防漂移。这里钉关键规则标记在两侧都存在；语义级一致仍靠改协议时人工对齐。
const keyRules = [
  ['禁读区', /docs\/archive/],
  ['版本纪律', /BUILD_NUMBER/],
  ['前端测试命令', /npm test|npm --prefix product\/web test/],
  ['后端测试命令', /gradlew :app:test/],
  ['AGENTS 指针', /AGENTS\.md/],
];
const agentsPath = join(root, 'AGENTS.md');
let agents = '';
try { agents = readFileSync(agentsPath, 'utf8'); } catch { /* 缺失算漂移 */ }
const ruleDrift = [];
for (const [label, re] of keyRules) {
  if (!re.test(template)) ruleDrift.push(`模板缺「${label}」`);
  if (!re.test(agents)) ruleDrift.push(`AGENTS.md 缺「${label}」`);
}

for (const name of targets) {
  const p = join(root, name);
  let cur = '';
  try { cur = readFileSync(p, 'utf8'); } catch { /* 缺失算漂移 */ }
  if (cur === template) continue;
  if (check) drift.push(name);
  else { writeFileSync(p, template); console.log(`[protocol] wrote ${name}`); }
}

if (check) {
  if (drift.length) {
    console.error(`[protocol] 漂移：${drift.join(', ')} 与 scripts/protocol-template.md 不一致。跑 \`npm run protocol:sync\``);
    process.exit(1);
  }
  if (ruleDrift.length) {
    console.error(`[protocol] 关键规则漂移：${ruleDrift.join('；')}。模板与 AGENTS.md 须同时包含这些规则。`);
    process.exit(1);
  }
  console.log('[protocol] OK：3 份入口与模板一致，关键规则双向在位');
} else {
  console.log('[protocol] 已同步 3 份入口');
}
