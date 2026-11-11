import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { asCell, secretsMatch } from '../lib/safety.js';
import { shouldDelegate } from '../lib/route.js';
import { demoLeads } from '../lib/leads.js';
import { askPrompt, parseLeadAnswer } from '../lib/ask.js';
import { officeText } from '../lib/office.js';
import { businessEnv, deskAuthorized, executeDryRun } from '../lib/desk-run.js';

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
  assert.equal(index.includes('secret: config.webhookSecret'), false);
  assert.equal(script.includes('body.secret'), false);
  assert.equal(python.includes('"secret": settings.webhook_secret'), false);
  assert.equal(script.includes('findDraftBySubject_'), true);
  assert.equal(script.includes('findOpenTask_'), true);
});

test('a dry run with no webhook reports that nothing was written', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-run-'));
  const run = await executeDryRun(dir, {
    ...process.env,
    GOOGLE_WEBHOOK_URL: '',
    WEBHOOK_SECRET: '',
    GEMINI_API_KEY: '',
    DRY_RUN: 'true',
  });
  assert.equal(run.code, 0);
  assert.equal(run.result.synced, false);
  assert.match(run.result.error, /Nothing was written/);
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
