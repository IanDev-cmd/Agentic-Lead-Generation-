import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('territory opens in the drawer and vendors Leaflet', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const map = readFileSync(new URL('../web/territory.js', import.meta.url), 'utf8');
  const license = readFileSync(new URL('../web/vendor/leaflet/LICENSE', import.meta.url), 'utf8');
  const leaflet = readFileSync(new URL('../web/vendor/leaflet/leaflet.js', import.meta.url), 'utf8');
  assert.match(page, /const inAppSheets = new Set\(\["map"\]\)/);
  assert.match(page, /inAppSheets\.has\(sheetButton\.dataset\.sheet\)\) openSheet/);
  assert.match(page, /else openGoogleApp/);
  assert.match(page, /class="territory"/);
  assert.match(page, /Territory\.destroy\(\)/);
  assert.match(page, /is-wide/);
  assert.match(page, /src="\/territory\.js"/);
  assert.match(map, /tile\.openstreetmap\.org/);
  assert.match(map, /World_Imagery/);
  assert.match(map, /World_Boundaries_and_Places/);
  assert.match(map, /Map tiles could not load/);
  assert.match(map, /No headquarters address is on the desk yet/);
  assert.match(map, /No public headquarters address/);
  assert.match(map, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(map, /Routes are drawn by the public OSRM server/);
  assert.equal(map.includes('innerHTML'), false);
  assert.match(license, /BSD/);
  assert.match(leaflet, /1\.9\.4/);
});

test('vendor files are cached as immutable and other responses stay no-store', async () => {
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const vendor = await fetch(`${base}/vendor/leaflet/leaflet.css`);
  const health = await fetch(`${base}/api/health`);
  const page = await fetch(`${base}/`);
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
