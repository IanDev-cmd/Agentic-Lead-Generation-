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

test('webhook callers do not put the secret in the JSON body', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const python = readFileSync(new URL('../fallback/pipeline.py', import.meta.url), 'utf8');
  const desk = readFileSync(new URL('../lib/desk-run.js', import.meta.url), 'utf8');
  assert.equal(index.includes('secret: config.webhookSecret'), false);
  assert.equal(script.includes('body.secret'), false);
  assert.equal(python.includes('"secret": settings.webhook_secret'), false);
  assert.equal(python.includes('X-Webhook-Secret'), true);
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
  assert.equal((await leads.json()).leads[0].company, 'Northwind Analytics');
  assert.equal(denied.status, 401);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.headers.get('content-type').includes('text/html'), true);
  assert.equal(html.startsWith('<!DOCTYPE html>'), true);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.env.DESK_TOKEN = '';
});

test('an Apps Script redirect is read with GET before a second POST', async () => {
  const { createServer } = await import('node:http');
  const { postAppsScript } = await import('../lib/webhook.js');
  const server = createServer((request, response) => {
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
    const ok = request.method === 'POST' && request.headers['x-webhook-secret'] === 'abcdefghijklmnop';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const result = await postAppsScript(`http://127.0.0.1:${port}/exec`, 'abcdefghijklmnop', { action: 'links' });
  assert.equal(result.body.ok, true);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the echo page is used when it already contains the JSON', async () => {
  const { createServer } = await import('node:http');
  const { postAppsScript } = await import('../lib/webhook.js');
  const server = createServer((request, response) => {
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
  const result = await postAppsScript(`http://127.0.0.1:${port}/exec`, 'abcdefghijklmnop', { action: 'links' });
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.items, []);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
