import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { asCell, secretsMatch } from '../lib/safety.js';
import { shouldDelegate } from '../lib/route.js';
import { demoLeads } from '../lib/leads.js';
import { askPrompt, parseLeadAnswer } from '../lib/ask.js';
import { officeText } from '../lib/office.js';
import { businessEnv, deskAuthorized, executeDryRun, executeRun } from '../lib/desk-run.js';
import { leadsFromMarkdown } from '../lib/lead-store.js';
import { deleteUpload, saveUploads } from '../lib/uploads.js';

process.env.GOOGLE_WEBHOOK_URL = '';
process.env.WEBHOOK_SECRET = '';
process.env.GEMINI_API_KEY = '';
process.env.DESK_TOKEN = '';

test('secret compare rejects a different length and a one-character change', () => {
  assert.equal(secretsMatch('abcdefghijklmnop', 'abcdefghijklmnop'), true);
  assert.equal(secretsMatch('abcdefghijklmnop', 'abcdefghijklmnoX'), false);
  assert.equal(secretsMatch('short', 'abcdefghijklmnop'), false);
  assert.equal(secretsMatch('', 'abcdefghijklmnop'), false);
});

test('sheet cells prefix formula characters', () => {
  assert.equal(asCell('=cmd'), "'=cmd");
  assert.equal(asCell('+1'), "'+1");
  assert.equal(asCell('-1'), "'-1");
  assert.equal(asCell('@sum'), "'@sum");
  assert.equal(asCell('Northwind'), 'Northwind');
});

test('routing stays on Node for a dry run and delegates a free run', () => {
  assert.equal(shouldDelegate({ dryRun: true, reportFile: '', resumeId: '' }, { DEMO_MODE: '', LEADGEN_ROUTE: '' }), false);
  assert.equal(shouldDelegate({ dryRun: false, reportFile: '', resumeId: '' }, { DEMO_MODE: 'true', LEADGEN_ROUTE: '' }), true);
  assert.equal(shouldDelegate({ dryRun: false, reportFile: '', resumeId: '' }, { DEMO_MODE: '', LEADGEN_ROUTE: 'paid' }), false);
  assert.equal(shouldDelegate({ dryRun: false, reportFile: 'output/last-report.md', resumeId: '' }, {}), false);
});

test('demo leads do not invent an email address', () => {
  const leads = demoLeads();
  assert.equal(leads.length, 2);
  assert.equal(leads[0].company, 'Northwind Analytics');
  assert.equal(leads[0].negative, false);
  assert.equal(leads[1].negative, true);
  assert.equal(JSON.stringify(leads).includes('@'), false);
});

test('an ask answer keeps only sourced leads and drops unknown emails', () => {
  const parsed = parseLeadAnswer([
    'EXPLANATION:',
    'Northwind is in the attached PDF.',
    'LEADS:',
    '| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Northwind | northwind.example | Chicago | Ada | Ops | unknown | Manual dispatch | Public case study | High | notes.pdf |',
    '| Contoso | contoso.example | Austin |  |  |  |  |  | Low | notes.pdf |',
  ].join('\n'));
  assert.equal(parsed.explanation, 'Northwind is in the attached PDF.');
  assert.equal(parsed.leads.length, 2);
  assert.equal(parsed.leads[0].email, '');
  assert.equal(parsed.leads[0].priority, 'High');
  assert.equal(parsed.leads[1].hook, '');
  assert.match(askPrompt('Find operators', { SELLER_OFFERING: 'Routing software' }), /Routing software/);
});

test('a spreadsheet with inline text is read cell by cell', () => {
  const xml = '<worksheet><sheetData><row><c t="inlineStr"><is><t>EdTech Academy</t></is></c><c t="inlineStr"><is><t>ada@school.example</t></is></c></row></sheetData></worksheet>';
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const data = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(name.length, 26);
  const text = officeText(Buffer.concat([local, name, data]));
  assert.match(text, /EdTech Academy/);
  assert.match(text, /ada@school.example/);
});

test('office text is read out of a docx zip', () => {
  const xml = '<w:document><w:t>Northwind pump</w:t></w:document>';
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(name.length, 26);
  const text = officeText(Buffer.concat([local, name, data]));
  assert.match(text, /Northwind pump/);
});

test('a business profile is the env for that run', () => {
  assert.deepEqual(businessEnv({
    sellerName: 'Northwind',
    offering: 'Dispatch software',
    industry: 'Logistics',
    region: 'Kenya',
    icp: 'Operators',
    maxLeads: '8',
  }), {
    SELLER_NAME: 'Northwind',
    SELLER_OFFERING: 'Dispatch software',
    TARGET_INDUSTRY: 'Logistics',
    TARGET_REGION: 'Kenya',
    IDEAL_CUSTOMER_PROFILE: 'Operators',
    MAX_LEADS: '8',
  });
  assert.deepEqual(businessEnv({ sellerName: '   ', maxLeads: '99' }), {});
});

test('production refuses writes until a desk token is set', () => {
  assert.equal(deskAuthorized('', '', true), false);
  assert.equal(deskAuthorized('desk-token-value', 'desk-token-value', true), true);
  assert.equal(deskAuthorized('', '', false), true);
});

test('webhook callers put the secret in the JSON body', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const python = readFileSync(new URL('../fallback/pipeline.py', import.meta.url), 'utf8');
  const webhook = readFileSync(new URL('../lib/webhook.js', import.meta.url), 'utf8');
  const decide = readFileSync(new URL('../fallback/decide.py', import.meta.url), 'utf8');
  const desk = readFileSync(new URL('../lib/desk-run.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(webhook, /JSON\.stringify\(\{ \.\.\.payload, secret \}\)/);
  assert.equal(webhook.includes('X-Webhook-Secret'), false);
  assert.equal(webhook.includes('console.'), false);
  assert.equal(python.includes('"secret": settings.webhook_secret'), true);
  assert.equal(python.includes('X-Webhook-Secret'), false);
  assert.equal(python.includes('if key != "secret"'), true);
  assert.equal(python.includes('if k != "secret"'), true);
  assert.match(decide, /text\.replace\(secret, "\[redacted\]"\)/);
  assert.equal(script.includes('X-Webhook-Secret'), false);
  assert.equal(script.includes('e.headers'), false);
  assert.match(script, /providedSecret_\(e, body\)/);
  const reader = script.slice(script.indexOf('function providedSecret_'), script.indexOf('function secretField_'));
  assert.ok(reader.indexOf('parsePostData_') < reader.indexOf('parameter.secret'));
  assert.match(script, /e\.postData\.contents/);
  assert.match(script, /parameter\.secret/);
  assert.match(script, /catch \(err\) \{\s*return null;/);
  const loggedSecret = python.split('\n').filter((line) => (
    /log\.(info|warning|error|debug)/.test(line)
    && line.includes('webhook_secret')
    && !line.includes('_redact')
  ));
  assert.deepEqual(loggedSecret, []);
  const loggedIndex = index.split('\n').filter((line) => (
    line.includes('console.') && line.includes('webhookSecret') && !line.includes('hideSecret')
  ));
  assert.deepEqual(loggedIndex, []);
  const loggedServer = server.split('\n').filter((line) => (
    line.includes('console.') && /WEBHOOK_SECRET|webhookSecret|GOOGLE_WEBHOOK_URL/.test(line)
  ));
  assert.deepEqual(loggedServer, []);
  assert.equal(script.includes('findDraftBySubject_'), true);
  assert.equal(script.includes('findOpenTask_'), true);
  assert.equal(script.includes('sheetKey_'), true);
  assert.equal(desk.includes("DRY_RUN: 'true'"), false);
});

test('a dry run with no webhook reports that nothing was written', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-run-'));
  const run = await executeDryRun(dir, {
    ...process.env,
    GOOGLE_WEBHOOK_URL: '',
    WEBHOOK_SECRET: '',
    GEMINI_API_KEY: '',
    DRY_RUN: 'true',
    DEMO_MODE: 'false',
    LEADGEN_ROUTE: '',
    BILLING_ENABLED: 'false',
    FORCE_FREE_TIER: 'false',
  });
  assert.equal(run.code, 0);
  assert.equal(run.result.synced, false);
  assert.match(run.result.error, /Nothing was written/);
  assert.equal(run.leads[0].company, 'Northwind Analytics');
  assert.equal(run.leads[0].interactionId.startsWith('dry-run-'), true);
});

test('a company re-research stays on that company during a dry run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-focus-'));
  const run = await executeRun(dir, {
    ...process.env,
    DRY_RUN: 'true',
    DEMO_MODE: 'false',
    LEADGEN_ROUTE: '',
    GOOGLE_WEBHOOK_URL: '',
    WEBHOOK_SECRET: '',
    GEMINI_API_KEY: '',
    RESEARCH_COMPANY: 'EdTech Academy',
    RESEARCH_DOMAIN: 'academy.example',
  });
  assert.equal(run.code, 0);
  assert.equal(run.leads.length, 1);
  assert.equal(run.leads[0].company, 'EdTech Academy');
  assert.equal(run.leads[0].domain, 'academy.example');
  assert.equal(run.leads[0].hook, '');
});

test('a live run keeps DRY_RUN false and does not write the fixture', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-live-'));
  const run = await executeRun(dir, {
    ...process.env,
    DRY_RUN: 'false',
    DEMO_MODE: 'false',
    LEADGEN_ROUTE: 'paid',
    BILLING_ENABLED: 'false',
    FORCE_FREE_TIER: 'false',
    GEMINI_API_KEY: '',
    GEMINI_API_KEY_1: '',
    GEMINI_API_KEY_2: '',
    GEMINI_API_KEY_3: '',
    GEMINI_API_KEY_4: '',
    GEMINI_API_KEY_5: '',
    GOOGLE_WEBHOOK_URL: '',
    WEBHOOK_SECRET: '',
    SELLER_OFFERING: '',
    TARGET_INDUSTRY: '',
  });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /GEMINI_API_KEY/);
  assert.equal(run.leads.length, 0);
});

test('discovered leads keep their interaction id and a deleted source removes both files', () => {
  const parsed = leadsFromMarkdown([
    '| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |',
    '| Northwind | northwind.example | Chicago | Ada | Ops | unknown | Manual dispatch | Public case study | High | notes.pdf |',
  ].join('\n'), 'batch-1');
  assert.equal(parsed[0].interactionId, 'batch-1');
  assert.equal(parsed[0].negative, false);
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-src-'));
  const saved = saveUploads(dir, [{ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') }]);
  assert.equal(deleteUpload(dir, saved[0].id), true);
  assert.equal(existsSync(path.join(dir, 'output', 'uploads', `${saved[0].id}.bin`)), false);
  assert.equal(existsSync(path.join(dir, 'output', 'uploads', `${saved[0].id}.json`)), false);
});

test('the desk API returns leads and rejects a missing token', async () => {
  process.env.DESK_TOKEN = 'desk-token-value';
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  const leads = await fetch(`${base}/api/leads`);
  const denied = await fetch(`${base}/api/runs`, { method: 'POST' });
  assert.equal(health.status, 200);
  const listed = await leads.json();
  assert.equal(listed.ok, true);
  assert.equal(listed.leads.some((lead) => lead.company === 'Northwind Analytics'), false);
  assert.equal(listed.leads.some((lead) => lead.company === 'Contoso Fabrication'), false);
  assert.equal(denied.status, 401);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.headers.get('content-type').includes('text/html'), true);
  assert.equal(html.startsWith('<!DOCTYPE html>'), true);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.env.DESK_TOKEN = '';
});

function readRaw(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function jsonSecret(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return '';
    return String(parsed.secret ?? '').trim();
  } catch {
    return '';
  }
}

function responseHides(value, secret) {
  assert.equal(JSON.stringify(value).includes(secret), false);
}

test('an Apps Script redirect is read with GET before a second POST', async () => {
  const { createServer } = await import('node:http');
  const { postAppsScript } = await import('../lib/webhook.js');
  const secret = 'abcdefghijklmnop';
  const posts = [];
  const server = createServer(async (request, response) => {
    const raw = await readRaw(request);
    if (request.method === 'POST') {
      posts.push({
        secret: jsonSecret(raw),
        header: request.headers['x-webhook-secret'] || '',
        type: request.headers['content-type'] || '',
      });
    }
    if (request.url === '/exec') {
      response.writeHead(302, { Location: '/echo' });
      response.end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!DOCTYPE html><html><body>Moved</body></html>');
      return;
    }
    const encoded = JSON.stringify({ ok: jsonSecret(raw) === secret });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(encoded);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const result = await postAppsScript(`http://127.0.0.1:${port}/exec`, secret, { action: 'links' });
  assert.equal(result.body.ok, true);
  responseHides(result, secret);
  assert.equal(posts.length, 2);
  assert.equal(posts.every((post) => post.secret === secret && post.header === '' && post.type.includes('application/json')), true);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the echo page is used when it already contains the JSON', async () => {
  const { createServer } = await import('node:http');
  const { postAppsScript } = await import('../lib/webhook.js');
  const secret = 'abcdefghijklmnop';
  const posts = [];
  const server = createServer(async (request, response) => {
    const raw = await readRaw(request);
    if (request.method === 'POST') {
      posts.push({
        secret: jsonSecret(raw),
        header: request.headers['x-webhook-secret'] || '',
      });
    }
    if (request.url === '/exec') {
      response.writeHead(302, { Location: '/echo' });
      response.end();
      return;
    }
    if (request.method === 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!DOCTYPE html><html><body>echo rejects POST</body></html>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, items: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const result = await postAppsScript(`http://127.0.0.1:${port}/exec`, secret, { action: 'links' });
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.items, []);
  responseHides(result, secret);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].secret, secret);
  assert.equal(posts[0].header, '');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('an Apps Script mock that ignores headers authorizes the body secret', async () => {
  const { createServer } = await import('node:http');
  const { postAppsScript } = await import('../lib/webhook.js');
  const expected = 'abcdefghijklmnop';
  const wrong = 'abcdefghijklmnoX';
  const responses = [];
  const server = createServer(async (request, response) => {
    const raw = await readRaw(request);
    const provided = jsonSecret(raw);
    const payload = secretsMatch(provided, expected)
      ? { ok: true, service: 'lead-generation-webhook' }
      : { ok: false, error: 'Unauthorized webhook. Render WEBHOOK_SECRET does not match this script property.' };
    const encoded = JSON.stringify(payload);
    responses.push(encoded);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(encoded);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/exec`;
  try {
    const good = await postAppsScript(url, expected, { action: 'links' });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    responseHides(good, expected);

    const rejected = await postAppsScript(url, wrong, { action: 'links' });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.ok, false);
    assert.match(rejected.body.error, /^Unauthorized webhook/);
    responseHides(rejected, wrong);
    responseHides(rejected, expected);

    const missing = await postAppsScript(url, '', { action: 'links' });
    assert.equal(missing.status, 401);
    assert.match(missing.body.error, /^Unauthorized webhook/);

    const headerOnly = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': expected },
      body: JSON.stringify({ action: 'links' }),
    });
    const headerBody = await headerOnly.json();
    assert.equal(headerBody.ok, false);
    assert.match(headerBody.error, /^Unauthorized webhook/);
    responseHides(headerBody, expected);

    const bodyWins = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': wrong },
      body: JSON.stringify({ action: 'links', secret: expected }),
    });
    const bodyWinsJson = await bodyWins.json();
    assert.equal(bodyWinsJson.ok, true);
    responseHides(bodyWinsJson, expected);
    assert.equal(responses.every((body) => !body.includes(expected) && !body.includes(wrong)), true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a GET health check authorizes the query secret and does not echo it', async () => {
  const { createServer } = await import('node:http');
  const secret = 'abc/defghijklmno';
  const server = createServer(async (request, response) => {
    const provided = String(new URL(request.url, 'http://127.0.0.1').searchParams.get('secret') || '').trim();
    const payload = secretsMatch(provided, secret)
      ? { ok: true, service: 'lead-generation-webhook', spreadsheetConfigured: false }
      : { ok: false, error: 'Unauthorized webhook. Render WEBHOOK_SECRET does not match this script property.' };
    const encoded = JSON.stringify(payload);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(encoded);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const target = new URL(`http://127.0.0.1:${port}/exec`);
    target.searchParams.set('secret', secret);
    const good = await fetch(target);
    const goodBody = await good.json();
    assert.equal(goodBody.ok, true);
    responseHides(goodBody, secret);

    const missingUrl = new URL(`http://127.0.0.1:${port}/exec`);
    const missing = await fetch(missingUrl);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.error, /^Unauthorized webhook/);

    const wrongUrl = new URL(`http://127.0.0.1:${port}/exec`);
    wrongUrl.searchParams.set('secret', 'abcdefghijklmnoX');
    const wrong = await fetch(wrongUrl);
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.ok, false);
    assert.match(wrongBody.error, /^Unauthorized webhook/);
    responseHides(wrongBody, 'abcdefghijklmnoX');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
