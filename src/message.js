/**
 * Turn a OneBot v11 message (array of segments, or a plain string) into
 * readable plain text we can feed to an LLM.
 */

/** 把消息段数组归一化 */
function segmentsOf(message) {
  if (!message) return [];
  return Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message) } }];
}

/**
 * 提取可读文本。图片/表情会保留成占位标记，方便模型理解上下文。
 * @param {any} message
 * @param {{keepFace?:boolean}} opts keepFace=true 时保留 [表情:名] 而不是丢弃
 */
export function extractText(message, opts = {}) {
  const keepFace = !!opts.keepFace;
  let out = '';
  for (const seg of segmentsOf(message)) {
    const type = seg.type;
    const data = seg.data || {};
    if (type === 'text') {
      out += data.text || '';
    } else if (type === 'face' || type === 'emoji') {
      out += keepFace ? `[表情:${data.id ?? data.faceIndex ?? ''}]` : '';
    } else if (type === 'at') {
      out += `@${data.qq || ''} `;
    } else if (type === 'image') {
      out += '[图片]';
    } else if (type === 'record') {
      out += '[语音]';
    } else if (type === 'video') {
      out += '[视频]';
    } else if (type === 'reply') {
      // 引用回复：把被引用消息的摘要带上，AI 才知道他在回哪句
      const q = data.text || data.summary || '';
      if (q) out += `[引用:${stripCqCodes(String(q)).slice(0, 60)}] `;
    } else if (type === 'file') {
      out += `[文件:${data.name || ''}]`;
    } else if (type === 'json' || type === 'xml') {
      out += '[卡片消息]';
    } else if (type === 'forward') {
      out += '[合并转发]';
    } else {
      out += `[${type}]`;
    }
  }
  return stripCqCodes(out).replace(/[ \t]{2,}/g, ' ').trim();
}

/** Remove raw CQ codes like [CQ:image,file=xxx]. */
export function stripCqCodes(text) {
  return String(text).replace(/\[CQ:[^\]]*\]/g, '');
}

/** Build a human-readable sender label. */
export function senderLabel(msg) {
  const userId = msg.user_id ?? msg.sender?.user_id;
  const nickname = msg.sender?.card || msg.sender?.nickname || '';
  return { userId, nickname };
}

export const isPrivate = (msg) => msg.message_type === 'private';
export const isGroup = (msg) => msg.message_type === 'group';

/** 会话键：私聊用 u<id>，群聊用 g<id>，避免上下文串台 */
export function conversationKey(msg) {
  if (isGroup(msg)) return `g${msg.group_id}`;
  return `u${msg.user_id ?? msg.sender?.user_id ?? 'unknown'}`;
}

/**
 * 消息里是否 @ 了指定 QQ 号（selfId）。
 * 注意：@全体成员（qq=all）不算「单独 @我」，由 isAtAll 单独判断。
 * 同时兼容 [CQ:at,qq=xxx] 文本形式。
 */
export function isAtSelf(msg, selfId) {
  if (!selfId) return false;
  const target = String(selfId);
  for (const seg of segmentsOf(msg.message)) {
    if (seg.type === 'at') {
      const qq = String(seg.data?.qq ?? '');
      if (qq === target) return true;
    }
  }
  const raw = typeof msg.message === 'string' ? msg.message : '';
  if (raw && new RegExp(`\\[CQ:at,qq=${target}\\]`).test(raw)) return true;
  const rawMsg = typeof msg.raw_message === 'string' ? msg.raw_message : '';
  if (rawMsg && new RegExp(`\\[CQ:at,qq=${target}\\]`).test(rawMsg)) return true;
  return false;
}

/** 是否 @ 了全体成员 */
export function isAtAll(msg) {
  for (const seg of segmentsOf(msg.message)) {
    if (seg.type === 'at' && String(seg.data?.qq) === 'all') return true;
  }
  const rawMsg = typeof msg.raw_message === 'string' ? msg.raw_message : '';
  return /\[CQ:at,qq=all\]/.test(rawMsg);
}

/** 提取消息里所有被 @ 的 QQ 号 */
export function atTargets(msg) {
  const out = [];
  for (const seg of segmentsOf(msg.message)) {
    if (seg.type === 'at') out.push(String(seg.data?.qq ?? ''));
  }
  return out.filter(Boolean);
}

/** 消息里有没有图片 */
export function hasImage(msg) {
  return segmentsOf(msg.message).some((s) => s.type === 'image');
}

/** 取第一张图片（用于看图说话） */
export function firstImageUrl(msg) {
  for (const seg of segmentsOf(msg.message)) {
    if (seg.type === 'image') return seg.data?.url || seg.data?.file || '';
  }
  return '';
}

/** 群名片优先，其次昵称，最后 QQ 号 */
export function displayName(msg) {
  const { userId, nickname } = senderLabel(msg);
  return nickname || String(userId ?? '某人');
}

export { segmentsOf };
