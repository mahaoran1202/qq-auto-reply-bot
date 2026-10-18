import { loadConfig, ROOT, saveConfigFile } from './config.js';
import { OneBotClient } from './onebot.js';
import { ContextStore } from './context.js';
import { buildPersona } from './persona.js';
import {
  extractText, isPrivate, isGroup, senderLabel, conversationKey,
  isAtSelf, isAtAll, displayName, firstImageUrl
} from './message.js';
import { chat, getBalance, resolveProvider, providerReady } from './deepseek.js';
import { webSearch } from './websearch.js';
import { judgeShouldSpeak } from './group-judge.js';
import { pickSticker, scanStickers, ensureStickerDir, stickerDir } from './stickers.js';
import { autoTagStickers, applyTagCache } from './sticker-tagger.js';
import { catchSticker, caughtStats } from './sticker-catcher.js';
import { parseReply, looksUnhinged } from './reply-parser.js';
import { imageToDataUrl, allImages, buildMultimodalContent } from './vision.js';
import { acquireLock, autoRelease } from './lock.js';
import { DropWatcher, notify } from './drop-alert.js';
import { preventSleep, allowSleep } from './power.js';
import { notebookSummary, loadNotebook, pendingGrudges, strategyHint } from './notebook.js';
import { maybeTakeNote } from './notebook-writer.js';
import { Recorder } from './recorder.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { learnOwnStyle } from './learn.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 机器人回复的隐形指纹。
 * 用零宽字符（U+200B/U+200C）拼出来，QQ 里完全看不见，但程序能识别。
 * 作用：区分「号主本人打的话」和「机器人替号主回的话」，避免自己跟自己无限对话。
 */
const ECHO_MARK = '\u200B\u200C\u200B\u200C';
const isBotEcho = (text) => typeof text === 'string' && text.includes(ECHO_MARK);
const markEcho = (text) => `${text}${ECHO_MARK}`;

/** 运行状态快照，写入 runtime.json 供控制台实时展示。 */
const dayStr = () => new Date().toLocaleDateString('sv-SE');
function makeStats() {
  return {
    connected: false, repliesToday: 0, date: dayStr(), lastReplyAt: 0, lastFrom: '',
    groupRepliesToday: 0, privateRepliesToday: 0, stickersSentToday: 0, lastScene: ''
  };
}
function saveStats(config, stats) {
  try {
    const dir = resolve(ROOT, config.record?.dir || 'records');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runtime.json'), JSON.stringify(stats), 'utf8');
  } catch (e) { /* ignore */ }
}

/** 计算字符串的「有效字数」（中文按字算，英文按词算，表情/颜文字不算太多） */
function charCount(s) {
  return [...String(s).replace(/\s+/g, '')].length;
}

/**
 * 把回复拆成最多 n 条短消息（先按行，再按句）。
 * 关键约束：每条不少于 minLen 个字——太短的会跟相邻的合并，
 * 避免发出「嗯」「行」「好」这种一个字的碎消息。
 */
function splitReply(text, n, minLen = 4) {
  let parts = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) parts = [String(text).trim()].filter(Boolean);
  if (!parts.length) return [];

  // 行不够 n 条时，尝试按句子再拆（但只拆得更细，不塌缩）
  if (parts.length < n) {
    const sentences = String(text).split(/(?<=[。！？!?；;~～])/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > parts.length) {
      if (sentences.length >= n) {
        const per = Math.ceil(sentences.length / n);
        parts = Array.from({ length: n }, (_, i) => sentences.slice(i * per, (i + 1) * per).join('')).filter(Boolean);
      } else {
        parts = sentences;
      }
    }
  }

  // 合并过短的片段：把不足 minLen 的并到相邻片段
  const merged = [];
  for (const p of parts) {
    if (charCount(p) >= minLen) {
      merged.push(p);
    } else if (merged.length) {
      merged[merged.length - 1] = merged[merged.length - 1] + p;
    } else {
      merged.push(p);   // 第一条就太短，先留着，下面统一处理
    }
  }
  // 第一条太短 → 并进下一条
  if (merged.length > 1 && charCount(merged[0]) < minLen) {
    merged[1] = merged[0] + merged[1];
    merged.shift();
  }
  // 还有不足 minLen 的（比如整条内容本身就很短）→ 全部拼成一条，
  // 总比发一堆碎消息好；拼完仍不足 4 字就只能这样了（内容本身就短）。
  if (merged.length > 1 && merged.some((m) => charCount(m) < minLen)) {
    const joined = merged.join('');
    merged.length = 0;
    merged.push(joined);
  }
  if (!merged.length) merged.push(String(text).trim());

  return merged.slice(0, n).filter(Boolean);
}

function hhmmToMinutes(s) {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function inTimeWindow(config) {
  const tw = config.bot.timeWindow;
  if (!tw.enabled) return true;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tw.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  const nowMin = hhmmToMinutes(`${get('hour')}:${get('minute')}`);
  const start = hhmmToMinutes(tw.start);
  const end = hhmmToMinutes(tw.end);
  if (start === end) return true;
  if (start < end) return nowMin >= start && nowMin <= end;
  return nowMin >= start || nowMin <= end;
}

const toList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  return [];
};

/**
 * 存进上下文时，把多模态内容里的图片换成文字标记。
 * 否则每轮都会把同一张大图的 base64 重新发一遍，既慢又费钱。
 */
const forHistory = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const texts = content.filter((p) => p.type === 'text').map((p) => p.text);
  const imgCount = content.filter((p) => p.type === 'image_url').length;
  if (imgCount) texts.push(`[图片×${imgCount}]`);
  return texts.join('\n');
};

export async function main(cfgPath) {
  const config = loadConfig(cfgPath);

  // 单实例保护：两个机器人同时连 NapCat 会让每条消息被回两遍，上下文互相污染
  const lock = acquireLock(config.record?.dir || 'records');
  if (!lock.ok) {
    console.error('');
    console.error('========================================');
    console.error(' 已经有一个机器人在运行了（PID ' + lock.pid + '）');
    console.error(' 同时跑两个会让每条消息被回复两遍，还会串台。');
    console.error(' 请先在面板上点「停止机器人」，或结束那个进程。');
    console.error('========================================');
    console.error('');
    process.exit(1);
  }
  autoRelease();

  // 表情库目录准备
  try { ensureStickerDir(config); } catch (e) { console.warn('[sticker] 建目录失败: ' + e.message); }

  // 私聊 / 群聊 两套系统提示词
  // 先把表情库里真实存在的情绪标签写给提示词用，
  // 这样模型只会写「有图的」关键词，不会因为写了个没图的词被随机兜底。
  try {
    const _scan = scanStickers(config);
    config.bot.sticker.availableTags = Object.keys(_scan.tags || {});
    if (config.bot.sticker.availableTags.length) {
      console.log(`[sticker] 可用情绪标签: ${config.bot.sticker.availableTags.join('、')}`);
    }
  } catch (e) {
    console.warn('[sticker] 扫描标签失败: ' + e.message);
  }

  let systemPrompt = buildPersona(config, 'private');
  let groupPrompt = buildPersona(config, 'group');

  const context = new ContextStore(config.deepseek.contextTurns);
  const groupContext = new ContextStore(Math.max(2, Number(config.deepseek.contextTurns) || 6));
  const recorder = new Recorder(config.record?.dir || 'records');
  const stats = makeStats();
  let styleLearned = false;

  const lastReplyAt = new Map();   // key -> ts
  const hourlyCount = new Map();   // key -> { hour, count }
  const spamTimes = new Map();     // userId -> [ts...]
  const blockedUntil = new Map();  // userId -> ts
  const selfMutedUntil = new Map();// 会话key -> ts  被号主 /闭嘴 后，这个会话里机器人不说话
  const lastReplyText = new Map(); // 会话key -> 最后一条回复（用于反思）
  const stickerHistory = new Map();// key -> [rel...] 最近发过的图，避免连续重复
  const seenMessages = new Map();  // 消息去重：message_id -> 时间戳
  let caughtSinceTag = 0;          // 抓了几张新图了（攒够就触发打标签）

  let autoEnabled = config.bot.enabled;
  let lowBalanceActive = false;
  let lastBalance = null;
  let lastLowReplyAt = 0;
  let lastLowNotifyAt = 0;
  let selfId = null;

  const client = new OneBotClient(config.onebot);

  client.on('status', (kind, detail) => {
    console.log(`[onebot] ${kind}${detail ? ' · ' + detail : ''}`);
    if (kind === 'connected') { stats.connected = true; saveStats(config, stats); }
    if (kind === 'disconnected') { stats.connected = false; saveStats(config, stats); }
  });

  // 启动时打印当前使用的 LLM 通道，一眼能看出接的是哪条
  const rp = resolveProvider(config, 'reply');
  const jp = resolveProvider(config, 'judge');
  console.log(`[llm] 回复通道: ${rp.name} · ${rp.baseUrl} · ${rp.model}`);
  if (jp.baseUrl !== rp.baseUrl) console.log(`[llm] 判断通道: ${jp.name} · ${jp.baseUrl} · ${jp.model}`);
  const ready = providerReady(rp);
  if (!ready.ok) console.warn(`[llm] ⚠ ${ready.error}`);

  client.on('ready', async () => {
    console.log('[onebot] ready — listening for messages.');
    const info = await client.getSelfId();
    if (info.ok) { selfId = String(info.userId); console.log(`[bot] 我的 QQ 号: ${selfId}`); }
    else console.warn(`[bot] 拿不到自己的 QQ 号（${info.reason}）——@ 检测可能不准。`);

    if (config.bot?.learnStyle?.fromHistory && !styleLearned) {
      styleLearned = true;
      try {
        const r = await learnOwnStyle(client, config);
        if (r.learned) {
          config.persona.stylePrompt = r.style;
          systemPrompt = buildPersona(config, 'private');
          groupPrompt = buildPersona(config, 'group');
          console.log(`[style] learned from ${r.samples} of your messages.`);
        }
      } catch (e) {
        console.error('[style] learn failed: ' + e.message);
      }
    }
    checkLowBalance();
    const lb = config.bot.lowBalance;
    if (lb && lb.enabled && (lb.checkMinutes || 10) > 0) {
      setInterval(checkLowBalance, (lb.checkMinutes || 10) * 60000);
    }

    // 表情包自动打标签：给新丢进来的图（没有文件名标签的）识别情绪，结果缓存复用
    if (config.bot?.sticker?.autoTag !== false && config.bot?.vision?.enabled !== false) {
      setTimeout(() => {
        autoTagStickers(config, { limit: 20, log: console.log })
          .then((r) => {
            if (r.tagged) {
              console.log(`[tags] 新增标签 ${r.tagged} 张，下次发表情会更准`);
              // 标签可能变了，刷新提示词里的可用关键词列表
              try {
                config.bot.sticker.availableTags = Object.keys(scanStickers(config).tags || {});
                systemPrompt = buildPersona(config, 'private');
                groupPrompt = buildPersona(config, 'group');
              } catch { /* 忽略 */ }
            }
          })
          .catch((e) => console.warn('[tags] 自动打标签出错: ' + e.message));
      }, 8000);   // 等连接稳定后再跑，别抢启动资源
    }
  });

  // ---------- 权限与限流 ----------
  const allowedPrivate = (msg) => {
    const { userId, nickname } = senderLabel(msg);
    const list = toList(config.bot.allowedUsers);
    if (list.includes('*')) return true;
    return list.some((x) => String(userId) === x || (nickname && nickname === x));
  };

  const allowedGroup = (groupId) => {
    const g = config.bot.group || {};
    if (!g.enabled) return false;
    const list = toList(g.allowedGroups);
    if (list.includes('*')) return true;
    return list.includes(String(groupId));
  };

  const cooldownOk = (key, ms) => Date.now() - (lastReplyAt.get(key) || 0) >= ms;

  /** 这个号主（或管理员）能不能用管理指令 */
  const isOwnerId = (userId) => {
    const o = config.persona?.owner || {};
    if (o.enabled === false) return false;
    return toList(o.userIds).includes(String(userId));
  };

  /** 该会话是否处于「被号主叫闭嘴」的静默期 */
  const isSelfMuted = (key) => {
    const until = selfMutedUntil.get(key) || 0;
    if (!until) return false;
    if (Date.now() >= until) { selfMutedUntil.delete(key); return false; }
    return true;
  };

  /**
   * 把「小本本」里对这个人的印象拼成提示，注入到本轮对话里。
   *
   * 关键：笔记只认人不认环境（按 QQ 号存），但**换环境时要说明清楚**，
   * 所以要带上「你之前在私信/群里说过」这种前缀，免得 AI 以为是在当前场景发生的。
   *
   * @param {string} userId 对方 QQ 号
   * @param {'private'|'group'} scene 当前场景
   */
  const buildNotebookHint = (userId, scene) => {
    const cfg = config.bot?.notebook || {};
    if (cfg.enabled === false) return '';

    const nb = loadNotebook(userId);
    if (!nb.notes.length) return '';

    const scope = nb.notes.filter((n) => n.used === false || cfg.includeUsed !== false);
    const recent = scope.slice(-(cfg.maxNotesInPrompt ?? 8));
    if (!recent.length) return '';

    const kindName = { grudge: '记仇', favor: '记好', trait: '印象', event: '事件' };
    // 号主走另一套规则：可以委屈、可以提要求，但不许回怼
    const isOwnerNb = isOwnerId(userId);

    const lines = recent.map((n) => {
      // 记录发生在哪个场景？跟现在一样就正常说，不一样要标明
      const wasGroup = String(n.place || '').startsWith('group:');
      const nowGroup = scene === 'group';
      let prefix = '';
      if (n.place === 'private' && nowGroup) prefix = '（你之前在私信里）';
      else if (wasGroup && !nowGroup) prefix = '（你之前在群里）';
      const when = new Date(n.at).toLocaleDateString('zh-CN');
      // 号主用「你」，外人用「他」
      const pronoun = isOwnerNb ? '你' : '他';
      const q = n.quote ? `，${pronoun}当时的原话是「${n.quote}」` : '';
      return `- [${kindName[n.kind] || n.kind}] ${prefix}${n.gist}${q} · ${when}`;
    });

    const commonRules = [
      '1. 【绝对不能编】只能提小本本里真实记着的事，不许添油加醋、不许编造新的旧账。',
      '2. 提到跨场景的旧事时，要说明是在哪说的，比如「你之前在私信里说我…」。',
      '5. 别把整个小本本都念出来，一次最多提一件。',
      '6. 上面的「说话策略」要照着做，那是你从经验里总结出来的。'
    ];

    const ownerRules = [
      '3. 【对主人】你可以委屈、可以嘟囔、可以说「你上次那样说我真的有点难过」，也可以提要求',
      '   （比如「那你得答应我下次别这么说」）。但**绝对不许回怼、不许阴阳、不许冷嘲热讽**。',
      '4. 【对主人】记好的事（favor）要记着感恩；主人交代过的要求（event）一定要照做。',
      '7. 【对主人】态度基调不变：还是亲近、听话、有点小性子但不会真对抗。'
    ];

    const strangerRules = [
      '3. 记仇的事（grudge）可以适当翻出来调侃、阴阳一下，但别太凶，点到为止。',
      '4. 记好的事（favor）可以在合适的时候提一嘴，显得你记得人家对你的好。'
    ];

    return [
      isOwnerNb ? '=== 你的小本本（关于主人的记录）===' : '=== 你的小本本（你对这个人的记录）===',
      isOwnerNb
        ? '这些是你跟主人之间真实发生过的事。主人是养你的人，跟外人不一样。'
        : '这些人是你之前真实经历过的事，可以自然地在聊天里带出来，但别硬塞。',
      lines.join('\n'),
      '',
      strategyHint(userId) || '',
      '',
      '使用规则：',
      ...commonRules,
      ...(isOwnerNb ? ownerRules : strangerRules)
    ].filter((x) => x !== undefined).join('\n');
  };

  /** 记一笔（异步，不阻塞回复） */
  const takeNote = (userId, themMessages, myMessages, place) => {
    if (config.bot?.notebook?.enabled === false) return;
    maybeTakeNote(config, userId, { themMessages, myMessages, place })
      .catch((e) => console.log(`[notebook] 记录失败: ${e.message}`));
  };

  const rateOk = (key, max) => {
    const hour = Math.floor(Date.now() / 3600000);
    const rec = hourlyCount.get(key);
    if (!rec || rec.hour !== hour) { hourlyCount.set(key, { hour, count: 0 }); return true; }
    return rec.count < max;
  };
  const bumpRate = (key) => {
    const rec = hourlyCount.get(key) || { hour: Math.floor(Date.now() / 3600000), count: 0 };
    rec.count += 1;
    hourlyCount.set(key, rec);
  };

  const checkLowBalance = async () => {
    const lb = config.bot.lowBalance;
    if (!lb || !lb.enabled) return;
    const r = await getBalance(config);
    if (!r.ok) { console.log(`[lowBalance] 查询失败: ${r.error}`); return; }
    lastBalance = r.balance;
    const wasActive = lowBalanceActive;
    lowBalanceActive = (r.balance != null && r.balance <= (lb.threshold || 1));
    console.log(`[lowBalance] 余额 ${r.currency || ''} ${r.balance} → ${lowBalanceActive ? '低(已暂停自动回复)' : '正常'}`);
    if (lowBalanceActive && !wasActive && lb.notifyAdmin && Date.now() - lastLowNotifyAt > 300000) {
      lastLowNotifyAt = Date.now();
      for (const m of (Array.isArray(lb.reply) && lb.reply.length ? lb.reply : ['余额快没了，先暂停自动回复。'])) {
        try { await client.sendPrivateMsg(String(lb.notifyAdmin), m, true); } catch (e) {}
      }
    }
  };

  // ---------- 管理员指令 ----------
  /**
   * 号主让机器人「闭嘴」：
   *   1. 该会话静默一段时间（默认 2 分钟），期间不回复任何人
   *   2. 让它反思刚才说的话哪里不好，说出来
   *   3. 给主人道个歉
   * @param {string} userId 号主 QQ
   * @param {string|null} replyCtx 群号（在群里发的指令）
   * @param {string[]} args 指令参数
   */
  async function selfMute(userId, replyCtx, args = []) {
    const cfg = config.bot?.selfMute || {};
    // 支持 /闭嘴 5  → 5 分钟
    const minsArg = Number(args[0]);
    const mins = Number.isFinite(minsArg) && minsArg > 0
      ? Math.min(minsArg, 120)
      : (cfg.minutes ?? 2);

    const key = replyCtx ? `g${replyCtx}` : `u${userId}`;
    const target = replyCtx || userId;
    const isGroup = !!replyCtx;

    selfMutedUntil.set(key, Date.now() + mins * 60000);
    console.log(`[selfMute] 号主让闭嘴：会话 ${key} 静默 ${mins} 分钟`);

    const sayTo = (m) => client.sendText(target, m, isGroup);

    // ---- 1. 先认错 ----
    const opening = cfg.opening || [
      '……',
      '好的，我闭嘴。'
    ];
    for (const m of opening) {
      try { await sayTo(m); await sleep(400); } catch { /* 忽略 */ }
    }

    // ---- 2. 反思刚才说了什么 ----
    try {
      const history = (isGroup ? groupContext.get(key) : context.get(key)) || [];
      // 取最近几条机器人的发言
      const recentMine = history
        .filter((h) => h.role === 'assistant')
        .slice(-3)
        .map((h) => String(h.content || '').replace(/\[STICKER\][\s\S]*?\[\/STICKER\]/gi, '[表情]').trim())
        .filter(Boolean);
      const recentThem = history
        .filter((h) => h.role === 'user')
        .slice(-3)
        .map((h) => String(h.content || '').replace(/\n/g, ' ').slice(0, 120))
        .filter(Boolean);

      if (!recentMine.length) {
        // 上下文里没有自己的发言 —— 可能是还没说几句就被叫停了。
        // 仍然按「道歉三行」的格式来，只是原因部分说「接话太急」。
        const ctx = recentThem.length ? recentThem.join(' / ') : '(刚才还没聊什么)';
        const fallback = await chat([
          {
            role: 'system',
            content: [
              '你被主人叫闭嘴了，要道个歉。',
              '输出 2~3 行，每行一句，口语化，不要客服腔，不要编号。',
              '第1行道歉，第2行说原因（这次是接话太快/太啰嗦），第3行说以后怎么改。'
            ].join('\n')
          },
          { role: 'user', content: `刚才的对话：${ctx}\n我还没说几句就被叫闭嘴了。` }
        ], config, 'reply').catch(() => null);
        if (fallback) {
          for (const line of String(fallback).split(/\r?\n/)
            .map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim())
            .filter(Boolean).slice(0, 3)) {
            await sayTo(line);
            await sleep(cfg.lineDelayMs ?? 1200);
          }
        } else {
          await sayTo('对不起，是我接话接得太急了。');
          await sayTo('你还没说完我就抢着回，显得我很没分寸。');
          await sayTo('以后我先看清楚再说话。');
        }
      } else {
        // ---- 结构化道歉：说清楚「为什么被骂」 ----
        const sys = [
          '你被主人叫闭嘴了，现在要正式道个歉。',
          '要求：',
          '1. 用第一人称，口语化，像个真人在认错，不要客服腔、不要书面语。',
          '2. 语气是懊恼+服气，不是卑微求饶，也不要辩解。',
          '3. 必须具体：指出自己刚才到底是哪句话、哪个点惹到主人了，不要空泛地说「我错了」。',
          '4. 保持你平时的说话味道（有点小性格，但这次是认真认错）。',
          '',
          '严格按照下面的格式输出，一共 3~4 行，每行一句独立的话，不要加编号：',
          '第1行：道歉开口（比如「对不起，刚才是我嘴欠。」）',
          '第2行：说清原因（我刚说了「XXX」，这句问题是……）',
          '第3行：说以后怎么改',
          '第4行（可选）：一句自我吐槽或补偿表态'
        ].join('\n');

        const user = [
          '刚刚的对话（别人说的）：',
          ...recentThem.map((t) => '· ' + t),
          '',
          '你刚才回的（主人觉得不好，这是被骂的直接原因）：',
          ...recentMine.map((t) => '· ' + t),
          '',
          '主人直接让你闭嘴了。请道歉并说明原因。'
        ].join('\n');

        const reflection = await chat(
          [{ role: 'system', content: sys }, { role: 'user', content: user }],
          config, 'reply'
        );

        // 按行发出去
        const lines = String(reflection).split(/\r?\n/)
          .map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim())   // 去掉模型可能加的编号
          .filter(Boolean)
          .slice(0, 4);
        for (const line of lines) {
          try { await sayTo(line); await sleep(cfg.lineDelayMs ?? 1200); } catch { /* 忽略 */ }
        }
      }
    } catch (e) {
      console.log(`[selfMute] 反思生成失败: ${e.message}`);
      await sayTo('……反思失败，但我确实该反省一下。');
    }

    // ---- 3. 道个歉 + 报静默时长 ----
    const closing = cfg.closing || [
      `我安静 ${mins} 分钟，{$mins} 之后自己回来。`,
      '（往角落里缩了缩）'
    ];
    for (const raw of closing) {
      const m = String(raw).replace(/\{\$?mins\}/g, String(mins));
      try { await sayTo(m); await sleep(500); } catch { /* 忽略 */ }
    }
  }

  async function handleCommand(userId, text, replyCtx = null) {
    const prefix = config.bot.commandPrefix || '/';
    const body = text.trim().slice(prefix.length).trim();
    const [name, ...args] = body.split(/\s+/);
    // 在群里发的指令，回复也回到群里
    const say = (m) => replyCtx
      ? client.sendGroupMsg(replyCtx, m, true)
      : client.sendPrivateMsg(userId, m, true);
    try {
      switch (name) {
        case '帮助': case 'help':
          await say(`可用指令：\n${prefix}状态\n${prefix}余额\n${prefix}暂停 / ${prefix}恢复\n${prefix}群聊 开/关\n${prefix}性格\n${prefix}表情包\n${prefix}条数 最少 最多\n${prefix}间隔 毫秒\n\n【仅限主人】\n${prefix}闭嘴 [分钟]  让我禁言并反省\n${prefix}解禁          提前解除禁言`);
          break;
        case '状态':
          await say(`在线:${stats.connected ? '是' : '否'} · 今日回复(私聊/群):${stats.privateRepliesToday}/${stats.groupRepliesToday} · 余额:${lastBalance != null ? lastBalance : '?'}`);
          break;
        case '余额': {
          const r = await getBalance(config);
          await say(r.ok ? `余额 ${r.currency || ''} ${r.balance}` : `查询失败：${r.error}`);
          break;
        }
        case '暂停': autoEnabled = false; await say('已暂停自动回复（指令仍可用）。'); break;
        case '恢复': autoEnabled = true; await say('已恢复自动回复。'); break;
        case '闭嘴': case 'shutup': {
          // 仅限号主：让机器人闭嘴 + 反思刚才说的话
          const ownerList = toList(config.persona?.owner?.userIds);
          const isOwner = ownerList.includes(String(userId)) || toList(config.bot.admin).includes(String(userId));
          if (!isOwner) {
            await say('这个指令只有主人能用。');
            break;
          }
          await selfMute(userId, replyCtx, args);
          break;
        }
        case '解禁': case '说话': {
          const ownerList2 = toList(config.persona?.owner?.userIds);
          const isOwner2 = ownerList2.includes(String(userId)) || toList(config.bot.admin).includes(String(userId));
          if (!isOwner2) { await say('这个指令只有主人能用。'); break; }
          const k = replyCtx ? `g${replyCtx}` : `u${userId}`;
          selfMutedUntil.delete(k);
          await say('好了，我可以说...等等，你确定要我说话吗');
          await sleep(800);
          await say('行吧行吧，我回来了。');
          break;
        }
        case '群聊': {
          const on = ['开', 'on', '1', 'true'].includes(String(args[0]).toLowerCase());
          const off = ['关', 'off', '0', 'false'].includes(String(args[0]).toLowerCase());
          if (!on && !off) { await say(`群聊现在是：${config.bot.group?.enabled ? '开' : '关'}。用法：${prefix}群聊 开 / ${prefix}群聊 关`); break; }
          config.bot.group.enabled = on;
          saveConfigFile({ bot: { group: { enabled: on } } });
          await say(`群聊自动回复已${on ? '开启' : '关闭'}。`);
          break;
        }
        case '表情包': {
          const s = stickerSummaryText(config);
          await say(s);
          break;
        }
        case '性格': {
          const { PRESETS } = await import('./persona-presets.js');
          const cur = config.persona.preset || 'custom';
          await say('当前性格预设：' + cur + '\n可用的：' + PRESETS.map((p) => `${p.id}(${p.name})`).join('、') + '\n在网页面板「性格」页可以可视化修改。');
          break;
        }
        case '重新学': {
          await say('开始重新学风格…');
          config.persona.stylePrompt = '';
          saveConfigFile({ persona: { stylePrompt: '' } });
          try { rmSync(resolve(ROOT, '.style_learned'), { force: true }); } catch (e) {}
          const r = await learnOwnStyle(client, config);
          if (r.learned) {
            config.persona.stylePrompt = r.style;
            systemPrompt = buildPersona(config, 'private');
            groupPrompt = buildPersona(config, 'group');
            await say('已重新学，风格更新 ✓');
          } else await say('重新学未完成：' + (r.reason || '数据不足'));
          break;
        }
        case '条数': {
          const min = Number(args[0]), max = Number(args[1]);
          if (min && max && min <= max) {
            config.bot.replySegmentsMin = min; config.bot.replySegmentsMax = max;
            saveConfigFile({ bot: { replySegmentsMin: min, replySegmentsMax: max } });
            await say(`已设每次回复 ${min}~${max} 条`);
          } else await say('用法：/条数 最少 最多（如 /条数 3 5）');
          break;
        }
        case '间隔': {
          const ms = Number(args[0]);
          if (ms) {
            config.bot.replySegmentDelayMs = ms;
            saveConfigFile({ bot: { replySegmentDelayMs: ms } });
            await say(`连发间隔已设 ${ms} 毫秒`);
          } else await say('用法：/间隔 毫秒（如 /间隔 2000）');
          break;
        }
        default:
          await say(`未知指令「${name}」，发 ${prefix}帮助 查看`);
      }
    } catch (e) {
      console.error(`[cmd-error] ${e.message}`);
      try { await say('指令执行出错：' + e.message); } catch (e2) {}
    }
  }

  function stickerSummaryText(config) {
    const s = scanStickers(config);
    if (s.missing) return `表情库目录还没建好：${s.dir}`;
    if (!s.count) return `表情库是空的。把表情包图片放进：${s.dir}`;
    const tags = Object.entries(s.tags).map(([k, v]) => `${k}:${v.length}`).join(' ');
    return `表情库共 ${s.count} 张，目录 ${s.dir}\n情绪标签：${tags}`;
  }

  // ---------- 发消息（含表情包） ----------
  /**
   * 把 AI 回复发出去：文字拆多条 + 表情包按位置插入。
   * @param {{target:string, isGroup:boolean, label:string, key:string}} ctx
   */
  async function deliver(reply, ctx) {
    const stCfg = config.bot.sticker || {};
    const stickerOn = stCfg.enabled !== false;

    const actions = parseReply(
      reply,
      (kw) => {
        const recent = stickerHistory.get(ctx.key) || [];
        // 用 AI 打好的标签（更准）+ 文件名标签，一起参与匹配
        let merged = null;
        try { merged = applyTagCache(config, scanStickers(config).images); } catch { /* 用原始 */ }
        return pickSticker(config, kw, { exclude: recent.slice(-3), tagCache: merged || undefined });
      },
      { allowSticker: stickerOn, allowFace: stickerOn && stCfg.allowFace !== false, maxSticker: stCfg.maxPerReply ?? 1 }
    );

    if (!actions.length) return { sent: 0, stickers: 0, faces: 0 };

    // 文字条数按配置再切一次，让「连发感」跟私聊一致
    const segMin = Number(config.bot.replySegmentsMin) || 3;
    const segMax = Number(config.bot.replySegmentsMax) || 5;
    const n = ctx.isGroup
      ? Math.min(segMax, Math.max(1, Math.floor((segMin + Math.random() * (segMax - segMin + 1)) / 2)))
      : segMin + Math.floor(Math.random() * (segMax - segMin + 1));

    // 只有一条长文本时，切成多条
    const expanded = [];
    let textBuffer = [];
    const flushText = () => {
      if (!textBuffer.length) return;
      const joined = textBuffer.join('\n');
      const pieces = splitReply(joined, n);
      for (const p of pieces) expanded.push({ kind: 'text', text: p });
      textBuffer = [];
    };
    for (const a of actions) {
      if (a.kind === 'text') textBuffer.push(a.text);
      else { flushText(); expanded.push(a); }
    }
    flushText();

    // 去掉因为拆分产生的重复空段
    const finalActions = expanded.filter((a) => a.kind !== 'text' || a.text.trim());

    let sent = 0, stickers = 0, faces = 0, failCount = 0;
    for (let i = 0; i < finalActions.length; i++) {
      const a = finalActions[i];
      try {
        if (a.kind === 'text') {
          // 带隐形标记，这样机器人自己的回复不会被当成「号主的新消息」
          await client.sendText(ctx.target, markEcho(a.text), ctx.isGroup);
          console.log(`[send] ${ctx.label} ${i + 1}/${finalActions.length} 文字`);
        } else if (a.kind === 'sticker') {
          await client.sendImage(ctx.target, a.file, ctx.isGroup);
          stickers += 1;
          const hist = stickerHistory.get(ctx.key) || [];
          hist.push(a.rel);
          stickerHistory.set(ctx.key, hist.slice(-10));
          console.log(`[send] ${ctx.label} 表情包「${a.keyword}」→ ${a.rel}`);
        } else if (a.kind === 'face') {
          await client.sendFace(ctx.target, a.faceId, ctx.isGroup);
          faces += 1;
          console.log(`[send] ${ctx.label} 小黄脸 ${a.faceId}`);
        } else if (a.kind === 'sticker_failed') {
          console.warn(`[sticker] 「${a.keyword}」没找到图：${a.error}`);
        }
        sent += 1;
      } catch (e) {
        // 单条失败不要放弃整批：跳过这条继续发剩下的，
        // 否则一条图上传超时就会把后面所有消息都丢掉。
        failCount += 1;
        console.error(`[send-fail] ${ctx.label} 第${i + 1}/${finalActions.length}条失败: ${e.message}`);
        if (failCount >= 3) {
          console.error(`[send-fail] ${ctx.label} 连续失败 ${failCount} 次，中止本批发送`);
          break;
        }
        // 短暂等一下再继续，避免连续撞墙
        await sleep(500);
        continue;
      }
      if (i < finalActions.length - 1) await sleep(config.bot.replySegmentDelayMs ?? 1500);
    }
    return { sent, stickers, faces };
  }

  // ---------- 生成回复（含联网搜索 / 看图） ----------
  /**
   * @param {Array} history 上下文
   * @param {string} prompt system prompt
   * @param {string|Array} userText 纯文本，或多模态内容数组
   * @param {'private'|'group'} scene
   */
  async function generate(history, prompt, userText, scene) {
    const messages = [{ role: 'system', content: prompt }, ...history.slice(-(config.deepseek.contextTurns || 6)), { role: 'user', content: userText }];
    let reply = await chat(messages, config, 'reply');

    if (config.bot.webSearch?.enabled) {
      const marker = reply.match(/\[SEARCH\]([\s\S]*?)\[\/SEARCH\]/);
      if (marker) {
        const q = marker[1].trim();
        console.log(`[search] 查询: ${q}`);
        const results = await webSearch(q);
        if (results) {
          const msgs2 = [...messages, { role: 'user', content: `（联网搜索“${q}”的结果）\n${results}\n——请基于以上结果重新组织你的回复，不要包含[SEARCH]标记。` }];
          reply = await chat(msgs2, config, 'reply');
          console.log('[search] 已结合结果重答');
        } else {
          console.log('[search] 未查到结果，用原回复');
        }
      }
    }
    reply = reply.replace(/\[SEARCH\][\s\S]*?\[\/SEARCH\]/g, '').trim();

    // 输出质检：模型偶尔会失控（自言自语、乱码、超长），这种绝不能发出去。
    // 检测到就重试一次；还不行就用兜底短句，宁可少说也别乱说。
    const check = looksUnhinged(reply);
    if (check.bad) {
      console.warn(`[qc] 回复不合格（${check.why}），重试一次…`);
      try {
        const retryMsgs = [
          ...messages,
          { role: 'assistant', content: String(reply).slice(0, 400) },
          { role: 'user', content: '（你刚才那段乱掉了。请重新用简短、正常的中文回一句，2~3 条，每条一句话，不要符号堆砌、不要自言自语。）' }
        ];
        const retry = await chat(retryMsgs, config, 'reply');
        const check2 = looksUnhinged(retry);
        if (!check2.bad) {
          console.log('[qc] 重试成功');
          return String(retry).trim();
        }
        console.warn(`[qc] 重试仍不合格（${check2.why}），改用兜底话术`);
      } catch (e) {
        console.warn('[qc] 重试失败: ' + e.message);
      }
      return reply_fallback();
    }

    // 兜底：模型返回空（常见于推理模型被 max_tokens 截断）时，别发空白消息出去
    if (!reply) {
      console.warn('[llm] 模型返回了空内容，用兜底话术代替（检查一下模型/token 设置）');
      reply = reply_fallback();
    }

    // 内容太短（只有一两个字）时，让模型补一句完整的话
    // —— 用户要求每条不少于 4 个字
    const minLen = Number(config.bot?.minSegmentChars) || 4;
    const stripped = reply.replace(/\[STICKER\][\s\S]*?\[\/STICKER\]/gi, '').replace(/\[FACE\][\s\S]*?\[\/FACE\]/gi, '').trim();
    if (charCount(stripped) > 0 && charCount(stripped) < minLen) {
      console.warn(`[qc] 回复太短（${charCount(stripped)}字），让模型补完整…`);
      try {
        const retry = await chat([
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: `（太短了，只有「${stripped}」。请把这句话补充完整，每条至少 4 个字，还是 ${segMin}~${segMax} 条，用你平时的语气。）` }
        ], config, 'reply');
        if (retry && charCount(String(retry).replace(/\[[^\]]*\]/g, '').trim()) >= minLen) {
          return String(retry).trim();
        }
      } catch (e) {
        console.warn('[qc] 补长失败: ' + e.message);
      }
    }
    return reply;
  }

  /** 模型抽风时的兜底回复（按性格预设给个最简短的） */
  function reply_fallback() {
    const preset = config.persona?.preset;
    if (preset === 'cold') return '嗯';
    if (preset === 'business') return '收到';
    if (preset === 'cute') return '诶嘿';
    return '咋了';
  }

  // ---------- 涩图 / 淫秽内容拦截 ----------
  /**
   * 检查消息里有没有色情图片或淫秽文字。
   * 命中就发警告并返回 true（调用方应直接 return）。
   */
  async function checkNsfw({ msg, text, userId, key, isGroup, label, target }) {
    const cfg = config.bot?.nsfwFilter || {};
    if (cfg.enabled === false) return false;

    let hitKind = null;   // 'image' | 'text'
    let hitDetail = '';

    // 1) 图片检查
    const imgs = allImages(msg);
    if (imgs.length && config.bot?.vision?.enabled !== false) {
      for (const im of imgs.slice(0, 2)) {
        try {
          const r = await imageToDataUrl(im);
          if (!r.ok) continue;
          const b64 = r.dataUrl.split(',')[1];
          const buf = Buffer.from(b64, 'base64');
          const { analyzeImage, VERDICTS } = await import('./image-classifier.js');
          const a = await analyzeImage(config, buf);
          if (a.ok && a.verdict === VERDICTS.NSFW) {
            hitKind = 'image';
            hitDetail = a.desc || '色情图片';
            break;
          }
        } catch (e) {
          console.log(`[nsfw] 图片检查出错: ${e.message}`);
        }
      }
    }

    // 2) 文字检查
    if (!hitKind && text) {
      const { detectNsfwText } = await import('./image-classifier.js');
      const t = detectNsfwText(text);
      if (t.bad) { hitKind = 'text'; hitDetail = t.hit; }
    }

    if (!hitKind) return false;

    // ---- 命中：骂回去 ----
    const { nsfwReply, addStrike, escalate } = await import('./nsfw-filter.js');
    const n = addStrike(key);
    const esc = escalate(n);
    const msgs = [...nsfwReply(config, hitKind), ...esc.extra];

    console.log(`[nsfw] ${hitKind === 'image' ? '涩图' : '淫秽文字'} 命中 ← ${label}（第 ${n} 次，${hitDetail}）`);

    for (const m of msgs) {
      try {
        await client.sendText(target, m, isGroup);
        await sleep(config.bot.replySegmentDelayMs ?? 1200);
      } catch (e) { /* 发不出去就算了 */ }
    }

    // 再犯加重：静默
    if (esc.muteMs > 0) {
      blockedUntil.set(userId, Date.now() + esc.muteMs);
      console.log(`[nsfw] ${label} 被静默 ${Math.round(esc.muteMs/60000)} 分钟`);
    }

    // 记录一下，方便事后查
    try {
      recorder.append(isGroup ? `${userId}` : userId, 'them', `[已拦截${hitKind === 'image' ? '涩图' : '淫秽文字'}] ${hitDetail}`);
    } catch { /* 忽略 */ }

    return true;
  }

  // ---------- 反浪费 ----------
  function antiWasteBlocked(userId) {
    const aw = config.bot.antiWaste;
    if (!aw?.enabled) return false;
    const until = blockedUntil.get(userId) || 0;
    if (until > Date.now()) {
      console.log(`[antiWaste] ${userId} 仍在静默（剩余 ${Math.round((until - Date.now()) / 1000)}s）`);
      return true;
    }
    const win = aw.windowMs || 60000;
    const now = Date.now();
    const times = (spamTimes.get(userId) || []).filter((t) => now - t <= win);
    times.push(now);
    spamTimes.set(userId, times);
    if (times.length > (aw.maxMessagesInWindow || 5)) {
      blockedUntil.set(userId, now + (aw.blockMs || 1800000));
      return true;
    }
    return false;
  }

  // ---------- 私聊处理 ----------
  async function handlePrivate(msg, inText, opts = {}) {
    const asOwnerTalk = !!opts.asOwnerTalk;
    const { userId, nickname } = senderLabel(msg);
    const key = `u${userId}`;

    // ---- 被号主 /闭嘴 之后，这个会话静默 ----
    if (isSelfMuted(key)) {
      console.log(`[selfMute] 私聊 ${key} 静默中，跳过回复`);
      if (inText) recorder.append(userId, 'them', inText);
      return;
    }

    // 号主自己发的：走一条更宽松的通道（不看白名单、不受刷屏限制）
    if (asOwnerTalk) {
      if (inText) recorder.append(userId, 'me-self', inText);
      const history = context.get(key);
      const userContent = `【这是号主本人在自己的号上打的字】\n${inText}`;
      try {
        const reply = await generate(history, systemPrompt, userContent, 'private');
        context.push(key, 'user', forHistory(userContent));
        context.push(key, 'assistant', reply);
        console.log(`[out] (号主自语) ← ${reply.replace(/\n/g, ' / ')}`);
        // 回在同一个聊天框里（你自己发的，就回给你自己）
        await deliver(reply, { target: userId, isGroup: false, label: '号主自语', key });
      } catch (e) {
        console.error(`[error] 号主自语回复失败: ${e.message}`);
      }
      return;
    }

    if (inText) recorder.append(userId, 'them', inText);
    if (!allowedPrivate(msg)) {
      console.log(`[skip] 私聊 ${userId}(${nickname}) 不在 allowedUsers 里`);
      return;
    }
    if (antiWasteBlocked(userId)) {
      const aw = config.bot.antiWaste;
      const msgs = (Array.isArray(aw.reply) && aw.reply.length) ? aw.reply : ['别刷了，我是AI，不浪费token。'];
      for (const m of msgs) { try { await client.sendPrivateMsg(userId, m, true); } catch (e) {} }
      console.log(`[antiWaste] 触发：${userId} 刷屏 → 已提示并静默`);
      return;
    }
    if (!inTimeWindow(config)) { console.log(`[skip] 不在时间段 (${userId})`); return; }
    if (!cooldownOk(key, config.bot.replyCooldownMs)) { console.log(`[skip] 冷却中 (${userId})`); return; }
    if (!rateOk(key, config.bot.maxAutoRepliesPerConversationPerHour)) { console.log(`[skip] 超每小时上限 (${userId})`); return; }

    const text = extractText(msg.message);
    if (!text && !firstImageUrl(msg)) { console.log(`[skip] 空消息 (${userId})`); return; }

    // ---- 涩图/淫秽内容拦截（最高优先级，先于一切处理）----
    const nsfw = await checkNsfw({ msg, text, userId, key, isGroup: false, label: nickname || userId, target: userId });
    if (nsfw) return;

    console.log(`[in]  ${nickname || userId} → ${text}`);

    if (config.bot.lowBalance?.enabled && lowBalanceActive) {
      const lb = config.bot.lowBalance;
      if (Date.now() - lastLowReplyAt > (lb.replyCooldownMs || 600000)) {
        lastLowReplyAt = Date.now();
        for (const m of (Array.isArray(lb.reply) && lb.reply.length ? lb.reply : ['余额快没了，先暂停回复。'])) {
          try { await client.sendPrivateMsg(userId, m, true); } catch (e) {}
        }
      }
      console.log(`[lowBalance] 余额 ${lastBalance}，已暂停（不花 token）`);
      return;
    }

    // 图片消息：真正「看」图 —— 把图片转成 base64 一起发给模型
    let userContent = text;
    const visionOn = config.bot?.vision?.enabled !== false;
    const imgs = allImages(msg);
    if (imgs.length && visionOn) {
      const loaded = [];
      for (const im of imgs.slice(0, config.bot?.vision?.maxImages ?? 3)) {
        const r = await imageToDataUrl(im);
        if (r.ok) loaded.push(r);
        else console.log(`[vision] 图片读取失败: ${r.reason}`);
      }
      if (loaded.length) {
        console.log(`[vision] 收到 ${loaded.length} 张图，已转给模型识别`);
        userContent = buildMultimodalContent(
          (text ? `${text}\n` : '') + '（对方发来一张图片，你能看到这张图。先用你的眼睛看清：画的是什么、有没有文字、什么颜色、什么表情。然后用你自己的语气回一句，可以自然地把看到的内容说出来，但别像在做图片描述任务。）',
          loaded
        );
      } else {
        userContent = text || '[对方发来一张图片，但没取到，稍微应一句]';
      }
    } else if (imgs.length && !visionOn) {
      userContent = text || '[图片]';
    }

    // 号主本人：在消息前加标记，让 AI 知道该切换成「对自己」的态度
    const isOwner = isOwnerId(userId);
    if (isOwner && typeof userContent === 'string') {
      userContent = `【这是号主本人发的】\n${userContent}`;
      console.log(`[owner] ${userId} 是号主本人，使用专属态度`);
    } else if (!isOwner && typeof userContent === 'string') {
      userContent = `【这是外人（不是号主）发的】\n${userContent}`;
    }

    const history = context.get(key);
    try {
      // 把「小本本」里对这个人的印象注入本轮对话
      const nbHint = buildNotebookHint(userId, 'private');
      const promptWithNb = nbHint ? `${systemPrompt}\n\n${nbHint}` : systemPrompt;
      const reply = await generate(history, promptWithNb, userContent, 'private');
      context.push(key, 'user', forHistory(userContent));
      context.push(key, 'assistant', reply);
      lastReplyAt.set(key, Date.now());
      bumpRate(key);

      console.log(`[out] ${nickname || userId} ← ${reply.replace(/\n/g, ' / ')}`);
      recorder.append(userId, 'me', reply.replace(/\[STICKER\][\s\S]*?\[\/STICKER\]/gi, '[表情包]'));

      const r = await deliver(reply, { target: userId, isGroup: false, label: nickname || userId, key });

      // 记一笔小本本（异步，不阻塞）
      takeNote(userId, [text], [reply], 'private');

      const today = dayStr();
      if (stats.date !== today) { stats.date = today; stats.repliesToday = 0; stats.groupRepliesToday = 0; stats.privateRepliesToday = 0; stats.stickersSentToday = 0; }
      stats.repliesToday += 1;
      stats.privateRepliesToday += 1;
      stats.stickersSentToday += (r.stickers + r.faces);
      stats.lastReplyAt = Date.now();
      stats.lastFrom = String(userId);
      stats.lastScene = 'private';
      saveStats(config, stats);
      console.log(`[done] 私聊 ${nickname || userId} 共发 ${r.sent} 条（图${r.stickers} 表情${r.faces}）`);
    } catch (err) {
      console.error(`[error] 私聊回复失败 ${userId}: ${err.message}`);
    }
  }

  // ---------- 群聊处理 ----------
  async function handleGroup(msg, inText, opts = {}) {
    const asOwnerTalk = !!opts.asOwnerTalk;
    const groupId = String(msg.group_id);
    const userId = String(msg.user_id ?? msg.sender?.user_id ?? '');
    const name = displayName(msg);
    const key = `g${groupId}`;

    // ---- 被号主 /闭嘴 之后，这个群静默 ----
    // 但指令本身要放行（否则 /解禁 都用不了）
    {
      const prefix = config.bot.commandPrefix || '/';
      const isCmd = inText && inText.startsWith(prefix);
      if (isSelfMuted(key) && !isCmd) {
        console.log(`[selfMute] 群 ${key} 静默中，跳过回复`);
        if (inText) recorder.append(`g${groupId}`, 'them', `${name}: ${inText}`);
        return;
      }
    }
    const g = config.bot.group || {};

    // 号主自己在群里打的字：直接回，不用 @（这是「我发的统统回复」）
    if (asOwnerTalk) {
      if (!allowedGroup(groupId)) {
        console.log(`[skip] 群 ${groupId} 不在 allowedGroups 里（号主自语也跳过）`);
        return;
      }
      if (inText) recorder.append(`g${groupId}`, 'me-self', inText);
      const history = groupContext.get(key);
      const userContent = `[${name}]【这是号主本人在群里打的字】: ${inText}`;
      try {
        const reply = await generate(history, groupPrompt, userContent, 'group');
        groupContext.push(key, 'user', forHistory(userContent));
        groupContext.push(key, 'assistant', reply);
        console.log(`[out] 群${groupId} (号主自语) ← ${reply.replace(/\n/g, ' / ')}`);
        await deliver(reply, { target: groupId, isGroup: true, label: `群${groupId}·号主自语`, key });
      } catch (e) {
        console.error(`[error] 群内号主自语回复失败: ${e.message}`);
      }
      return;
    }

    if (!allowedGroup(groupId)) {
      console.log(`[skip] 群 ${groupId} 不在 allowedGroups 里`);
      return;
    }
    const atMe = isAtSelf(msg, selfId);
    // @全体成员 是群公告性质，不是单独叫我，不要傻乎乎去回
    const atAllOnly = isAtAll(msg) && !isAtSelf(msg, selfId);
    const isCmd = inText && inText.startsWith(config.bot.commandPrefix || '/');

    // 群里的指令：一律先交给 handleCommand 处理，由它判断权限。
    // 这样外人发 /闭嘴 会被明确拒绝，而不是落到 AI 判断里被静默忽略。
    if (isCmd) {
      console.log(`[cmd] 群${groupId} ${userId} → ${inText}`);
      await handleCommand(userId, inText, groupId);
      return;
    }
    if (!autoEnabled) { console.log(`[skip] 自动回复已关闭（群 ${groupId}）`); return; }
    if (atAllOnly) { console.log(`[skip] 群 ${groupId} 只是@全体成员，不是叫我`); return; }

    if (inText) recorder.append(`g${groupId}`, 'them', `${name}: ${inText}`);

    // ---- 涩图/淫秽内容拦截：必须在抓取表情包之前，否则涩图会被收进库里 ----
    {
      const gText = extractText(msg.message, { keepFace: false }).replace(/@\d+\s*/g, '').trim();
      const nsfw = await checkNsfw({
        msg, text: gText, userId: key, key,
        isGroup: true, label: `${name}@群${groupId}`, target: groupId
      });
      if (nsfw) return;
    }

    // ---- 自动抓表情包：群里别人发的图，先判断值不值得收 ----
    // 放在最前面，这样即使机器人不回复（AI 判断不插话），图照样能收到。
    const catchCfg = config.bot?.catchSticker || {};
    if (catchCfg.enabled !== false) {
      const cImgs = allImages(msg);
      for (const im of cImgs.slice(0, 2)) {
        catchSticker(config, im, {
          maxBytes: catchCfg.maxKB ? catchCfg.maxKB * 1024 : 5_000_000,
          source: `${name}@${groupId}`,
          classify: catchCfg.classify !== false,   // 默认开：过滤截图/照片/无意义图
          onLog: (m) => console.log(m)
        }).then((r) => {
          if (r.ok) {
            caughtSinceTag++;
            const tagTxt = r.tags?.length ? ` [${r.tags.join(',')}]` : '';
            console.log(`[catch] 收下表情包 ${r.rel} (${Math.round(r.bytes/1024)}KB)${tagTxt} ${r.desc || ''} ← ${name}`);
            // 分类时已经打好标签了，这里只在标签为空时补打
            if (!r.tags?.length && caughtSinceTag >= (catchCfg.tagEvery ?? 3)) {
              caughtSinceTag = 0;
              autoTagStickers(config, { limit: 10, onlyUntagged: true, log: (m) => console.log(m) })
                .then(() => {
                  config.bot.sticker.availableTags = Object.keys(scanStickers(config).tags || {});
                  systemPrompt = buildPersona(config, 'private');
                  groupPrompt = buildPersona(config, 'group');
                })
                .catch(() => {});
            } else if (r.tags?.length) {
              // 有新标签了，刷新提示词里的可用词
              config.bot.sticker.availableTags = Object.keys(scanStickers(config).tags || {});
              systemPrompt = buildPersona(config, 'private');
              groupPrompt = buildPersona(config, 'group');
            }
          } else if (r.reason && r.reason.startsWith('not_a_sticker:')) {
            const kind = r.reason.split(':')[1];
            const zh = { screenshot: '截图', photo: '照片', text: '文字长图', qr: '二维码', junk: '无意义图' }[kind] || kind;
            console.log(`[catch] 跳过（${zh}）${r.desc || ''} ← ${name}`);
          } else if (!r.skipped) {
            console.log(`[catch] 这张没收下：${r.reason}`);
          }
        }).catch(() => {});
      }
    }

    if (antiWasteBlocked(groupId)) {
      console.log(`[antiWaste] 群 ${groupId} 刷屏，静默中`);
      return;
    }
    if (!inTimeWindow(config)) { console.log(`[skip] 不在时间段（群 ${groupId}）`); return; }
    if (!cooldownOk(key, g.replyCooldownMs ?? 20000)) { console.log(`[skip] 群冷却中（${groupId}）`); return; }
    if (!rateOk(key, g.maxRepliesPerGroupPerHour ?? 20)) { console.log(`[skip] 群每小时上限（${groupId}）`); return; }

    const text = extractText(msg.message, { keepFace: false }).replace(/@\d+\s*/g, '').trim();
    const imgUrl = firstImageUrl(msg);
    // 关键：只 @ 不说话（消息里只剩一个 @）是最常见的用法，必须当成有效消息回复，
    // 不能让「去掉@后为空」把它误判成空消息跳过。
    if (!text && !imgUrl && !atMe) { console.log(`[skip] 群消息为空（${groupId}）`); return; }

    // ---- 该不该回：@ 必回；否则让模型判断 ----
    let decision = { speak: true, score: 5, reason: 'at_me' };
    if (!atMe) {
      if (g.replyWhenAt === false && !g.autoJudge) { console.log(`[skip] 群 ${groupId} 未@且未开自主判断`); return; }
      decision = await judgeShouldSpeak({
        chatFn: chat, config,
        history: groupContext.get(key),
        latest: { name, content: text || '[图片]' },
        selfName: config.persona?.botNickname || '',
        atMe: false
      });
      if (!decision.speak) {
        console.log(`[skip] 群判断不插话 (${decision.reason}) 群${groupId} ${name}: ${text.slice(0, 40)}`);
        // 群里其他人的消息仍记入上下文，让后续判断更准
        groupContext.push(key, 'user', `[${name}] ${text || '[图片]'}`);
        return;
      }
      console.log(`[judge] 决定插话 (${decision.reason}) 群${groupId}`);
    }

    console.log(`[in]  群${groupId} ${name}${atMe ? '(@我)' : ''} → ${text || '(只@了我，没说话)'}`);

    if (config.bot.lowBalance?.enabled && lowBalanceActive) {
      console.log(`[lowBalance] 余额 ${lastBalance}，群消息不回复（不花 token）`);
      return;
    }

    // 只 @ 没说话时，给模型一个明确的提示语，让它自然地接话
    let cleanText;
    if (text) cleanText = text;
    else if (imgUrl) cleanText = '[图片]';
    else cleanText = '（@了我，但没说话——大概是想让我吱一声，你随便接一句）';
    // 号主本人在群里说话，同样切换成专属态度
    const groupIsOwner = isOwnerId(userId);
    let groupUserContent = groupIsOwner
      ? `[${name}]【这是号主本人发的】: ${cleanText}`
      : `[${name}](外人): ${cleanText}`;
    if (groupIsOwner) console.log(`[owner] 群里 ${userId} 是号主本人，使用专属态度`);

    // 群里发图也让它看
    const gImgs = allImages(msg);
    if (gImgs.length && config.bot?.vision?.enabled !== false) {
      const loaded = [];
      for (const im of gImgs.slice(0, config.bot?.vision?.maxImages ?? 3)) {
        const r = await imageToDataUrl(im);
        if (r.ok) loaded.push(r);
        else console.log(`[vision] 群图片读取失败: ${r.reason}`);
      }
      if (loaded.length) {
        console.log(`[vision] 群里收到 ${loaded.length} 张图，转给模型识别`);
        groupUserContent = buildMultimodalContent(
          `${groupUserContent}\n（顺便看看这张图是什么，用你的语气接一句）`, loaded
        );
      }
    }
    const userContent = groupUserContent;
    const history = groupContext.get(key);

    try {
      // 群里也带上对这个人的小本本印象（只认人不认环境）
      const nbHint = buildNotebookHint(userId, 'group');
      const promptWithNb = nbHint ? `${groupPrompt}\n\n${nbHint}` : groupPrompt;
      const reply = await generate(history, promptWithNb, userContent, 'group');
      groupContext.push(key, 'user', forHistory(userContent));
      groupContext.push(key, 'assistant', reply);
      lastReplyAt.set(key, Date.now());
      bumpRate(key);

      console.log(`[out] 群${groupId} ${name} ← ${reply.replace(/\n/g, ' / ')}`);
      recorder.append(`g${groupId}`, 'me', reply.replace(/\[STICKER\][\s\S]*?\[\/STICKER\]/gi, '[表情包]'));

      const r = await deliver(reply, { target: groupId, isGroup: true, label: `群${groupId}`, key });

      // 记一笔（带群号，方便以后跨环境提起时说清是在哪说的）
      takeNote(userId, [cleanText], [reply], `group:${groupId}`);

      const today = dayStr();
      if (stats.date !== today) { stats.date = today; stats.repliesToday = 0; stats.groupRepliesToday = 0; stats.privateRepliesToday = 0; stats.stickersSentToday = 0; }
      stats.repliesToday += 1;
      stats.groupRepliesToday += 1;
      stats.stickersSentToday += (r.stickers + r.faces);
      stats.lastReplyAt = Date.now();
      stats.lastFrom = `${name}@群${groupId}`;
      stats.lastScene = 'group';
      saveStats(config, stats);
      console.log(`[done] 群${groupId} 共发 ${r.sent} 条（图${r.stickers} 表情${r.faces}）`);
    } catch (err) {
      console.error(`[error] 群回复失败 ${groupId}: ${err.message}`);
    }
  }

  // ---------- 统一入口 ----------
  async function handleMessage(msg) {
    // 去重：NapCat 偶尔会把同一条消息推两遍（尤其开了多个连接时），
    // 不去重会导致机器人对同一句话回两次。
    //
    // ⚠️ 不能只用 message_id —— QQ 的 message_id 在不同会话间会重复，
    // 有时还会缺失或恒为 0/1，那样会把完全不同的消息也误判成重复。
    // 所以改成「会话 + 发送者 + 消息内容 + 秒级时间」做指纹。
    const textForDedup = extractText(msg.message).slice(0, 120);
    const segTypes = Array.isArray(msg.message)
      ? msg.message.map((s) => s.type).join(',') : '';
    const msgId = msg.message_id;
    // message_id 有效（不是 0/1/undefined）时才纳入指纹
    const idPart = (msgId && Number(msgId) > 1) ? String(msgId) : '';
    const dedupKey = [
      msg.message_type,
      msg.group_id || '',
      msg.user_id || msg.sender?.user_id || '',
      idPart,
      textForDedup,
      segTypes,
      Math.floor((msg.time || Date.now() / 1000))   // 秒级时间，同秒同内容才算重复
    ].join('|');

    const now = Date.now();
    const last = seenMessages.get(dedupKey);
    if (last && now - last < 8000) {     // 8 秒内完全相同的消息才判重
      console.log(`[dup] 忽略重复消息（${textForDedup.slice(0, 20)}）`);
      return;
    }
    seenMessages.set(dedupKey, now);
    if (seenMessages.size > 500) {
      for (const [k, t] of seenMessages) if (now - t > 20000) seenMessages.delete(k);
    }

    const prefix = config.bot.commandPrefix || '/';
    const admins = toList(config.bot.admin);
    const inText = extractText(msg.message);
    const fromSelfAccount = String(msg.message_sent_type) === 'send' || (selfId && String(msg.user_id) === selfId);
    const isCmd = !!inText && inText.startsWith(prefix);

    // 号主自己在任意聊天框发的消息：也要回（这是「我发的统统回复」）
    // 但必须区分「我打的话」和「机器人替我说的话」，否则会无限对话。
    // 办法：机器人发出的每条回复都带一个隐形标记，看到标记就说明是自己刚发的，跳过。
    if (fromSelfAccount) {
      const echoOn = config.bot?.replyToSelf?.enabled;
      if (!echoOn) {
        if (isCmd) {
          console.log(`[self][cmd] ${inText}`);
          const gid = isGroup(msg) ? String(msg.group_id) : null;
          await handleCommand(msg.user_id, inText, gid);
        }
        return;
      }
      // 是机器人自己发的 → 不当作新消息
      if (isBotEcho(inText)) {
        console.log(`[self] 检测到机器人自己的回复，跳过（防循环）`);
        return;
      }
      // 指令仍然照常执行
      if (isCmd) {
        console.log(`[self][cmd] ${inText}`);
        const gid = isGroup(msg) ? String(msg.group_id) : null;
        await handleCommand(msg.user_id, inText, gid);
        return;
      }
      // 剩下的是号主本人打的话 → 当成对话处理
      const gid = isGroup(msg) ? String(msg.group_id) : null;
      if (gid && config.bot?.replyToSelf?.includeGroups === false) {
        console.log(`[self] 群内自语已关闭（includeGroups=false），跳过`);
        return;
      }
      console.log(`[self][talk] 号主本人${gid ? '在群' + gid : '私聊'}说：${inText}`);
      if (gid) await handleGroup(msg, inText, { asOwnerTalk: true });
      else await handlePrivate(msg, inText, { asOwnerTalk: true });
      return;
    }

    if (isGroup(msg)) {
      await handleGroup(msg, inText);
      return;
    }
    if (isPrivate(msg)) {
      if (isCmd && admins.includes(String(msg.user_id))) {
        console.log(`[cmd] ${msg.user_id} → ${inText}`);
        await handleCommand(msg.user_id, inText);
        return;
      }
      await handlePrivate(msg, inText);
      return;
    }
  }

  let msgChain = Promise.resolve();
  client.on('message', (msg) => {
    msgChain = msgChain.then(() => handleMessage(msg)).catch((e) => console.error('[error]', e));
  });

  client.start();

  // ---------- 掉线监控 ----------
  // QQ 掉线时机器人自己没法用 QQ 通知你，所以走系统弹窗 + 桌面文件。
  //
  // ⚠️ 重要：不能用 get_status 的 online 字段判断！
  //    实测 QQ 掉线时 get_status 仍然返回 {"online": true}（假在线），
  //    但发消息报「网络连接异常」、好友列表变成空的。
  //
  //    所以用两个不会撒谎的探针（按可靠性排序）：
  //      a) 试调一个轻量但依赖 QQ 网络的动作（get_friend_list）
  //      b) 好友列表为空 && 之前曾经非空 → 掉线
  //    另外：如果启动时好友数就是 0，记下来，下次仍为 0 也判定异常。
  let lastFriendCount = null;
  let probeFails = 0;
  const watcher = new DropWatcher({
    config,
    log: console.log,
    check: async () => {
      const connected = stats.connected;
      if (!connected) return { connected: false, online: null, reason: 'OneBot 未连接' };

      try {
        const res = await client.call('get_friend_list', {}, 8000);
        const list = Array.isArray(res?.data) ? res.data : null;

        if (!list) {
          probeFails += 1;
          return {
            connected: true, online: false,
            reason: `好友列表返回格式异常（第 ${probeFails} 次）`
          };
        }

        const count = list.length;

        if (count > 0) {
          // 正常：有好友
          probeFails = 0;
          lastFriendCount = count;
          return { connected: true, online: true };
        }

        // count === 0：可能是掉线，也可能是账号本来就没好友
        probeFails += 1;
        // 如果最一开始就拿到过 >0，现在变 0 → 明确掉线
        if (lastFriendCount !== null && lastFriendCount > 0) {
          return {
            connected: true, online: false,
            reason: `好友列表从 ${lastFriendCount} 变成 0（QQ 掉线特征）`
          };
        }
        // 从没拿到过非 0：连续 2 次都是 0 也判定为异常（避免无好友账号永远不报）
        if (probeFails >= 2) {
          return {
            connected: true, online: false,
            reason: `好友列表为空（第 ${probeFails} 次探测，QQ 可能已掉线）`
          };
        }
        return { connected: true, online: null, reason: '首次探测好友列表为空，观察中' };
      } catch (e) {
        probeFails += 1;
        return {
          connected: true, online: false,
          reason: `查询好友列表失败（第 ${probeFails} 次）: ` + e.message
        };
      }
    }
  });
  watcher.start();

  // ---------- 阻止睡眠 ----------
  // 电脑一睡，NapCat 就变空壳，唤醒后收发全废且无法自愈。
  // 所以机器人运行期间让系统保持唤醒。
  if (config.bot?.keepAwake?.enabled !== false) {
    const r = preventSleep({
      log: console.log,
      alsoKeepDisplayOn: config.bot?.keepAwake?.keepDisplayOn === true
    });
    if (r.ok) {
      console.log('[power] 提示：机器人运行期间电脑不会自动睡眠（防止 NapCat 掉线）');
    } else {
      console.warn(`[power] 阻止睡眠失败: ${r.error}（电脑睡眠后可能需要手动重启 NapCat）`);
    }
  }

  const shutdown = () => {
    console.log('[bot] shutting down...');
    try { watcher.stop(); } catch {}
    try { allowSleep(); } catch {}
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const st = scanStickers(config);
  console.log('[bot] qq-auto-reply started.');
  console.log(`[bot] 私聊提示词 ${systemPrompt.length} 字 · 群聊提示词 ${groupPrompt.length} 字 · 性格预设 ${config.persona.preset || 'custom'}`);
  console.log(`[bot] 私聊白名单: ${toList(config.bot.allowedUsers).join(', ') || '(空)'}`);
  console.log(`[bot] 群聊: ${config.bot.group?.enabled ? `开 · 白名单 ${toList(config.bot.group.allowedGroups).join(', ') || '(空，需填写)'} · 自主判断 ${config.bot.group.autoJudge ? '开' : '关'}` : '关'}`);
  console.log(`[bot] 表情库: ${st.count} 张 @ ${stickerDir(config)} ${st.missing ? '(目录不存在)' : ''}`);
  console.log(`[bot] 时间段: ${config.bot.timeWindow.enabled ? `${config.bot.timeWindow.start}-${config.bot.timeWindow.end}` : '不限'}`);
  console.log(`[bot] 录制: ${recorder.isEnabled() ? 'ON' : 'OFF'} -> ${config.record?.dir || 'records'}`);
}

// 支持通过命令行指定配置文件：node src/bot.js [配置路径]
const argvCfg = process.argv[2] && !process.argv[2].startsWith('-') ? resolve(process.cwd(), process.argv[2]) : undefined;

main(argvCfg)
  .catch((e) => {
    console.error('[fatal]', e);
    process.exit(1);
  });
