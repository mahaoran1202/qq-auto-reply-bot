/**
 * 把 AI 的回复文本解析成「要发送的动作序列」。
 *
 * AI 会在回复里写标记：
 *   [STICKER]笑死[/STICKER]   → 从本地表情库挑一张图发出去
 *   [FACE]178[/FACE]          → 发 QQ 内置小黄脸
 *   [SEARCH]关键词[/SEARCH]   → 联网搜索（在 bot.js 里提前处理掉，不会走到这里）
 *
 * 解析结果里，文字按行拆成多条消息，表情包按出现顺序插入到对应位置。
 */

const STICKER_RE = /\[STICKER\]([\s\S]*?)\[\/STICKER\]/gi;
// 宽容匹配：模型可能写成 [FACE]178[/FACE]、[FACE]14微笑[/FACE]、[FACE]微笑[/FACE]，
// 也可能是漏了斜杠的 [FACE]178]、[FACE 178] 之类。先抓出里面的编号或名字。
const FACE_RE = /\[FACE\]\s*([^\[\]]*?)\s*\[\/FACE\]/gi;
const FACE_LOOSE_RE = /\[FACE[\]\s:：]*\s*(\d+)\s*[\]\s]*/gi;   // 容错：残缺写法

/** QQ 小黄脸名字 → 编号（模型有时会写名字而不是编号） */
const FACE_NAME_TO_ID = {
  微笑: 14, 难耐: 5, 得意: 4, 流泪: 9, 害羞: 10, 闭嘴: 12, 睡: 13, 惊吓: 16,
  偷笑: 20, 白眼: 23, 大哭: 32, 晕: 34, 吐: 39, 鼓掌: 42, 猪头: 46, 拥抱: 49,
  蛋糕: 53, 玫瑰: 63, 爱心: 66, 太阳: 74, 月亮: 75, 赞: 76, 握手: 78, 胜利: 79,
  飞吻: 85, 擦汗: 98, 嘿: 105, 可爱: 106, 憨笑: 109, 尴尬: 111, 疑问: 112,
  冷汗: 114, 抠鼻: 118, 叹气: 122, 思考: 123, ok: 124, 好: 125, 点头: 128,
  摇头: 129, 饥饿: 140, 困: 141, 吐舌: 142, 发愣: 144, 坏笑: 147, 亲亲: 148,
  生气: 149, 惊讶: 152, 耍酷: 154, 呲牙: 156, 无聊: 157, 酷: 158, 鄙视: 159,
  悠闲: 161, 大笑: 162, 惊恐: 164, 发怒: 165, 委屈: 166, 哼: 167, 可怜: 168,
  斜眼: 169, 调皮: 170, 抓狂: 176, 傲慢: 196, 流汗: 200, 色: 202, 难过: 213
};

/** 把 [FACE] 里的内容解析成编号："178" / "14微笑" / "微笑" 都能处理 */
export function parseFaceId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.match(/\d+/);
  if (digits) {
    const id = Number(digits[0]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  // 没有数字就按名字查表
  const key = s.replace(/[\s表情]/g, '');
  if (FACE_NAME_TO_ID[key]) return FACE_NAME_TO_ID[key];
  // 模糊包含
  for (const [name, id] of Object.entries(FACE_NAME_TO_ID)) {
    if (key.includes(name) || name.includes(key)) return id;
  }
  return null;
}

/**
 * 解析回复，返回动作数组。
 * @param {string} reply AI 原始回复
 * @param {(kw:string)=>object} resolveSticker 把关键词解析成具体图片的函数
 * @param {{allowSticker?:boolean, allowFace?:boolean, maxSticker?:number}} opts
 * @returns {Array<{kind:'text'|'sticker'|'face', text?:string, file?:string, faceId?:number, keyword?:string, error?:string}>}
 */
export function parseReply(reply, resolveSticker, opts = {}) {
  const allowSticker = opts.allowSticker !== false;
  const allowFace = opts.allowFace !== false;
  const maxSticker = Number.isFinite(opts.maxSticker) ? opts.maxSticker : 1;

  let text = String(reply ?? '');

  // 先剥掉推理模型的思维链（本地 qwen3 / deepseek-r1 等会输出），
  // 否则思维链里的方括号内容会污染解析。
  text = String(text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, '')
    .trim();

  // 关键预处理：模型常在标记中间插入换行（如 "[FACE]\n107]" 或 "[STICKER]\n无语\n[/STICKER]"），
  // 先把标记内部的换行和空格清掉，否则解析会失败、残渣漏进正文。
  text = text.replace(/\[\s*(STICKER|FACE|SEARCH)\s*\]/gi, (_m, tag) => `[${tag.toUpperCase()}]`);
  text = text.replace(/\[\s*\/\s*(STICKER|FACE|SEARCH)\s*\]/gi, (_m, tag) => `[/${tag.toUpperCase()}]`);
  // [FACE] 与编号之间被插入了换行
  text = text.replace(/(\[FACE\])\s*\n\s*/gi, '$1');
  text = text.replace(/(\[STICKER\])\s*\n\s*/gi, '$1');
  // 编号/关键词与闭合标签之间被插入了换行
  text = text.replace(/\n\s*(\[\/FACE\])/gi, '$1');
  text = text.replace(/\n\s*(\[\/STICKER\])/gi, '$1');

  // 把标记换成不会跟正文冲突的占位符，保住它们在文本里的位置
  const tokens = [];
  const tokenize = (re, kind) => {
    text = text.replace(re, (_m, g1) => {
      const idx = tokens.length;
      tokens.push({ kind, value: String(g1).trim() });
      return `\u0000${idx}\u0000`;
    });
  };
  tokenize(STICKER_RE, 'sticker');
  tokenize(FACE_RE, 'face');
  // 抢救被 max_tokens 截断的残缺标记：[FACE]5难耐  /  [STICKER]无语
  // （模型输出到一半被截断时很常见，里面的内容其实是有用的）
  // 必须放在宽松匹配之前，且要把整段都吃掉，否则「5难耐」里的「难耐」会漏成正文。
  text = text.replace(/\[FACE\]\s*([^\[\]]+?)\s*$/gim, (_m, g1) => {
    const idx = tokens.length;
    tokens.push({ kind: 'face', value: String(g1).trim() });
    return `\u0000${idx}\u0000`;
  });
  text = text.replace(/\[STICKER\]\s*([^\[\]]+?)\s*$/gim, (_m, g1) => {
    const idx = tokens.length;
    tokens.push({ kind: 'sticker', value: String(g1).trim() });
    return `\u0000${idx}\u0000`;
  });
  // 最后才做宽松匹配：模型写残了的 [FACE 178 之类
  tokenize(FACE_LOOSE_RE, 'face');

  // 清掉搜索标记残留（正常情况下 bot.js 已处理）
  text = text.replace(/\[SEARCH\][\s\S]*?\[\/SEARCH\]/gi, '');
  text = text.replace(/\[SEARCH\]/gi, '');
  // 清掉模型偶尔写出的其它方括号指令残留（含残缺写法）
  text = text.replace(/\[(?:STICKER|FACE)\]/gi, '');
  // 处理被 max_tokens 截断的残缺标记：[FACE]5难耐  或  [STICKER]无语
  text = text.replace(/\[\/?FACE[^\[\]]*$/gim, '');
  text = text.replace(/\[\/?STICKER[^\[\]]*$/gim, '');
  text = text.replace(/\[\/?FACE[^\[\]]*\]?/gi, '');
  text = text.replace(/\[\/?STICKER[^\[\]]*\]?/gi, '');

  // 按行切分：每行一个「片段」，行内可能夹着表情占位符
  const lines = text.split(/\r?\n/);

  const actions = [];
  let stickerUsed = 0;
  let faceUsed = 0;
  const maxFace = Number.isFinite(opts.maxFace) ? opts.maxFace : 1;

  const emitText = (s) => {
    const cleaned = s.replace(/\u0000\d+\u0000/g, '').trim();
    if (!cleaned) return;
    // 跳过模型自己写出来的纯占位说明
    if (/^[\[（(].{0,6}[\]）)]$/.test(cleaned) && cleaned.length <= 8) return;
    actions.push({ kind: 'text', text: cleaned });
  };

  for (const line of lines) {
    const parts = line.split(/(\u0000\d+\u0000)/g);
    for (const part of parts) {
      const m = part.match(/^\u0000(\d+)\u0000$/);
      if (!m) { emitText(part); continue; }
      const tok = tokens[Number(m[1])];
      if (!tok) continue;

      if (tok.kind === 'sticker') {
        // 超出限额的多余表情直接丢弃（不要留下一行空标记）
        if (!allowSticker || stickerUsed >= maxSticker) continue;
        const r = resolveSticker ? resolveSticker(tok.value) : { ok: false, reason: 'sticker disabled' };
        if (r && r.ok) {
          stickerUsed += 1;
          actions.push({ kind: 'sticker', file: r.file, rel: r.rel, keyword: tok.value });
        } else {
          actions.push({ kind: 'sticker_failed', keyword: tok.value, error: r?.reason || 'unknown' });
        }
      } else if (tok.kind === 'face') {
        if (!allowFace || faceUsed >= maxFace) continue;
        const id = parseFaceId(tok.value);
        if (id) { faceUsed += 1; actions.push({ kind: 'face', faceId: id }); }
      }
    }
  }

  // 如果整条回复只有表情没有文字，也算合法（但补一句避免空回复）
  if (!actions.length) {
    const fallback = text.replace(/\u0000\d+\u0000/g, '').trim();
    if (fallback) actions.push({ kind: 'text', text: fallback });
  }

  return actions;
}

/**
 * 检测「模型失控」的输出。
 * 表现：自言自语、大量乱码符号、重复啰嗦、承认自己在乱说、超长。
 * 这种内容绝不能发出去，宁可发一句短的正常话。
 */
export function looksUnhinged(reply) {
  const s = String(reply ?? '');
  if (!s.trim()) return { bad: true, why: '空内容' };

  // 1) 明显在自我对话/暴露失控
  const giveaway = /(模型胡乱|胡乱派生|脱角色|我人炸|我已乱|我在乱|不演了|我中插|乱码|防歪|串行|派生文|角色串|乱说正事)/;
  if (giveaway.test(s)) return { bad: true, why: '模型承认失控' };

  // 2) 大量异常符号（正常聊天不会这么密）
  const weirdCount = (s.match(/[〔〕『』【】\\/|{}=+*~^`<>\[\]∑∮⊛⊜⊝♓№※〓]/g) || []).length;
  const ratio = weirdCount / Math.max(s.length, 1);
  if (s.length > 40 && ratio > 0.14) return { bad: true, why: `异常符号过密(${Math.round(ratio*100)}%)` };

  // 3) 过长（正常人连发也不会一条上千字）
  if (s.length > 1200) return { bad: true, why: `内容过长(${s.length}字)` };

  // 4) 离谱的重复（同一小段出现很多次）
  const chunks = s.split(/[\n。！？!?]/).map((x) => x.trim()).filter((x) => x.length > 8);
  if (chunks.length > 6) {
    const counts = new Map();
    for (const c of chunks) counts.set(c, (counts.get(c) || 0) + 1);
    const max = Math.max(...counts.values());
    if (max >= 4) return { bad: true, why: `重复片段×${max}` };
  }

  // 5) 分隔线刷屏（---- ==== 这类）——包括夹在文字中间的
  const seps = (s.match(/^[\s=+\-*_—–~]{4,}$/gm) || []).length;
  if (seps >= 3) return { bad: true, why: `分隔线×${seps}` };
  const inlineSeps = (s.match(/[=+\-*_—–~]{6,}/g) || []).length;
  if (inlineSeps >= 3) return { bad: true, why: `连续符号段×${inlineSeps}` };

  return { bad: false };
}

/** 供面板/日志展示：回复里有多少个表情标记 */
export function countMarkers(reply) {
  const s = String(reply ?? '');
  return {
    stickers: (s.match(STICKER_RE) || []).length,
    faces: (s.match(FACE_RE) || []).length,
    searches: (s.match(/\[SEARCH\][\s\S]*?\[\/SEARCH\]/gi) || []).length
  };
}

/** 在发送前剥离所有标记，得到纯文本（用于记录/日志） */
export function stripMarkers(reply) {
  return String(reply ?? '')
    .replace(STICKER_RE, '')
    .replace(FACE_RE, '')
    .replace(FACE_LOOSE_RE, '')
    .replace(/\[SEARCH\][\s\S]*?\[\/SEARCH\]/gi, '')
    .replace(/\[\/?STICKER[^\[\]]*\]?/gi, '')
    .replace(/\[\/?FACE[^\[\]]*\]?/gi, '')
    .replace(/\[(?:STICKER|FACE|SEARCH)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
