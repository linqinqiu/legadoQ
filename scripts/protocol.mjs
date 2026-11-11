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
  console.log('[protocol] OK：3 份入口与模板一致');
} else {
  console.log('[protocol] 已同步 3 份入口');
}
