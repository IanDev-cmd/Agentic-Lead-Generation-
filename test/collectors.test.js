import assert from 'node:assert/strict';
import test from 'node:test';
import { askPrompt } from '../lib/ask.js';
import { keyedNotes } from '../lib/collectors/keyed.js';
import { mergeLeadRecords } from '../lib/collectors/merge.js';

test('two sources for the same domain become one lead', () => {
  const merged = mergeLeadRecords(
    [{ company: 'Scoot Market', domain: 'https://www.scoot.market/', email: 'hello@scoot.market', source: 'gemini', sources: ['gemini'], hq: 'Lisbon' }],
    [{ company: 'Scoot', domain: 'scoot.market', source: 'clearbit', sources: ['clearbit'], signals: ['Clearbit public company record'], photo: 'https://logo.clearbit.com/scoot.market' }],
    'electric scooter marketplace',
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, 'hello@scoot.market');
  assert.equal(merged[0].hq, 'Lisbon');
  assert.equal(merged[0].photo, 'https://logo.clearbit.com/scoot.market');
  assert.deepEqual(merged[0].sources.sort(), ['clearbit', 'gemini']);
  assert.equal(merged[0].score, 15);
});

test('an unrelated source does not join the batch', () => {
  const merged = mergeLeadRecords(
    [{ company: 'Harbor Analytics', domain: 'harbor.example', source: 'gemini' }],
    [{ company: 'Weather Wire', domain: 'weather.example', source: 'hacker_news', signals: ['Unrelated headline'] }],
    'harbor routing',
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].company, 'Harbor Analytics');
});

test('keyed collectors stay quiet when no free key is set', async () => {
  const notes = await keyedNotes('electric scooter', {});
  assert.deepEqual(notes, []);
});

test('the gemini prompt asks for a complete public batch', () => {
  const prompt = askPrompt('photo of an electric scooter', { SELLER_OFFERING: 'Routing software' });
  assert.match(prompt, /Routing software/);
  assert.match(prompt, /marketplace/i);
  assert.match(prompt, /latitude/i);
  assert.match(prompt, /Do not invent an email address/);
  assert.match(prompt, /10 companies/);
});
