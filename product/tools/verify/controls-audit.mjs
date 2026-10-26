import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, SHOTS, ROOT, launchOptions } from './env.mjs'
const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const b = await puppeteer.launch(launchOptions());
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const scan = () => p.evaluate(() => {
  const parse = (c) => {
    if (!c) return null;
    let m = /^color\(srgb ([\d.-]+) ([\d.-]+) ([\d.-]+)(?: \/ ([\d.]+))?\)$/.exec(c);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
    m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const q = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); if (q.length < 3) return null; return { r: q[0], g: q[1], b: q[2], a: q.length > 3 ? q[3] : 1 }; }
    return null;
  };
  const over = (px, base) => { if (!px) return base; const a = Math.min(1, Math.max(0, px.a)); return { r: px.r * a + base.r * (1 - a), g: px.g * a + base.g * (1 - a), b: px.b * a + base.b * (1 - a), a: 1 }; };
  const bgOf = (el) => { if (!el) return { r: 255, g: 255, b: 255 }; const px = parse(getComputedStyle(el).backgroundColor); if (px && px.a > 0) return over(px, el.parentElement ? bgOf(el.parentElement) : { r: 255, g: 255, b: 255 }); return el.parentElement ? bgOf(el.parentElement) : { r: 255, g: 255, b: 255 }; };
  const lin = (c) => { c = Math.max(0, Math.min(255, c)) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (px) => px ? 0.2126 * lin(px.r) + 0.7152 * lin(px.g) + 0.0722 * lin(px.b) : null;
  const str = (px) => `rgb(${Math.round(px.r)}, ${Math.round(px.g)}, ${Math.round(px.b)})`;
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll('button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea, a[class]')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 16);
    const cls = (el.className || '').toString().replace(/theme-(light|paper|dark) ?/g, '').slice(0, 30);
    const bg = bgOf(el); const fg = parse(cs.color);
    const l1 = lum(bg), l2 = lum(fg);
    const contrast = (l1 === null || l2 === null) ? null : +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
    const flags = [];
    if (contrast === null) flags.push('无法测量');
    else if (contrast < 3) flags.push('严重对比' + contrast);
    else if (contrast < 4.5) flags.push('偏低' + contrast);
    if (r.height < 30) flags.push('高' + Math.round(r.height));
    if (cs.visibility === 'hidden') flags.push('不可见'); else if (!el.disabled && parseFloat(cs.opacity) < 0.9 && !el.closest('[data-hover-reveal]')) flags.push('不可见');
    if (flags.length) { const key = el.tagName + '.' + cls + '|' + flags.join(','); if (!seen.has(key)) { seen.add(key); out.push({ label, cls, bg: str(bg), own: cs.backgroundColor, fg: cs.color, contrast, flags: flags.join(',') }); } }
  }
  return out;
});
const report = {};
for (const theme of ['theme-light', 'theme-paper', 'theme-dark']) {
  for (const hash of ['#library', '#shelf', '#explore', '#sources', '#rules', '#subscriptions', '#backup']) {
    await p.goto(BASE + "/" + hash, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await p.waitForSelector('.app-shell', { timeout: 20000 }).catch(() => {});
    await p.evaluate(t => {
      const shell = document.querySelector('.app-shell');
      if (!shell) return;
      const cur = shell.className.split(' ').find(c => c.indexOf('theme-') === 0);
      if (cur) shell.classList.remove(cur);
      shell.classList.add(t);
    }, theme);
    await new Promise(r => setTimeout(r, 1600));
    const bad = await scan();
    if (bad.length) report[theme + ' ' + hash] = bad;
  }
}
fs.writeFileSync(path.join(OUT, 'controls.json'), JSON.stringify(report, null, 1));
let n = 0; for (const k of Object.keys(report)) n += report[k].length;
console.log('去重后缺陷种类合计', n, '，涉及', Object.keys(report).length, '个页面/主题组合');
for (const k of Object.keys(report)) { console.log('\n### ' + k); for (const x of report[k].slice(0, 14)) console.log('   ', String(x.label).padEnd(16), '|', x.cls.padEnd(30), '|', x.flags, '| bg=' + x.bg, 'fg=' + x.fg); }
await b.close();
