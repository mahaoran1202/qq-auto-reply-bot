/**
 * 涩图/淫秽内容拦截。
 *
 * 触发后：
 *   1. 不回原内容（不接这个话）
 *   2. 发一组凶狠但不带脏字的警告
 *   3. 不收进表情库
 *
 * 文案可配置，默认给一套「凶狠但干净」的。
 */

/** 默认警告文案（凶狠、不脏、带点鲸鱼娘味道） */
export const DEFAULT_NSFW_REPLY = [
  '停，这东西别往我这儿发。',
  '你当我这是回收站呢？再发一张我就当没看见你这个人。',
  '自己收好，别拿出来恶心别人。'
];

/** 默认的文字淫秽警告 */
export const DEFAULT_NSFW_TEXT_REPLY = [
  '你这话说的，自己不觉得脏吗。',
  '换个话题，不然我先把你静音了。'
];

/**
 * 取警告文案（优先用配置，没有就用默认）。
 * @param {object} config
 * @param {'image'|'text'} kind
 */
export function nsfwReply(config, kind = 'image') {
  const cfg = config.bot?.nsfwFilter || {};
  const arr = kind === 'text'
    ? (Array.isArray(cfg.textReply) && cfg.textReply.length ? cfg.textReply : DEFAULT_NSFW_TEXT_REPLY)
    : (Array.isArray(cfg.reply) && cfg.reply.length ? cfg.reply : DEFAULT_NSFW_REPLY);
  return arr.filter((m) => String(m || '').trim());
}

/**
 * 记录违规次数（用于「再犯加重」）。
 * 放在内存里即可，重启清零。
 */
const strikes = new Map();

/**
 * @param {string} key 用户或群的标识
 * @returns {number} 累计违规次数
 */
export function addStrike(key) {
  const n = (strikes.get(key) || 0) + 1;
  strikes.set(key, n);
  return n;
}

export function getStrikes(key) {
  return strikes.get(key) || 0;
}

export function resetStrikes(key) {
  strikes.delete(key);
}

/**
 * 根据违规次数决定要不要「加重处理」。
 * 第 1 次：口头警告
 * 第 2 次：再警告一次 + 提示会静默
 * 第 3 次起：返回 muteMs > 0，让调用方静默这个人
 */
export function escalate(n) {
  if (n >= 3) return { muteMs: 600000, extra: ['第三次了，我静音你十分钟，自己反省。'] };
  if (n === 2) return { muteMs: 0, extra: ['又是你。再发一次我就静音你了。'] };
  return { muteMs: 0, extra: [] };
}
