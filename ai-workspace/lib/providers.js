// Provider adapters: OpenRouter, Groq, custom OpenAI-compatible.
// Server-side only — keys never touch the browser (build plan §5.4, §13).
'use strict';

const sec = require('./security');

const MAX_MODEL_BODY = 4 * 1024 * 1024;
const MAX_STREAM_CHARS = Number(process.env.MAX_STREAM_CHARS) || 2 * 1024 * 1024;

const BASES = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
};

const GROQ_CONTEXT = [
  [/llama-3\.3-70b/, 131072], [/llama-3\.1-8b/, 131072], [/llama3-70b/, 8192], [/llama3-8b/, 8192],
  [/gemma2-9b/, 8192], [/gemma-7b/, 8192], [/mixtral-8x7b/, 32768], [/llama-guard/, 8192],
  [/llama-4/, 131072], [/deepseek-r1-distill/, 131072], [/qwen-qwq/, 131072],
];

function baseUrlFor(cred) {
  if (cred.provider === 'custom') {
    // Shape-only check (sync callers). Use assertUsableBase() before any fetch.
    const raw = (cred.baseUrl || '').replace(/\/+$/, '');
    sec.assertSafeUrl(raw, { requireHttps: false });
    return raw;
  }
  const base = BASES[cred.provider];
  if (!base) throw Object.assign(new Error('Unknown provider.'), { status: 400 });
  return base;
}

function headersFor(apiKey, provider) {
  // Header-injection guard: a key containing CR/LF could forge extra headers.
  const key = String(apiKey || '').replace(/[\r\n\0]/g, '');
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    h['HTTP-Referer'] = 'https://ai-workspace.local';
    h['X-Title'] = 'AI Workspace (demo build)';
  }
  return h;
}

function normalizeError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = j?.error?.message || j?.message || ''; } catch { detail = bodyText?.slice(0, 300) || ''; }
  const map = {
    401: { code: 'invalid_key', message: 'We couldn\u2019t use this API key. Check that it\u2019s correct and active.', retryable: false },
    403: { code: 'invalid_key', message: 'This key was rejected by the provider (permission denied).', retryable: false },
    402: { code: 'billing', message: 'The provider says this key has no credit or an unpaid balance.', retryable: false },
    404: { code: 'model_not_found', message: 'The model was not found at the provider. Try refreshing the model list.', retryable: false },
    429: { code: 'rate_limited', message: 'The provider is rate-limiting this key right now. Try again in a moment.', retryable: true },
  };
  if (map[status]) return map[status];
  if (status === 400 && /context|token|length/i.test(detail)) {
    return { code: 'context_exceeded', message: 'This message is too long for the model\u2019s context window. Trim attachments or history.', retryable: false, detail };
  }
  if (status >= 500) return { code: 'overloaded', message: `The provider is having trouble (HTTP ${status}). Retry shortly.`, retryable: true, detail };
  return { code: 'unknown', message: detail || `Provider error (HTTP ${status}).`, retryable: false };
}

// Authenticated key check (OpenRouter exposes /models publicly, so list-fetch is not proof of a valid key).
async function verifyKey(cred, apiKey) {
  if (cred.provider === 'openrouter') {
    const res = await fetch(`${BASES.openrouter}/auth/key`, { headers: headersFor(apiKey, 'openrouter'), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw normalizeError(res.status, await res.text().catch(() => ''));
    return true;
  }
  await listModels(cred, apiKey); // groq/custom: /models requires the key
  return true;
}

// Re-resolve custom hosts immediately before every outbound call. Checking DNS
// only when the credential is saved leaves a TOCTOU window: a host that resolved
// public at save time can be re-pointed at 127.0.0.1 later (DNS rebinding).
async function assertUsableBase(cred) {
  const base = baseUrlFor(cred);
  if (cred.provider === 'custom') await sec.assertResolvesPublic(base);
  return base;
}

// ---- model catalog ----
function looksLikeVision(provider, modelId, meta) {
  if (meta?.architecture?.input_modalities?.includes?.('image')) return true;
  const id = modelId.toLowerCase();
  if (provider === 'groq') return /vision|llava|llama-4/.test(id);
  return /vision|gpt-4o|gpt-4-turbo|claude-3|claude-sonnet|claude-opus|gemini|pixtral|llava|qwen2\.5-vl|qwen-vl|internvl|yi-vision|deepseek-chat-v3|grok-2-vision/.test(id);
}

async function listModels(cred, apiKey) {
  const base = await assertUsableBase(cred);
  const res = await fetch(`${base}/models`, { headers: headersFor(apiKey, cred.provider), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw normalizeError(res.status, text);
  if (text.length > MAX_MODEL_BODY) throw Object.assign(new Error('The provider returned an unexpectedly large model list.'), { status: 502 });
  let json;
  try { json = JSON.parse(text); } catch { throw Object.assign(new Error('The provider returned a malformed model list.'), { status: 502 }); }
  const raw = Array.isArray(json) ? json : json.data || [];
  return raw.map((m) => {
    const pricing = m.pricing || {};
    const ctx = m.context_length
      || (GROQ_CONTEXT.find(([re]) => re.test(m.id)) || [])[1]
      || (cred.provider === 'groq' ? 8192 : undefined);
    return {
      id: m.id,
      name: m.name || m.id,
      vision: looksLikeVision(cred.provider, m.id, m),
      context: ctx || null,
      inputCostPerMtok: pricing.prompt ? Math.round(parseFloat(pricing.prompt) * 1e6 * 100) / 100 : null,
      outputCostPerMtok: pricing.completion ? Math.round(parseFloat(pricing.completion) * 1e6 * 100) / 100 : null,
      source: 'provider',
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// ---- streaming chat ----
async function streamChat({ cred, apiKey, model, messages, temperature = 0.7, maxTokens, signal, onEvent }) {
  const base = await assertUsableBase(cred);
  const body = { model, messages, stream: true, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (cred.provider === 'openrouter') body.stream_options = { include_usage: true };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: headersFor(apiKey, cred.provider), body: JSON.stringify(body), signal, redirect: 'error',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw normalizeError(res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  let finishReason = null;

  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let j; try { j = JSON.parse(payload); } catch { return; }
    if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
    const choice = j.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta?.content;
    if (delta) {
      if (full.length + delta.length > MAX_STREAM_CHARS) { finishReason = finishReason || 'length_guard'; return; }
      full += delta; onEvent({ type: 'delta', text: delta });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) handleLine(l);
  }
  if (buf) handleLine(buf);

  // estimate tokens if provider gave no usage
  if (!usage) {
    const approx = (s) => Math.ceil(s.length / 4);
    usage = {
      input: approx(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ')),
      output: approx(full),
      estimated: true,
    };
  }
  return { text: full, usage, finishReason };
}

module.exports = { baseUrlFor, assertUsableBase, headersFor, listModels, streamChat, normalizeError, looksLikeVision, verifyKey };
