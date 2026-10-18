/**
 * 图片分析：判断一张图「值不值得当表情包收藏」，并归到合适的情绪类。
 *
 * 一次 AI 调用同时干三件事：
 *   1. 判断是不是表情包（vs 聊天截图 / 照片 / 风景 / 长截图 / 二维码 / 无意义图）
 *   2. 给出情绪标签（从表情库已有的词里选）
 *   3. 给一句话描述
 *
 * 结果缓存到 stickers/.tags.json，同一张图不重复分析（按内容指纹）。
 *
 * 省钱做法：
 *  - 用很小的 max_tokens（判断只需要几个字）
 *  - 先用本地规则筛掉明显无意义的（极小图、纯色图、二维码尺寸特征）
 *  - 只对「大小像表情包」的图调 AI
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { chatWithProvider, resolveProvider } from './deepseek.js';

/** 判断结果类型 */
export const VERDICTS = {
  STICKER: 'sticker',     // 是表情包，值得收
  MEME: 'meme',           // 梗图，也算表情包
  SCREENSHOT: 'screenshot', // 聊天/网页截图，不收
  PHOTO: 'photo',         // 真人照片/风景，不收
  TEXT: 'text',           // 大段文字图（长图/文档），不收
  QR: 'qr',               // 二维码，不收
  JUNK: 'junk',           // 无意义（纯色/极小/乱码），不收
  NSFW: 'nsfw'            // 色情/擦边图 —— 不仅要丢，还要骂回去
};

/** 值得收藏的类型 */
const KEEP = new Set([VERDICTS.STICKER, VERDICTS.MEME]);

/** 需要「骂回去」的类型 */
export const OFFENSIVE = new Set([VERDICTS.NSFW]);

/**
 * 本地预筛：明显不值得收的直接否掉，不花 AI 的钱。
 * @returns {{skip:true, verdict:string, reason:string}|{skip:false}}
 */
export function prefilter(buf, mime = '') {
  if (!buf || buf.length < 1024) {
    return { skip: true, verdict: VERDICTS.JUNK, reason: '文件太小，不像图片' };
  }
  // 超大图一般是截图或照片
  if (buf.length > 3_000_000) {
    return { skip: true, verdict: VERDICTS.PHOTO, reason: `文件过大(${Math.round(buf.length/1024)}KB)` };
  }
  return { skip: false };
}

/** 内容指纹 */
export function fingerprint(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const ANALYZE_SYSTEM = `你看图判断它的类型。只输出一行 JSON，不要任何其他文字。

JSON 格式：{"v":"类型","tags":["情绪1","情绪2"],"desc":"画面描述"}

v 可选值（按优先级从上到下判断，先匹配到的就用它）：
- nsfw：色情、裸露、性暗示、擦边球。包括：真人裸照/半裸、性行为、露点、内裤内衣特写、明显的性暗示姿势或构图、二次元涩图/本子图/リョナ等成人内容。**从严判断**：只要画面有性意味就归这里。
- screenshot：聊天记录、网页、软件界面截图
- photo：正常的真人照片、自拍、风景、实物照（不含色情）
- text：大段文字的长图、文档、表格
- qr：二维码、条形码
- junk：纯色块、看不清、无意义
- sticker：适合当表情包的图（卡通/梗图/表情/带情绪文字的小图）
- meme：网络梗图、搞笑图

判断标准：表情包应该是**画面简单、有情绪、能用来回应聊天**的小图。
聊天截图、真人照片、风景照、二维码、文档长图都**不算**表情包。
**任何有性意味的图都判 nsfw**，宁可误判也不要漏。

tags 从这些词里选 1~2 个最贴切的（nsfw 时留空数组）：{{TAGS}}
desc 用不超过 15 个字描述画面。`;

/** 纯文本的淫秽内容检测（用于拦截文字消息） */
const TEXT_NSFW_PATTERNS = [
  /约炮|一夜情|援交|卖淫|嫖|鸡婆|包养/i,
  /裸照|裸聊|露点|自慰|手冲|撸管|口交|肛交|性交|做爱|操我|上我/i,
  /发我(?:的)?(?:裸|奶|胸|逼|屄|阴)|看看(?:你的)?(?:奶|胸|逼|屄|阴|鸡巴)/i,
  /色图|涩图|黄图|本子(?:图)?|里番|无码|有码|步兵|骑兵/i,
  /\b(?:nsfw|hentai|porn|nude|naked|xxx|18\+)\b/i,
  /(?:操|草|干|日)(?:你|死你|翻你)(?:妈|逼|屄|屁眼)/i
];

/**
 * 检测文字里有没有淫秽内容。
 * @returns {{bad:boolean, hit?:string}}
 */
export function detectNsfwText(text) {
  const s = String(text || '');
  if (!s.trim()) return { bad: false };
  for (const re of TEXT_NSFW_PATTERNS) {
    const m = s.match(re);
    if (m) return { bad: true, hit: m[0] };
  }
  return { bad: false };
}

/**
 * 用 AI 分析一张图。
 * @param {object} config
 * @param {Buffer} buf 图片二进制
 * @param {{timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, verdict:string, keep:boolean, tags:string[], desc:string}|{ok:false, reason:string}>}
 */
export async function analyzeImage(config, buf, opts = {}) {
  const pre = prefilter(buf);
  if (pre.skip) {
    return { ok: true, verdict: pre.verdict, keep: false, tags: [], desc: pre.reason, prefiltered: true };
  }

  const available = Array.isArray(config.bot?.sticker?.availableTags) && config.bot.sticker.availableTags.length
    ? config.bot.sticker.availableTags
    : ['笑死', '开心', '无语', '震惊', '生气', '委屈', '得意', '点赞', '吃瓜', '抱抱'];

  // 猜 mime
  let mime = 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
  else if (buf.slice(8, 12).toString() === 'WEBP') mime = 'image/webp';

  const prov = resolveProvider(config, 'reply');
  try {
    const out = await chatWithProvider([
      { role: 'system', content: ANALYZE_SYSTEM.replace('{{TAGS}}', available.join('、')) },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么图？按格式输出 JSON。' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
        ]
      }
    ], { ...prov, maxTokens: 120, temperature: 0.1, timeoutMs: opts.timeoutMs ?? 30000 });

    const text = String(out);
    // 宽松解析 JSON（模型可能包了 ``` 或多余文字）
    const m = text.match(/\{[\s\S]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }

    if (!parsed || !parsed.v) {
      // 解析失败时保守处理：不收（避免收进没意义的图）
      return { ok: false, reason: 'AI 返回无法解析: ' + text.slice(0, 80) };
    }

    const verdict = String(parsed.v).trim().toLowerCase();
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).trim()).filter((t) => available.includes(t)).slice(0, 2)
      : [];
    const desc = String(parsed.desc || '').trim().slice(0, 30);

    return { ok: true, verdict, keep: KEEP.has(verdict), tags, desc };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 分析并决定收不收。会写标签缓存。
 * @param {object} config
 * @param {Buffer} buf
 * @param {string} rel 相对路径（用作缓存 key）
 * @returns {Promise<{keep:boolean, verdict:string, tags:string[], desc:string, reason?:string}>}
 */
export async function analyzeAndClassify(config, buf, rel) {
  const hash = fingerprint(buf);
  const r = await analyzeImage(config, buf);

  if (!r.ok) {
    return { keep: false, verdict: 'error', tags: [], desc: '', reason: r.reason };
  }

  // 值得收的才写标签缓存
  if (r.keep) {
    try {
      const { loadTagCache, saveTagCache } = await import('./sticker-tagger.js');
      const cache = loadTagCache(config);
      if (r.tags.length || r.desc) {
        cache[rel] = { tags: r.tags, desc: r.desc || '', at: Date.now(), hash, auto: true };
        saveTagCache(config, cache);
      }
    } catch { /* 忽略缓存失败 */ }
  }

  return { keep: r.keep, verdict: r.verdict, tags: r.tags, desc: r.desc };
}
