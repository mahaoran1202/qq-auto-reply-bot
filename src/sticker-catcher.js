/**
 * 从群聊里自动抓取别人发的表情包，收进本地表情库。
 *
 * 流程：群里有人发图 → 下载 → 存到 stickers/_caught/ → 打情绪标签 → 以后自己也能发
 *
 * 防重复：用图片内容的 SHA-256 做指纹，同一张图只存一次。
 * 防自抓：机器人自己发的图不抓（否则会把自己的图又收回来）。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { stickerDir } from './stickers.js';

const HASH_FILE = '.caught-hashes.json';
/** 抓来的图放这里（相对表情库根目录） */
const CAUGHT_SUBDIR = '_自动抓取';

function caughtDir(config) {
  return join(stickerDir(config), CAUGHT_SUBDIR);
}
function hashPath(config) {
  return join(stickerDir(config), HASH_FILE);
}

/** 读指纹库 */
function loadHashes(config) {
  const p = hashPath(config);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}
function saveHashes(config, h) {
  try { writeFileSync(hashPath(config), JSON.stringify(h), 'utf8'); } catch { /* 忽略 */ }
}

/** 根据 content-type / 魔数判断图片扩展名 */
function extFromBuffer(buf, ct = '') {
  if (ct.includes('png') || (buf[0] === 0x89 && buf[1] === 0x50)) return '.png';
  if (ct.includes('gif') || (buf[0] === 0x47 && buf[1] === 0x49)) return '.gif';
  if (ct.includes('webp') || (buf.slice(8, 12).toString() === 'WEBP')) return '.webp';
  if (ct.includes('jpeg') || ct.includes('jpg') || (buf[0] === 0xFF && buf[1] === 0xD8)) return '.jpg';
  return '.png';
}

/**
 * 抓一张图存进表情库。
 * @param {object} config
 * @param {{url?:string, file?:string}} imgData OneBot 的 image 段 data
 * @param {{maxBytes?:number, source?:string}} opts
 * @returns {Promise<{ok:true, rel:string, bytes:number}|{ok:false, reason:string, skipped?:boolean}>}
 */
export async function catchSticker(config, imgData, opts = {}) {
  const maxBytes = opts.maxBytes ?? 5_000_000;

  // 1) 拿到图片二进制
  let buf = null;
  let ct = '';

  const url = imgData?.url || '';
  const file = imgData?.file || '';
  const target = url || (/^https?:/.test(file) ? file : '');

  // 本地路径优先（省一次网络请求）
  for (const cand of [file, url]) {
    if (!cand) continue;
    if (cand.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(cand)) {
      const p = cand.replace(/^file:\/\/\//, '').replace(/\//g, '\\');
      try {
        if (existsSync(p) && statSync(p).size <= maxBytes) {
          buf = readFileSync(p);
          ct = extname(p).toLowerCase();
          break;
        }
      } catch { /* 继续走网络 */ }
    }
  }

  if (!buf) {
    if (!target) return { ok: false, reason: '没有图片地址' };
    try {
      const resp = await fetch(target, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) return { ok: false, reason: `下载失败 HTTP ${resp.status}` };
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > maxBytes) return { ok: false, reason: `太大(${Math.round(ab.byteLength/1024)}KB)` };
      buf = Buffer.from(ab);
      ct = resp.headers.get('content-type') || '';
    } catch (e) {
      return { ok: false, reason: '下载出错: ' + e.message };
    }
  }

  if (!buf || buf.length < 200) return { ok: false, reason: '图片数据过小，可能不是有效图片' };

  // 2) 去重
  const hash = createHash('sha256').update(buf).digest('hex');
  const hashes = loadHashes(config);
  if (hashes[hash]) {
    return { ok: false, reason: 'already_caught', skipped: true };
  }

  // 2.5) 分类：判断值不值得收（截图/照片/二维码/无意义图直接丢弃，不占地方）
  let classification = null;
  if (opts.classify !== false) {
    try {
      const { analyzeAndClassify } = await import('./image-classifier.js');
      const cls = await analyzeAndClassify(config, buf, `${CAUGHT_SUBDIR}/pending`);
      classification = cls;
      // 色情图不仅要丢，还要让上层骂回去（这里只负责不收）
      if (cls.verdict === 'nsfw') {
        hashes[hash] = { at: Date.now(), rejected: 'nsfw', reason: cls.desc || '', bytes: buf.length };
        saveHashes(config, hashes);
        return { ok: false, reason: 'not_a_sticker:nsfw', skipped: true, verdict: 'nsfw', desc: cls.desc, nsfw: true };
      }
      if (!cls.keep) {
        // 记进指纹库，避免同一张废图反复分析（省 AI 调用）
        hashes[hash] = { at: Date.now(), rejected: cls.verdict, reason: cls.desc || '', bytes: buf.length };
        saveHashes(config, hashes);
        return { ok: false, reason: `not_a_sticker:${cls.verdict}`, skipped: true, verdict: cls.verdict, desc: cls.desc };
      }
    } catch (e) {
      // 分类失败时不拦（宁可收下也不要漏），但记日志
      opts.onLog?.(`[catch] 分类失败，仍收下: ${e.message}`);
    }
  }

  // 3) 存盘
  const dir = caughtDir(config);
  mkdirSync(dir, { recursive: true });
  const ext = extFromBuffer(buf, ct);
  const name = `${hash.slice(0, 12)}${ext}`;
  const out = join(dir, name);
  try {
    writeFileSync(out, buf);
  } catch (e) {
    return { ok: false, reason: '写文件失败: ' + e.message };
  }

  // 3.5) 分类结果落到正确的缓存 key 上（上面预分析时用的占位 key）
  if (classification && (classification.tags.length || classification.desc)) {
    try {
      const { loadTagCache, saveTagCache } = await import('./sticker-tagger.js');
      const cache = loadTagCache(config);
      delete cache[`${CAUGHT_SUBDIR}/pending`];
      cache[`${CAUGHT_SUBDIR}/${name}`] = {
        tags: classification.tags,
        desc: classification.desc || '',
        at: Date.now(),
        hash,
        auto: true
      };
      saveTagCache(config, cache);
    } catch { /* 忽略 */ }
  }

  // 4) 记指纹
  hashes[hash] = {
    at: Date.now(),
    rel: `${CAUGHT_SUBDIR}/${name}`,
    from: opts.source || '',
    bytes: buf.length,
    verdict: classification?.verdict || 'unclassified'
  };
  saveHashes(config, hashes);

  return {
    ok: true,
    rel: `${CAUGHT_SUBDIR}/${name}`,
    bytes: buf.length,
    verdict: classification?.verdict,
    tags: classification?.tags || [],
    desc: classification?.desc || ''
  };
}

/** 统计抓了多少张 */
export function caughtStats(config) {
  const dir = caughtDir(config);
  if (!existsSync(dir)) return { count: 0, bytes: 0, dir };
  let count = 0, bytes = 0;
  try {
    for (const f of readdirSync(dir)) {
      const st = statSync(join(dir, f));
      if (st.isFile()) { count++; bytes += st.size; }
    }
  } catch { /* 忽略 */ }
  return { count, bytes, dir };
}

/** 清空抓来的图（面板用） */
export function clearCaught(config) {
  const dir = caughtDir(config);
  if (!existsSync(dir)) return { ok: true, removed: 0 };
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (statSync(p).isFile()) { unlinkSync(p); removed++; } } catch { /* 忽略 */ }
    }
    const hp = hashPath(config);
    if (existsSync(hp)) writeFileSync(hp, '{}', 'utf8');
  } catch { /* 忽略 */ }
  return { ok: true, removed };
}
