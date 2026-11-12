import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { allLeads } from '../lib/lead-store.js';
import { normalizeLead } from '../lib/leads.js';
import {
  confidenceOf,
  geocodeAddress,
  geocodeStoredLeads,
  precisionOf,
  resetGeocodeForTests,
  searchAddresses,
  stripUnits,
  takeGeocodeBudget,
  trimEntries,
} from '../lib/geocode.js';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

test('old lead files load and coordinates stay backward compatible', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lead-geo-'));
  try {
    mkdirSync(path.join(dir, 'fallback'));
    mkdirSync(path.join(dir, 'output'));
    writeFileSync(path.join(dir, 'fallback', 'demo_leads.json'), JSON.stringify({ leads: [] }));
    writeFileSync(path.join(dir, 'output', 'discovered-leads.json'), JSON.stringify({
      leads: [{
        company: 'Old Mill',
        hq: '1 Main Street, Springfield',
        priority: 'Low',
        pain: 'Late invoices',
        hook: '',
      }],
    }));
    const loaded = allLeads(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].company, 'Old Mill');
    assert.equal(loaded[0].lat, null);
    assert.equal(loaded[0].lng, null);
    assert.equal(loaded[0].coords, '');
    assert.equal(loaded[0].geo.status, 'pending');
    const placed = normalizeLead({ company: 'Placed Co', hq: '1 Market Street', coords: '37.79, -122.39', priority: 'Low' });
    assert.equal(placed.lat, 37.79);
    assert.equal(placed.lng, -122.39);
    assert.equal(placed.coords, '37.79, -122.39');
    assert.equal(placed.geo.status, 'ok');
    const skipped = normalizeLead({ company: 'No Address', hq: '', priority: 'Low' });
    assert.equal(skipped.geo.status, 'skipped');
    assert.equal(skipped.lat, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nominatim lookups are cached, retried once without unit tokens, and rate limited', async () => {
  resetGeocodeForTests();
  const previousEmail = process.env.GEOCODER_EMAIL;
  const previousAgent = process.env.GEOCODER_USER_AGENT;
  process.env.GEOCODER_EMAIL = 'desk@example.com';
  process.env.GEOCODER_USER_AGENT = 'lead-desk/1.0';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'geocode-'));
  mkdirSync(path.join(dir, 'output'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), agent: init.headers['User-Agent'] });
    const query = new URL(url).searchParams.get('q');
    if (query.startsWith('reject')) return jsonResponse(400, { error: 'no' });
    if (query.startsWith('busy')) return jsonResponse(429, [], { 'retry-after': '0' });
    if (query.includes('Suite')) return jsonResponse(200, []);
    if (query.startsWith('search me')) {
      return jsonResponse(200, [
        { lat: '41.0', lon: '-87.0', addresstype: 'city', importance: 0.4, display_name: 'One' },
        { lat: '42.0', lon: '-88.0', addresstype: 'road', importance: 0.5, display_name: 'Two' },
      ]);
    }
    return jsonResponse(200, [{
      lat: '41.8781',
      lon: '-87.6298',
      addresstype: 'house',
      importance: 0.8,
      display_name: 'Chicago',
    }]);
  };
  try {
    assert.equal(precisionOf({ addresstype: 'house' }), 'rooftop');
    assert.equal(precisionOf({ addresstype: 'road' }), 'street');
    assert.equal(precisionOf({ addresstype: 'suburb' }), 'area');
    assert.equal(precisionOf({ addresstype: 'city' }), 'region');
    assert.ok(confidenceOf('rooftop', 0.8) > confidenceOf('region', 0.8));
    assert.equal(stripUnits('100 Market Street Suite 200, Chicago'), '100 Market Street, Chicago');

    const first = await geocodeAddress('500 West Madison Street, Chicago', {
      root: dir,
      fetch: fetchImpl,
      gapMs: 0,
    });
    assert.equal(first.cached, false);
    assert.equal(first.result.precision, 'rooftop');
    assert.equal(first.result.source, 'nominatim');
    assert.equal(calls[0].agent, 'lead-desk/1.0');
    assert.match(calls[0].url, /email=desk%40example.com/);
    const second = await geocodeAddress('500 West Madison Street, Chicago', {
      root: dir,
      fetch: fetchImpl,
      gapMs: 0,
    });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);
    const cache = JSON.parse(readFileSync(path.join(dir, 'output', 'geocode-cache.json'), 'utf8'));
    assert.ok(cache.entries['500 west madison street, chicago'].result.lat);

    const stripped = await geocodeAddress('100 Market Street Suite 200, Chicago', {
      root: dir,
      fetch: fetchImpl,
      gapMs: 0,
    });
    assert.equal(stripped.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[2].url).searchParams.get('q').includes('Suite'), false);

    const missed = await geocodeAddress('', { root: dir, fetch: fetchImpl, gapMs: 0 });
    assert.equal(missed.reason, 'skipped');
    const unknown = await geocodeAddress('unknown', { root: dir, fetch: fetchImpl, gapMs: 0 });
    assert.equal(unknown.reason, 'skipped');
    assert.equal(calls.length, 3);
    const beforeReject = calls.length;
    await assert.rejects(
      () => geocodeAddress('reject this', { root: dir, fetch: fetchImpl, gapMs: 0 }),
      (caught) => caught.status === 400,
    );
    assert.equal(calls.length, beforeReject + 1);
    await assert.rejects(
      () => geocodeAddress('busy street', { root: dir, fetch: fetchImpl, gapMs: 0 }),
      (caught) => caught.status === 429,
    );
    const search = await searchAddresses('search me', { root: dir, fetch: fetchImpl, gapMs: 0 });
    assert.equal(search.candidates.length, 2);
    assert.equal(search.candidates[0].precision, 'region');
    const again = await searchAddresses('search me', { root: dir, fetch: fetchImpl, gapMs: 0 });
    assert.equal(again.cached, true);
    const entries = {};
    for (let index = 0; index < 2002; index += 1) entries['k' + index] = { at: index, result: { lat: 1, lng: 2 } };
    assert.equal(Object.keys(trimEntries(entries)).length, 2000);
    resetGeocodeForTests();
    for (let index = 0; index < 60; index += 1) assert.equal(takeGeocodeBudget(1, 1_000), true);
    assert.equal(takeGeocodeBudget(1, 1_000), false);

    mkdirSync(path.join(dir, 'fallback'));
    writeFileSync(path.join(dir, 'fallback', 'demo_leads.json'), JSON.stringify({ leads: [] }));
    writeFileSync(path.join(dir, 'output', 'discovered-leads.json'), JSON.stringify({
      leads: [
        { id: 'mill', company: 'Old Mill', hq: '9 River Road, Chicago', priority: 'Low', pain: 'Late invoices', hook: '' },
        { id: 'blank', company: 'Blank', hq: '', priority: 'Low', pain: '', hook: '' },
      ],
    }));
    resetGeocodeForTests();
    const outcome = await geocodeStoredLeads(dir, ['mill', 'blank'], { fetch: fetchImpl, gapMs: 0 });
    assert.equal(outcome.status, 200);
    const mill = outcome.body.leads.find((lead) => lead.id === 'mill');
    assert.equal(mill.geo.status, 'ok');
    assert.equal(mill.coords, `${mill.lat}, ${mill.lng}`);
    assert.equal(outcome.body.remaining, 0);
  } finally {
    if (previousEmail == null) delete process.env.GEOCODER_EMAIL;
    else process.env.GEOCODER_EMAIL = previousEmail;
    if (previousAgent == null) delete process.env.GEOCODER_USER_AGENT;
    else process.env.GEOCODER_USER_AGENT = previousAgent;
    resetGeocodeForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('geocode routes sit behind the desk gate and do not use the shared write limiter', async () => {
  const page = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../web/territory.js', import.meta.url), 'utf8');
  const gate = page.indexOf('deskAuthorized');
  const route = page.indexOf("url.pathname === '/api/geocode'");
  const shared = page.indexOf('const metered');
  assert.ok(gate > 0 && gate < route && route < shared);
  assert.match(client, /Placing pins /);
  assert.match(client, /\/api\/geocode/);
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    const cookie = health.headers.get('set-cookie').split(';')[0];
    const denied = await fetch(`${base}/api/geocode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['missing-lead'] }),
    });
    const placed = await fetch(`${base}/api/geocode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: ['missing-lead'] }),
    });
    const search = await fetch(`${base}/api/geocode/search?q=`, { headers: { cookie } });
    const placedBody = await placed.json();
    const searchBody = await search.json();
    if (denied.status !== 401) assert.equal(denied.status, 200);
    assert.equal(placed.status, 200);
    assert.equal(Array.isArray(placedBody.leads), true);
    assert.equal(Array.isArray(placedBody.failed), true);
    assert.equal(typeof placedBody.remaining, 'number');
    assert.equal(search.status, 200);
    assert.deepEqual(searchBody.candidates, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
