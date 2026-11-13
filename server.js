import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { businessEnv, deskAuthorized, executeRun } from './lib/desk-run.js';
import { geocodeStoredLeads, searchAddresses } from './lib/geocode.js';
import { narrateTerritory, territoryFacts } from './lib/territory-brief.js';
import { allLeads, findLead, rememberLeads } from './lib/lead-store.js';
import { postAppsScript } from './lib/webhook.js';
import { askSources } from './lib/ask.js';
import { companyLeads, runAgentSearch } from './lib/agents.js';
import { deskText, geminiKeys, rotatingAi } from './lib/keys.js';
import { resolveMark } from './lib/mark.js';
import { deleteUpload, loadUpload, saveUploads, uploadPart } from './lib/uploads.js';
import QRCode from 'qrcode';
import { broadcastPush, sendPushNotification, validPushSubscription, vapidPublicKey } from './lib/push.js';
import { removeSubscription, removeSubscriptionsForUser, upsertSubscription } from './lib/push-store.js';

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
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

function send(response, status, payload, type = 'application/json; charset=utf-8', cache = 'no-store', headers = null) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const fields = {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Set-Cookie': deskCookie(),
  };
  if (headers) Object.assign(fields, headers);
  response.writeHead(status, fields);
  response.end(body);
}

function publicOrigin(request) {
  const configured = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(configured)) return configured;
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || 'localhost').split(',')[0].trim();
  const proto = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) return 'http://localhost';
  return `${proto}://${host}`;
}

function notifyDesk(payload) {
  try {
    Promise.resolve(broadcastPush(root, payload)).catch(() => {});
  } catch {
    // A push failure does not change the desk result.
  }
}

const pushHits = [];
function pushLimited(now = Date.now()) {
  while (pushHits.length && now - pushHits[0] > 10 * 60 * 1000) pushHits.shift();
  if (pushHits.length >= 8) return true;
  pushHits.push(now);
  return false;
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

function missingWebhook(action) {
  const { url, secret } = webhookConfig();
  const tail = action === 'save' ? 'Nothing was saved in Gmail.' : 'Nothing was read from Google.';
  if (!url && !secret) return `GOOGLE_WEBHOOK_URL and WEBHOOK_SECRET are empty. ${tail}`;
  if (!url) return `GOOGLE_WEBHOOK_URL is empty. ${tail}`;
  if (!secret) return `WEBHOOK_SECRET is empty. Paste the same string you saved in Apps Script. ${tail}`;
  return '';
}

async function callAppsScript(payload) {
  const { url, secret } = webhookConfig();
  const missing = missingWebhook('read');
  if (missing) return { status: 424, body: { ok: false, error: missing } };
  try {
    return await postAppsScript(url, secret, payload);
  } catch {
    return { status: 502, body: { ok: false, error: 'The desk could not reach Apps Script.' } };
  }
}

async function postApprove(company, interactionId, seller = {}) {
  const { url, secret } = webhookConfig();
  const missing = missingWebhook('save');
  if (missing) {
    return { status: 424, body: { ok: false, synced: false, sent: false, error: missing } };
  }
  try {
    const outcome = await postAppsScript(url, secret, {
      action: 'approve',
      company,
      interactionId,
      ...(seller.name || seller.offering ? { seller } : {}),
    });
    if (!outcome.body?.ok) return { status: outcome.status, body: { ...outcome.body, sent: false, synced: false } };
    return { status: 200, body: { ...outcome.body, sent: false, synced: true } };
  } catch {
    return { status: 502, body: { ok: false, sent: false, error: 'The approve call did not reach Apps Script. Nothing was sent.' } };
  }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    send(response, 200, { ok: true, service: 'lead-desk' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/qr.svg') {
    try {
      const svg = await QRCode.toString(`${publicOrigin(request)}/`, {
        type: 'svg',
        margin: 1,
        width: 180,
        color: { dark: '#07161e', light: '#ffffff' },
      });
      send(response, 200, svg, 'image/svg+xml; charset=utf-8', 'no-cache');
    } catch {
      send(response, 500, { ok: false, error: 'The QR code could not be drawn.' });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/leads') {
    send(response, 200, { ok: true, leads: allLeads(root) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/mark') {
    const photo = await resolveMark({
      company: url.searchParams.get('company') || '',
      contact: url.searchParams.get('contact') || '',
      website: url.searchParams.get('website') || '',
      source: url.searchParams.get('source') || '',
      photo: url.searchParams.get('photo') || '',
    });
    send(response, 200, { ok: true, photo });
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
  if (request.method === 'GET' && url.pathname === '/api/geocode/search') {
    const query = String(url.searchParams.get('q') || '').slice(0, 200);
    try {
      const found = await searchAddresses(query, { root });
      send(response, 200, { ok: true, candidates: found.candidates });
    } catch (error) {
      const busy = error.status === 429;
      send(response, busy ? 429 : 502, {
        ok: false,
        error: busy
          ? 'The geocoder is busy. Nothing was searched.'
          : 'The geocoder did not answer. Nothing was searched.',
        candidates: [],
      });
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/geocode') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The geocode request was not JSON. Nothing was placed.' });
      return;
    }
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)).slice(0, 6) : [];
    try {
      const outcome = await geocodeStoredLeads(root, ids);
      send(response, outcome.status, outcome.body);
    } catch {
      send(response, 502, { ok: false, error: 'The geocoder did not answer. Nothing was placed.', leads: allLeads(root), remaining: 0, failed: [] });
    }
    return;
  }
  const metered = url.pathname === '/api/runs' || url.pathname === '/api/ask' || url.pathname === '/api/agents/search' || url.pathname === '/api/territory/brief' || /\/approve$/.test(url.pathname);
  if (metered && limited()) {
    send(response, 429, { ok: false, error: 'Too many desk writes. Wait a few minutes. Nothing was sent.' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/territory/brief') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The brief request was not JSON. Nothing was asked.' });
      return;
    }
    const rawStart = body && body.start;
    const start = rawStart && Number.isFinite(Number(rawStart.lat)) && Number.isFinite(Number(rawStart.lng))
      && Math.abs(Number(rawStart.lat)) <= 90 && Math.abs(Number(rawStart.lng)) <= 180
      ? { lat: Number(rawStart.lat), lng: Number(rawStart.lng) }
      : null;
    const keys = geminiKeys();
    if (!keys.length) {
      send(response, 424, { ok: false, error: 'GEMINI_API_KEY is empty. Nothing was asked.' });
      return;
    }
    try {
      const facts = territoryFacts(root, start);
      const brief = await narrateTerritory({
        apiKey: keys[0],
        ai: rotatingAi(keys),
        model: (process.env.FREE_MODEL || 'gemini-3.6-flash').trim() || 'gemini-3.6-flash',
        facts,
      });
      send(response, 200, { ok: true, brief });
    } catch (error) {
      console.error('[/api/territory/brief failed]', error?.status, error?.code, String(error?.message || error).slice(0, 400));
      send(response, 200, { ok: true, brief: deskText(error) });
    }
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
  const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (request.method === 'DELETE' && sourceMatch) {
    const removed = deleteUpload(root, decodeURIComponent(sourceMatch[1]));
    send(response, removed ? 200 : 404, removed
      ? { ok: true }
      : { ok: false, error: 'That source is not on this desk.' });
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
  if (request.method === 'POST' && url.pathname === '/api/agents/search') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The agent request was not JSON. Nothing was searched.' });
      return;
    }
    const channel = body.channel === 'social' ? 'social' : body.channel === 'linkedin' ? 'linkedin' : '';
    const query = String(body.query || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!channel || !query) {
      send(response, 422, { ok: false, error: 'The agent needs a topic. Nothing was searched.' });
      return;
    }
    const keys = geminiKeys();
    if (!keys.length) {
      send(response, 424, { ok: false, error: 'GEMINI_API_KEY is empty. Nothing was searched.' });
      return;
    }
    try {
      const found = await runAgentSearch({
        apiKey: keys[0],
        ai: rotatingAi(keys),
        model: (process.env.FREE_MODEL || 'gemini-3.6-flash').trim() || 'gemini-3.6-flash',
        query,
        channel,
        profile: businessEnv(body),
      });
      const leads = rememberLeads(root, companyLeads(found.companies, channel));
      send(response, 200, {
        ok: true,
        channel,
        keywords: found.keywords,
        explanation: found.explanation,
        companies: found.companies,
        people: found.people,
        leads,
      });
    } catch (error) {
      console.error('[/api/agents/search failed]', error?.status, error?.code, String(error?.message || error).slice(0, 400));
      send(response, 200, {
        ok: true,
        channel,
        keywords: [],
        explanation: deskText(error),
        companies: [],
        people: [],
        leads: [],
      });
    }
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
    const keys = geminiKeys();
    if (!keys.length) {
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
        apiKey: keys[0],
        ai: rotatingAi(keys),
        model: (process.env.FREE_MODEL || 'gemini-3.6-flash').trim() || 'gemini-3.6-flash',
        question,
        profile: businessEnv(body),
        parts: built.parts,
        urls: built.urls,
        tabular: built.tabular,
      });
      const leads = rememberLeads(root, answer.leads);
      const explanation = answer.explanation;
      if (leads.length) {
        notifyDesk({
          title: 'New leads',
          body: `${leads.length} ${leads.length === 1 ? 'company' : 'companies'} came back from the question.`,
          data: { url: '/?view=accounts' },
        });
      }
      send(response, 200, { ok: true, explanation, leads });
    } catch (error) {
      console.error('[/api/ask failed]', error?.status, error?.code, String(error?.message || error).slice(0, 400));
      send(response, 200, { ok: true, explanation: deskText(error), leads: [] });
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
    const run = await executeRun(outputDir, { ...process.env, ...businessEnv(body) });
    const stored = rememberLeads(root, run.leads || []);
    const result = run.result || {
      ok: false,
      synced: false,
      error: 'The batch did not report a webhook result. Nothing was written to Sheets.',
    };
    const record = {
      id,
      ok: Boolean(result.ok && result.synced !== false),
      synced: Boolean(result.synced),
      interactionId: result.interactionId || stored[0]?.interactionId || '',
      error: result.error || '',
      appsScript: result.appsScript || null,
      leads: stored,
    };
    runs.set(id, record);
    notifyDesk(record.ok ? {
      title: 'Batch accepted',
      body: 'Apps Script accepted the lead batch.',
      data: { url: '/?view=pipeline' },
    } : {
      title: 'Batch not written',
      body: record.error || 'The batch was not written to Sheets.',
      data: { url: '/?view=studio' },
    });
    send(response, record.ok ? 200 : 424, record);
    return;
  }
  const approveMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/approve$/);
  if (request.method === 'POST' && approveMatch) {
    const id = decodeURIComponent(approveMatch[1]);
    const lead = findLead(root, id);
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
      if (outcome.body?.ok) {
        notifyDesk({
          title: 'Draft saved',
          body: `${lead.company} is in Gmail. The pitch was not sent.`,
          data: { url: '/?view=draft' },
        });
      }
      send(response, outcome.status, outcome.body);
    } catch {
      send(response, 502, { ok: false, sent: false, error: 'The approve call did not reach Apps Script. Nothing was sent.' });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/push/vapid') {
    const publicKey = vapidPublicKey();
    if (!publicKey) {
      send(response, 424, { ok: false, error: 'VAPID_PUBLIC_KEY is empty. Notifications stay off.' });
      return;
    }
    send(response, 200, { ok: true, publicKey }, 'application/json; charset=utf-8', 'no-cache');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The subscription was not JSON.' });
      return;
    }
    const record = validPushSubscription(body);
    if (!record) {
      send(response, 422, { ok: false, error: 'That push subscription could not be saved.' });
      return;
    }
    upsertSubscription(root, record);
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The unsubscribe body was not JSON.' });
      return;
    }
    const endpoint = String(body.endpoint || body.subscription?.endpoint || '');
    const userId = String(body.userId || '');
    if (endpoint) removeSubscription(root, endpoint);
    else if (userId) removeSubscriptionsForUser(root, userId);
    else {
      send(response, 422, { ok: false, error: 'No subscription was identified.' });
      return;
    }
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/push/test') {
    if (pushLimited()) {
      send(response, 429, { ok: false, error: 'Too many test alerts. Wait a few minutes.' });
      return;
    }
    let body = {};
    try {
      body = await readJson(request);
    } catch {
      send(response, 400, { ok: false, error: 'The test alert was not JSON.' });
      return;
    }
    const userId = String(body.userId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) {
      send(response, 422, { ok: false, error: 'That device id cannot receive a test alert.' });
      return;
    }
    const result = await sendPushNotification(root, userId, {
      title: 'Lead desk',
      body: 'Notifications are on for this desk.',
      data: { url: '/' },
    });
    send(response, result.ok && result.sent > 0 ? 200 : 424, result.ok && result.sent > 0
      ? result
      : { ...result, ok: false, error: result.error || 'No device received the test alert.' });
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
    const ext = path.extname(target).toLowerCase();
    const vendor = requested.startsWith('/vendor/');
    const cache = requested === '/sw.js' || requested.endsWith('.html') || requested.endsWith('.webmanifest')
      ? 'no-cache'
      : 'public, max-age=86400';
    send(
      response,
      200,
      file,
      TYPES[ext] || 'application/octet-stream',
      cache,
      vendor ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : null,
    );
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
