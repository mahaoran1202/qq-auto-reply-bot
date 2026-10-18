import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeStyle } from './deepseek.js';
import { extractText } from './message.js';
import { Recorder } from './recorder.js';
import { saveConfigFile, ROOT } from './config.js';

const MARKER = join(ROOT, '.style_learned');

/**
 * One-time style learning. Scrapes the conversation with the target user via
 * the history API (if supported), keeps ONLY "your own" messages, summarizes
 * your speaking style with ONE LLM call, and stores it in persona.stylePrompt.
 * Never runs again once stylePrompt is set (so it won't burn tokens).
 */
export async function learnOwnStyle(client, config, log = console.log) {
  const persona = config.persona || {};
  if (persona.stylePrompt && persona.stylePrompt.trim()) {
    return { learned: false, reason: 'already_learned' };
  }
  if (existsSync(MARKER)) {
    return { learned: false, reason: 'already_learned_marker' };
  }

  const learnCfg = config.bot?.learnStyle || {};
  const userId = (learnCfg.userId || config.bot?.allowedUsers?.[0] || '').toString();
  if (!userId) {
    log('[style] no userId to learn from (set bot.learnStyle.userId)');
    return { learned: false, reason: 'no_userId' };
  }

  // 1) Whose messages are "mine"?
  const selfInfo = await client.getSelfId();
  const selfId = selfInfo.ok ? selfInfo.userId : null;
  if (!selfId) {
    log(`[style] cannot get own QQ id (${selfInfo.reason}) — falling back to recorded messages.`);
  }

  // 2) Try to scrape history, else fall back to the recorder.
  let ownTexts = [];
  if (selfId) {
    const hist = await client.fetchFriendHistory(userId, learnCfg.maxSamples || 400);
    if (hist.ok && hist.messages.length) {
      ownTexts = hist.messages
        .map((m) => ({ text: extractText(m.message), sender: m.sender?.user_id ?? m.user_id }))
        .filter((m) => m.text && String(m.sender) === String(selfId))
        .map((m) => m.text);
      log(`[style] scraped history with ${userId}: got ${hist.messages.length} messages, ${ownTexts.length} of mine.`);
    } else {
      log(`[style] history API unavailable (${hist.reason}) — using recorded messages instead.`);
    }
  }

  if (ownTexts.length < 3) {
    const rec = new Recorder(config.record?.dir || 'records');
    const recMine = rec.myMessages(userId);
    if (recMine.length > ownTexts.length) {
      ownTexts = recMine;
      log(`[style] using ${ownTexts.length} recorded messages because history gave too few.`);
    }
  }

  if (ownTexts.length < 3) {
    log(`[style] not enough of YOUR messages (${ownTexts.length}). Send the friend a few messages while the bot is running, or use the control panel to paste your own messages.`);
    return { learned: false, reason: 'insufficient_samples', samples: ownTexts.length };
  }

  // 3) ONE LLM call to summarize style only (no content).
  const style = await analyzeStyle(ownTexts, config);

  // 4) Persist so it never re-runs.
  saveConfigFile({ persona: { stylePrompt: style } });
  writeFileSync(MARKER, new Date().toISOString(), 'utf8');

  log(`[style] learned your speaking style from ${ownTexts.length} of your messages and saved it to persona.stylePrompt.`);
  return { learned: true, samples: ownTexts.length, style };
}
