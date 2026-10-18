/**
 * LLM 调用层。支持两条通道（面板里可切换，也可以按用途分别指定）：
 *
 *  1) deepseek —— DeepSeek 官方。除了 chat，还能查余额（/user/balance）。
 *  2) openai   —— 任何 OpenAI 兼容接口。填 baseUrl + model + （可选）apiKey，就能接：
 *                  · 其他云厂商的兼容端点（智谱/Kimi/通义/硅基流动/OpenRouter…）
 *                  · 中转站
 *                  · 本地模型：Ollama(http://127.0.0.1:11434/v1)、LM Studio(:1234/v1)、
 *                    vLLM、llama.cpp server、one-api / new-api 等
 *                 本地模型通常不需要 key，留空即可。
 *
 * 上层通过 resolveProvider(config, purpose) 拿到该用哪条通道，再交给 chat()。
 * purpose: 'reply'（正常回话）| 'judge'（群聊插话判断）| 'style'（风格分析）
 */

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

/** 判断是否本机/局域网地址（这类地址不带 key 也放行，且不走余额检查） */
export function isLocalUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '0.0.0.0' ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h)
    );
  } catch {
    return false;
  }
}

/**
 * 决定某次调用用哪条通道。
 * config.llm = {
 *   active: 'deepseek' | 'openai',
 *   purposes: { reply?:'deepseek'|'openai', judge?:..., style?:... },  // 可选，按用途分流
 *   openai: { baseUrl, apiKey, model, temperature, maxTokens, timeoutMs }
 * }
 * 兼容老配置：没有 config.llm 时，直接用 config.deepseek。
 */
export function resolveProvider(config, purpose = 'reply') {
  const llm = config.llm || {};
  const ds = config.deepseek || {};

  const pick = llm.purposes?.[purpose] || llm.active || 'deepseek';

  if (pick === 'openai') {
    const o = llm.openai || {};
    const baseUrl = trimSlash(o.baseUrl || '');
    // 关键修正：很多人把 baseUrl 填成 https://host/v1/chat/completions，
    // 这里自动剥掉尾巴，统一成「到 /v1 为止」再拼 /chat/completions。
    let base = baseUrl
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/completions\/?$/i, '');
    if (base && !/\/v\d+$/i.test(base) && !/\/api$/i.test(base)) {
      // 没写版本号的，多数兼容端点都要 /v1
      base = base + '/v1';
    }
    return {
      kind: 'openai',
      name: o.name || 'OpenAI 兼容',
      baseUrl: base,
      apiKey: o.apiKey || '',
      model: o.model || '',
      temperature: o.temperature ?? ds.temperature ?? 0.8,
      maxTokens: o.maxTokens ?? ds.maxTokens ?? 800,
      timeoutMs: o.timeoutMs ?? ds.timeoutMs ?? 60000
    };
  }

  return {
    kind: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: trimSlash(ds.baseUrl || 'https://api.deepseek.com'),
    apiKey: ds.apiKey || '',
    model: ds.model || 'deepseek-chat',
    temperature: ds.temperature ?? 0.8,
    maxTokens: ds.maxTokens ?? 800,
    timeoutMs: ds.timeoutMs ?? 60000
  };
}

/** 这条通道配置是否可用（本地地址允许没有 key） */
export function providerReady(p) {
  if (!p) return { ok: false, error: '没有可用通道' };
  if (!p.baseUrl) return { ok: false, error: 'baseUrl 为空' };
  if (!p.model) return { ok: false, error: 'model 未填写' };
  if (!p.apiKey && !isLocalUrl(p.baseUrl)) {
    return { ok: false, error: `通道「${p.name}」缺少 API Key` };
  }
  return { ok: true };
}

/** 组装请求头（本地服务不需要 Authorization） */
function headersFor(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h['Authorization'] = `Bearer ${p.apiKey}`;
  if (p.kind === 'openai' && p.extraHeaders && typeof p.extraHeaders === 'object') {
    Object.assign(h, p.extraHeaders);
  }
  return h;
}

/**
 * 真正发请求。provider 由 resolveProvider 给出；也可以直接传 config（自动按 reply 解析）。
 */
export async function chatWithProvider(messages, provider) {
  const p = provider?.kind ? provider : resolveProvider(provider, 'reply');
  const ready = providerReady(p);
  if (!ready.ok) throw new Error(ready.error);

  const url = `${p.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs || 60000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: headersFor(p),
      body: JSON.stringify({
        model: p.model,
        messages,
        temperature: p.temperature,
        max_tokens: p.maxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`${p.name} HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }

    const json = await resp.json();
    const content =
      json?.choices?.[0]?.message?.content ??
      json?.choices?.[0]?.text ??
      json?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`${p.name} 返回格式不认识: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return stripThinking(content).trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 剥掉推理模型的思维链。
 * 本地 qwen3 / deepseek-r1 等会把思考过程放在  thinking…<｜end▁of▁thinking｜> 里一起返回，
 * 直接发给对方会很怪，这里统一清掉。
 */
export function stripThinking(text) {
  let s = String(text ?? '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // 只有开标签没闭合（被 max_tokens 截断）时，丢掉开标签之前的所有内容
  s = s.replace(/^[\s\S]*?<\/think(?:ing)?>/i, '');
  // 智谱等用 <|thinking|> 风格
  s = s.replace(/<\|?(?:thinking|reasoning)\|?>[\s\S]*?<\/(?:thinking|reasoning)>/gi, '');
  return s.replace(/^\s*<\/think(?:ing)?>/i, '').trim();
}

/** 兼容老签名：chat(messages, config, purpose) */
export async function chat(messages, config, purpose = 'reply') {
  const p = resolveProvider(config, purpose);
  const out = await chatWithProvider(messages, p);

  // 保护：推理模型（本地 qwen3 / deepseek-r1 等）会先输出思维链，
  // 如果 max_tokens 太小，思维链还没写完就被截断，正文会是空的。
  // 这种情况自动放宽 token 再试一次，避免对方收到一片空白。
  if (!out && (p.maxTokens || 0) < 2048) {
    try {
      const retry = await chatWithProvider(messages, { ...p, maxTokens: 2048, timeoutMs: Math.max(p.timeoutMs || 60000, 120000) });
      if (retry) return retry;
    } catch { /* 重试失败就用原结果 */ }
  }
  return out;
}

/** 连通性/模型列表自检：面板上「测试连接」用 */
export async function testProvider(config, which = 'reply') {
  const p = resolveProvider(config, which);
  const ready = providerReady(p);
  if (!ready.ok) return { ok: false, provider: p.name, error: ready.error };
  const t0 = Date.now();
  try {
    const out = await chatWithProvider(
      [{ role: 'user', content: '回复一个「好」字即可' }],
      { ...p, maxTokens: 16, timeoutMs: Math.min(p.timeoutMs || 60000, 30000) }
    );
    return { ok: true, provider: p.name, baseUrl: p.baseUrl, model: p.model, ms: Date.now() - t0, sample: String(out).slice(0, 60) };
  } catch (e) {
    return { ok: false, provider: p.name, baseUrl: p.baseUrl, model: p.model, ms: Date.now() - t0, error: e.message };
  }
}

/** 拉取可用模型列表（OpenAI 兼容的 /models 接口），方便面板下拉选择 */
export async function listModels(config, which = 'reply') {
  const p = resolveProvider(config, which);
  try {
    const resp = await fetch(`${p.baseUrl}/models`, { headers: headersFor(p) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const json = await resp.json();
    const ids = (json?.data || json?.models || [])
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
      .filter(Boolean);
    return { ok: true, models: [...new Set(ids)].sort() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 查余额。只有 DeepSeek 官方支持这个接口，其它通道返回不支持。
 */
export async function getBalance(config) {
  const p = resolveProvider(config, 'reply');
  if (p.kind !== 'deepseek') {
    return { ok: false, balance: null, currency: null, error: `通道「${p.name}」不支持余额查询（仅 DeepSeek 官方支持）` };
  }
  if (!p.apiKey) return { ok: false, balance: null, currency: null, error: 'no api key' };
  const url = `${p.baseUrl}/user/balance`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${p.apiKey}` }, signal: controller.signal });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, balance: null, currency: null, error: `HTTP ${resp.status}: ${detail.slice(0, 200)}` };
    }
    const json = await resp.json();
    const infos = json.balance_infos || [];
    const info = infos.find((b) => b.currency === 'CNY') || infos[0];
    const balance = info ? parseFloat(info.total_balance) : null;
    return { ok: true, balance, currency: info?.currency || null, is_available: json.is_available };
  } catch (e) {
    return { ok: false, balance: null, currency: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 让模型总结「我」的说话风格。
 */
export async function analyzeStyle(samples, config, purpose = 'style') {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('No samples provided to analyzeStyle');
  }
  const sampleText = samples.slice(0, 200).join('\n').slice(0, 12000);
  const messages = [
    {
      role: 'system',
      content: '你是一个文本风格分析师。根据下面提供的「我」自己发出的聊天消息样本，总结我的说话风格：语气、常用词、句长、表情/标点习惯、口头禅、是否有特定称呼、消息组织的规律。用简洁的中文条目描述，输出纯风格描述（不要输出样本内容）。'
    },
    { role: 'user', content: '以下是我的聊天记录样本：\n\n' + sampleText }
  ];
  return chat(messages, config, purpose);
}
