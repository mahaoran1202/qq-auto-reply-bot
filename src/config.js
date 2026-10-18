import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULTS = {
  onebot: {
    mode: 'forward-ws',
    host: '127.0.0.1',
    port: 3001,
    accessToken: '',
    reconnectDelayMs: 3000
  },
  bot: {
    enabled: true,
    allowedUsers: [],
    admin: [],
    commandPrefix: '/',
    timeWindow: { enabled: true, start: '09:00', end: '23:00', timezone: 'Asia/Shanghai' },
    replyCooldownMs: 10000,
    maxAutoRepliesPerConversationPerHour: 12,
    respondWhenOffline: true,
    replySegments: 3,
    replySegmentsMin: 3,
    replySegmentsMax: 5,
    replySegmentDelayMs: 5000,
    /** 每条消息最少几个字（不足的会跟相邻合并，模型输出太短会让它重写） */
    minSegmentChars: 4,
    /** 整条回复最多几个字（防啰嗦刷屏） */
    maxReplyChars: 150,
    webSearch: { enabled: true },
    learnStyle: { fromHistory: true, userId: '', maxSamples: 400 },
    antiWaste: {
      enabled: false,
      windowMs: 60000,
      maxMessagesInWindow: 5,
      blockMs: 1800000,
      reply: [
        '别刷了，我是AI，不浪费token。',
        '再刷我就先不回了。'
      ]
    },
    lowBalance: {
      enabled: false,
      threshold: 1,
      checkMinutes: 10,
      notifyAdmin: '',
      replyCooldownMs: 600000,
      reply: [
        '余额快见底了，先暂停自动回复。',
        '（再聊真就欠费了，等充值再说。）'
      ]
    },
    /** 表情包 */
    sticker: {
      enabled: true,
      dir: 'stickers',
      allowFace: true,
      maxPerReply: 1,
      /** 新丢进来的图自动用 AI 识别情绪并打标签（结果缓存，不重复花钱） */
      autoTag: true
    },
    /**
     * 自动抓群里的表情包。
     * 别人在群里发的图会被收进 stickers/_自动抓取/，自动打标签后自己也能发。
     * 按图片内容指纹去重，同一张只存一次。
     */
    catchSticker: {
      enabled: true,
      /** 超过这个大小就不收（KB），防止收进大图 */
      maxKB: 4880,
      /** 攒够几张新图就打一次标签（分类已打标签时不需要） */
      tagEvery: 3,
      /** 收之前先用 AI 判断是不是表情包：截图/照片/二维码/无意义图直接丢掉 */
      classify: true
    },
    /**
     * 号主用 /闭嘴 让机器人自我禁言 + 反思。
     * 仅限号主（persona.owner.userIds）或管理员（bot.admin）能用。
     */
    selfMute: {
      enabled: true,
      /** 默认静默多少分钟（可以用 /闭嘴 5 临时指定） */
      minutes: 2,
      /** 认错的开场白 */
      opening: ['……', '好的，我闭嘴。'],
      /** 反思完的收尾（{$mins} 会替换成分钟数） */
      closing: ['我安静 {$mins} 分钟，到点自己回来。', '（默默缩到角落去了）'],
      /** 反思内容每行之间的间隔 */
      lineDelayMs: 1200
    },
    /**
     * 小本本 —— 对每个人的印象笔记。
     * 只认人不认环境（按 QQ 号存），私聊和群聊共用。
     * 有事才记：只在情绪波动或标志性事件时写，不做定期总结。
     */
    notebook: {
      enabled: true,
      /** 每次注入提示词最多带几条记录（别太多，省 token 也不乱） */
      maxNotesInPrompt: 8,
      /** 注入时是否也带上已经用过的记录 */
      includeUsed: true,
      /** 必须有原话出处才允许记（防捏造的关键，别关） */
      requireQuote: true,
      /** 是否根据记录自动总结「说话策略」 */
      strategyEnabled: true,
      /** 至少几条记录才值得总结策略 */
      strategyMinNotes: 2
    },
    /**
     * 机器人运行期间阻止电脑睡眠。
     * 电脑一睡，NapCat 会变空壳进程，唤醒后收发全废且无法自愈。
     */
    keepAwake: {
      enabled: true,
      /** 连屏幕也不让它关（默认只防睡眠，屏幕照常关） */
      keepDisplayOn: false
    },
    /**
     * 掉线告警 + 自动恢复。
     * QQ 掉线时机器人发不出消息，所以走系统弹窗 + 桌面文件通知。
     */
    dropAlert: {
      enabled: true,
      /** 每多少秒检查一次 */
      checkSeconds: 60,
      /** 连续几次异常才告警（防止网络抖动误报） */
      confirmTimes: 2,
      /** 掉线时抓一份系统现场快照，方便事后定位原因 */
      diagnose: true,
      /** 弹系统通知 + 声音 */
      notify: true,
      /** 在桌面写一个告警文件 */
      writeFile: true,
      /** 恢复时也通知一声 */
      notifyOnRecover: true,
      /** 自动尝试重启 QQ + NapCat（需要管理员权限，会弹 UAC） */
      autoRestart: true,
      /** 两次自动重启的最小间隔（分钟），防止反复重启 */
      restartCooldownMinutes: 10
    },
    /**
     * 涩图/淫秽内容拦截。
     * 严格的：图片只要有性意味就判 nsfw，文字里的淫秽词也拦。
     * 命中后骂回去 + 不收进表情库 + 累犯静默。
     */
    nsfwFilter: {
      enabled: true,
      /** 图片命中时的警告（一行一条，凶狠但不带脏字） */
      reply: [
        '停，这东西别往我这儿发。',
        '你当我这是回收站呢？再发一张我就当没看见你这个人了。',
        '自己收好，别拿出来恶心别人。'
      ],
      /** 文字命中时的警告 */
      textReply: [
        '你这话说的，自己不觉得脏吗。',
        '换个话题，不然我先把你静音了。'
      ]
    },
    /**
     * 视觉：让 AI 真的「看见」图片/表情包。
     * 实测 DeepSeek 的 chat 接口能收 image_url（base64），所以不用额外装视觉模型。
     * 如果换成本地纯文本模型（如 qwen3），要在这里关掉，否则会报错。
     */
    vision: {
      enabled: true,
      /** 一条消息最多看几张图 */
      maxImages: 3
    },
    /**
     * 「我发的消息统统回复」：
     * 号主自己在任意聊天框（含好友聊天框、群聊）打的字，机器人都回。
     * 机器人自己的回复带隐形标记，不会被当成新消息，所以不会无限循环。
     */
    replyToSelf: {
      enabled: false,
      /** 是否也管群聊里自己打的字 */
      includeGroups: true
    },
    /** 群聊 */
    group: {
      enabled: false,
      /** 允许的群号，['*'] 表示全部群 */
      allowedGroups: [],
      /** 被 @ 必回 */
      replyWhenAt: true,
      /** 没被 @ 时是否允许 AI 自己判断插话 */
      autoJudge: true,
      /** AI 判断插话时允许的最低相关度（1~5），越高越少插话 */
      judgeThreshold: 3,
      /** 群里同一人冷却（毫秒），一般比私聊长一些 */
      replyCooldownMs: 20000,
      /** 每小时每群最多回几条 */
      maxRepliesPerGroupPerHour: 20,
      /** 判断插话的模型（省钱用 flash 之类的便宜模型；留空则用默认模型） */
      judgeModel: ''
    }
  },
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxTokens: 800,
    contextTurns: 6,
    timeoutMs: 60000
  },
  /**
   * 双通道 LLM 配置。
   *  active: 'deepseek' 用官方通道；'openai' 用任意 OpenAI 兼容通道（其他网站 / 中转 / 本地）。
   *  purposes: 可选，按用途分流，例如让「群里插话判断」走本地模型省钱。
   *    { reply:'deepseek', judge:'openai', style:'deepseek' }
   *  openai.baseUrl 填到 /v1 为止即可，例如：
   *    Ollama      http://127.0.0.1:11434/v1
   *    LM Studio   http://127.0.0.1:1234/v1
   *    硅基流动     https://api.siliconflow.cn/v1
   *    智谱         https://open.bigmodel.cn/api/paas/v4
   */
  llm: {
    active: 'deepseek',
    purposes: {},
    openai: {
      name: 'OpenAI 兼容通道',
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.8,
      maxTokens: 800,
      timeoutMs: 60000
    }
  },
  persona: {
    stylePrompt: '',
    personaFile: '',
    /** 预设 id，见 persona-presets.js；'custom' = 只用自定义描述 */
    preset: 'buddy',
    /** 自定义补充描述（叠加在预设之上） */
    customStyle: '',
    /** 参数化调节 */
    params: {},
    /** 口头禅 / 禁用词 */
    catchphrases: [],
    forbiddenWords: [],
    /** 群里的昵称、对号主的称呼 */
    botNickname: '',
    ownerCall: '',
    /**
     * 对「号主本人」的特殊态度。
     * 号主 = 你的号（可能有好几个），对这些人用另一套更亲近、更配合的语气。
     */
    owner: {
      enabled: true,
      userIds: [],
      style: ''
    }
  },
  record: { dir: 'records' },
  logging: { level: 'info' }
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  if (!isPlainObject(base)) return override;
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (isPlainObject(base[k]) && isPlainObject(override[k])) {
      out[k] = merge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export function loadConfig(path = CONFIG_PATH) {
  let file = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    file = JSON.parse(raw);
  } else {
    console.warn('[config] %s not found, using built-in defaults.', path);
  }

  const config = merge(deepClone(DEFAULTS), file);

  // Load persona from file if configured.
  if (config.persona.personaFile) {
    const personaPath = resolve(ROOT, config.persona.personaFile);
    if (existsSync(personaPath)) {
      config.persona.stylePrompt = readFileSync(personaPath, 'utf8').trim();
    } else {
      console.warn('[config] personaFile %s not found, using stylePrompt as-is.', personaPath);
    }
  }

  validate(config);
  return config;
}

function validate(config) {
  const problems = [];
  if (!config.deepseek.apiKey) {
    problems.push('deepseek.apiKey is empty — set your DeepSeek API key in config.json');
  }
  if (!Array.isArray(config.bot.allowedUsers) || config.bot.allowedUsers.length === 0) {
    problems.push('bot.allowedUsers is empty — add the QQ user ids allowed to trigger auto-replies');
  }
  for (const p of ['start', 'end']) {
    if (!/^\d{2}:\d{2}$/.test(config.bot.timeWindow[p])) {
      problems.push(`bot.timeWindow.${p} must be "HH:mm" (e.g. "21:00")`);
    }
  }
  if (problems.length) {
    console.warn('[config] Warnings:');
    for (const w of problems) console.warn('  - ' + w);
  }
  return problems;
}

export { ROOT, CONFIG_PATH };

/**
 * Deep-merge partial config over the existing config.json and write it back.
 * Used by the bot (to persist the learned style) and the control panel.
 */
export function saveConfigFile(partial, path = CONFIG_PATH) {
  let existing = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { existing = {}; }
  }
  const next = merge(existing, partial);
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
