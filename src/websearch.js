/**
 * 免费联网搜索（无需 API Key），按顺序尝试多个源（国内/海外都可）：
 * 1) 百度百科 lemma 卡片（国内可用）
 * 2) 必应网页搜索 cn.bing.com（国内可用）
 * 3) 中文维基百科（海外可用，作为后备）
 * 每个源独立 try/catch，失败自动跳过；全部失败返回 null。
 */
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' };
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;/g, (m) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[m] || '')).trim();

async function baike(query) {
  const r = await (await fetch(`https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(query)}`, { headers: UA })).json();
  if (r && r.title) {
    const desc = stripTags(r.description || '');
    if (desc) return `[百度百科] ${r.title}：${desc.slice(0, 400)}`;
  }
  return null;
}

async function bing(query, limit) {
  const html = await (await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=${limit}`, { headers: UA })).text();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const b of blocks.slice(0, limit)) {
    const t = b.match(/<h2[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h2>/);
    const s = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const title = t ? stripTags(t[1]) : '';
    const snip = s ? stripTags(s[1]) : '';
    if (title) out.push(`[Bing] ${title}：${snip.slice(0, 300)}`);
  }
  return out.length ? out.join('\n') : null;
}

async function wiki(query, limit) {
  const s = await (await fetch(`https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=${limit}&redirects=1`, { headers: UA })).json();
  const out = [];
  for (const t of (s.query?.search || []).slice(0, 2)) {
    const e = await (await fetch(`https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(t.title)}&format=json&utf8=1&redirects=1`, { headers: UA })).json();
    for (const p of Object.values(e.query?.pages || {})) {
      if (p.extract) out.push(`[维基百科] ${p.title}：${String(p.extract).slice(0, 400)}`);
    }
  }
  return out.length ? out.join('\n') : null;
}

export async function webSearch(query, limit = 3) {
  for (const fn of [baike, bing, wiki]) {
    try {
      const r = await fn(query, limit);
      if (r) return r;
    } catch (e) { /* 跳过该源 */ }
  }
  return null;
}
