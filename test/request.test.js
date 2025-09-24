import 'dotenv/config';
import { fetch } from 'undici';

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:8787';

const headers = {
  'content-type': 'application/json'
};

// Allow passing Lingxi headers from env for quick testing without .env in server
if (process.env.LINGXI_SESSION_ID) headers['x-lingxi-session-id'] = process.env.LINGXI_SESSION_ID;
if (process.env.LINGXI_COOKIE) headers['x-lingxi-cookie'] = process.env.LINGXI_COOKIE;
if (process.env.LINGXI_BASE_URL) headers['x-lingxi-base-url'] = process.env.LINGXI_BASE_URL;
if (process.env.LINGXI_SSE_PATH) headers['x-lingxi-sse-path'] = process.env.LINGXI_SSE_PATH;
if (process.env.LINGXI_REFERER) headers['x-lingxi-referer'] = process.env.LINGXI_REFERER;
if (process.env.LINGXI_USER_AGENT) headers['x-lingxi-user-agent'] = process.env.LINGXI_USER_AGENT;
if (process.env.LINGXI_CLIENT_TYPE) headers['x-lingxi-client-type'] = process.env.LINGXI_CLIENT_TYPE;

async function nonStreaming() {
  const body = {
    model: 'lingxi',
    messages: [
      { role: 'user', content: 'Who am I?' }
    ],
    stream: false
  };

  const res = await fetch(`${baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(async () => ({ error: await res.text() }));
  console.log('Non-streaming response:');
  console.log(JSON.stringify(json, null, 2));
}

async function streaming() {
  const body = {
    model: 'lingxi',
    messages: [
      { role: 'user', content: 'Who am I?' }
    ],
    stream: true
  };

  const res = await fetch(`${baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  console.log('Streaming response:');
  for await (const chunk of res.body) {
    process.stdout.write(new TextDecoder().decode(chunk));
  }
}

(async () => {
  try {
    await nonStreaming();
  } catch (e) {
    console.error('Non-streaming failed:', e);
  }
  try {
    await streaming();
  } catch (e) {
    console.error('Streaming failed:', e);
  }
})(); 