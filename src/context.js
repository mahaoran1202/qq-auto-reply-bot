/**
 * In-memory per-conversation context. Keeps the last N turns per user so the
 * LLM reply has continuity without storing anything to disk.
 */
export class ContextStore {
  constructor(maxTurns = 6) {
    this.maxTurns = maxTurns;
    this.conversations = new Map();
  }

  push(userId, role, content, maxTurns = this.maxTurns) {
    if (!this.conversations.has(userId)) this.conversations.set(userId, []);
    const turns = this.conversations.get(userId);
    turns.push({ role, content });
    // Keep last maxTurns (plus a little slack), and cap total.
    while (turns.length > maxTurns) turns.shift();
  }

  get(userId) {
    return this.conversations.get(userId) || [];
  }

  /** Build messages array for the chat completion API. */
  toMessages(userId, systemPrompt, maxTurns = this.maxTurns) {
    const history = this.get(userId).slice(-maxTurns);
    return [{ role: 'system', content: systemPrompt }, ...history];
  }

  clear(userId) {
    this.conversations.delete(userId);
  }
}
