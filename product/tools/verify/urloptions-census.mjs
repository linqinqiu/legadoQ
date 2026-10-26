import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ROOT } from './env.mjs';

const db = new DatabaseSync(process.argv[2] || path.join(ROOT, 'data', 'legado.sqlite'), { readOnly: true });
const rows = db.prepare('select id, payload from source').all();
db.close();

// 复刻服务端 splitUrlOptions：取第一个 ",{" 之后的整段，要求 kotlinx Json 严格解析成功。
// 解析失败时服务端会把「URL + options 尾巴」原样丢给 parseUri → 报“URL 格式无效或包含未解析变量”。
const strictJsonTail = (value) => {
  const start = value.indexOf(',{');
  if (start < 0) return null;
  const tail = value.slice(start + 1).trim();
  try { const o = JSON.parse(tail); return { ok: o && typeof o === 'object' && !Array.isArray(o), tail }; } catch { return { ok: false, tail }; }
};

const stats = { total: rows.length, withTail: 0, tailStrictOk: 0, tailBroken: 0 };
const examples = [];
const methods = new Map();
for (const row of rows) {
  let s; try { s = JSON.parse(row.payload); } catch { continue; }
  const url = s.searchUrl ?? '';
  const r = strictJsonTail(url);
  if (!r) continue;
  stats.withTail++;
  if (r.ok) {
    stats.tailStrictOk++;
    const m = JSON.parse(r.tail).method ?? 'GET';
    methods.set(m, (methods.get(m) ?? 0) + 1);
  } else {
    stats.tailBroken++;
    if (examples.length < 6) examples.push({ host: s.bookSourceUrl, tail: r.tail.replace(/\s+/g, ' ').slice(0, 120) });
  }
}
console.log(`带 ",{" options 尾巴的 searchUrl: ${stats.withTail}`);
console.log(`  严格 JSON、服务端可解析: ${stats.tailStrictOk}`);
console.log(`  JS 对象字面量、服务端必然失败: ${stats.tailBroken}  （占全部 ${stats.total} 个书源的 ${(stats.tailBroken / stats.total * 100).toFixed(1)}%）`);
console.log(`可解析那批的 method 分布: ${JSON.stringify(Object.fromEntries(methods))}`);
console.log('\n失败样例（服务端会整串当 URL）:');
for (const e of examples) console.log(`  ${e.host}\n    ${e.tail}`);
