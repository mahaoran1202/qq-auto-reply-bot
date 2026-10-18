/**
 * 让 AI 真正「看见」图片。
 *
 * 实测结论：DeepSeek 的 chat 接口能接收 image_url（base64 或 http 都行），
 * 所以不用额外的视觉模型，直接把图片塞进消息里即可。
 *
 * 这个模块负责：
 *  1. 从 OneBot 给的 url / file 路径把图片拿下来
 *  2. 转成 data:image/xxx;base64
 *  3. 太大就压一下（表情包通常很小，但截图可能几 MB）
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** 允许的图片类型 → MIME */
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

/** base64 体积上限（约 3.5MB 原图），超过就放弃识别，避免请求过大 */
const MAX_BYTES = 3_500_000;

function toDataUrl(buf, mime) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 把 OneBot 图片段解析成可直接发给模型的 data URL。
 * @param {{url?:string, file?:string}} imgData OneBot 的 image 段 data
 * @returns {Promise<{ok:true, dataUrl:string, mime:string, bytes:number}|{ok:false, reason:string}>}
 */
export async function imageToDataUrl(imgData) {
  const url = imgData?.url || '';
  const file = imgData?.file || '';

  // 1) 本地路径（NapCat 有时给 file:/// 或直接给磁盘路径）
  for (const candidate of [file, url]) {
    if (!candidate) continue;
    if (candidate.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(candidate)) {
      const p = candidate.replace(/^file:\/\/\//, '').replace(/\//g, '\\');
      try {
        if (existsSync(p)) {
          const buf = readFileSync(p);
          if (buf.length > MAX_BYTES) return { ok: false, reason: `图片太大(${Math.round(buf.length/1024)}KB)` };
          const mime = MIME_BY_EXT[extname(p).toLowerCase()] || 'image/jpeg';
          return { ok: true, dataUrl: toDataUrl(buf, mime), mime, bytes: buf.length };
        }
      } catch { /* 继续尝试网络 */ }
    }
  }

  // 2) 网络地址
  const target = url || (/^https?:/.test(file) ? file : '');
  if (!target) return { ok: false, reason: '没有可用的图片地址' };

  try {
    const resp = await fetch(target, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return { ok: false, reason: `下载失败 HTTP ${resp.status}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) return { ok: false, reason: `图片太大(${Math.round(buf.length/1024)}KB)` };
    const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();
    const mime = MIME_BY_EXT[extname(new URL(target).pathname).toLowerCase()] || ct || 'image/jpeg';
    if (!mime.startsWith('image/')) return { ok: false, reason: `不是图片(${mime})` };
    return { ok: true, dataUrl: toDataUrl(buf, mime), mime, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: '下载出错: ' + e.message };
  }
}

/** 消息里所有的图片段 */
export function allImages(msg) {
  const segs = Array.isArray(msg?.message) ? msg.message : [];
  return segs.filter((s) => s.type === 'image').map((s) => s.data || {});
}

/**
 * 构造带图片的用户消息内容（OpenAI 多模态格式）。
 * @param {string} text 文字部分
 * @param {Array<{dataUrl:string}>} images 已转好的图片
 * @param {{maxImages?:number}} opts
 */
export function buildMultimodalContent(text, images, opts = {}) {
  const maxImages = opts.maxImages ?? 3;
  const picked = (images || []).slice(0, maxImages);
  if (!picked.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of picked) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  // 多模态消息至少要有个 text，否则某些实现会报错
  if (!parts.some((p) => p.type === 'text')) {
    parts.unshift({ type: 'text', text: '（看图）' });
  }
  return parts;
}

export { MAX_BYTES };
