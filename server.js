import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { demoLeads } from './lib/leads.js';
import { businessEnv, deskAuthorized, executeDryRun, redactSecrets } from './lib/desk-run.js';
import { askSources } from './lib/ask.js';
import { loadUpload, saveUploads, uploadPart } from './lib/uploads.js';

const root = process.cwd();
const webRoot = path.resolve(root, 'web');
const runs = new Map();
const hits = [];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let mintedDeskToken = '';

function expectedDeskToken() {
  const configured = (process.env.DESK_TOKEN || '').trim();
  if (configured) return configured;
  if (!mintedDeskToken) mintedDeskToken = randomBytes(24).toString('hex');
  return mintedDeskToken;
}

function cookieToken(request) {
  const raw = request.headers.cookie || '';
  const match = String(raw).match(/(?:^|;\s*)desk=([^;]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function deskCookie() {
  const secure = process.env.RENDER === 'true' ? '; Secure' : '';
  return `desk=${encodeURIComponent(expectedDeskToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`;
}

function send(response, status, payload, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Set-Cookie': deskCookie(),
  });
  response.end(body);
}

function limited(now = Date.now()) {
  while (hits.length && now - hits[0] > 10 * 60 * 1000) hits.shift();
  if (hits.length >= 10) return true;
  hits.push(now);
  return false;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function webhookConfig() {
  const url = (process.env.GOOGLE_WEBHOOK_URL || '').trim();
  const secret = (process.env.WEBHOOK_SECRET || '').trim();
  return { url, secret };
}

async function callAppsScript(payload) {
  const { url, secret } = webhookConfig();
  if (!url || !secret) {
    return { status: 424, body: { ok: false, error: 'GOOGLE_WEBHOOK_URL is empty. Nothing was read from Google.' } };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 502, body: { ok: false, error: 'Apps Script returned a non-JSON response.' } };
    }
    if (!body.ok) return { status: 409, body };
    return { status: 200, body };
  } catch {
    return { status: 502, body: { ok: false, error: 'The desk could not reach Apps Script.' } };
  }
}

async function postApprove(company, interactionId, seller = {}) {
  const { url, secret } = webhookConfig();
  if (!url || !secret) {
    return {
      status: 424,
      body: {
        ok: false,
        synced: false,
        sent: false,
        error: 'GOOGLE_WEBHOOK_URL is empty. Nothing was saved in Gmail.',
      },
    };
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret,
    },
    body: JSON.stringify({
      action: 'approve',
      company,
      interactionId,
      ...(seller.name || seller.offering ? { seller } : {}),
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 502, body: { ok: false, sent: false, error: 'Apps Script returned a non-JSON response. Nothing was sent.' } };
  }
  if (!body.ok) {
    return { status: 409, body: { ...body, sent: false, synced: false } };
  }
  return { status: 200, body: { ...body, sent: false, synced: true } };
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    send(response, 200, { ok: true, service: 'lead-desk' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/leads') {
    send(response, 200, { ok: true, leads: demoLeads(root) });
    return;
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    const record = runs.get(decodeURIComponent(runMatch[1]));
    if (!record) {
      send(response, 404, { ok: false, error: 'That run is not on this desk.' });
      return;
    }
    send(response, 200, record);
    return;
  }
  const headerToken = request.headers['x-desk-token'];
  const presented = (Array.isArray(headerToken) ? headerToken[0] : headerToken) || cookieToken(request);
  const production = process.env.RENDER === 'true';
  if (!deskAuthorized(presented, expectedDeskToken(), production)) {
    send(response, 401, { ok: false, error: 'Desk token was rejected.' });
    return;
  }
  const metered = url.pathname === '/api/runs' || url.pathname === '/api/ask' || /\/approve$/.test(url.pathname);
  if (metered && limited()) {
    send(response, 429, { ok: false, error: 'Too many desk writes. Wait a few minutes. Nothing was sent.' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/sources') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The file body was not JSON. Nothing was added.' });
      return;
    }
    const files = Array.isArray(body.files) ? body.files.slice(0, 12) : [];
    const sources = saveUploads(root, files);
    send(response, sources.some((item) => item.ok) ? 200 : 422, { ok: sources.some((item) => item.ok), sources });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/google') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The Google request was not JSON.' });
      return;
    }
    const action = body.action === 'list' ? 'list' : 'links';
    const payload = action === 'list'
      ? { action, kinds: Array.isArray(body.kinds) ? body.kinds.slice(0, 5) : [] }
      : { action: 'links' };
    const outcome = await callAppsScript(payload);
    send(response, outcome.status, outcome.body);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/ask') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The question was not JSON. Nothing was asked.' });
      return;
    }
    const question = String(body.question || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 2000);
    if (!question) {
      send(response, 422, { ok: false, error: 'The question was empty. Nothing was asked.' });
      return;
    }
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || /^(your-|paste-)/i.test(apiKey)) {
      send(response, 424, { ok: false, error: 'GEMINI_API_KEY is empty. Nothing was asked.' });
      return;
    }
    const uploads = (Array.isArray(body.uploads) ? body.uploads : []).slice(0, 8).map((id) => loadUpload(root, id)).filter(Boolean);
    const workspace = (Array.isArray(body.workspace) ? body.workspace : []).slice(0, 6);
    let texts = [];
    if (workspace.length) {
      const read = await callAppsScript({ action: 'read', ids: workspace });
      if (!read.body?.ok) {
        send(response, read.status, read.body);
        return;
      }
      texts = Array.isArray(read.body.texts) ? read.body.texts : [];
    }
    try {
      const built = partsForAsk(uploads, texts);
      const answer = await askSources({
        apiKey,
        model: (process.env.FREE_MODEL || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash',
        question,
        profile: businessEnv(body),
        parts: built.parts,
        urls: built.urls,
        tabular: built.tabular,
      });
      send(response, 200, { ok: true, explanation: answer.explanation, leads: answer.leads });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : '', [apiKey]).slice(0, 300);
      send(response, 502, { ok: false, error: message || 'Gemini did not answer. Nothing was written to Sheets.' });
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/runs') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, synced: false, error: 'Run body was not JSON. Nothing was written to Sheets.' });
      return;
    }
    const id = randomUUID();
    const outputDir = path.join(root, 'output', 'runs', id);
    const run = await executeDryRun(outputDir, { ...process.env, ...businessEnv(body) });
    const result = run.result || {
      ok: false,
      synced: false,
      error: 'The batch did not report a webhook result. Nothing was written to Sheets.',
    };
    const record = {
      id,
      ok: Boolean(result.ok && result.synced !== false),
      synced: Boolean(result.synced),
      interactionId: result.interactionId || '',
      error: result.error || '',
      appsScript: result.appsScript || null,
    };
    runs.set(id, record);
    send(response, record.ok ? 200 : 424, record);
    return;
  }
  const approveMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/approve$/);
  if (request.method === 'POST' && approveMatch) {
    const id = decodeURIComponent(approveMatch[1]);
    const lead = demoLeads(root).find((item) => item.id === id);
    if (!lead) {
      send(response, 404, { ok: false, sent: false, error: 'That lead is not on this desk.' });
      return;
    }
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, sent: false, error: 'Approve body was not JSON. Nothing was sent.' });
      return;
    }
    if (lead.negative || !lead.hook) {
      send(response, 422, { ok: false, sent: false, error: 'A negative match does not create a draft. Nothing was sent.' });
      return;
    }
    const interactionId = String(body.interactionId || '').trim();
    if (!interactionId) {
      send(response, 424, { ok: false, sent: false, error: 'Run research and wait for Apps Script before approving. Nothing was saved in Gmail.' });
      return;
    }
    try {
      const profile = businessEnv(body);
      const outcome = await postApprove(lead.company, interactionId, {
        name: profile.SELLER_NAME || '',
        offering: profile.SELLER_OFFERING || '',
      });
      send(response, outcome.status, outcome.body);
    } catch {
      send(response, 502, { ok: false, sent: false, error: 'The approve call did not reach Apps Script. Nothing was sent.' });
    }
    return;
  }
  send(response, 404, { ok: false, error: 'No such desk route.' });
}

function partsForAsk(uploads, texts) {
  const parts = [];
  let tabular = false;
  let urls = false;
  let bytes = 0;
  for (const record of uploads) {
    const part = uploadPart(record);
    if (part.tabular) tabular = true;
    if (part.text) parts.push({ text: part.text });
    else if (part.inline) {
      bytes += record.bytes.length;
      if (bytes > 18 * 1024 * 1024) {
        throw new Error('The checked files together are over 18 MB. Uncheck one and ask again.');
      }
      parts.push({ inlineData: { mimeType: part.mime, data: part.data } });
    }
  }
  for (const item of texts) {
    if (/^https?:\/\//i.test(item.url || '')) urls = true;
    parts.push({ text: `Google source ${item.name || item.id}:\n${item.text || ''}` });
  }
  return { parts, tabular, urls };
}

async function handleStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(webRoot, `.${requested}`);
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
    send(response, 403, { ok: false, error: 'That path is outside the desk.' });
    return;
  }
  try {
    const file = await readFile(target);
    send(response, 200, file, TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(response, 404, { ok: false, error: 'That file is not on the desk.' });
  }
}

export function createDeskServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(response, 405, { ok: false, error: 'The desk files only accept GET.' });
        return;
      }
      await handleStatic(response, decodeURIComponent(url.pathname));
    } catch (error) {
      send(response, 500, { ok: false, error: 'The desk hit an unexpected error.' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 8787);
  createDeskServer().listen(port, '0.0.0.0', () => {
    console.log(`Lead desk listening on ${port}`);
  });
}
