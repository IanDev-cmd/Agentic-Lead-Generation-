import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { profilePrompt } from './prompts.js';

export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    seller: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        offering_summary: { type: 'string' },
        domain: { type: 'string' },
        hq_region: { type: 'string' },
      },
    },
    services: { type: 'array' },
    target_industries: { type: 'array' },
    buyer_roles: { type: 'array' },
    tech_keywords: { type: 'array' },
    size_band: { type: 'object' },
    regions: { type: 'object' },
    existing_clients: { type: 'array' },
    lookalike_descriptions: { type: 'array' },
    exclude_domains: { type: 'array' },
    exclude_company_types: { type: 'array' },
  },
};

function hostOf(value) {
  const match = String(value || '').match(/https?:\/\/(?:www\.)?([^/\s]+)/i);
  return match ? match[1].replace(/^www\./, '').toLowerCase() : '';
}

function clientsFromMaterial(material) {
  const match = String(material || '').match(/(?:existing clients|clients include|our clients)\s*[:\-]\s*([^\n.]+)/i);
  if (!match) return [];
  return match[1].split(/,| and /i).map((item) => item.trim()).filter((item) => item.length > 1);
}

function blankSpec() {
  return {
    seller: { name: '', offering_summary: '', domain: '', hq_region: '' },
    services: [],
    target_industries: [],
    buyer_roles: [],
    tech_keywords: [],
    size_band: { min_employees: 20, max_employees: 1500, reasoning: 'Mid-market buyers without an in-house team.' },
    regions: { primary: [], secondary: [] },
    existing_clients: [],
    lookalike_descriptions: [],
    exclude_domains: [],
    exclude_company_types: ['directory', 'marketplace', 'news site', 'job board'],
  };
}

export function applyProfileOverrides(spec, profile, material) {
  const next = blankSpec();
  Object.assign(next, spec || {});
  next.seller = { ...next.seller, ...(spec?.seller || {}) };
  next.regions = { primary: [], secondary: [], ...(spec?.regions || {}) };
  next.size_band = { ...next.size_band, ...(spec?.size_band || {}) };
  next.existing_clients = [...new Set([...(spec?.existing_clients || []), ...clientsFromMaterial(material)])];
  const domain = String(next.seller.domain || hostOf(material) || '').replace(/^www\./, '').toLowerCase();
  next.seller.domain = domain;
  if (profile?.SELLER_NAME) next.seller.name = profile.SELLER_NAME;
  if (profile?.SELLER_OFFERING) next.seller.offering_summary = profile.SELLER_OFFERING;
  if (profile?.TARGET_INDUSTRY) next.target_industries = [profile.TARGET_INDUSTRY];
  if (profile?.TARGET_REGION) next.regions.primary = [profile.TARGET_REGION];
  if (profile?.IDEAL_CUSTOMER_PROFILE) {
    next.lookalike_descriptions = [profile.IDEAL_CUSTOMER_PROFILE, ...(next.lookalike_descriptions || [])];
  }
  const excluded = new Set((next.exclude_domains || []).map((item) => String(item).toLowerCase()));
  if (domain) excluded.add(domain);
  next.exclude_domains = [...excluded];
  return next;
}

function cacheFile(root, material, profile) {
  const hash = createHash('sha256').update(JSON.stringify({ material, profile })).digest('hex').slice(0, 20);
  return path.join(root, 'output', 'cache', `profile-${hash}.json`);
}

export async function buildProfile({ material, profile, generateJson, cacheRoot, useCache = true }) {
  const file = useCache ? cacheFile(cacheRoot || process.cwd(), material, profile || {}) : '';
  if (file) {
    try {
      return applyProfileOverrides(JSON.parse(readFileSync(file, 'utf8')), profile, material);
    } catch {
      // A missing cache means this upload set has not been read yet.
    }
  }
  const generated = await generateJson(profilePrompt(material, profile), PROFILE_SCHEMA);
  const spec = applyProfileOverrides(generated, profile, material);
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(spec, null, 2));
  }
  return spec;
}
