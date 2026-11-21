// RSSからニュースを集めて news.json を作る（依存パッケージなし / Node 20+）
import { writeFile, readFile } from 'node:fs/promises';

const G = (t) => `https://news.google.com/rss/headlines/section/topic/${t}?hl=ja&gl=JP&ceid=JP:ja`;
const FEEDS = [
  { r: 'jp', c: '主要',       u: 'https://news.yahoo.co.jp/rss/topics/top-picks.xml' },
  { r: 'jp', c: '国内',       u: G('NATION') },
  { r: 'jp', c: '経済',       u: G('BUSINESS') },
  { r: 'jp', c: 'テクノロジー', u: G('TECHNOLOGY') },
  { r: 'jp', c: 'スポーツ',   u: G('SPORTS') },
  { r: 'jp', c: 'エンタメ',   u: G('ENTERTAINMENT') },
  { r: 'wd', c: '国際',       u: G('WORLD') },
  { r: 'wd', c: '海外速報',   u: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },
  { r: 'wd', c: 'BBC',        u: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
];
const PER_REGION = 60;

// ---- 英語見出しの日本語訳（無料のGoogle翻訳エンドポイント。失敗時は原文のまま） ----
const isJa = (t) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(t);
const TR = { need: 0, applied: 0, errors: [] };
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
const tag = (x, name) => { const m = x.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };

export function parse(xml, f) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([x]) => {
    let t = tag(x, 'title'), s = tag(x, 'source');
    if (s && t.endsWith(' - ' + s)) t = t.slice(0, -(s.length + 3));
    else if (!s) { const m = t.match(/^(.*) - ([^-]{1,40})$/); if (m && f.u.includes('news.google')) { t = m[1]; s = m[2]; } }
    if (!s) s = f.u.includes('yahoo') ? 'Yahoo!ニュース' : f.u.includes('bbc') ? 'BBC' : '';
    const d = new Date(tag(x, 'pubDate') || tag(x, 'dc:date') || Date.now());
    return { r: f.r, c: f.c, t, s, u: tag(x, 'link'), d: isNaN(d) ? new Date().toISOString() : d.toISOString() };
  }).filter(n => n.t && n.u);
}

async function get(f) {
  try {
    const res = await fetch(f.u, { headers: { 'user-agent': 'Mozilla/5.0 NewsSquareBot' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(res.status);
    const items = parse(await res.text(), f);
    console.log(`ok  ${items.length.toString().padStart(3)}  ${f.c}`);
    return items;
  } catch (e) { console.log(`ERR ${f.c}: ${e.message}`); return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = (await Promise.all(FEEDS.map(get))).flat();
  let prev = [];
  try { prev = JSON.parse(await readFile('news.json', 'utf8')).items || []; } catch {}
  // 前回の訳を再利用（原文→訳）。新しく取った英語見出しは原文を o に退避して比較
  const cache = new Map(prev.filter((n) => n.o).map((n) => [n.o, n.t]));
  for (const n of prev) if (n.o) n.t = n.o;          // 前回分も原文に戻してから重複判定
  const seen = new Set(), out = { jp: [], wd: [] };
  for (const n of [...all, ...prev].sort((a, b) => b.d.localeCompare(a.d))) {
    const key = n.t.replace(/\s/g, '').slice(0, 40);
    if (seen.has(key) || out[n.r].length >= PER_REGION) continue;
    seen.add(key); out[n.r].push(n);
  }
  const items = [...out.jp, ...out.wd];
  await translateAll(items, cache);
  if (!all.length) { console.log('全フィード取得失敗。news.json は変更しません'); process.exit(0); }
  await writeFile('news.json', JSON.stringify({ updated: new Date().toISOString(), tr: TR, items }, null, 0) + '\n');
  console.log(`news.json: 日本 ${out.jp.length} / 世界 ${out.wd.length}`);
}
