import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Records private-message traffic per user and can export it to a plain-text
 * file for style analysis. Recording is toggled by the content of
 * <dir>/.enabled  ("1" = on, anything else = off). Missing file = on.
 */
export class Recorder {
  constructor(dir = 'records') {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
    this.ctlPath = join(this.dir, '.enabled');
  }

  isEnabled() {
    if (!existsSync(this.ctlPath)) return true; // default on
    const v = readFileSync(this.ctlPath, 'utf8').trim();
    return v === '1';
  }

  setEnabled(on) {
    writeFileSync(this.ctlPath, on ? '1' : '0', 'utf8');
  }

  fileFor(userId) {
    return join(this.dir, `${userId}.jsonl`);
  }

  /**
   * role: 'them'（对方）/ 'me'（机器人替你说的）/ 'me-self'（你自己在聊天框打的）
   */
  append(userId, role, text) {
    if (!this.isEnabled()) return;
    const entry = { ts: Date.now(), userId: String(userId), role, text };
    appendFileSync(this.fileFor(userId), JSON.stringify(entry) + '\n', 'utf8');
  }

  /** Read all recorded entries for a user, oldest first. */
  entriesFor(userId) {
    const file = this.fileFor(userId);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (String(e.userId) === String(userId)) out.push(e);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  }

  usersOnRecord() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  }

  /**
   * Write a human-readable export for a user to <exports>/chat_<userId>.txt.
   * Lines look like "HH:MM 我: ..." / "HH:MM 对方: ...".
   * Returns the export path.
   */
  exportFor(userId, outDir = 'exports') {
    const entries = this.entriesFor(userId);
    const lines = ['# 聊天记录导出', '# 我: 你的消息（含机器人替你回的话）', '# 对方: 对方的消息', '', ''];
    const fmt = (ts) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    for (const e of entries) {
      const who = e.role === 'me' ? '我' : '对方';
      lines.push(`${fmt(e.ts)} ${who}: ${e.text}`);
    }
    mkdirSync(outDir, { recursive: true });
    const path = resolve(join(outDir, `chat_${userId}.txt`));
    writeFileSync(path, lines.join('\n'), 'utf8');
    return path;
  }

  /** Extract only "my" (role=me) messages — the style-corpus. */
  myMessages(userId) {
    return this.entriesFor(userId).filter((e) => e.role === 'me').map((e) => e.text);
  }

  /** Extract only "them" messages. */
  theirMessages(userId) {
    return this.entriesFor(userId).filter((e) => e.role === 'them').map((e) => e.text);
  }
}
