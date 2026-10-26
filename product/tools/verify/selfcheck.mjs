import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = process.env.LEGADO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// .env 可选（且被 .gitignore 忽略）：干净 clone / CI 里没有它不该直接崩，缺失回落空对象。
const envFile = path.join(ROOT, '.env');
const env = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
      .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
  : {};
// 端口不写死：环境变量 > .env > 本机默认 1234。
const PORT = Number(process.env.LEGADO_PORT || env.LEGADO_PORT || 1234);
const rows = [];
const skips = [];
const ok = (n, p, d = '') => { rows.push([n, p, d]); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '   [' + d + ']' : ''}`); };

function raw(method, path, body, cookie, csrf, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(timeoutMs, () => { r.destroy(new Error('本地请求超时 ' + path)); });
    r.on('error', reject);
    r.end(data);
  });
}

// —— A 传输与前端壳
const idx = await raw('GET', '/');
const asset = idx.text.match(/\/assets\/index-[\w-]+\.js/)?.[0];
ok('H5 首页返回 SPA 壳', idx.status === 200 && /<div id="root"|<script/i.test(idx.text), `HTTP ${idx.status} 资源 ${asset ?? '未找到'}`);
const js = asset ? await raw('GET', asset) : { status: 0, body: Buffer.alloc(0) };
ok('JS bundle 可加载且非空', js.status === 200 && js.body.length > 50000, `${js.status} ${js.body.length}B`);
const nf = await raw('GET', '/api/does-not-exist');
ok('未知 API 路径 404 且不回落成 HTML', nf.status === 404 && !/<html/i.test(nf.text), `${nf.status} body=${JSON.stringify(nf.text.slice(0, 40))}`);
const deep = await raw('GET', '/some/client/route');
const hashRouted = /location\.hash/.test(fs.readFileSync(path.join(ROOT, 'web/src/main.tsx'), 'utf8'));
ok('前端用 hash 路由，服务端无需深路径回落', deep.status === 404 && hashRouted, `深路径 ${deep.status}，客户端 hash 路由=${hashRouted}`);
const idx2 = await raw('GET', '/index.html');
ok('/index.html 直连可用', idx2.status === 200 && /<div id="root"|<script/i.test(idx2.text), `${idx2.status}`);

// —— B 不设身份：本机打开就能用，写操作只过同源闸门（闸门逐条由 authfixes 验）
const sess = await raw('GET', '/healthz');
const cookie = '';
const csrf = '';
ok('服务不设身份：不带任何凭据也能读到受保护接口', sess.status === 200, String(sess.status));
const anonGet = await raw('GET', '/api/sources');
ok('匿名 GET 受保护接口 200', anonGet.status === 200, `${anonGet.status}`);
const crossSite = await raw('POST', '/api/search', { keyword: '测试', sourceIds: [] }, '', '', { Origin: 'http://evil.example' });
ok('外站页面驱动浏览器写本机被拒（同源闸门在位）', crossSite.status === 403 && /cross_origin/.test(crossSite.text), `${crossSite.status} ${crossSite.text.slice(0, 50)}`);
const localWrite = await raw('POST', '/api/replace-rules', { id: 'selfcheck-write-probe', name: '', group: '自检', pattern: '', replacement: '', isRegex: false, scope: '', excludeScope: '', scopeTitle: false, scopeContent: true, isEnabled: false, order: 0, timeoutMillisecond: 3000 }, cookie, csrf);
ok('本机写请求被业务层受理（400 空模式，不是被鉴权挡）', localWrite.status === 400 && /invalid_rule/.test(localWrite.text), `${localWrite.status} ${localWrite.text.slice(0, 60)}`);

// —— C 数据面（直接读库，不信序列化）
const db = new DatabaseSync(path.join(ROOT, 'data/legado.sqlite'), { readOnly: true });
const q = (s) => db.prepare(s).all();
const srcCount = q('select count(*) n from source')[0].n;
const ruleStat = q('select is_enabled, count(*) n from replace_rule group by is_enabled');
const shelf = q('select source_id, name from book_shelf');
db.close();
const apiSourceCount = JSON.parse(anonGet.text).length
ok('书源数量：读库与接口一致（导入备份会改总数，写死历史数字等于替用户的数据下结论）',
  srcCount > 0 && srcCount === apiSourceCount, `库 ${srcCount} / 接口 ${apiSourceCount}`);
const apiRuleCount = JSON.parse((await raw('GET', '/api/replace-rules')).text).length;
ok('替换规则：读库与接口一致（导入备份会改条数，写死历史数字是替用户的数据下结论）',
  ruleStat.reduce((a, r) => a + r.n, 0) === apiRuleCount && apiRuleCount > 0,
  `库 ${ruleStat.reduce((a, r) => a + r.n, 0)} / 接口 ${apiRuleCount}｜${JSON.stringify(ruleStat.map((r) => `${r.is_enabled ? '启用' : '停用'}=${r.n}`))}`);
  // 只验"自检没动用户数据"，**不要求**书架上必须有本地书 ——
  // 那取决于用户导没导入过，是环境状态不是产品事实。
  // 从前这条写成 some(b => b.source_id === 'loc_book')，在没有本地书的库上必然红，
  // 等于把"用户没导入过本地书"判成产品坏了。
  const shelfAfterCheck = JSON.parse((await raw('GET', '/api/bookshelf')).text).length;
  ok('自检全程没有增删书架条目（不碰用户数据）',
    shelf.length === shelfAfterCheck,
    `书架 ${shelf.length} 本：${shelf.map((s) => s.name).join('、')}`);

// —— D 在线链路
const sources = JSON.parse(anonGet.text);
// 按名排序的前 N 个源里大半是死站/坏规则（实测 60 源样本仅 3 个能出结果），
// 所以链路测试用一组已知存活源，另用大池子衡量“搜索整体是否工作”。
const LIVE = /shukuge\.com|swsk\.org|bqgns\.com|xwurexs\.com|19shuyuan\.com/;
const livePool = sources.filter((s) => LIVE.test(s.url)).map((s) => s.id);
/**
 * 搜索样本要"均匀铺开"，不能取按名排序的前 12 个。
 *
 * 整库启用之后，`slice(0, 12)` 拿到的全是 `00小说网 / 01书库 / 114中文网…` 这类
 * 数字开头的老站，实测 17 个源的样本一条命中都没有 —— 于是"多源并发搜索出结果"
 * 这条红的是样本偏差，不是搜索回归。改成在启用源里等距抽 60 个。
 */
const enabledPlain = sources.filter((s) => !s.isJsSource && s.enabled);
const SAMPLE_SIZE = 60;
const sampleStride = Math.max(1, Math.floor(enabledPlain.length / SAMPLE_SIZE));
const pool = enabledPlain.filter((_, index) => index % sampleStride === 0).slice(0, SAMPLE_SIZE).map((s) => s.id);
// 服务端只搜启用的源。主人把已知存活的五个域全停用时，这三项在本机测不到引擎，
// 但那不是代码回归 —— 明确报出来并计入 SKIP，绝不去改用户的启用位刷绿。
const liveEnabled = sources.filter((s) => LIVE.test(s.url) && s.enabled).map((s) => s.id);
// 一次非流式搜索要等完整个样本池（每个源最多 30 秒、并发 16~32），慢站多时两分钟以上是实测有的。
// 客户端到点**不能把整份自检崩掉**：下面那句"崩了就什么都看不到"是上一轮写的教训，
// 但当时只兜住了 JSON 解析，没兜住请求本身 —— 一个慢池就让后面 20 条断言全没了。
let search = { status: 0, text: '' }
try {
  search = await raw('POST', '/api/search', { keyword: '都市', sourceIds: [...new Set([...livePool, ...pool])] }, cookie, csrf, {}, 300000)
} catch (error) {
  search = { status: 0, text: '' }
  ok('多源并发搜索在 300 秒内返回', false, String(error.message))
  skips.push('搜索命中 / 详情→目录→正文 / 净化 A/B —— 样本池里慢站太多，客户端等到 300 秒仍没拿到回答（不是 500，是真没返回）。要覆盖这三项：node tools/verify/chaincheck.mjs <源> <关键词>')
}
// 响应不是数组时（服务被上一轮搜索压住、返回了错误体）要当场报出来，
// 不能让 `hits.filter is not a function` 把整个自检崩掉 —— 崩了就什么都看不到了。
const parsedSearch = (() => { try { return JSON.parse(search.text) } catch { return null } })()
const hits = Array.isArray(parsedSearch) ? parsedSearch : []
if (!Array.isArray(parsedSearch) && search.status !== 0) {
  ok('多源并发搜索返回的是数组', false, `${search.status} ${String(search.text).slice(0, 160) || '(空响应体)'}`)
}
const brokenUrls = hits.filter((h) => /\{\$|\{%/.test(h.bookUrl)).length;
if (liveEnabled.length === 0) {
  ok('多源并发搜索接口可用（命中数不判：本机把已知存活源全停用了）', search.status === 200, String(search.status));
  skips.push('搜索命中 / 详情→目录→正文 / 净化 A/B —— 本机没有启用任何已知存活源（' + livePool.length + ' 个全停用）。要覆盖这三项：启用任一 shukuge/swsk/bqgns/xwurexs/19shuyuan 源后重跑，或 node tools/verify/chaincheck.mjs <源> <关键词>');
} else if (Array.isArray(parsedSearch)) {
  ok('多源并发搜索出结果', search.status === 200 && hits.length > 0,
    `样本 ${pool.length} 个启用源 → ${hits.length} 条，来自 ${new Set(hits.map((h) => h.sourceId)).size} 个书源；其中 bookUrl 含未解析占位符 ${brokenUrls} 条`);
}

let chain = null;
const chainTried = [];
if (hits.length) {
  // 候选里混着 `pool` 前 12 个源（大半是死站），只试前 8 条会全踩空；先试已知存活源的命中。
  const candidates = hits.filter((x) => !/\{\$|\{%/.test(x.bookUrl))
    .sort((a, b) => (livePool.includes(a.sourceId) ? 0 : 1) - (livePool.includes(b.sourceId) ? 0 : 1))
  for (const h of candidates.slice(0, 24)) {
    const det = await raw('POST', '/api/books/details', { sourceId: h.sourceId, bookUrl: h.bookUrl }, cookie, csrf);
    if (det.status !== 200) { chainTried.push(`${h.sourceId} 详情 ${det.status}`); continue; }
    const toc = await raw('POST', '/api/books/chapters', { sourceId: h.sourceId, bookUrl: h.bookUrl }, cookie, csrf);
    const chs = JSON.parse(toc.text); const arr = Array.isArray(chs) ? chs : (chs.chapters || []);
    if (!arr.length) { chainTried.push(`${h.sourceId} 目录 0 章`); continue; }
    const pick = arr[Math.min(6, arr.length - 1)];
    const ct = await raw('POST', '/api/books/content', { sourceId: h.sourceId, chapterUrl: pick.url, bookUrl: h.bookUrl }, cookie, csrf);
    const j = JSON.parse(ct.text);
    if ((j.content || '').length > 300) { chain = { h, det: JSON.parse(det.text), arr, n: arr.length, usedIdx: new Set([arr.indexOf(pick)]), title: j.title || pick.title, len: j.content.length, sample: j.content.replace(/\s+/g, ' ').slice(0, 60) }; break; }
    chainTried.push(`${h.sourceId} 正文 ${ct.status}/${(j.content || '').length} 字`);
  }
}
// 这两条要真实正文，跟着搜索命中一起走数据前置。
// 判据分两种红法：候选里有源取到了目录、却在正文这一步失败 ⇒ 真回归；
// 全部候选都停在"详情报错 / 目录 0 章" ⇒ 这一批域名根本连不上，是数据状态，计入 SKIP。
// （主人把整库 5,574 个源全启用之后，已知存活域里也混进了已经关站的老域名，
//  只按"有没有启用存活源"决定跳过已经不够用了。）
const chainStuckUpstream = chainTried.length > 0
  && chainTried.every(entry => /详情 \d|目录 0 章/.test(entry))
if (chain) {
  ok('详情→目录→正文 全链路', true,
    `${chain.det.name}｜${chain.n} 章｜《${chain.title}》${chain.len} 字｜${JSON.stringify(chain.sample)}…`)
} else if (chainStuckUpstream) {
  skips.push(`详情→目录→正文 / 净化 A/B —— 试了 ${chainTried.length} 个候选全部停在详情或目录（域名连不上或站已关），不是代码回归。要覆盖这两项：启用一个确认存活的源后重跑，或 node tools/verify/chaincheck.mjs <源> <关键词>`)
} else {
  ok('详情→目录→正文 全链路', false, `未取到正文（试了 ${chainTried.length} 个候选：${chainTried.slice(0, 3).join('; ') || '没有可用命中'}）`)
}

// 净化 A/B：两条都是从未请求过、因而未缓存的新章节，规则前 vs 规则后
const punct = (s) => (s.match(/，/g) || []).length;
const freshIdx = chain ? chain.arr.map((_, i) => i).filter((i) => !chain.usedIdx.has(i)).slice(0, 2) : [];
const commaAt = async (i) => {
  const j = JSON.parse((await raw('POST', '/api/books/content', { sourceId: chain.h.sourceId, chapterUrl: chain.arr[i].url, bookUrl: chain.h.bookUrl }, cookie, csrf)).text);
  return punct(j.content || '');
};
const commaBefore = freshIdx.length === 2 ? await commaAt(freshIdx[0]) : -1;
const ruleId = 'selfcheck-punct';
const created = await raw('POST', '/api/replace-rules', { id: ruleId, name: '自检标点替换', group: '自检', pattern: '，', replacement: '。', isRegex: false, scope: '', excludeScope: '', scopeTitle: false, scopeContent: true, isEnabled: true, order: 0, timeoutMillisecond: 3000 }, cookie, csrf);
ok('自检规则已创建', created.status === 200, `${created.status}`);
const commaAfter = freshIdx.length === 2 ? await commaAt(freshIdx[1]) : -1;
const removed = await raw('DELETE', '/api/replace-rules/' + encodeURIComponent(ruleId), undefined, cookie, csrf);
// 净化 A/B 依赖上一条取到的那本书：上一条没跑成（SKIP）时这里也不能判红。
if (chain) {
  ok('在线正文确实经过净化管道（加规则后的新章节逗号数 0）', commaAfter === 0, `规则前另一章 ${commaBefore} 个 / 规则后 ${commaAfter} 个`);
}
ok('自检规则已清理', removed.status === 204, `${removed.status}`);
const db2 = new DatabaseSync(path.join(ROOT, 'data/legado.sqlite'), { readOnly: true });
const leftovers = db2.prepare("select id from replace_rule where id like 'selfcheck%'").all();
db2.close();
ok('自检没有在库里留下任何残留规则', leftovers.length === 0, leftovers.map((r) => r.id).join(',') || '无 selfcheck* 记录');

// 其它端点存活
for (const [p, name] of [['/api/subscriptions', '订阅'], ['/api/replace-rules', '规则'], ['/api/rss/sources', 'RSS 订阅'], ['/api/bookshelf', '书架']]) {
  const r = await raw('GET', p, undefined, cookie, null);
  ok(`${name} 端点可用`, r.status === 200, `${r.status} ${(r.text || '').length}B`);
}
// 发现（explore）：Legado 的核心功能之一，服务端与前端都依赖这三个接口
const exSources = JSON.parse((await raw('GET', '/api/explore/sources', undefined, cookie, null)).text);
const allSources = JSON.parse((await raw('GET', '/api/sources', undefined, cookie, null)).text);
const enabledCount = allSources.filter((s) => s.enabled).length;
// 这个接口只列「启用且配了 exploreUrl」的源：数量低是主人自己停用的结果，不是代码回归，
// 所以把启用总数一起打出来，免得下次有人去翻发现页的代码。
ok(
  '发现页可用书源列表',
  Array.isArray(exSources) && exSources.every(item => allSources.some(s => s.enabled && (item.id ?? item.url) === s.id)),
  `${exSources.length} 个书源配了 exploreUrl（全库 ${allSources.length}，仅 ${enabledCount} 个启用）`,
);
const EX = 'https://fq-book.netsite.cc';
const exTabs = JSON.parse((await raw('GET', `/api/sources/${encodeURIComponent(EX)}/explore`, undefined, cookie, null)).text);
ok('发现分栏解析（@js: 数组形式）', Array.isArray(exTabs) && exTabs.length > 3 && exTabs.every((t) => t.title && t.url), `${exTabs.length} 个分栏：${exTabs.slice(0, 4).map((t) => t.title).join('、')}`);
const rankTab = exTabs.find((t) => /榜单/.test(t.title));
const exBooks = JSON.parse((await raw('POST', '/api/explore', { sourceId: EX, url: rankTab?.url }, cookie, csrf)).text);
ok('发现页取到书籍', Array.isArray(exBooks) && exBooks.length > 0, `${Array.isArray(exBooks) ? exBooks.length : exBooks.code ?? '?'} 本，例：${(Array.isArray(exBooks) ? exBooks[0]?.name : '') ?? ''}`);

const dbgSrc = chain?.h.sourceId ?? pool[0];
const dbg = await raw('GET', `/api/sources/${encodeURIComponent(dbgSrc)}/debug?keyword=%E9%83%BD%E5%B8%82`, undefined, cookie, null);
ok('书源 debug(SSE) 有事件流', dbg.status === 200 && /event:/.test(dbg.text), `${dbg.status} ${dbg.text.split('\n').filter((l) => l.startsWith('data:')).length} 条事件`);

// —— E 错误处理与边界
const bad = await raw('POST', '/api/search', { keyword: '   ' }, cookie, csrf);
ok('空关键词 400 + 错误码', bad.status === 400 && /"code"/.test(bad.text), `${bad.status} ${bad.text.slice(0, 60)}`);
const ghost = await raw('POST', '/api/books/details', { sourceId: 'http://not-a-source.invalid', bookUrl: 'x' }, cookie, csrf);
ok('不存在书源 404', ghost.status === 404, `${ghost.status}`);
const garbage = await raw('POST', '/api/search', Buffer.from('{不是 json'), cookie, csrf, { 'content-type': 'application/json' });
ok('坏 JSON 不导致 500', garbage.status === 400, `${garbage.status}`);

// 随包更新日志：读的是打进 jar 的那一份（不是磁盘上的仓库文件），所以这一条同时也在验打包环节。
const chlog = await raw('GET', '/api/changelog');
ok('随包 CHANGELOG 可用（200 + markdown + 有版本号段）',
  chlog.status === 200 && /^text\/markdown/.test(chlog.headers['content-type'] ?? '') && /^## \[[^\]]+\]/m.test(chlog.text),
  `${chlog.status} ${chlog.headers['content-type'] ?? ''} ${chlog.text.length}B`);

const listen = execSync('netstat -ano', { encoding: 'utf8' }).split(/\r?\n/).filter((l) => new RegExp(`:${PORT}\\s`).test(l) && /LISTENING/i.test(l)).map((l) => l.trim().split(/\s+/).join(' '));
const localOnly = listen.length === 1 && /\b127\.0\.0\.1:/.test(listen[0]);
ok('只监听回环', localOnly, listen.map((l) => l.split(' ').slice(0, 2).join(' ')).join(' | ') || '无');
const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const probe = (h) => new Promise((r) => { const s = net.connect({ host: h, port: PORT, timeout: 2500 }); s.once('connect', () => { s.destroy(); r('OPEN!!'); }); s.once('timeout', () => { s.destroy(); r('timeout'); }); s.once('error', (e) => r(e.code)); });
const res = [];
for (const ip of ips) res.push(`${ip}=${await probe(ip)}`);
ok('局域网地址连不上', !res.some((x) => x.endsWith('OPEN!!')), res.join(' ') || '无局域网 IPv4');

const psOut = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8' }).trim();
const javaProcs = JSON.parse(psOut.startsWith('[') ? psOut : `[${psOut}]`);
const proc = javaProcs.filter((p) => /legado.*-all\.jar/.test(p.CommandLine ?? ''));
ok('只有一个服务进程，且跑的是本地构建 jar', proc.length === 1, proc.map((p) => 'PID ' + p.ProcessId).join(',') || `java 进程 ${javaProcs.length} 个，无 legado`);

const db3 = new DatabaseSync(path.join(ROOT, 'data/legado.sqlite'), { readOnly: true });
const deadTables = db3.prepare("select name from sqlite_master where type = 'table' and name in ('session', 'app_user')").all();
db3.close();
ok('鉴权删掉后 session / app_user 两张死表已收掉（库里不留无人读的凭据）', deadTables.length === 0, deadTables.map((t) => t.name).join(',') || '无');

// 失败项在收尾处再点名一次：这台机器上 selfcheck 会被并发负载打到偶发红（全库搜索还在服务端排队时
// 实测掉过 31/33、30/33，单跑必绿），而逐行 PASS/FAIL 打在几千行输出的中段，
// `tail -3` 只看得到计数看不到是哪三条 —— 等于把"红得有没有道理"又变成一次重新排查。
const failedRows = rows.filter((r) => !r[1]);
if (failedRows.length) {
  console.log('');
  console.log('本轮失败项：');
  for (const r of failedRows) console.log(`  FAIL ${r[0]}${r[2] ? '   [' + String(r[2]).slice(0, 160) + ']' : ''}`)
}
console.log(`\n${rows.length - failedRows.length}/${rows.length} 通过`);
if (skips.length) {
  console.log('');
  console.log(skips.length + ' 项因本机数据状态本轮未覆盖：');
  for (const s of skips) console.log('  SKIP ' + s)
}
process.exit(failedRows.length ? 1 : 0);
