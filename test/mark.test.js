import assert from 'node:assert/strict';
import test from 'node:test';
import { imagesIn, isPlatformIcon, ownWebsite, resolveMark } from '../lib/mark.js';

test('a social favicon is not a company logo', () => {
  assert.equal(isPlatformIcon('https://www.google.com/s2/favicons?domain=linkedin.com&sz=128'), true);
  assert.equal(isPlatformIcon('https://static.licdn.com/aero-v1/sc/h/logo.png'), true);
  assert.equal(isPlatformIcon('https://media.licdn.com/dms/image/company-logo.png'), false);
  assert.equal(ownWebsite('https://www.linkedin.com/company/one-acre-fund'), '');
  assert.equal(ownWebsite('https://oneacrefund.org'), 'https://oneacrefund.org');
});

test('a company page prefers its own icon over the network mark', () => {
  const html = `
    <meta property="og:image" content="https://cdn.example/banner.jpg">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="icon" href="/favicon.ico">
  `;
  const found = imagesIn(html, 'https://oneacrefund.org/');
  assert.equal(found[0].url, 'https://cdn.example/banner.jpg');
  assert.equal(found.some((item) => item.url === 'https://oneacrefund.org/apple-touch-icon.png'), true);
});

test('the lead photo uses the company mark or a public face', async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.startsWith('https://oneacrefund.org')) {
      return {
        ok: true,
        url: target,
        headers: { get: () => 'text/html' },
        text: async () => '<link rel="apple-touch-icon" href="https://oneacrefund.org/logo.png">',
      };
    }
    if (target.includes('wbsearchentities') && target.includes('Andrew')) {
      return {
        ok: true,
        url: target,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ search: [{ id: 'Q20020931', label: 'Andrew Youn', description: 'American social entrepreneur' }] }),
      };
    }
    if (target.includes('Q20020931')) {
      return {
        ok: true,
        url: target,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ entities: { Q20020931: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Andrew Youn.jpg' } } }] } } } }),
      };
    }
    return { ok: false, url: target, headers: { get: () => '' }, text: async () => '' };
  };
  const logo = await resolveMark({
    company: 'One Acre Fund',
    website: 'https://www.linkedin.com/company/one-acre-fund',
    source: 'https://oneacrefund.org',
    photo: 'https://www.google.com/s2/favicons?domain=linkedin.com&sz=128',
  }, fetchImpl);
  assert.equal(logo, 'https://oneacrefund.org/logo.png');
  const face = await resolveMark({
    company: 'Andrew Youn',
    contact: 'Andrew Youn',
    source: 'https://www.linkedin.com/in/andrew-youn',
    photo: 'https://www.google.com/s2/favicons?domain=linkedin.com&sz=128',
  }, fetchImpl);
  assert.equal(face, 'https://commons.wikimedia.org/wiki/Special:FilePath/Andrew_Youn.jpg?width=500');
});

test('a private address is not fetched', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return { ok: false, url: String(url), headers: { get: () => '' }, text: async () => '' };
  };
  const photo = await resolveMark({ company: 'Local', website: 'http://127.0.0.1/admin', source: 'http://10.0.0.5/' }, fetchImpl);
  assert.equal(photo, '');
  assert.equal(seen.some((url) => /127\.0\.0\.1|10\.0\.0\.5/.test(url)), false);
});
