// ============================================================
// Quran Cipher — Netlify AI Proxy Function
// Built by: Rahmat Khan Afghan
// ============================================================

const ALLOWED_PROVIDERS = ['groq', 'claude', 'gemini', 'gpt', 'deepseek'];

const PROVIDER_CONFIGS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    type: 'openai',
    envKey: 'GROQ_API_KEY',
  },
  claude: {
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    type: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    model: 'gemini-2.0-flash',
    type: 'gemini',
    envKey: 'GEMINI_API_KEY',
  },
  gpt: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    type: 'openai',
    envKey: 'OPENAI_API_KEY',
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    type: 'openai',
    envKey: 'DEEPSEEK_API_KEY',
  }
};

const _rateLimits = {};
const RATE_LIMIT_PER_MIN = 15;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!_rateLimits[ip] || now > _rateLimits[ip].resetAt) {
    _rateLimits[ip] = { count: 0, resetAt: now + 60000 };
  }
  if (_rateLimits[ip].count >= RATE_LIMIT_PER_MIN) return false;
  _rateLimits[ip].count++;
  return true;
}

async function callOpenAICompat(cfg, key, messages, systemPrompt, maxTokens) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')]
    : messages.filter(m => m.role !== 'system');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: cfg.model, messages: msgs, max_tokens: maxTokens || 1000, stream: false }),
  });
  if (res.status === 401) throw { status: 401, message: 'Invalid API key' };
  if (res.status === 429) throw { status: 429, message: 'Rate limit exceeded' };
  if (!res.ok) throw { status: res.status, message: 'Provider error ' + res.status };
  const data = await res.json();
  if (data.error) throw { status: 400, message: data.error.message || 'Provider error' };
  return data.choices?.[0]?.message?.content || '';
}

async function callClaude(cfg, key, messages, systemPrompt, maxTokens) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens || 1000,
      system: systemPrompt || 'You are a knowledgeable Islamic scholar specializing in Quran.',
      messages: messages.filter(m => m.role !== 'system'),
    }),
  });
  if (res.status === 401) throw { status: 401, message: 'Invalid Claude API key' };
  if (res.status === 429) throw { status: 429, message: 'Claude rate limit' };
  if (!res.ok) throw { status: res.status, message: 'Claude error ' + res.status };
  const data = await res.json();
  if (data.error) throw { status: 400, message: data.error.message || 'Claude error' };
  return data.content?.[0]?.text || '';
}

async function callGemini(cfg, key, messages, systemPrompt, maxTokens) {
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens || 1000 } };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 400 || res.status === 403) throw { status: 403, message: 'Invalid Gemini key' };
  if (res.status === 429) throw { status: 429, message: 'Gemini rate limit' };
  if (!res.ok) throw { status: res.status, message: 'Gemini error ' + res.status };
  const data = await res.json();
  if (data.error) throw { status: 400, message: data.error.message || 'Gemini error' };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (body.ping) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, version: 'quran-cipher-proxy-v1' }) };

  const { provider = 'groq', messages, systemPrompt, maxTokens } = body;

  if (!ALLOWED_PROVIDERS.includes(provider))
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown provider: ' + provider }) };
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages required' }) };

  const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip))
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };

  const cfg = PROVIDER_CONFIGS[provider];
  const envKey = process.env[cfg.envKey] || '';
  const userKey = typeof body.userKey === 'string' ? body.userKey.trim() : '';
  const apiKey = envKey || userKey;

  if (!apiKey)
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'NO_KEY:' + provider, message: 'API key not configured' }) };

  try {
    let text = '';
    if (cfg.type === 'openai') text = await callOpenAICompat(cfg, apiKey, messages, systemPrompt, maxTokens);
    else if (cfg.type === 'anthropic') text = await callClaude(cfg, apiKey, messages, systemPrompt, maxTokens);
    else if (cfg.type === 'gemini') text = await callGemini(cfg, apiKey, messages, systemPrompt, maxTokens);
    return { statusCode: 200, headers, body: JSON.stringify({ text, provider }) };
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Internal server error';
    if (status === 401 || status === 403)
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'NO_KEY:' + provider, message }) };
    return { statusCode: status, headers, body: JSON.stringify({ error: message }) };
  }
};
