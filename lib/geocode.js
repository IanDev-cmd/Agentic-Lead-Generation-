import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allLeads, rememberLeads } from './lead-store.js';

const POSITIVE_TTL = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
const GAP_MS = 1100;
const TIMEOUT_MS = 8000;
const MAX_ENTRIES = 2000;
const BUDGET = 60;
const BUDGET_WINDOW = 10 * 60 * 1000;
const EMPTY = /^(unknown|n\/a|none|-)$/i;

const ROOFTOP = new Set(['house', 'building', 'residential', 'apartments', 'farm', 'allotments', 'amenity', 'shop', 'office', 'industrial', 'yes']);
const STREET = new Set(['road', 'street', 'highway', 'pedestrian', 'footway', 'path', 'cycleway', 'service']);
const AREA = new Set(['suburb', 'neighbourhood', 'neighborhood', 'quarter', 'city_block', 'city_district', 'borough', 'postcode', 'postal_code']);
const REGION = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'county', 'state', 'region', 'country', 'administrative', 'state_district', 'province']);

const memory = new Map();
const geoHits = [];
let gate = Promise.resolve();
let lastAt = 0;
let fetchOverride = null;
let gapOverride = null;

export function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function isGeocodable(value) {
  const query = normalizeQuery(value);
  return Boolean(query) && !EMPTY.test(query);
}

export function stripUnits(value) {
  return normalizeQuery(String(value || '')
    .replace(/\b(?:suite|ste|floor|apt|apartment|unit|room)\b\.?\s*#?\s*[\w-]+/gi, ' ')
    .replace(/#\s*[\w-]+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ', '));
}

export function precisionOf(hit) {
  const kind = String(hit?.addresstype || hit?.type || '').toLowerCase();
  if (ROOFTOP.has(kind)) return 'rooftop';
  if (STREET.has(kind)) return 'street';
  if (AREA.has(kind)) return 'area';
  if (REGION.has(kind)) return 'region';
  const address = hit?.address || {};
  if (address.house_number) return 'rooftop';
  if (address.road || address.pedestrian) return 'street';
  if (address.suburb || address.neighbourhood || address.postcode) return 'area';
  return 'region';
}

export function confidenceOf(precision, importance) {
  const base = { rooftop: 0.55, street: 0.4, area: 0.25, region: 0.1 }[precision] || 0.1;
  const span = { rooftop: 0.45, street: 0.4, area: 0.3, region: 0.2 }[precision] || 0.2;
  const weight = Number(importance);
  const score = base + (Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0) * span;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

export function interpretHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon ?? hit.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const precision = precisionOf(hit);
  return {
    lat,
    lng,
    precision,
    confidence: confidenceOf(precision, hit.importance),
    displayName: String(hit.display_name || '').slice(0, 300),
    source: 'nominatim',
  };
}

export function trimEntries(entries, max = MAX_ENTRIES) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  keys.sort((left, right) => (entries[left]?.at || 0) - (entries[right]?.at || 0));
  for (const key of keys.slice(0, keys.length - max)) delete entries[key];
  return entries;
}

export function needsGeocode(lead) {
  if (!lead || !isGeocodable(lead.hq)) return false;
  if (lead.geo && (lead.geo.status === 'not_found' || lead.geo.status === 'skipped')) return false;
  return lead.lat == null || lead.lng == null;
}

export function resetGeocodeForTests() {
  geoHits.length = 0;
  fetchOverride = null;
  gapOverride = null;
  lastAt = 0;
  memory.clear();
}

export function takeGeocodeBudget(count = 1, now = Date.now()) {
  while (geoHits.length && now - geoHits[0] > BUDGET_WINDOW) geoHits.shift();
  if (geoHits.length + count > BUDGET) return false;
  for (let index = 0; index < count; index += 1) geoHits.push(now);
  return true;
}

function cacheFile(root) {
  return path.join(root, 'output', 'geocode-cache.json');
}

function entriesFor(root) {
  const key = path.resolve(root);
  if (memory.has(key)) return memory.get(key);
  let entries = {};
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(key), 'utf8'));
    if (parsed && parsed.entries && typeof parsed.entries === 'object') entries = parsed.entries;
  } catch {
    entries = {};
  }
  memory.set(key, entries);
  return entries;
}

function writeEntries(root, entries) {
  trimEntries(entries);
  const dir = path.join(root, 'output');
  mkdirSync(dir, { recursive: true });
  const file = cacheFile(root);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ entries }));
  renameSync(temp, file);
}

function fresh(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  const age = now - Number(entry.at || 0);
  if (entry.result) return age >= 0 && age < POSITIVE_TTL;
  return age >= 0 && age < NEGATIVE_TTL;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueue(task, gapMs) {
  const run = gate.then(async () => {
    const wait = Math.max(0, gapMs - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    return task();
  });
  gate = run.then(() => {}, () => {});
  return run;
}

function userAgent() {
  return (process.env.GEOCODER_USER_AGENT || 'lead-desk/1.0').trim() || 'lead-desk/1.0';
}

function busyError() {
  const error = new Error('The geocoder is busy. Pins that are already placed stay on the map.');
  error.status = 429;
  return error;
}

async function nominatim(query, limit, fetchImpl) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('q', query);
  const email = (process.env.GEOCODER_EMAIL || '').trim();
  if (email) url.searchParams.set('email', email);
  let attempt = 0;
  while (attempt < 3) {
    attempt += 1;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = new Error('The geocoder did not answer.');
      timeout.status = 504;
      timeout.cause = error;
      throw timeout;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 3) throw response.status === 429 ? busyError() : Object.assign(new Error('The geocoder did not answer.'), { status: 502 });
      const header = response.headers?.get?.('retry-after');
      let wait = attempt * 1000;
      if (header != null && header !== '') {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) wait = Math.min(seconds, 30) * 1000;
      }
      if (wait) await sleep(wait);
      continue;
    }
    if (!response.ok) {
      const error = new Error('The geocoder rejected the address.');
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  }
  return [];
}

async function resolveQuery(query, limit, options) {
  const root = options.root || process.cwd();
  const now = options.now || Date.now();
  const text = normalizeQuery(query);
  const entries = options.cache || entriesFor(root);
  const key = `${options.prefix || ''}${text.toLowerCase()}`;
  if (!isGeocodable(text)) return { ok: false, reason: 'skipped', result: options.many ? [] : null, cached: true };
  if (fresh(entries[key], now)) {
    const result = entries[key].result;
    if (options.many) return { ok: true, result: Array.isArray(result) ? result : [], cached: true };
    return result
      ? { ok: true, result, cached: true }
      : { ok: false, reason: 'not_found', result: null, cached: true };
  }
  if (!takeGeocodeBudget(1, now)) throw busyError();
  const fetchImpl = options.fetch || fetchOverride || fetch;
  const gapMs = options.gapMs ?? gapOverride ?? GAP_MS;
  let hits = await enqueue(() => nominatim(text, limit, fetchImpl), gapMs);
  let result = options.many
    ? hits.map(interpretHit).filter(Boolean).slice(0, limit)
    : (hits[0] ? interpretHit(hits[0]) : null);
  if (!options.many && !result) {
    const stripped = stripUnits(text);
    if (stripped && stripped.toLowerCase() !== text.toLowerCase() && isGeocodable(stripped)) {
      hits = await enqueue(() => nominatim(stripped, 1, fetchImpl), gapMs);
      result = hits[0] ? interpretHit(hits[0]) : null;
    }
  }
  const stored = options.many ? (result.length ? result : null) : (result || null);
  entries[key] = { at: Date.now(), result: stored };
  if (!options.cache) writeEntries(root, entries);
  if (options.many) return { ok: true, result, cached: false };
  return result
    ? { ok: true, result, cached: false }
    : { ok: false, reason: 'not_found', result: null, cached: false };
}

export function geocodeAddress(query, options = {}) {
  return resolveQuery(query, 1, options);
}

export function searchAddresses(query, options = {}) {
  return resolveQuery(query, 5, { ...options, many: true, prefix: 'search:' }).then((found) => ({
    ok: found.ok,
    candidates: found.result || [],
    cached: found.cached,
    reason: found.reason || '',
  }));
}

function stamped(lead, result) {
  const resolvedAt = new Date().toISOString();
  if (!result) {
    return {
      ...lead,
      lat: null,
      lng: null,
      coords: '',
      geo: { status: 'not_found', precision: '', confidence: 0, source: 'nominatim', resolvedAt },
    };
  }
  return {
    ...lead,
    lat: result.lat,
    lng: result.lng,
    coords: `${result.lat}, ${result.lng}`,
    geo: {
      status: 'ok',
      precision: result.precision,
      confidence: result.confidence,
      source: 'nominatim',
      resolvedAt,
    },
  };
}

export async function geocodeStoredLeads(root, ids = [], options = {}) {
  const chosen = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
  const selected = allLeads(root).filter((lead) => !chosen.size || chosen.has(lead.id));
  const batch = selected.filter(needsGeocode).slice(0, 6);
  const failed = [];
  let busy = false;
  for (const lead of batch) {
    try {
      const outcome = await geocodeAddress(lead.hq, { root, ...options });
      if (outcome.reason === 'skipped') continue;
      rememberLeads(root, [stamped(lead, outcome.ok ? outcome.result : null)]);
    } catch (error) {
      failed.push({ id: lead.id, reason: error.status === 429 ? 'busy' : 'geocoder' });
      if (error.status === 429) busy = true;
      break;
    }
  }
  const leads = allLeads(root);
  const remaining = leads.filter(needsGeocode).length;
  if (busy) {
    return {
      status: 429,
      body: {
        ok: false,
        error: 'The geocoder is busy. Pins that are already placed stay on the map.',
        leads,
        remaining,
        failed,
      },
    };
  }
  return { status: 200, body: { ok: failed.length === 0, leads, remaining, failed } };
}
