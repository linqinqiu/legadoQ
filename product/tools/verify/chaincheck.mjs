import http from 'node:http';

const req = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...headers };
  if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
  const r = http.request({ host: '127.0.0.1', port: 1234, path, method, headers: h }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.setTimeout(180000, () => r.destroy(new Error('客户端超时'))); r.on('error', reject); r.end(data);
});

const sourceId = process.argv[2] || 'https://fq-book.netsite.cc';
const keyword = process.argv[3] || '都市';

// 本服务已删整套身份认证：/healthz 不再发 legado_session cookie / csrfToken，
// 旧代码去取会 null 崩。写操作只过同源闸门——带上同源 Origin 即可（本机 curl 不带 Origin 也放行）。
const H = { Origin: 'http://127.0.0.1:1234' };

const search = await req('POST', '/api/search', { keyword, sourceIds: [sourceId] }, H);
const hits = JSON.parse(search.text);
console.log(`1) 搜索「${keyword}」→ ${hits.length} 条`);
if (!hits.length) process.exit(1);
const pick = hits.find((h) => h.bookUrl && !/\{\$/.test(h.bookUrl)) ?? hits[0];
console.log(`   取《${pick.name}》${pick.bookUrl.slice(0, 70)}`);

const det = await req('POST', '/api/books/details', { sourceId, bookUrl: pick.bookUrl }, H);
const details = det.text.startsWith('{') ? JSON.parse(det.text) : null;
console.log(`2) 详情 → HTTP ${det.status} ${details ? `《${details.name}》作者=${details.author ?? '-'} 简介=${(details.intro ?? '').slice(0, 40)} toc=${(details.tocUrl ?? '').slice(0, 50)}` : det.text.slice(0, 120)}`);

const toc = await req('POST', '/api/books/chapters', { sourceId, bookUrl: details?.tocUrl ?? pick.bookUrl }, H);
let chapters = null;
try { chapters = JSON.parse(toc.text); } catch { /* ignore */ }
const list = Array.isArray(chapters) ? chapters : chapters?.chapters;
console.log(`3) 目录 → HTTP ${toc.status} ${Array.isArray(list) ? list.length + ' 章 首章=' + JSON.stringify(list[0]?.title ?? list[0]?.name ?? '') : toc.text.slice(0, 140)}`);
if (!Array.isArray(list) || !list.length) process.exit(1);

const target = list[Math.min(2, list.length - 1)];
const content = await req('POST', '/api/books/content', { sourceId, bookUrl: details?.tocUrl ?? pick.bookUrl, chapterUrl: target.url ?? target }, H);
let body = null;
try { body = JSON.parse(content.text); } catch { /* ignore */ }
console.log(`4) 正文 → HTTP ${content.status} ${body ? `${(body.content ?? '').length} 字《${body.title ?? target.title ?? ''}》开头=${JSON.stringify((body.content ?? '').replace(/\s+/g, ' ').slice(0, 70))}` : content.text.slice(0, 160)}`);
