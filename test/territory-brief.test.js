import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { briefPrompt, territoryFacts } from '../lib/territory-brief.js';

test('the brief is built from stored leads and does not invent a start', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brief-'));
  try {
    mkdirSync(path.join(dir, 'fallback'));
    mkdirSync(path.join(dir, 'output'));
    writeFileSync(path.join(dir, 'fallback', 'demo_leads.json'), JSON.stringify({ leads: [] }));
    writeFileSync(path.join(dir, 'output', 'discovered-leads.json'), JSON.stringify({
      leads: [
        { id: 'sf', company: 'Harbor Analytics', hq: '1 Market Street', priority: 'High', hook: 'Hiring', pain: 'Manual research', lat: 37.79, lng: -122.39, geo: { status: 'ok', precision: 'rooftop', confidence: 0.9, source: 'nominatim', resolvedAt: '2026-01-01' } },
        { id: 'chi', company: 'River Works', hq: '500 West Madison', priority: 'Low', hook: '', pain: 'Old machines', lat: 41.88, lng: -87.63, geo: { status: 'ok', precision: 'street', confidence: 0.6, source: 'nominatim', resolvedAt: '2026-01-01' } },
      ],
    }));
    const facts = territoryFacts(dir, { lat: 37.79, lng: -122.39 });
    assert.equal(facts.placed, 2);
    assert.equal(facts.plan.label, 'estimate');
    assert.equal(facts.plan.stops[0], 'Harbor Analytics');
    assert.equal(facts.rings[0].count, 1);
    const prompt = briefPrompt(facts);
    assert.match(prompt, /Do not invent/);
    assert.match(prompt, /Harbor Analytics/);
    assert.equal(prompt.includes('secret'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a territory brief without a Gemini key asks for nothing', async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = '';
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    const cookie = health.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/territory/brief`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ start: { lat: 37.7, lng: -122.4 }, company: 'Ignore this' }),
    });
    const body = await response.json();
    assert.equal(response.status, 424);
    assert.match(body.error, /GEMINI_API_KEY is empty/);
    assert.equal(body.brief, undefined);
  } finally {
    if (previous == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});
