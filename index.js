// Shop Hub copilot relay (Railway).
// Purpose: hold Dallas's copilot questions/answers as live state so the
// Shop Hub app can show answers in seconds instead of waiting for a
// Vercel redeploy of qa.json. Slack (#dallas-copilot) remains the
// transport to the answering watcher and the human-visible log:
//   app -> POST /ask -> relay stores question + mirrors to Slack webhook
//   watcher (VM cron) answers in the Slack thread + qa.json as before,
//   and also POSTs the answer here -> app polls GET /qa.
// State is in-memory by design: qa.json on Vercel is the durable record.
// If this service restarts, history repopulates from new traffic and the
// app falls back to qa.json for older entries.

const http = require('http');

const PORT = process.env.PORT || 8080;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const MAX_ITEMS = 50;

const items = []; // newest first: {id, q, a, status, ts, answered_ts}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Secret',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function mirrorToSlack(id, q) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Dallas asks (shop hub): [relay:' + id + '] ' + q,
      }),
    });
  } catch (e) {
    console.error('slack mirror failed', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, items: items.length });
    }
    if (req.method === 'GET' && url.pathname === '/qa') {
      return json(res, 200, { items });
    }
    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await readBody(req);
      const q = String(body.q || '').trim().slice(0, 2000);
      if (!q) return json(res, 400, { ok: false, error: 'empty question' });
      const id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const item = {
        id,
        q,
        a: null,
        status: 'pending',
        ts: new Date().toISOString(),
        answered_ts: null,
      };
      items.unshift(item);
      if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
      mirrorToSlack(id, q); // fire and forget; Slack stays the log + trigger
      return json(res, 200, { ok: true, id });
    }
    if (req.method === 'POST' && url.pathname === '/answer') {
      if (!RELAY_SECRET || req.headers['x-relay-secret'] !== RELAY_SECRET) {
        return json(res, 403, { ok: false, error: 'bad secret' });
      }
      const body = await readBody(req);
      const item = items.find((i) => i.id === body.id);
      if (!item) return json(res, 404, { ok: false, error: 'unknown id' });
      item.a = String(body.a || '').slice(0, 8000);
      item.status = 'answered';
      item.answered_ts = new Date().toISOString();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e && e.message) });
  }
});

server.listen(PORT, () => console.log('copilot-relay listening on ' + PORT));
