import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { askSources, leadCap } from '../lib/ask.js';
import { applyQuote } from '../lib/pipeline/extract.js';
import { groundingTargets, resolveFinalUrl } from '../lib/pipeline/gemini.js';
import { runPipeline } from '../lib/pipeline/index.js';
import { mapLead, mapResult } from '../lib/pipeline/map.js';
import { planQueries } from '../lib/pipeline/plan.js';
import { buildProfile } from '../lib/pipeline/profile.js';
import { emailsOnPage } from '../lib/pipeline/contacts.js';
import { scoreCandidate, tierOf } from '../lib/pipeline/score.js';
import { verifyCandidates } from '../lib/pipeline/verify.js';

const spec = {
  seller: { name: 'Zanari Analytics Ltd', offering_summary: 'business intelligence and analytics', domain: 'zanarianalytics.com' },
  services: [{ name: 'Analytics', buyer_pains: ['manual reporting'], trigger_signals: ['data analyst vacancy'] }],
  target_industries: ['health'],
  regions: { primary: ['Nairobi'], secondary: ['London'] },
  existing_clients: ['Kenya Railways', 'Nairobi Hospital', 'County of Kiambu'],
  lookalike_descriptions: ['county hospital'],
  exclude_domains: ['zanarianalytics.com'],
  size_band: { min_employees: 20, max_employees: 500 },
};

test('a company profile excludes the seller and its existing clients', async () => {
  const material = [
    'Zanari Analytics Ltd',
    'Website: https://www.zanarianalytics.com',
    'Existing clients: Kenya Railways, Nairobi Hospital, County of Kiambu',
  ].join('\n');
  const built = await buildProfile({
    material,
    profile: {},
    useCache: false,
    generateJson: async () => ({
      seller: { name: 'Zanari Analytics Ltd', offering_summary: 'analytics', domain: '' },
      existing_clients: ['Kenya Railways', 'Nairobi Hospital', 'County of Kiambu'],
      regions: { primary: ['Nairobi'], secondary: [] },
      services: [],
      target_industries: ['health'],
      exclude_domains: [],
    }),
  });
  assert.equal(built.seller.name, 'Zanari Analytics Ltd');
  assert.ok(built.exclude_domains.includes('zanarianalytics.com'));
  assert.deepEqual(built.existing_clients, ['Kenya Railways', 'Nairobi Hospital', 'County of Kiambu']);
});

test('signal queries stay short, current, and unordered by a hardcoded country', () => {
  const source = readFileSync(new URL('../lib/pipeline/plan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Kenya first/i);
  const queries = planQueries(spec, { max: 16, now: new Date('2026-11-13T00:00:00Z') });
  assert.ok(queries.length >= 12 && queries.length <= 20);
  assert.ok(queries.every((query) => query.split(' ').length <= 12));
  assert.equal(new Set(queries.map((query) => query.toLowerCase())).size, queries.length);
  assert.ok(queries.some((query) => query.includes('2026')));
  const joined = queries.join('\n');
  assert.ok(joined.indexOf('Nairobi') < joined.indexOf('London'));
});

test('grounding redirects resolve and metadata is read', async () => {
  const targets = groundingTargets({
    candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'Clinic' } }] } }],
  });
  assert.equal(targets[0].title, 'Clinic');
  const fetchImpl = async (url) => {
    if (String(url).includes('grounding-api-redirect')) {
      return { status: 302, headers: { get: () => 'https://clinic.co.ke/news' } };
    }
    return { status: 200, headers: { get: () => '' } };
  };
  const finalUrl = await resolveFinalUrl(targets[0].uri, fetchImpl);
  assert.equal(finalUrl, 'https://clinic.co.ke/news');
});

test('an evidence quote that is not on the page is dropped', () => {
  const page = 'The county still compiles reports in Excel each Monday.';
  const kept = applyQuote({ evidence_quote: 'compiles reports in Excel' }, page);
  assert.equal(kept.quoteVerified, true);
  const dropped = applyQuote({ evidence_quote: 'a sentence that was never published' }, page);
  assert.equal(dropped.evidence_quote, '');
  assert.equal(dropped.quoteVerified, false);
  assert.equal(dropped.highEligible, false);
});

test('verification drops dead domains, the seller, clients, directories, and duplicates', async () => {
  const fetchPage = async (url) => {
    if (String(url).includes('dead.')) return { ok: false, status: 404, text: '' };
    return { ok: true, status: 200, text: 'Clinic Board serves Nairobi. Twin Clinic serves Nairobi.' };
  };
  const { kept, dropped } = await verifyCandidates([
    { company: 'Clinic Board', domain: 'clinic.co.ke', website: 'https://clinic.co.ke' },
    { company: 'Clinic Board', domain: 'clinic.co.ke', website: 'https://clinic.co.ke', hq: 'Nairobi' },
    { company: 'Gone Co', domain: 'dead.example', website: 'https://dead.example' },
    { company: 'Zanari Analytics Ltd', domain: 'zanarianalytics.com', website: 'https://zanarianalytics.com' },
    { company: 'Kenya Railways', domain: 'krc.co.ke', website: 'https://krc.co.ke' },
    { company: 'Directory', domain: 'crunchbase.com', website: 'https://crunchbase.com' },
  ], { fetchPage, spec });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].company, 'Clinic Board');
  assert.ok(dropped.some((item) => item.reason === 'dead-domain'));
  assert.ok(dropped.some((item) => item.reason === 'seller'));
  assert.ok(dropped.some((item) => item.reason === 'existing-client'));
  assert.ok(dropped.some((item) => item.reason === 'denylist'));
  assert.ok(dropped.some((item) => item.reason === 'duplicate'));
});

test('tier, enterprise cap, and the high priority rule are deterministic', () => {
  assert.equal(tierOf(75), 'A');
  assert.equal(tierOf(74), 'B');
  assert.equal(tierOf(55), 'B');
  assert.equal(tierOf(54), 'C');
  const base = {
    company: 'Clinic Board',
    industry: 'health',
    approx_size_signal: '80 staff',
    hq: 'Nairobi',
    signal: '2026 tender',
    hook: 'You still compile reports in Excel.',
    recent: true,
  };
  const high = scoreCandidate({ ...base, quoteVerified: true, evidence_quote: 'compiles reports in Excel' }, spec);
  assert.equal(high.tier, 'A');
  assert.equal(high.priority, 'High');
  const unverified = scoreCandidate({ ...base, quoteVerified: false, evidence_quote: '', hook: 'You still compile reports in Excel.' }, spec);
  assert.equal(unverified.priority, 'Low');
  assert.equal(unverified.hook, '');
  const giant = scoreCandidate({
    ...base,
    company: 'National Telecom',
    approx_size_signal: 'national telecom',
    quoteVerified: false,
    evidence_quote: '',
  }, spec, ['national telecom']);
  assert.ok(giant.fit_score <= 40);
  assert.notEqual(giant.tier, 'A');
  assert.equal(giant.priority, 'Low');
});

test('contact emails come from the company site only', () => {
  assert.equal(emailsOnPage('<a href="mailto:sales@clinic.co.ke">mail</a>', 'clinic.co.ke'), 'sales@clinic.co.ke');
  assert.equal(emailsOnPage('<p>Write hello@clinic.co.ke today.</p>', 'clinic.co.ke'), 'hello@clinic.co.ke');
  assert.equal(emailsOnPage('<p>ada@other.com</p>', 'clinic.co.ke'), '');
  assert.equal(emailsOnPage('<p>No address is published.</p>', 'clinic.co.ke'), '');
});

test('mapped leads keep the desk shape and a real source', () => {
  const mapped = mapResult(spec, [{
    company: 'Clinic Board',
    domain: 'clinic.co.ke',
    website: 'https://clinic.co.ke',
    hq: 'Nairobi',
    priority: 'High',
    hook: 'You still compile reports in Excel.',
    pain: 'Manual reporting',
    evidence_url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
    evidence_quote: 'compiles reports in Excel',
    fit_score: 90,
    tier: 'A',
    regionRank: 'primary',
    email: 'sales@clinic.co.ke',
  }], ['zanari-profile.pdf']);
  const lead = mapped.leads[0];
  for (const key of ['company', 'domain', 'website', 'hq', 'lat', 'lng', 'contact', 'title', 'email', 'pain', 'hook', 'priority', 'source']) {
    assert.ok(key in lead);
  }
  assert.equal(lead.source, 'https://clinic.co.ke');
  assert.doesNotMatch(lead.source, /grounding-api-redirect|zanari-profile/);
  assert.equal(lead.priority, 'High');
  assert.match(mapped.explanation, /Zanari Analytics Ltd/);
  assert.ok(mapped.explanation.length <= 600);
  const upload = mapLead({
    company: 'Clinic Board',
    domain: 'clinic.co.ke',
    evidence_url: 'https://files.example/zanari-profile.pdf',
    priority: 'Low',
  }, ['zanari-profile.pdf']);
  assert.equal(upload.source, 'https://clinic.co.ke');
});

test('askSources keeps its shape, the cap, and the one-shot fallback', async () => {
  const previous = process.env.PIPELINE_ENABLED;
  process.env.PIPELINE_ENABLED = 'true';
  const names = ['Harbor One', 'Harbor Two', 'Harbor Three', 'Harbor Four', 'Harbor Five', 'Harbor Six'];
  const header = '| Company | Domain | Website | HQ Address | Lat | Lng | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |';
  const rows = names.map((name, index) => `| ${name} | harbor${index}.example | https://harbor${index}.example | Nairobi | | | | | | Manual reporting | A public reporting load | High | https://harbor${index}.example/about |`);
  const text = ['EXPLANATION:', 'Harbor Desk sells routing software. These 6 companies are possible buyers, Nairobi first, then elsewhere.', 'LEADS:', header, '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
  try {
    const answer = await askSources({
      model: 'gemini-2.5-flash',
      question: 'Generate leads for me',
      profile: { MAX_LEADS: 4, SELLER_NAME: 'Harbor Desk', SELLER_OFFERING: 'routing software' },
      parts: [{ text: 'Harbor Desk sells routing software.' }],
      generateJson: async () => { throw new Error('pipeline down'); },
      useCache: false,
      ai: { models: { generateContent: async () => ({ text }) } },
      fetchPage: async () => ({ ok: true, status: 200, text: names.join(' ') }),
    });
    assert.equal(typeof answer.explanation, 'string');
    assert.ok(Array.isArray(answer.leads));
    assert.equal(answer.leads.length, 4);
    assert.equal(leadCap({ MAX_LEADS: 4 }), 4);
    assert.equal(answer.leads[0].company, 'Harbor One');
    assert.equal(answer.leads[0].priority, 'High');
  } finally {
    if (previous == null) delete process.env.PIPELINE_ENABLED;
    else process.env.PIPELINE_ENABLED = previous;
  }
});

test('a deadline returns the leads already found and does not throw', async () => {
  let clock = 0;
  const result = await runPipeline({
    deadlineMs: 30,
    now: () => clock,
    useCache: false,
    profile: {},
    parts: [{ text: 'Zanari Analytics Ltd sells analytics.' }],
    generateJson: async () => {
      clock = 1000;
      return {
        seller: { name: 'Zanari Analytics Ltd', offering_summary: 'analytics', domain: 'zanarianalytics.com' },
        existing_clients: [],
        regions: { primary: ['Nairobi'], secondary: [] },
        services: [],
        target_industries: ['health'],
      };
    },
  });
  assert.ok(Array.isArray(result.leads));
  assert.equal(result.leads.length, 0);
  assert.match(result.explanation, /Zanari Analytics Ltd/);
});
