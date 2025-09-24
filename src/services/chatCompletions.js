import { fetch } from 'undici';
import { Readable } from 'node:stream';

// Fixed base and client defaults
const FIXED_LINGXI_BASE_URL = 'https://lingxi.wps.cn';
const ENV_LINGXI_SESSION_ID = process.env.LINGXI_SESSION_ID; // e.g. 9776791727556322
const ENV_LINGXI_COOKIE = process.env.LINGXI_COOKIE; // raw cookie string with wps_sid etc.
const ENV_LINGXI_USER_AGENT = process.env.LINGXI_USER_AGENT || 'Mozilla/5.0';
const ENV_LINGXI_CLIENT_TYPE = process.env.LINGXI_CLIENT_TYPE || 'h5';

function resolveLingxiConfig(req) {
  const h = req.headers || {};
  const baseUrl = h['x-lingxi-base-url'] || FIXED_LINGXI_BASE_URL;
  const sessionId = h['x-lingxi-session-id'] || ENV_LINGXI_SESSION_ID;
  const cookie = h['x-lingxi-cookie'] || ENV_LINGXI_COOKIE;
  const userAgent = h['x-lingxi-user-agent'] || ENV_LINGXI_USER_AGENT;
  const clientType = h['x-lingxi-client-type'] || ENV_LINGXI_CLIENT_TYPE;
  const ssePath = h['x-lingxi-sse-path'] || (sessionId ? `/api/aigc/v3/assistant/sessions/${sessionId}/completions` : undefined);
  const referer = h['x-lingxi-referer'] || (sessionId ? `${baseUrl}/chat/${sessionId}` : undefined);
  return { baseUrl, sessionId, cookie, userAgent, clientType, ssePath, referer };
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
  const res = await fetch(lingxiUrl, {
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

  const upstream = await fetch(lingxiUrl, {
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
      cookie: cfg.cookie,
      userAgent: cfg.userAgent,
      clientType: cfg.clientType,
      referer: cfg.referer
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