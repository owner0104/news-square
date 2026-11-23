// RSSからニュースを集めて news.json を作る（依存パッケージなし / Node 20+）
import { writeFile, readFile } from 'node:fs/promises';

// 設定は config.json で行います（フィードの追加・削除、地域名、翻訳のオン／オフ）
const CONFIG = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const FEEDS = CONFIG.feeds.map((f) => ({ r: f.region, c: f.category, s: f.source || '', u: f.url }));
const PER_REGION = CONFIG.perRegion || 60;

// ---- 英語見出しの日本語訳（無料のGoogle翻訳エンドポイント。失敗時は原文のまま） ----
const isJa = (t) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(t);
const TR = { need: 0, applied: 0, errors: [] };
const STATUS = [];
async function mymemory(text) {
  const u = 'https://api.mymemory.translated.net/get?langpair=en|ja&de=news-square@users.noreply.github.com&q=' + encodeURIComponent(text);
  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  if (!res.ok || j.responseStatus != 200) throw new Error('mymemory ' + (j.responseDetails || res.status));
  return j.responseData.translatedText;
}
async function gtx(text) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('translate ' + res.status);
  const j = await res.json();
  return j[0].map((seg) => seg[0]).join('');
}
async function translateAll(items, cache) {
  const need = [...new Set(items.filter((n) => !isJa(n.t) && !cache.has(n.t)).map((n) => n.t))];
  for (let i = 0; i < need.length; i += 15) {
    const chunk = need.slice(i, i + 15);
    try {
      const out = (await gtx(chunk.join('\n'))).split('\n').map((x) => x.trim());
      if (out.length === chunk.length) chunk.forEach((t, k) => cache.set(t, out[k]));
      else for (const t of chunk) cache.set(t, (await gtx(t)).trim());
    } catch (e) {
      TR.errors.push(String(e.message).slice(0, 160));
      // 予備：1件ずつ別サービスで
      for (const t of chunk) { try { cache.set(t, (await mymemory(t)).trim()); } catch (e2) { TR.errors.push(String(e2.message).slice(0, 160)); break; } }
      if (TR.errors.length > 6) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  let n = 0;
  for (const it of items) {
    const orig = it.o || it.t;
    if (!isJa(orig) && cache.get(orig)) { it.o = orig; it.t = cache.get(orig); n++; }
  }
  TR.need = need.length; TR.applied = n;
  console.log(`翻訳: ${need.length}件を新規翻訳 / ${n}件に訳を適用`, TR.errors);
}

const decode = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (x, name) => { const m = x.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(decode(m[1])) : ''; };

// 日付の書式ゆれに対応（RFC822 / ISO / "Thu, 11/20/2026 - 10:00" など）
function parseDate(raw) {
  if (!raw) return new Date();
  let d = new Date(raw);
  if (!isNaN(d)) return d;
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) { d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], (+m[4] || 12) + 5, +m[5] || 0)); if (!isNaN(d)) return d; } // 米国東部時間→UTC
  return new Date();
}

export function parse(xml, f) {
  return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/g)].map(([x]) => {
    let t = tag(x, 'title'), s = tag(x, 'source');
    const own = f.s || '';
    if (s && t.endsWith(' - ' + s)) t = t.slice(0, -(s.length + 3));
    else if (!s) { const m = t.match(/^(.*) - ([^-]{1,40})$/); if (m && f.u.includes('news.google')) { t = m[1]; s = m[2]; } }
    if (own) s = own; else if (!s) s = '';
    const d = parseDate(tag(x, 'pubDate') || tag(x, 'dc:date') || tag(x, 'updated') || tag(x, 'published'));
    let u = tag(x, 'link'); if (!u) { const al = x.match(/<link[^>]*href="([^"]+)"/); if (al) u = al[1]; } if (!u) { const m = x.match(/<item[^>]*rdf:about="([^"]+)"/); if (m) u = m[1]; }
    return { r: f.r, c: f.c, t, s, u, k: f.u, d: isNaN(d) ? new Date().toISOString() : d.toISOString() };
  }).filter(n => n.t && n.u);
}

// 文字コードを判定して読む（Shift_JIS / EUC-JP の日本のサイトに対応）
function decodeBody(buf, ctype = '') {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 300));
  let enc = (head.match(/encoding=["']([\w-]+)["']/i) || [])[1] || (ctype.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  enc = enc.toLowerCase();
  if (/^(shift_jis|sjis|x-sjis|windows-31j|cp932|ms932)$/.test(enc)) enc = 'shift_jis';
  try { return new TextDecoder(enc).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}


// ---- 一般ニュース：Wikipedia「Current events」（CC BY-SA 4.0） ----
const CAT = [[/armed|conflict|attack/i,'紛争・事件'],[/politic|election/i,'政治'],[/business|econom/i,'経済'],[/disaster|accident/i,'災害・事故'],[/science|tech/i,'科学・技術'],[/sport/i,'スポーツ'],[/art|culture/i,'文化'],[/law|crime/i,'司法・犯罪'],[/health|environment/i,'健康・環境'],[/international|relation/i,'国際関係']];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function cleanWiki(t) {
  return t.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '')
    .replace(/\(\s*\[https?:[^\]]*\]\s*(\[https?:[^\]]*\]\s*)*\)/g, '').replace(/\[https?:\S+\s([^\]]+)\]/g, '').replace(/\[https?:\S+\]/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').replace(/'{2,}/g, '')
    .replace(/^[*:#\s]+/, '').replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}
async function wikipediaEvents(opt) {
  const out = [];
  for (let k = 0; k < (opt.days || 2); k++) {
    const day = new Date(Date.now() - k * 864e5);
    const title = `Portal:Current_events/${day.getUTCFullYear()}_${MONTHS[day.getUTCMonth()]}_${day.getUTCDate()}`;
    const api = 'https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&page=' + encodeURIComponent(title);
    try {
      const res = await fetch(api, { headers: { 'user-agent': 'NewsSquare/1.0 (https://github.com/owner0104/news-square)' }, signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (!j.parse) { STATUS.push({ source: 'Wikipedia ' + title.split('/')[1], ok: false, error: 'no page yet' }); continue; }
      let cat = 'できごと', n = 0;
      for (const line of j.parse.wikitext.split('\n')) {
        const h = line.match(/^'''(.+?)'''\s*$/) || line.match(/^;\s*(.+)$/);
        if (h) { const m = CAT.find(([re]) => re.test(h[1])); cat = m ? m[1] : 'できごと'; continue; }
        if (!/^\*/.test(line)) continue;
        const t = cleanWiki(line);
        if (t.length < 45 || !/[.!?]$/.test(t)) continue;
        const jp = (opt.japanKeywords || []).some((w) => t.includes(w));
        out.push({ r: jp ? 'jp' : 'wd', c: cat, t, s: 'Wikipedia', u: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title).replace(/%2F/g, '/'), k: 'wikipedia', d: new Date(Math.min(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12), Date.now()) - n++ * 60000).toISOString() });
      }
      STATUS.push({ source: 'Wikipedia ' + title.split('/')[1], ok: true, count: n });
    } catch (e) { STATUS.push({ source: 'Wikipedia', ok: false, error: String(e.message) }); }
  }
  return out;
}

// ---- 音楽：Apple Music ランキング（Apple RSS Feed Generator） ----
async function appleMusic(list) {
  const out = [];
  for (const m of list || []) {
    const path = `/api/v2/${m.country}/music/most-played/${m.count || 25}/songs.json`;
    for (const host of ['https://rss.marketingtools.apple.com', 'https://rss.applemarketingtools.com']) {
      try {
        const res = await fetch(host + path, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(res.status);
        const j = await res.json();
        j.feed.results.forEach((x, i) => out.push({ rank: i + 1, label: m.label, name: x.name, artist: x.artistName, url: x.url }));
        STATUS.push({ source: 'Apple Music ' + m.label, ok: true, count: j.feed.results.length }); break;
      } catch (e) { if (host.includes('applemarketingtools')) STATUS.push({ source: 'Apple Music ' + m.label, ok: false, error: String(e.message) }); }
    }
  }
  return out;
}


// ---- 日本の出来事：Wikipedia「2026年の日本」（日本語）/「2026 in Japan」（英語） ----
async function wikiYearPage(opt) {
  const out = [];
  const year = new Date().getUTCFullYear();
  const title = opt.lang === 'ja' ? `${year}年の日本` : `${year} in Japan`;
  const api = `https://${opt.lang}.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=` + encodeURIComponent(title);
  try {
    const res = await fetch(api, { headers: { 'user-agent': 'NewsSquare/1.0 (https://github.com/owner0104/news-square)' }, signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (!j.parse) { STATUS.push({ source: 'Wikipedia ' + title, ok: false, error: 'no page' }); return out; }
    const EN = MONTHS.map((m) => m.toLowerCase());
    let month = null, n = 0;
    const since = Date.now() - (opt.days || 21) * 864e5;
    for (const line of j.parse.wikitext.split('\n')) {
      const h = line.match(/^={2,4}\s*(.+?)\s*={2,4}\s*$/);
      if (h) { const t = cleanWiki(h[1]); const mj = t.match(/^(\d{1,2})月/); const me = EN.indexOf(t.toLowerCase()); month = mj ? +mj[1] : me >= 0 ? me + 1 : month; continue; }
      if (!/^\*/.test(line)) continue;
      let t = cleanWiki(line), mo = month, d = null;
      const dj = t.match(/^(?:(\d{1,2})月)?(\d{1,2})日\s*[-–—:：]?\s*/);
      const de = t.match(new RegExp('^(?:(' + MONTHS.join('|') + ')\\s+)?(\\d{1,2})\\s*[-–—:]\\s*', 'i'));
      if (opt.lang === 'ja' && dj) { if (dj[1]) mo = +dj[1]; d = +dj[2]; t = t.slice(dj[0].length); }
      else if (opt.lang !== 'ja' && de) { if (de[1]) mo = EN.indexOf(de[1].toLowerCase()) + 1; d = +de[2]; t = t.slice(de[0].length); }
      if (!mo || !d || t.length < (opt.lang === 'ja' ? 12 : 30)) continue;
      const ts = Date.UTC(year, mo - 1, d, 3) - n * 60000; // 日本時間の正午ごろ
      if (ts < since || ts > Date.now() + 864e5) continue;
      if (/[（(]\d{4}年生まれ[）)]|\(b\. \d{4}\)/.test(t)) t = '訃報：' + t.replace(/[（(]\d{4}年生まれ[）)]/, '').replace(/、/, '（') + (t.includes('、') ? '）' : '');
      out.push({ r: 'jp', c: '日本の出来事', t, s: 'Wikipedia', u: `https://${opt.lang}.wikipedia.org/wiki/` + encodeURIComponent(title), k: 'wikipedia', d: new Date(Math.min(ts, Date.now()) - n++ * 1000).toISOString() });
    }
    STATUS.push({ source: 'Wikipedia ' + title, ok: true, count: n });
  } catch (e) { STATUS.push({ source: 'Wikipedia ' + title, ok: false, error: String(e.message) }); }
  return out;
}

async function get(f) {
  try {
    const res = await fetch(f.u, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 NewsSquare/1.0', accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8', 'accept-language': 'ja,en;q=0.8' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(res.status);
    const items = parse(decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type')), f);
    STATUS.push({ source: f.s || f.c, ok: true, count: items.length, latest: items.map((n) => n.d).sort().pop() || null, sample: items[0]?.t?.slice(0, 30) || null });
    console.log(`ok  ${items.length.toString().padStart(3)}  ${f.c}`);
    return items;
  } catch (e) { STATUS.push({ source: f.s || f.c, ok: false, error: String(e.message) }); console.log(`ERR ${f.c}: ${e.message}`); return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = (await Promise.all(FEEDS.map(get))).flat();
  const EX = CONFIG.extras || {};
  if (EX.wikipediaCurrentEvents?.enabled) all.push(...await wikipediaEvents(EX.wikipediaCurrentEvents));
  if (EX.wikipediaJapan?.enabled) for (const lang of EX.wikipediaJapan.langs || ['ja']) all.push(...await wikiYearPage({ ...EX.wikipediaJapan, lang }));
  const music = await appleMusic(EX.music);
  let prev = [];
  try { prev = JSON.parse(await readFile('news.json', 'utf8')).items || []; } catch {}
  // 前回の訳を再利用（原文→訳）。新しく取った英語見出しは原文を o に退避して比較
  const urls = new Set([...FEEDS.map((f) => f.u), 'wikipedia']);
  prev = prev.filter((n) => n.k && urls.has(n.k) && !/\uFFFD/.test((n.o || '') + n.t));
  const cache = new Map(prev.filter((n) => n.o).map((n) => [n.o, n.t]));
  for (const n of prev) if (n.o) n.t = n.o;          // 前回分も原文に戻してから重複判定
  const seen = new Set(), out = { jp: [], wd: [] };
  // 今回取得した内容を優先（日付の修正を反映するため）、前回分は今回に無いものだけ残す
  const keyOf = (n) => n.t.replace(/\s/g, '').slice(0, 40);
  const fresh = new Set(all.map(keyOf));
  const merged = [...all, ...prev.filter((n) => !fresh.has(keyOf(n)))];
  for (const n of merged.sort((a, b) => b.d.localeCompare(a.d))) {
    const key = n.t.replace(/\s/g, '').slice(0, 40);
    if (seen.has(key) || out[n.r].length >= PER_REGION) continue;
    seen.add(key); out[n.r].push(n);
  }
  const items = [...out.jp, ...out.wd];
  if (CONFIG.translate !== false) await translateAll(items, cache);
  if (!all.length) { console.log('全フィード取得失敗。news.json は変更しません'); process.exit(0); }
  await writeFile('news.json', JSON.stringify({ updated: new Date().toISOString(), title: CONFIG.title, boardCount: CONFIG.boardCount || 45, regions: CONFIG.regions, sources: [...new Set(FEEDS.map((f) => f.s || f.c))], music, weather: EX.weather || [], feeds: STATUS, tr: TR, items }, null, 0) + '\n');
  console.log(`news.json: 日本 ${out.jp.length} / 世界 ${out.wd.length}`);
}
