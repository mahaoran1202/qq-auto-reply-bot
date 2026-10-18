/**
 * 群聊「要不要插话」判断器。
 *
 * 目的：群里消息量大，如果每条都调一次完整生成，token 会烧得很快。
 * 所以先用一次极短的调用问模型「这句该不该我接」，只有答案为「该」时才走完整回复。
 *
 * 省钱做法：
 *  - 用极小的 max_tokens（8），只让它吐一个数字；
 *  - 可选 judgeModel（例如更便宜的模型）单独指定；
 *  - 同一群连续刷屏时复用上一次的判断，不重复问。
 */

const JUDGE_SYSTEM = `你是一个群聊插话判断器。给你一小段群聊记录和最新一条消息，判断「我」现在应该发言吗。

只在下列情况回答 5 或 4：
- 这条消息就是在问我、或在回应我刚说的话
- 话题明显跟我有关（提到我的昵称、在讨论我）
- 有人在群里求助，且我能给出确切有用的回答

下列情况回答 1 或 2：
- 只是群友之间的日常闲聊、斗图、刷屏
- 与我无关的八卦、别人的私事
- 广告、链接、无意义字符、纯表情
- 单纯打招呼但没人理我

回答 3 表示说不准、可以插一句。

只输出一个数字（1~5），不要任何其他文字、标点或解释。`;

/**
 * 判断是否插话。
 * @returns {Promise<{speak:boolean, score:number, reason:string}>}
 */
export async function judgeShouldSpeak({ chatFn, config, history, latest, selfName, atMe }) {
  // 被 @ 了就直接回，不用花钱判断
  if (atMe) return { speak: true, score: 5, reason: 'at_me' };

  const g = config.bot?.group || {};
  if (g.autoJudge === false) return { speak: false, score: 0, reason: 'auto_judge_off' };

  // ── 语义修正 ──
  // 面板上的 judgeThreshold 是「积极程度」：
  //   1 = 几乎不插话（最安静）
  //   3 = 正常
  //   5 = 很爱接话
  // 而 AI 给出的 score 也是 1~5（越高越该说），所以判断条件是 score >= 阈值。
  // 这样 1 表示"只要不是明显不该说就说"……不对，那是最爱说。
  //
  // 正确映射：积极程度 = 6 - 阈值要求。
  // 即：用户设 1 → 只有 score=5（非常确定该说）才回；
  //     用户设 5 → score>=1 就回（几乎都回）。
  const eagerness = Math.max(1, Math.min(5, Number(g.judgeThreshold) || 3));
  const requiredScore = 6 - eagerness;   // 1→5, 3→3, 5→1

  // 记录很短，省 token：只给最近 8 条
  const lines = (history || []).slice(-8).map((h) => {
    const who = h.role === 'assistant' ? (selfName || '我') : (h.name || '群友');
    return `${who}: ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 120)}`;
  });
  lines.push(`【最新】${latest?.name || '群友'}: ${String(latest?.content || '').replace(/\s+/g, ' ').slice(0, 200)}`);

  const user = [
    selfName ? `我在群里的昵称：${selfName}` : '',
    '最近的群聊：',
    lines.join('\n'),
    '',
    '现在我应该发言吗？只回一个数字 1~5。'
  ].filter(Boolean).join('\n');

  try {
    const judgeCfg = { ...config, deepseek: { ...config.deepseek } };
    if (g.judgeModel) judgeCfg.deepseek.model = g.judgeModel;
    judgeCfg.deepseek.maxTokens = 8;
    judgeCfg.deepseek.temperature = 0;
    judgeCfg.deepseek.timeoutMs = 15000;

    const out = await chatFn(
      [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
      judgeCfg
    );
    const m = String(out).match(/[1-5]/);
    const score = m ? Number(m[0]) : 0;
    // 积极程度 1 → 需要 score>=5（几乎不插话）
    // 积极程度 3 → 需要 score>=3（正常）
    // 积极程度 5 → 需要 score>=1（很爱接话）
    return {
      speak: score >= requiredScore,
      score,
      reason: `judge_${score}(需要>=${requiredScore})`
    };
  } catch (e) {
    // 判断失败时保守处理：不插话（省钱优先），被 @ 的情况在上面已经提前返回了
    return { speak: false, score: 0, reason: 'judge_error: ' + e.message };
  }
}
