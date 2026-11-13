import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { leadCap } from '../ask.js';
import { browseCompanies, browserAgentEnabled } from './browser.js';
import { GroundingQuota, repairJson, responseText, withRetry } from './gemini.js';
import { mapResult } from './map.js';
import { planQueries } from './plan.js';
import { buildProfile } from './profile.js';
import { scoreCandidate, selectLeads } from './score.js';
import { searchQueries } from './search.js';
import { extractCandidates } from './extract.js';
import { attachContacts } from './contacts.js';
import { writeTrace } from './trace.js';
import { verifyCandidates } from './verify.js';

export function createDeadline(ms, now = Date.now) {
  const start = now();
  return {
    expired() {
      return now() - start >= ms;
    },
  };
}

export function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function fetchHtml(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'lead-desk/1.0', Accept: 'text/html' },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow',
  });
  const type = response.headers?.get?.('content-type') || '';
  if (type && !/text\/html|text\/plain/i.test(type)) return { ok: false, status: response.status, text: '' };
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  if (text.length > 1000000) text = text.slice(0, 1000000);
  const status = Number(response.status) || 0;
  return { ok: response.ok || (status >= 200 && status < 400), status, text };
}

function sellerMaterial(parts) {
  const text = (parts || []).filter((part) => part && part.text).map((part) => part.text).join('\n\n');
  const images = (parts || []).filter((part) => part && !part.text).length;
  return images ? `${text}\nAn image is attached to this same request.` : text;
}

async function liveGenerators(options) {
  const model = options.model || 'gemini-3.8-flash';
  const { GoogleGenAI } = await import('@google/genai');
  const { fallbackAi } = await import('../models.js');
  const ai = options.ai || fallbackAi(new GoogleGenAI({ apiKey: options.apiKey }));
  const quota = new GroundingQuota(
    path.join(options.root || process.cwd(), 'output', 'grounding-quota.json'),
    model,
    numberEnv('PIPELINE_MAX_QUERIES', 14),
  );
  const call = (config, prompt, ms) => withRetry(() => Promise.race([
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 504')), ms)),
  ]));
  return {
    quota,
    generateJson: async (prompt, schema) => {
      const config = { responseMimeType: 'application/json' };
      if (schema) config.responseSchema = schema;
      const response = await call(config, prompt, 25000);
      return repairJson(responseText(response));
    },
    generateGrounded: async (prompt) => {
      if (!quota.allow()) return { text: '', stopped: true };
      const response = await call({ tools: [{ googleSearch: {} }] }, prompt, 25000);
      quota.commit();
      return response;
    },
  };
}

export async function runPipeline(options = {}) {
  const started = Date.now();
  const now = options.now || Date.now;
  const deadline = createDeadline(options.deadlineMs ?? numberEnv('PIPELINE_DEADLINE_MS', 80000), now);
  const id = options.runId || randomUUID();
  const trace = { id, queries: [], counts: [], dropped: [], scores: [], quota: 0 };
  const empty = (spec) => ({ explanation: spec?.seller?.name ? `${spec.seller.name} sells ${spec.seller.offering_summary || 'its services'}. These 0 companies are possible buyers.` : '', leads: [] });
  if (deadline.expired()) return empty(null);
  let spec = options.spec || null;
  const material = options.material || sellerMaterial(options.parts);
  try {
    if (!spec) {
      const generators = options.generateJson ? null : await liveGenerators(options);
      const generateJson = options.generateJson || generators.generateJson;
      spec = await buildProfile({
        material,
        profile: options.profile,
        generateJson,
        cacheRoot: options.root || process.cwd(),
        useCache: options.useCache !== false,
      });
      if (generators) trace.quota = generators.quota.usedThisRun;
      options = { ...options, generateJson, generateGrounded: options.generateGrounded || generators?.generateGrounded, quota: generators?.quota };
    }
  } catch (error) {
    trace.error = error instanceof Error ? error.message : 'profile failed';
    throw error;
  }
  trace.spec = spec;
  if (deadline.expired()) {
    finish(trace, empty(spec), started, options);
    return empty(spec);
  }
  const max = numberEnv('PIPELINE_MAX_QUERIES', 14);
  const queries = planQueries(spec, { max, now: new Date(now()) });
  trace.queries = queries;
  const fetchPage = options.fetchPage || ((url) => fetchHtml(url, options.fetchImpl));
  let rows = [];
  if (options.generateGrounded && !deadline.expired()) {
    const searched = await searchQueries({
      queries,
      spec,
      generateGrounded: options.generateGrounded,
      fetchImpl: options.fetchImpl,
      concurrency: numberEnv('PIPELINE_CONCURRENCY', 3),
      deadline,
    });
    rows = searched.rows;
    trace.counts = searched.counts;
    if (options.quota) trace.quota = options.quota.usedThisRun;
  }
  if (browserAgentEnabled()) {
    try {
      await browseCompanies(rows.slice(0, 5), { root: options.root || process.cwd() });
    } catch {
      // A browser failure stays on the HTTP evidence already collected.
    }
  }
  const generateJson = options.generateJson;
  const extracted = generateJson ? await extractCandidates({
    rows,
    fetchPage,
    generateJson,
    limit: leadCap(options.profile) * 3,
    deadline,
  }) : [];
  const verified = await verifyCandidates(extracted, { fetchPage, spec, deadline });
  trace.dropped = verified.dropped;
  const scored = verified.kept.map((candidate) => scoreCandidate(candidate, spec));
  trace.scores = scored.map((candidate) => ({ company: candidate.company, fit_score: candidate.fit_score, tier: candidate.tier, priority: candidate.priority }));
  const minTier = process.env.PIPELINE_MIN_TIER || 'B';
  const chosen = selectLeads(scored, leadCap(options.profile), minTier);
  const withContacts = await attachContacts(chosen, fetchPage, deadline);
  const mapped = mapResult(spec, withContacts, options.uploadUrls || []);
  finish(trace, mapped, started, options);
  return mapped;
}

function finish(trace, mapped, started, options) {
  trace.leadCount = mapped.leads.length;
  trace.dropped = Array.isArray(trace.dropped) ? trace.dropped.length : trace.dropped;
  trace.ms = Date.now() - started;
  try {
    writeTrace(options.root || process.cwd(), trace.id, trace);
  } catch {
    // The desk still returns the leads when the trace cannot be written.
  }
}
