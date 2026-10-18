/**
 * 表情包库：扫描本地图片 → 建立「情绪关键词 → 图片文件」索引 → 按 AI 给的关键词挑图。
 *
 * 两种表情都能发：
 *  1) 图片表情包（本地收藏）：把图片丢进 stickers/ 文件夹（或其子文件夹），
 *     子文件夹名或文件名里带情绪词就会被自动打上标签，AI 写 [STICKER]笑死[/STICKER] 时按标签挑图。
 *  2) QQ 内置小黄脸：AI 写 [FACE]178[/FACE]，直接发对应 face id。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, extname, basename, relative } from 'node:path';
import { ROOT } from './config.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const MAX_SCAN_DEPTH = 3;

/**
 * 情绪词 → 同义词。图片文件名/目录名命中任意一个同义词，就算打了这个情绪标签。
 * 这样用户只要把表情包命名成「笑死.gif」「无语.jpg」或放进「/无语/」文件夹即可。
 */
export const EMOTION_ALIASES = {
  笑死: ['笑死', '爆笑', '大笑', '哈哈哈', '哈哈', '笑', '好笑', '搞笑', '乐', 'laugh', 'lol', 'xd'],
  无语: ['无语', '沉默', '麻了', '服了', '无奈', '呵呵', 'speechless', '...'],
  震惊: ['震惊', '吃惊', '惊讶', '卧槽', 'wc', '妈呀', '震惊', 'shock', 'omg', '！！'],
  生气: ['生气', '愤怒', '气死', '怒', '火大', '骂', 'angry', 'mad'],
  委屈: ['委屈', '难过', '哭', '伤心', '可怜', '泪', 'sad', 'cry'],
  开心: ['开心', '高兴', '快乐', '爽', '好耶', 'happy', 'smile', '耶'],
  害羞: ['害羞', '脸红', '羞', '不好意思', 'shy', 'blush'],
  得意: ['得意', '嚣张', '拽', '酷', 'doge', '骄傲', 'proud'],
  点赞: ['点赞', '赞', '牛', '强', 'nb', '666', '厉害', 'thumb', 'like', 'ok'],
  吃瓜: ['吃瓜', '围观', '看戏', '瓜子', 'popcorn'],
  问号: ['问号', '疑惑', '不懂', '懵逼', 'what', 'huh', '？？'],
  抱抱: ['抱抱', '抱', '摸头', '贴贴', '安慰', 'hug'],
  溜了: ['溜了', '跑', '告辞', '拜拜', '再见', '撤', 'run', 'bye'],
  睡觉: ['睡觉', '晚安', '困', '睡', 'sleep', 'zzz'],
  饿: ['饿', '吃饭', '干饭', '馋', '吃', 'food', 'hungry'],
  拒绝: ['拒绝', '不要', '不行', 'no', '打咩', '达咩'],
  加油: ['加油', '冲', '干', 'fighting', '努力'],
  吐血: ['吐血', '崩溃', '裂开', '裂', '累', '摆烂', 'die'],
  害怕: ['害怕', '恐惧', '慌', '怂', 'scared', '害怕'],
  亲亲: ['亲亲', '么么', '爱你', '比心', 'love', 'kiss', '心'],
  鼓掌: ['鼓掌', '拍手', '恭喜', '庆祝', 'clap', 'tada'],
  白眼: ['白眼', '鄙视', '嫌弃', '不屑', 'roll']
};

/** 常用 QQ 小黄脸对照表（AI 用编号发，面板用来展示） */
export const FACE_TABLE = [
  ['微笑', 14], ['难耐', 5], ['得意', 4], ['流泪', 9], ['害羞', 10], ['闭嘴', 12],
  ['睡', 13], ['惊吓', 16], ['偷笑', 20], ['白眼', 23], ['大哭', 32], ['晕', 34],
  ['吐', 39], ['鼓掌', 42], ['猪头', 46], ['拥抱', 49], ['蛋糕', 53], ['玫瑰', 63],
  ['爱心', 66], ['太阳', 74], ['月亮', 75], ['赞', 76], ['握手', 78], ['胜利', 79],
  ['飞吻', 85], ['指', 96], ['揍', 97], ['擦汗', 98], ['嘿', 105], ['可爱', 106],
  ['憨笑', 109], ['戴眼镜', 110], ['尴尬', 111], ['疑问', 112], ['冷汗', 114], ['抠鼻', 118],
  ['鼓掌2', 119], ['左右摆', 121], ['叹气', 122], ['思考', 123], ['OK', 124], ['好', 125],
  ['转圈', 126], ['点头', 128], ['摇头', 129], ['饥饿', 140], ['困', 141], ['吐舌', 142],
  ['狂汗', 143], ['发愣', 144], ['暗中观察', 146], ['坏笑', 147], ['亲亲', 148], ['生气', 149],
  ['惊讶', 152], ['耍酷', 154], ['擦泪', 155], ['呲牙', 156], ['无聊', 157], ['酷', 158],
  ['鄙视', 159], ['悠闲', 161], ['大笑', 162], ['惊恐', 164], ['发怒', 165], ['委屈', 166],
  ['哼', 167], ['可怜', 168], ['斜眼', 169], ['调皮', 170], ['抓狂', 176], ['微笑2', 178],
  ['害羞2', 179], ['白眼2', 180], ['得意2', 181], ['大哭2', 182], ['尴尬2', 183], ['调皮2', 185],
  ['呲牙2', 186], ['难过', 188], ['冷汗2', 191], ['偷笑2', 194], ['傲慢', 196], ['流汗', 200],
  ['憨笑2', 201], ['色', 202], ['难过2', 213]
];

/** 表情库目录（默认项目下 stickers/） */
export function stickerDir(config) {
  const dir = config?.bot?.sticker?.dir || 'stickers';
  return resolve(ROOT, dir);
}

/** 递归收集图片文件（限制深度，避免误扫整个磁盘） */
function walk(dir, depth = 0, out = []) {
  if (depth > MAX_SCAN_DEPTH || !existsSync(dir)) return out;
  let items = [];
  try { items = readdirSync(dir); } catch { return out; }
  for (const name of items) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, depth + 1, out);
    } else if (IMAGE_EXT.has(extname(name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 给一个文件路径打情绪标签。
 * 依据：相对路径里各段（目录名 + 文件名，去掉扩展名）能匹配到哪些情绪同义词。
 * 另外支持文件名前缀显式标签，如「[笑死]xxx.png」。
 */
function tagsForFile(fullPath, root) {
  const rel = relative(root, fullPath);
  const noExt = rel.replace(/\.[^.]+$/, '');
  const hay = noExt.toLowerCase().replace(/[_\-\s\[\]()（）]+/g, ' ');
  const tags = new Set();

  // 显式方括号标签
  for (const m of noExt.matchAll(/[\[【]([^\]】]+)[\]】]/g)) {
    tags.add(m[1].trim());
  }
  for (const [emotion, aliases] of Object.entries(EMOTION_ALIASES)) {
    for (const a of aliases) {
      if (hay.includes(a.toLowerCase())) { tags.add(emotion); break; }
    }
  }
  return [...tags];
}

/**
 * 扫描表情库，返回 { images: [...], tags: {...}, count, dir }
 * 结果可缓存到 <dir>/.index.json，但默认每次实时扫描（图片量小，且用户随时会加图）。
 */
export function scanStickers(config) {
  const dir = stickerDir(config);
  const images = [];
  const tagMap = new Map();

  if (!existsSync(dir)) {
    return { dir, count: 0, images: [], tags: {}, missing: true };
  }

  // 读 AI 标签缓存（抓来的图文件名是哈希，只能靠这个归类）
  let aiCache = {};
  try {
    const cachePath = join(dir, '.tags.json');
    if (existsSync(cachePath)) aiCache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { aiCache = {}; }

  for (const full of walk(dir)) {
    const fileTags = tagsForFile(full, dir);
    const rel = relative(dir, full).replace(/\\/g, '/');
    const ai = aiCache[rel];
    const aiTags = Array.isArray(ai?.tags) ? ai.tags : [];
    // AI 标签放前面（更准），文件名标签保留在后
    const tags = [...new Set([...aiTags, ...fileTags])];

    const item = {
      file: full,
      name: basename(full),
      rel,
      tags,
      aiTags,
      aiDesc: ai?.desc || '',
      size: (() => { try { return statSync(full).size; } catch { return 0; } })()
    };
    // 跳过明显的非表情包大图（>8MB 发起来慢）
    if (item.size > 8 * 1024 * 1024) continue;
    images.push(item);
    for (const t of tags) {
      if (!tagMap.has(t)) tagMap.set(t, []);
      tagMap.get(t).push(item.rel);
    }
  }

  const tags = {};
  for (const [k, v] of [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    tags[k] = v;
  }
  return { dir, count: images.length, images, tags, missing: false };
}

/**
 * 按 AI 给的关键词挑一张表情包。
 * 匹配优先级：情绪标签精确命中 → 标签包含关系 → 文件名包含 → 随机兜底。
 * @returns {{ok:true, file:string, rel:string, matched:string}|{ok:false, reason:string}}
 */
export function pickSticker(config, keyword, opts = {}) {
  let scan = scanStickers(config);
  if (scan.missing) return { ok: false, reason: `表情库目录不存在：${scan.dir}` };
  if (!scan.count) return { ok: false, reason: `表情库是空的（${scan.dir}），往里放些图片即可` };

  // 合并 AI 识别出来的标签（比文件名猜的准），失败就用原始索引
  if (opts.tagCache) {
    try { scan = { ...scan, images: opts.tagCache }; } catch { /* 忽略 */ }
  }

  const kw = String(keyword || '').trim();
  const exclude = new Set(opts.exclude || []);
  const pool = scan.images.filter((i) => !exclude.has(i.rel));
  const usable = pool.length ? pool : scan.images;

  let hits = [];
  if (kw) {
    // 1) 关键词本身或其同义词族命中标签
    const wanted = new Set([kw]);
    for (const [emotion, aliases] of Object.entries(EMOTION_ALIASES)) {
      if (emotion === kw || aliases.some((a) => a.toLowerCase() === kw.toLowerCase())) {
        wanted.add(emotion);
        aliases.forEach((a) => wanted.add(a));
      }
    }
    hits = usable.filter((i) => i.tags.some((t) => wanted.has(t)));
    // 2) 标签模糊包含
    if (!hits.length) {
      hits = usable.filter((i) => i.tags.some((t) => t.includes(kw) || kw.includes(t)));
    }
    // 3) 文件名/路径包含关键词
    if (!hits.length) {
      const low = kw.toLowerCase();
      hits = usable.filter((i) => i.rel.toLowerCase().includes(low));
    }
  }

  if (!hits.length) {
    // 4) 兜底：随机一张，保证「想发表情」时真的有图发
    hits = usable;
    if (!hits.length) return { ok: false, reason: '没有可用表情包' };
    const pick = hits[Math.floor(Math.random() * hits.length)];
    return { ok: true, file: pick.file, rel: pick.rel, matched: '(随机兜底)' };
  }

  const pick = hits[Math.floor(Math.random() * hits.length)];
  return { ok: true, file: pick.file, rel: pick.rel, matched: kw || '(未指定)' };
}

/**
 * 保证表情库目录存在，并写入一份说明文件，方便用户知道怎么加图。
 */
export function ensureStickerDir(config) {
  const dir = stickerDir(config);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, '怎么加表情包.txt');
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      '把 QQ 表情包图片直接丢进这个文件夹就能用（支持 .jpg .png .gif .webp .bmp）。',
      '',
      '【怎么让 AI 认得它们】',
      '按情绪给图片命名或分文件夹，例如：',
      '  stickers/笑死/01.gif',
      '  stickers/无语.jpg',
      '  stickers/[生气]骂人.png',
      'AI 回复里写 [STICKER]笑死[/STICKER] 时，程序就会从这里挑一张「笑死」的图发出去。',
      '',
      '【支持的文件夹/文件名关键词】',
      Object.keys(EMOTION_ALIASES).join('、'),
      '',
      '没有标签的图片也会被随机用到（AI 想发表情但没匹配到时兜底）。',
      '图片建议小于 5MB，太大的发送慢。'
    ].join('\n'), 'utf8');
  }
  return dir;
}

/** 统计各情绪标签有多少张图，面板展示用 */
export function stickerSummary(config) {
  const scan = scanStickers(config);
  return {
    dir: scan.dir,
    count: scan.count,
    missing: !!scan.missing,
    tags: Object.fromEntries(Object.entries(scan.tags).map(([k, v]) => [k, v.length])),
    faces: FACE_TABLE.length
  };
}

export { IMAGE_EXT };
