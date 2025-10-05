import { fetch } from 'undici';
import { Readable } from 'node:stream';

// Fixed base and client defaults
const FIXED_LINGXI_BASE_URL = 'https://lingxi.wps.cn';
const ENV_LINGXI_SESSION_ID = process.env.LINGXI_SESSION_ID; // e.g. 9776791727556322
const ENV_LINGXI_COOKIE = process.env.LINGXI_COOKIE; // raw cookie string with wps_sid etc.
const ENV_LINGXI_USER_AGENT = process.env.LINGXI_USER_AGENT || 'Mozilla/5.0';
const ENV_LINGXI_CLIENT_TYPE = process.env.LINGXI_CLIENT_TYPE || 'h5';
const DEFAULT_REFRESH_URL = 'https://account.wps.cn/p/auth/check';
const ENV_LINGXI_REFRESH_URL = process.env.LINGXI_REFRESH_URL; // optional endpoint to refresh cookies
const ENV_LINGXI_LOG = String(process.env.LINGXI_LOG || '').toLowerCase(); // '1'|'true' to enable
const ENV_LINGXI_ENABLE_AUTO_REFRESH = String(process.env.LINGXI_ENABLE_AUTO_REFRESH ?? '1').toLowerCase();
const ENV_LINGXI_REFRESH_INTERVAL_MS = Number(process.env.LINGXI_REFRESH_INTERVAL_MS || 3600000); // default 1h

// In-memory cookie that can be updated at runtime based on Set-Cookie
let INMEM_LINGXI_COOKIE = ENV_LINGXI_COOKIE || '';

function isLogEnabled(req) {
  const h = req.headers || {};
  const hv = String(h['x-log'] || h['x-logging'] || '').toLowerCase();
  const enabledByHeader = hv === '1' || hv === 'true' || hv === 'yes';
  const enabledByEnv = ENV_LINGXI_LOG === '1' || ENV_LINGXI_LOG === 'true' || ENV_LINGXI_LOG === 'yes';
  return enabledByHeader || enabledByEnv;
}

function maskCookie(cookieStr) {
  if (!cookieStr) return '';
  return cookieStr
    .split(';')
    .map(kv => {
      const [k, v] = kv.split('=');
      if (!v) return kv.trim();
      const key = k.trim();
      const val = v.trim();
      if (!val) return `${key}=`;
      const kept = val.slice(0, 4);
      return `${key}=${kept}***`;
    })
    .join('; ');
}

function maskQuestionPayload(payload) {
  try {
    if (!payload) return payload;
    const q = payload.question || '';
    const brief = q.length > 160 ? `${q.slice(0, 160)}...(${q.length})` : q;
    return { ...payload, question: brief };
  } catch {
    return payload;
  }
}

function parseSetCookieArray(res) {
  try {
    // Undici supports getSetCookie()
    const arr = res.headers?.getSetCookie?.();
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function mergeSetCookieIntoCookie(existingCookie, setCookieArray) {
  if (!setCookieArray || setCookieArray.length === 0) return existingCookie || '';
  const jar = new Map();
  const pushToJar = (cookieStr) => {
    cookieStr.split(';').forEach(part => {
      const [k, v] = part.split('=');
      if (!v) return;
      const key = k.trim();
      const val = v.trim();
      if (!key || !val) return;
      // ignore attributes like Path, HttpOnly etc. by keeping only first pair
      if (!jar.has(key)) jar.set(key, val);
    });
  };
  if (existingCookie) pushToJar(existingCookie);
  for (const sc of setCookieArray) {
    const firstPair = (sc || '').split(';')[0];
    if (firstPair) pushToJar(firstPair);
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function maybeRefreshCookie(cfg) {
  if (!cfg.refreshUrl) return false;
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'cookie': cfg.cookie || INMEM_LINGXI_COOKIE,
    'user-agent': cfg.userAgent,
    'origin': FIXED_LINGXI_BASE_URL,
    'referer': `${FIXED_LINGXI_BASE_URL}/`
  };
  const resp = await fetch(cfg.refreshUrl, {
    method: 'POST',
    headers,
    body: ''
  });
  if (cfg.logEnabled) console.log('[Lingxi][refresh] %s -> %d', cfg.refreshUrl, resp.status);
  const setCookies = parseSetCookieArray(resp);
  if (setCookies.length > 0) {
    INMEM_LINGXI_COOKIE = mergeSetCookieIntoCookie(cfg.cookie || INMEM_LINGXI_COOKIE, setCookies);
    if (cfg.logEnabled) console.log('[Lingxi][refresh cookie merged] %s', maskCookie(INMEM_LINGXI_COOKIE));
  }
  // Consider 2xx as a successful refresh even without Set-Cookie (server-side TTL bump)
  return resp.ok;
}

function resolveLingxiConfig(req) {
  const h = req.headers || {};
  const baseUrl = h['x-lingxi-base-url'] || FIXED_LINGXI_BASE_URL;
  const sessionId = h['x-lingxi-session-id'] || ENV_LINGXI_SESSION_ID;
  const cookie = h['x-lingxi-cookie'] || ENV_LINGXI_COOKIE;
  const userAgent = h['x-lingxi-user-agent'] || ENV_LINGXI_USER_AGENT;
  const clientType = h['x-lingxi-client-type'] || ENV_LINGXI_CLIENT_TYPE;
  const ssePath = h['x-lingxi-sse-path'] || (sessionId ? `/api/aigc/v3/assistant/sessions/${sessionId}/completions` : undefined);
  const referer = h['x-lingxi-referer'] || (sessionId ? `${baseUrl}/chat/${sessionId}` : undefined);
  const refreshUrl = h['x-lingxi-refresh-url'] || ENV_LINGXI_REFRESH_URL || DEFAULT_REFRESH_URL;
  const logEnabled = isLogEnabled(req);
  return { baseUrl, sessionId, cookie, userAgent, clientType, ssePath, referer, refreshUrl, logEnabled };
}

function ensureLingxiEnv(config) {
  if (!config.sessionId) throw new Error('Missing LINGXI_SESSION_ID (or x-lingxi-session-id)');
  if (!config.cookie) throw new Error('Missing LINGXI_COOKIE (or x-lingxi-cookie)');
}

function toLingxiPayloadFromOpenAI(body) {
  const question = Array.isArray(body?.messages)
    ? body.messages.map(m => m.content).filter(Boolean).join('\n')
    : (body?.prompt || body?.input || '');

  return {
    question,
    file_ids: [],
    upload_ids: [],
    collect_ids: [],
    quote_files: [],
    quote_images: [],
    thinking: 'enabled',
    command: ''
  };
}

function mapLingxiTextToOpenAIChoice(text, reasoningText) {
  const message = {
    role: 'assistant',
    content: text || ''
  };
  if (reasoningText) {
    message.reasoning_content = reasoningText;
  }
  return {
    index: 0,
    finish_reason: 'stop',
    message
  };
}

function mkOpenAICompletionResponse({ id = 'chatcmpl-temp', created = Math.floor(Date.now() / 1000), model = 'lingxi', choices, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices,
    usage: usage || {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null
    }
  };
}

function parseLingxiChunkToParts(obj) {
  try {
    const type = obj?.type || 'other';
    if (type === 'recommend' || type === 'recommend_start' || type === 'recommend_end' || type === 'ping' || type === 'end') {
      return { type: 'other', text: '' };
    }
    const text = typeof obj?.data === 'string' ? obj.data : (obj?.data?.text || '');
    if (type === 'reasoning') return { type: 'reasoning', text };
    if (type === 'reasoning_end') return { type: 'reasoning_end', text: '' };
    if (type === 'text' || type === 'text_start' || type === 'text_end') return { type: 'text', text };
    return { type: 'other', text: '' };
  } catch {
    return { type: 'other', text: '' };
  }
}

async function forwardLingxiNonStreaming(lingxiUrl, payload, headers) {
  const doFetch = async () => fetch(lingxiUrl, {
    method: 'POST',
    headers: {
      'accept': 'text/event-stream',
      'content-type': 'application/json',
      'cookie': headers.cookie,
      'user-agent': headers.userAgent,
      'referer': headers.referer,
      'x-client-type': headers.clientType
    },
    body: JSON.stringify(payload)
  });

  let res = await doFetch();
  if (headers.logEnabled) {
    // basic request log
    console.log('[Lingxi][non-stream] POST', lingxiUrl);
    console.log('[Lingxi][req headers] ua=%s client=%s referer=%s cookie=%s', headers.userAgent, headers.clientType, headers.referer, maskCookie(headers.cookie));
    console.log('[Lingxi][req body]', maskQuestionPayload(payload));
    console.log('[Lingxi][resp status]', res.status);
  }

  // Capture Set-Cookie to update in-memory cookie
  const setCookies1 = parseSetCookieArray(res);
  if (setCookies1.length > 0) {
    INMEM_LINGXI_COOKIE = mergeSetCookieIntoCookie(headers.cookie, setCookies1);
    headers.cookie = INMEM_LINGXI_COOKIE;
    if (headers.logEnabled) console.log('[Lingxi][cookie updated from response] %s', maskCookie(INMEM_LINGXI_COOKIE));
  }

  if (!res.ok && (res.status === 401 || res.status === 403) && headers.refreshUrl) {
    if (headers.logEnabled) console.log('[Lingxi] auth error %d, attempting cookie refresh via %s', res.status, headers.refreshUrl);
    const refreshed = await maybeRefreshCookie(headers);
    if (refreshed) {
      headers.cookie = INMEM_LINGXI_COOKIE;
      res = await doFetch();
      if (headers.logEnabled) console.log('[Lingxi] retry after refresh -> status %d', res.status);
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Lingxi HTTP ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  let buffer = '';
  let aggregatedText = '';
  let reasoningText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!chunk) continue;
      const jsonMatch = chunk.match(/\{.*\}$/s);
      if (!jsonMatch) continue;
      try {
        const obj = JSON.parse(jsonMatch[0]);
        const part = parseLingxiChunkToParts(obj);
        if (part.type === 'reasoning') {
          reasoningText += part.text || '';
        } else if (part.type === 'text') {
          aggregatedText += part.text || '';
        }
      } catch {}
    }
  }

  return { text: aggregatedText, reasoningText: reasoningText || null };
}

async function forwardLingxiStreaming(lingxiUrl, payload, headers, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const doFetch = async () => fetch(lingxiUrl, {
    method: 'POST',
    headers: {
      'accept': 'text/event-stream',
      'content-type': 'application/json',
      'cookie': headers.cookie,
      'user-agent': headers.userAgent,
      'referer': headers.referer,
      'x-client-type': headers.clientType
    },
    body: JSON.stringify(payload)
  });

  let upstream = await doFetch();
  if (headers.logEnabled) {
    console.log('[Lingxi][stream] POST', lingxiUrl);
    console.log('[Lingxi][req headers] ua=%s client=%s referer=%s cookie=%s', headers.userAgent, headers.clientType, headers.referer, maskCookie(headers.cookie));
    console.log('[Lingxi][req body]', maskQuestionPayload(payload));
    console.log('[Lingxi][resp status]', upstream.status);
  }

  // Update cookie from Set-Cookie
  const setCookies1 = parseSetCookieArray(upstream);
  if (setCookies1.length > 0) {
    INMEM_LINGXI_COOKIE = mergeSetCookieIntoCookie(headers.cookie, setCookies1);
    headers.cookie = INMEM_LINGXI_COOKIE;
    if (headers.logEnabled) console.log('[Lingxi][cookie updated from response] %s', maskCookie(INMEM_LINGXI_COOKIE));
  }

  if ((!upstream.ok || !upstream.body) && (upstream.status === 401 || upstream.status === 403) && headers.refreshUrl) {
    if (headers.logEnabled) console.log('[Lingxi] auth error %d(stream), attempting cookie refresh via %s', upstream.status, headers.refreshUrl);
    const refreshed = await maybeRefreshCookie(headers);
    if (refreshed) {
      headers.cookie = INMEM_LINGXI_COOKIE;
      upstream = await doFetch();
      if (headers.logEnabled) console.log('[Lingxi] retry after refresh(stream) -> status %d', upstream.status);
    }
  }

  if (!upstream.ok || !upstream.body) {
    res.write(`data: ${JSON.stringify({ error: { message: `Lingxi HTTP ${upstream.status}` } })}\n\n`);
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let buffer = '';

  const sendReasoningDelta = (deltaText) => {
    if (!deltaText) return;
    const data = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'lingxi',
      choices: [
        {
          index: 0,
          delta: { reasoning_content: deltaText },
          finish_reason: null
        }
      ]
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendContentDelta = (deltaText) => {
    if (!deltaText) return;
    const data = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'lingxi',
      choices: [
        {
          index: 0,
          delta: { content: deltaText },
          finish_reason: null
        }
      ]
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!chunk) continue;
        const jsonMatch = chunk.match(/\{.*\}$/s);
        if (!jsonMatch) continue;
        try {
          const obj = JSON.parse(jsonMatch[0]);
          const part = parseLingxiChunkToParts(obj);
          if (headers.logEnabled && (part.type === 'reasoning' || part.type === 'text')) {
            const preview = (part.text || '').slice(0, 80);
            console.log('[Lingxi][stream delta]', part.type, preview);
          }
          if (part.type === 'reasoning') {
            sendReasoningDelta(part.text);
          } else if (part.type === 'reasoning_end') {
            // switch to content phase (no-op here)
          } else if (part.type === 'text') {
            sendContentDelta(part.text);
          }
        } catch {}
      }
    }
  } catch (e) {
  } finally {
    res.write(`data: [DONE]\n\n`);
    res.end();
  }
}

export async function handleChatCompletions(req, res) {
  try {
    const cfg = resolveLingxiConfig(req);
    ensureLingxiEnv(cfg);

    const body = req.body || {};
    const stream = Boolean(body.stream);

    const lingxiPayload = toLingxiPayloadFromOpenAI(body);
    const lingxiUrl = `${cfg.baseUrl}${cfg.ssePath}`;
    const headers = {
      cookie: cfg.cookie || INMEM_LINGXI_COOKIE,
      userAgent: cfg.userAgent,
      clientType: cfg.clientType,
      referer: cfg.referer,
      refreshUrl: cfg.refreshUrl,
      logEnabled: cfg.logEnabled
    };

    if (stream) {
      await forwardLingxiStreaming(lingxiUrl, lingxiPayload, headers, res);
      return;
    }

    const { text, reasoningText } = await forwardLingxiNonStreaming(lingxiUrl, lingxiPayload, headers);
    const openai = mkOpenAICompletionResponse({
      choices: [mapLingxiTextToOpenAIChoice(text, reasoningText)],
      model: body.model || 'lingxi'
    });
    res.json(openai);
  } catch (err) {
    res.status(500).json({ error: { message: err?.message || 'Internal error' } });
  }
} 

// Background hourly refresh to keep cookie alive (opt-in by default)
let __autoRefreshTimer = null;
function startAutoRefreshIfNeeded() {
  const enabled = ENV_LINGXI_ENABLE_AUTO_REFRESH === '1' || ENV_LINGXI_ENABLE_AUTO_REFRESH === 'true' || ENV_LINGXI_ENABLE_AUTO_REFRESH === 'yes';
  if (!enabled) return;
  const intervalMs = Number.isFinite(ENV_LINGXI_REFRESH_INTERVAL_MS) && ENV_LINGXI_REFRESH_INTERVAL_MS > 0
    ? ENV_LINGXI_REFRESH_INTERVAL_MS
    : 3600000;
  if (__autoRefreshTimer) return; // avoid duplicates
  const cfg = {
    refreshUrl: ENV_LINGXI_REFRESH_URL || DEFAULT_REFRESH_URL,
    cookie: INMEM_LINGXI_COOKIE,
    userAgent: ENV_LINGXI_USER_AGENT,
    referer: `${FIXED_LINGXI_BASE_URL}/`,
    logEnabled: ENV_LINGXI_LOG === '1' || ENV_LINGXI_LOG === 'true' || ENV_LINGXI_LOG === 'yes'
  };
  const tick = async () => {
    try {
      await maybeRefreshCookie(cfg);
      // update cookie reference in cfg after potential merge
      cfg.cookie = INMEM_LINGXI_COOKIE;
    } catch (e) {
      if (cfg.logEnabled) console.error('[Lingxi][auto-refresh error]', e?.message || e);
    }
  };
  // initial attempt soon after startup
  setTimeout(tick, 5000);
  __autoRefreshTimer = setInterval(tick, intervalMs);
}

startAutoRefreshIfNeeded();