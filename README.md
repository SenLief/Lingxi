# Lingxi OpenAI-Compatible Proxy

An Express service that exposes OpenAI-compatible `POST /v1/chat/completions`, forwards to WPS Lingxi (`/api/aigc/v3/assistant/sessions/{session_id}/completions`), parses SSE, and returns OpenAI-style responses. Supports streaming and non-streaming.

## Setup

1. Copy `ENV.SAMPLE` to `.env` and fill values:

```bash
cp ENV.SAMPLE .env
# Edit .env: set LINGXI_SESSION_ID and LINGXI_COOKIE from your browser session
```

2. Install deps and start:

```bash
npm install
npm run start
```

Service runs at `http://localhost:8787` by default.

## Configuration (.env)
- `PORT`: Server port (default 8787)
- `LINGXI_BASE_URL`: `https://lingxi.wps.cn`
- `LINGXI_SESSION_ID`: Chat session id from Lingxi URL
- `LINGXI_COOKIE`: Raw cookie string including `wps_sid`
- `LINGXI_SSE_PATH`: SSE path (auto-derived, override if needed)
- `LINGXI_USER_AGENT`, `LINGXI_REFERER`, `LINGXI_CLIENT_TYPE`: Header overrides

## API

### POST /v1/chat/completions
OpenAI-compatible. Minimal body:

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": "Who am I?"}
  ],
  "stream": false
}
```

- If `stream: true`, response is Server-Sent Events emitting OpenAI chunk format ending with `[DONE]`.

### cURL examples

Non-streaming:
```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"lingxi","messages":[{"role":"user","content":"Who am I?"}]}' | jq
```

Streaming:
```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"lingxi","messages":[{"role":"user","content":"Who am I?"}],"stream":true}'
```

## Notes
- This proxy concatenates Lingxi SSE `data.text` into a single assistant message for non-streaming.
- For streaming, it maps each partial `data.text` to OpenAI `delta.content` chunks.
- You must supply valid `LINGXI_COOKIE` from an authenticated Lingxi browser session. 