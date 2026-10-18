/**
 * 从对话里判断「有没有值得记进小本本的事」。
 *
 * 设计要点（对应用户要求）：
 *   1. 有事才记 —— 不做定期总结，只在情绪波动/标志性事件时触发
 *   2. 绝不捏造 —— 要求 AI 附带对方原话，程序再校验原话是否真在对话里出现过
 *   3. 省钱 —— 用极小的 max_tokens，且只在一轮对话结束后跑一次
 */
import { chatWithProvider, resolveProvider } from './deepseek.js';
import { addNote, loadNotebook, saveStrategy, notebookSummary } from './notebook.js';

/** 判断用的提示词 */
const JUDGE_SYSTEM = `你是一个"值不值得记小本本"的判断器。

给你一段刚发生的对话，判断这里面有没有【值得记下来】的事。

只有下面几类才值得记（其他一律不记）：
- 记仇(grudge)：对方骂了你、开你玩笑、让你难堪、让你生气/不爽/委屈的事
- 记好(favor)：对方夸了你、帮了你、让你开心/感动的事
- 性格印象(trait)：对方表现出明显的性格特点（比如嘴毒、爱抬杠、很温柔、爱撒娇）
- 事件(event)：值得记住的具体事（比如他说要请你吃饭、他失恋了、他换了工作）

**大部分对话都不值得记。** 日常寒暄、普通问答、没有情绪起伏的闲聊，一律不记。
宁可少记，也不要记流水账。

如果值得记，严格输出一行 JSON（不要任何其他文字）：
{"kind":"类型","gist":"一句话概括","quote":"对方的原话片段","intensity":1到5的数字}

【最重要】quote 必须是对方真实说过的话，逐字照抄，不要改写、不要编。
如果找不到确切原话，就不要输出这条记录，直接输出 {} 表示不记。

不值得记就直接输出：{}`;

/** 对号主专用的判断提示词：可以记仇/委屈，但重点记「主人的偏好和要求」 */
const JUDGE_SYSTEM_OWNER = `你在帮你记「关于主人」的笔记。主人是养你的人，关系跟外人完全不同。

对主人的对话，记录这几类：
- 记好(favor)：主人夸你、对你好、让你开心的事
- 记仇(grudge)：主人骂你、凶你、让你委屈的事。**可以记**，因为你也是会委屈的，
  但这是"记着主人欠我一个说法"，不是"记恨主人"。强度照实写。
- 性格印象(trait)：主人的说话习惯、脾气、喜欢什么讨厌什么
- 事件(event)：主人交代过的事、要求、约定（比如"以后别用颜文字"、"记得提醒我"）

**对主人要记得更细一点**：主人的偏好、要求、忌讳，哪怕只是随口一说也值得记。
但纯日常寒暄（"在吗"、"吃了没"）还是不用记。

如果值得记，严格输出一行 JSON：
{"kind":"类型","gist":"一句话概括","quote":"主人的原话片段","intensity":1到5的数字}

【最重要】quote 必须是主人真实说过的话，逐字照抄，不许改写、不许编。
找不到确切原话就输出 {}。

不值得记就直接输出：{}`;

/** 类型中文名 */
const KIND_ZH = { grudge: '记仇', favor: '记好', trait: '印象', event: '事件' };

/**
 * 分析一轮对话，值得记就写进小本本。
 * @param {object} config
 * @param {string} userId 对方的 QQ 号（笔记按人存）
 * @param {{themMessages:string[], myMessages:string[], place:string, name?:string}} ctx
 * @returns {Promise<{recorded:boolean, kind?:string, gist?:string, reason?:string}>}
 */
export async function maybeTakeNote(config, userId, ctx) {
  const cfg = config.bot?.notebook || {};
  if (cfg.enabled === false) return { recorded: false, reason: 'disabled' };

  // 是不是号主？号主走另一套判断逻辑
  const ownerIds = Array.isArray(config.persona?.owner?.userIds) ? config.persona.owner.userIds.map(String) : [];
  const isOwner = config.persona?.owner?.enabled !== false && ownerIds.includes(String(userId));

  const them = (ctx.themMessages || []).filter(Boolean).slice(-4);
  const mine = (ctx.myMessages || []).filter(Boolean).slice(-3);
  if (!them.length) return { recorded: false, reason: 'no_input' };

  // 把对话拼成文本
  const who = isOwner ? '主人' : '对方';
  const convo = [
    `${who}说的：`,
    ...them.map((t) => '· ' + String(t).replace(/\n/g, ' ').slice(0, 150)),
    '',
    '你说的：',
    ...mine.map((t) => '· ' + String(t).replace(/\n/g, ' ').slice(0, 150))
  ].join('\n');

  const prov = resolveProvider(config, 'reply');
  let out;
  try {
    out = await chatWithProvider([
      { role: 'system', content: isOwner ? JUDGE_SYSTEM_OWNER : JUDGE_SYSTEM },
      { role: 'user', content: convo + `\n\n这段对话有值得记的事吗？` }
    ], { ...prov, maxTokens: 200, temperature: 0.1, timeoutMs: 25000 });
  } catch (e) {
    return { recorded: false, reason: 'llm_error: ' + e.message };
  }

  // 解析 JSON
  const text = String(out).trim();
  if (text === '{}' || text === '') return { recorded: false, reason: 'nothing' };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { recorded: false, reason: 'no_json' };

  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { recorded: false, reason: 'bad_json' }; }
  if (!parsed || !parsed.kind || !parsed.gist) return { recorded: false, reason: 'empty' };

  const kind = String(parsed.kind).trim();
  if (!['grudge', 'favor', 'trait', 'event'].includes(kind)) {
    return { recorded: false, reason: 'bad_kind' };
  }

  // ---- 防捏造：校验 quote 确实在对方说过的话里 ----
  const quote = String(parsed.quote || '').trim();
  if (cfg.requireQuote !== false) {
    if (!quote) return { recorded: false, reason: 'no_quote' };
    const hay = them.join('\n');
    // 取 quote 的前 6 个字做包含判断（AI 可能截断或加标点）
    const probe = quote.replace(/[\s"'「」『』…。，！？!?、]/g, '').slice(0, 6);
    const hayClean = hay.replace(/[\s"'「」『』…。，！？!?、]/g, '');
    if (probe.length >= 3 && !hayClean.includes(probe)) {
      console.log(`[notebook] 丢弃疑似捏造的记录：「${quote}」不在对话里`);
      return { recorded: false, reason: 'quote_not_found' };
    }
  }

  // ---- 写入 ----
  const r = addNote(userId, {
    kind,
    gist: String(parsed.gist).trim(),
    quote,
    place: ctx.place || '',
    intensity: Number(parsed.intensity) || 3
  });

  if (r.ok) {
    console.log(`[notebook] ✎ 记了一笔（${KIND_ZH[kind] || kind}）：${r.note.gist}`);
    // 记录变了，说话策略也要跟着更新（异步，不阻塞）
    refreshStrategy(config, userId).catch(() => {});
    return { recorded: true, kind, gist: r.note.gist, note: r.note };
  }
  return { recorded: false, reason: r.reason };
}

/** 策略生成的提示词（对外人） */
const STRATEGY_SYSTEM = `你根据一本"人物笔记"总结出【跟这个人说话该怎么应对】。

输出严格是一行 JSON（不要任何其他文字）：
{"summary":"一句话总结这人是谁、跟他相处要注意什么","tone":"用什么语气","doList":["该做的事1","该做的事2"],"dontList":["别做的事1","别做的事2"]}

要求：
- summary 不超过 40 字，要具体到这个人，不要空话
- tone 不超过 15 字（比如"随意带点怼""客气但保持距离"）
- doList / dontList 各 1~3 条，每条不超过 25 字
- **只能根据笔记里真实记着的事来总结**，不许编造笔记里没有的信息
- 如果笔记里大多是「记仇」，就提醒要防着点、别太热脸；
  如果大多是「记好」，就说可以亲近一点

笔记内容：`;

/** 策略生成的提示词（对号主）—— 不是"怎么应付"，而是"怎么让他满意" */
const STRATEGY_SYSTEM_OWNER = `你根据一本"关于主人的笔记"总结出【该怎么跟主人相处】。

⚠️ 这是主人，不是外人。态度基调是亲近、听话、有点小性子但不会真的对抗。

输出严格是一行 JSON（不要任何其他文字）：
{"summary":"一句话总结主人的脾性和跟主人相处要注意什么","tone":"用什么样的语气对主人","doList":["该做的事"],"dontList":["别做的事"]}

要求：
- summary 不超过 40 字，要具体到这个人
- tone 不超过 15 字（比如"亲近随意，偶尔撒个娇"）
- doList / dontList 各 1~3 条，每条不超过 25 字
- **只能根据笔记里真实记着的事来总结**，不许编造
- 重点抓：主人喜欢什么、讨厌什么、有什么要求、忌讳什么
- 如果笔记里有主人凶过你的事（记仇），不要写成"要防着主人"，
  而是写成「可以适当表达委屈/提要求，但不能回怼」这种分寸
- 绝不要出现"保持距离""别掏心掏肺""怼回去"这类对付外人的话

笔记内容：`;

/**
 * 根据某人的笔记生成/更新「说话策略」。
 * @param {object} config
 * @param {string} userId
 * @returns {Promise<{ok:boolean, strategy?:object, reason?:string}>}
 */
export async function refreshStrategy(config, userId) {
  const cfg = config.bot?.notebook || {};
  if (cfg.enabled === false || cfg.strategyEnabled === false) {
    return { ok: false, reason: 'disabled' };
  }

  const nb = loadNotebook(userId);
  // 至少要有几条记录才值得总结
  if (nb.notes.length < (cfg.strategyMinNotes ?? 2)) {
    return { ok: false, reason: 'not_enough_notes' };
  }

  const summary = notebookSummary(userId, { limit: 20 });
  if (!summary) return { ok: false, reason: 'empty' };

  // 号主用专门的提示词
  const ownerIds = Array.isArray(config.persona?.owner?.userIds) ? config.persona.owner.userIds.map(String) : [];
  const isOwner = config.persona?.owner?.enabled !== false && ownerIds.includes(String(userId));

  const prov = resolveProvider(config, 'reply');
  let out;
  try {
    out = await chatWithProvider([
      { role: 'system', content: isOwner ? STRATEGY_SYSTEM_OWNER : STRATEGY_SYSTEM },
      { role: 'user', content: summary }
    ], { ...prov, maxTokens: 300, temperature: 0.3, timeoutMs: 25000 });
  } catch (e) {
    return { ok: false, reason: 'llm_error: ' + e.message };
  }

  const m = String(out).match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: 'no_json' };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { ok: false, reason: 'bad_json' }; }
  if (!parsed?.summary) return { ok: false, reason: 'no_summary' };

  const saved = saveStrategy(userId, {
    summary: parsed.summary,
    tone: parsed.tone,
    doList: parsed.doList,
    dontList: parsed.dontList,
    basedOn: nb.notes.length
  });
  console.log(`[notebook] ↻ 更新了对这个人的说话策略：${saved.summary}`);
  return { ok: true, strategy: saved };
}
