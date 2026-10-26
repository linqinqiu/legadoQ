import { readFileSync, readdirSync } from 'node:fs';

const dir = process.argv[2];
const failed = [];
let total = 0, skipped = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.xml'))) {
  const xml = readFileSync(dir + '/' + f, 'utf8');
  for (const chunk of xml.split('<testcase').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('>'));
    const attr = (a) => new RegExp(`${a}="([^"]*)"`).exec(head)?.[1] ?? '';
    total++;
    if (/<skipped/.test(chunk)) skipped++;
    if (/<failure|<error/.test(chunk)) failed.push(`${attr('classname')} > ${attr('name')}`);
  }
}
failed.sort();
console.log(`total=${total} failed=${failed.length} skipped=${skipped}`);
for (const f of failed) console.log(f);
