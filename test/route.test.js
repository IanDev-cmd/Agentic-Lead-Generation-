import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('from and to routes use OSRM and fall back to a straight line', () => {
  const map = readFileSync(new URL('../web/territory.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(map, /router\.project-osrm\.org/);
  assert.match(map, /overview=full&geometries=geojson/);
  assert.match(map, /Straight-line distance, not a road route/);
  assert.match(map, /role", "listbox"/);
  assert.match(map, /My location/);
  assert.match(map, /haversineKm\(origin, point\) > 15/);
  assert.match(map, /day\.length >= 10/);
  assert.equal(map.includes('innerHTML'), false);
  assert.match(page, /getSelected: \(\) => selected/);
  assert.match(page, /function pickLead/);
});
