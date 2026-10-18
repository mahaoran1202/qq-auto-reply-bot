/**
 * 小本本 —— 机器人对每个人的印象笔记。
 *
 * 设计原则：
 *   1. 只认人不认环境 —— 用 QQ 号做键，私聊和群聊共用同一份笔记
 *   2. 有事才记 —— 不做定期总结，只在「情绪波动」或「标志性事件」时写
 *   3. 绝不捏造 —— 每条记录必须能在真实对话里找到出处，带原文引用
 *
 * 每条记录的结构：
 *   {
 *     id,          // 唯一 id
 *     at,          // 时间戳
 *     kind,        // 'grudge'(记仇) | 'favor'(记好) | 'trait'(性格印象) | 'event'(事件)
 *     gist,        // 一句话概括
 *     quote,       // 当时的原话（防止捏造的关键）
 *     place,       // 'private' | 'group:<群号>'
 *     intensity,   // 1~5，情绪强度（决定以后要不要翻出来）
 *     used         // 是否已经拿出来说过
 *   }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.js';

const DIR = resolve(ROOT, 'notebooks');

function fileFor(userId) {
  // 只用数字 QQ 号做文件名，防路径穿越
  const safe = String(userId).replace(/[^0-9a-zA-Z_-]/g, '');
  return join(DIR, `${safe}.json`);
}

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/** 读某人的笔记 */
export function loadNotebook(userId) {
  ensureDir();
  const f = fileFor(userId);
  if (!existsSync(f)) return { userId: String(userId), name: '', updatedAt: 0, notes: [], strategy: null };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return {
      userId: String(userId),
      name: j.name || '',
      updatedAt: j.updatedAt || 0,
      notes: Array.isArray(j.notes) ? j.notes : [],
      strategy: j.strategy || null
    };
  } catch {
    return { userId: String(userId), name: '', updatedAt: 0, notes: [], strategy: null };
  }
}

/** 写某人的笔记 */
export function saveNotebook(userId, nb) {
  ensureDir();
  nb.updatedAt = Date.now();
  writeFileSync(fileFor(userId), JSON.stringify(nb, null, 2), 'utf8');
  return nb;
}

/**
 * 加一条记录。
 * @param {string} userId
 * @param {{kind:string, gist:string, quote?:string, place?:string, intensity?:number}} note
 * @returns {{ok:true, note:object}|{ok:false, reason:string}}
 */
export function addNote(userId, note) {
  // 防捏造：必须有一句话概括
  const gist = String(note?.gist || '').trim();
  if (!gist) return { ok: false, reason: '没有内容' };

  const nb = loadNotebook(userId);
  const entry = {
    id: `n${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    at: Date.now(),
    kind: ['grudge', 'favor', 'trait', 'event'].includes(note.kind) ? note.kind : 'event',
    gist: gist.slice(0, 120),
    quote: String(note.quote || '').trim().slice(0, 160),   // 原话，防捏造用
    place: String(note.place || '').slice(0, 40),
    intensity: Math.max(1, Math.min(5, Number(note.intensity) || 3)),
    used: false
  };

  // 去重：同一件事别重复记
  const dup = nb.notes.find((n) => n.gist === entry.gist);
  if (dup) return { ok: false, reason: '已经记过了' };

  nb.notes.push(entry);
  // 只保留最近 60 条，避免文件无限膨胀
  if (nb.notes.length > 60) nb.notes = nb.notes.slice(-60);
  saveNotebook(userId, nb);
  return { ok: true, note: entry };
}

/**
 * 取笔记摘要，供 AI 参考或展示。
 * @param {string} userId
 * @param {{limit?:number, kinds?:string[]}} opts
 */
export function notebookSummary(userId, opts = {}) {
  const nb = loadNotebook(userId);
  let notes = nb.notes;
  if (opts.kinds?.length) notes = notes.filter((n) => opts.kinds.includes(n.kind));
  notes = notes.slice(-(opts.limit ?? 12));
  if (!notes.length) return '';
  const kindName = { grudge: '记仇', favor: '记好', trait: '印象', event: '事件' };
  return notes.map((n) => {
    const when = new Date(n.at).toLocaleDateString('zh-CN');
    const place = n.place === 'private' ? '私聊' : (n.place?.startsWith('group:') ? '群聊' : '');
    const q = n.quote ? `（他当时说：「${n.quote}」）` : '';
    return `- [${kindName[n.kind] || n.kind}] ${n.gist}${q}${place ? ` · ${place}` : ''} · ${when}`;
  }).join('\n');
}

/** 有没有值得翻出来的旧账（强度高的记仇且还没用过） */
export function pendingGrudges(userId, minIntensity = 3) {
  const nb = loadNotebook(userId);
  return nb.notes.filter((n) => n.kind === 'grudge' && !n.used && n.intensity >= minIntensity);
}

/** 标记某条已使用 */
export function markUsed(userId, noteId) {
  const nb = loadNotebook(userId);
  const n = nb.notes.find((x) => x.id === noteId);
  if (!n) return false;
  n.used = true;
  saveNotebook(userId, nb);
  return true;
}

/** 删一条（面板手动改） */
export function removeNote(userId, noteId) {
  const nb = loadNotebook(userId);
  const before = nb.notes.length;
  nb.notes = nb.notes.filter((n) => n.id !== noteId);
  if (nb.notes.length === before) return false;
  saveNotebook(userId, nb);
  return true;
}

/** 列出所有有笔记的人 */
export function listNotebooks() {
  ensureDir();
  const out = [];
  try {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      const userId = f.replace(/\.json$/, '');
      const nb = loadNotebook(userId);
      if (nb.notes.length) {
        out.push({
          userId,
          name: nb.name || '',
          count: nb.notes.length,
          updatedAt: nb.updatedAt,
          ...notebookStats(userId)
        });
      }
    }
  } catch { /* 忽略 */ }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 存这个人的「说话策略」。
 * @param {string} userId
 * @param {{summary?:string, doList?:string[], dontList?:string[], tone?:string, at:number}} strategy
 */
export function saveStrategy(userId, strategy) {
  const nb = loadNotebook(userId);
  nb.strategy = {
    summary: String(strategy.summary || '').slice(0, 200),
    tone: String(strategy.tone || '').slice(0, 60),
    doList: Array.isArray(strategy.doList) ? strategy.doList.slice(0, 5).map((s) => String(s).slice(0, 80)) : [],
    dontList: Array.isArray(strategy.dontList) ? strategy.dontList.slice(0, 5).map((s) => String(s).slice(0, 80)) : [],
    /** 生成策略时依据了几条记录 */
    basedOn: Number(strategy.basedOn) || 0,
    at: Date.now()
  };
  saveNotebook(userId, nb);
  return nb.strategy;
}

/** 读这个人的说话策略 */
export function loadStrategy(userId) {
  return loadNotebook(userId).strategy;
}

/** 把策略拼成给 AI 看的提示 */
export function strategyHint(userId) {
  const s = loadStrategy(userId);
  if (!s || !s.summary) return '';
  const parts = [`【对这个人的说话策略】${s.summary}`];
  if (s.tone) parts.push(`语气：${s.tone}`);
  if (s.doList?.length) parts.push('该做：' + s.doList.join('；'));
  if (s.dontList?.length) parts.push('别做：' + s.dontList.join('；'));
  return parts.join('\n');
}

/** 统计（面板展示用） */
export function notebookStats(userId) {
  const nb = loadNotebook(userId);
  const by = { grudge: 0, favor: 0, trait: 0, event: 0 };
  for (const n of nb.notes) by[n.kind] = (by[n.kind] || 0) + 1;
  return { total: nb.notes.length, by, updatedAt: nb.updatedAt };
}

export { DIR as NOTEBOOK_DIR };
