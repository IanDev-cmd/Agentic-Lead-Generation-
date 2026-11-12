import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('enter opens research, with leads, territory, and analytics', () => {
  const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(page, /function openDesk\(\) \{\s*gate\.hidden = true;\s*document\.getElementById\("desk"\)\.hidden = false;\s*show\("studio"\);/);
  assert.match(page, /id="view-accounts"/);
  assert.match(page, /id="view-map"/);
  assert.match(page, /id="view-analytics"/);
  assert.match(page, /sheetButton\.closest\("#toolGrid"\)\) \{\s*openSheet\(sheetButton\.dataset\.sheet\);/);
  assert.match(page, /id="view-strategy"/);
  assert.match(page, /class="territory"/);
  assert.match(page, /Territory\.destroy\(\)/);
  assert.match(page, /is-wide/);
  assert.match(page, /src="\/territory\.js/);
  assert.match(page, />Analytics</);
  assert.equal(page.includes('id="view-pains"'), false);
  assert.equal(page.includes('id="view-priority"'), false);
  assert.equal(page.includes('Northwind'), false);
  assert.equal(page.includes('Contoso'), false);
});
