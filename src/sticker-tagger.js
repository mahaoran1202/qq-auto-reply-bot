/**
 * 表情包自动打标签（只对新图做，已有标签的直接复用）。
 *
 * 思路：
 *  - 用 AI 看一眼图片，得出准确的情绪标签 + 一句画面描述
 *  - 结果缓存到 stickers/.tags.json，下次直接用，不重复花钱
 *  - 文件名已经带标签的图，默认不覆盖（用户自己的分类优先）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanStickers, stickerDir, EMOTION_ALIASES } from './stickers.js';
import { chatWithProvider, resolveProvider } from './deepseek.js';

const TAG_FILE = '.tags.json';

function cachePath(config) {
  return join(stickerDir(config), TAG_FILE);
}

/** 读缓存 */
export function loadTagCache(config) {
  const p = cachePath(config);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

/** 写缓存 */
export function saveTagCache(config, cache) {
  try {
    writeFileSync(cachePath(config), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[tags] 写缓存失败: ' + e.message);
  }
}

const EMOTION_LIST = Object.keys(EMOTION_ALIASES);

/**
 * 让 AI 看一张图，给出情绪标签。
 * @returns {Promise<{tags:string[], desc:string}|null>}
 */
async function askTags(config, img) {
  const { imageToDataUrl } = await import('./vision.js');
  const r = await imageToDataUrl({ file: img.file });
  if (!r.ok) return null;

  const prov = resolveProvider(config, 'reply');
  const out = await chatWithProvider([
    {
      role: 'system',
      content: [
        '你看图给表情包打标签。',
        `只能从这些情绪词里选 1~2 个最贴切的：${EMOTION_LIST.join('、')}`,
        '另外用不超过 15 个字描述画面。',
        '严格按这个格式输出，不要任何多余内容：',
        '标签：词1,词2',
        '画面：简短描述'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张表情包该打什么标签？' },
        { type: 'image_url', image_url: { url: r.dataUrl } }
      ]
    }
  ], { ...prov, maxTokens: 120, temperature: 0.2 });

  const text = String(out);
  const tagLine = text.match(/标签[：:]\s*(.+)/);
  const descLine = text.match(/画面[：:]\s*(.+)/);
  const tags = tagLine
    ? tagLine[1].split(/[,，、\s]+/).map((s) => s.trim()).filter((s) => EMOTION_LIST.includes(s))
    : [];
  return {
    tags: tags.slice(0, 2),
    desc: descLine ? descLine[1].trim().slice(0, 40) : ''
  };
}

/**
 * 给还没有标签的表情包打标签。
 * @param {object} config
 * @param {{limit?:number, log?:Function, onlyUntagged?:boolean}} opts
 */
export async function autoTagStickers(config, opts = {}) {
  const log = opts.log || console.log;
  const limit = opts.limit ?? 10;
  const onlyUntagged = opts.onlyUntagged !== false;

  const scan = scanStickers(config);
  if (!scan.count) return { ok: true, tagged: 0, reason: '表情库为空' };

  const cache = loadTagCache(config);

  // 挑出需要打标签的：没缓存的（默认还要求文件名没自带标签）
  const todo = scan.images.filter((img) => {
    if (cache[img.rel]) return false;
    if (onlyUntagged && img.tags.length) return false;
    return true;
  }).slice(0, limit);

  if (!todo.length) {
    log('[tags] 没有需要打标签的新图');
    return { ok: true, tagged: 0, reason: '无需处理' };
  }

  log(`[tags] 有 ${todo.length} 张新图需要识别，开始…`);
  let done = 0;
  for (const img of todo) {
    try {
      const r = await askTags(config, img);
      if (r && r.tags.length) {
        cache[img.rel] = { tags: r.tags, desc: r.desc, at: Date.now() };
        done++;
        log(`[tags] ${img.rel} → ${r.tags.join(',')}  (${r.desc})`);
      } else {
        log(`[tags] ${img.rel} → 没识别出标签，跳过`);
      }
    } catch (e) {
      log(`[tags] ${img.rel} 识别失败: ${e.message}`);
    }
    saveTagCache(config, cache);   // 每张都存，中断也不丢
  }

  log(`[tags] 完成，新打标签 ${done} 张`);
  return { ok: true, tagged: done };
}

/**
 * 把缓存里的 AI 标签合并进表情索引。
 * pickSticker 用得到：优先用 AI 标签（更准），没有才用文件名标签。
 */
export function applyTagCache(config, images) {
  const cache = loadTagCache(config);
  return images.map((img) => {
    const c = cache[img.rel];
    if (!c || !c.tags?.length) return img;
    // AI 标签放前面（更准），文件名标签保留在后
    const merged = [...new Set([...c.tags, ...img.tags])];
    return { ...img, tags: merged, aiTags: c.tags, aiDesc: c.desc || '' };
  });
}
