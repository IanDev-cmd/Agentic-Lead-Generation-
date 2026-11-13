import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { leadsFromMarkdown } from './lead-store.js';
import { secretsMatch } from './safety.js';

export function redactSecrets(text, secrets) {
  let safe = String(text || '');
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe.slice(0, 500);
}

export function readWebhookResult(outputDir) {
  try {
    return JSON.parse(readFileSync(path.join(outputDir, 'last-webhook.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function businessEnv(body = {}) {
  const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const env = {};
  const fields = [
    ['SELLER_NAME', clean(body.sellerName, 120)],
    ['SELLER_OFFERING', clean(body.offering, 500)],
    ['TARGET_INDUSTRY', clean(body.industry, 200)],
    ['TARGET_REGION', clean(body.region, 200)],
    ['IDEAL_CUSTOMER_PROFILE', clean(body.icp, 500)],
  ];
  for (const [key, value] of fields) {
    if (value) env[key] = value;
  }
  const maxLeads = clean(body.maxLeads, 2);
  if (/^(4|8|15|50)$/.test(maxLeads)) env.MAX_LEADS = maxLeads;
  const company = clean(body.company, 200);
  const domain = clean(body.domain, 200);
  if (company) env.RESEARCH_COMPANY = company;
  if (domain) env.RESEARCH_DOMAIN = domain;
  return env;
}

function kept(env, name) {
  const value = env[name];
  return value == null ? '' : String(value);
}

export function executeRun(outputDir, env = process.env) {
  mkdirSync(outputDir, { recursive: true });
  const childEnv = {
    ...env,
    DRY_RUN: kept(env, 'DRY_RUN'),
    DEMO_MODE: kept(env, 'DEMO_MODE'),
    BILLING_ENABLED: kept(env, 'BILLING_ENABLED'),
    FORCE_FREE_TIER: kept(env, 'FORCE_FREE_TIER'),
    LEADGEN_ROUTE: kept(env, 'LEADGEN_ROUTE'),
    LEADGEN_OUTPUT_DIR: outputDir,
    GOOGLE_WEBHOOK_URL: env.GOOGLE_WEBHOOK_URL || '',
    WEBHOOK_SECRET: env.WEBHOOK_SECRET || '',
    GEMINI_API_KEY: env.GEMINI_API_KEY || '',
    GEMINI_API_KEY_1: env.GEMINI_API_KEY_1 || '',
    GEMINI_API_KEY_2: env.GEMINI_API_KEY_2 || '',
    GEMINI_API_KEY_3: env.GEMINI_API_KEY_3 || '',
    GEMINI_API_KEY_4: env.GEMINI_API_KEY_4 || '',
    GEMINI_API_KEY_5: env.GEMINI_API_KEY_5 || '',
    RESEARCH_COMPANY: env.RESEARCH_COMPANY || '',
    RESEARCH_DOMAIN: env.RESEARCH_DOMAIN || '',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js'], {
      cwd: process.cwd(),
      env: childEnv,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      const result = readWebhookResult(outputDir);
      let leads = [];
      try {
        const markdown = readFileSync(path.join(outputDir, 'last-report.md'), 'utf8');
        const meta = JSON.parse(readFileSync(path.join(outputDir, 'last-report.json'), 'utf8'));
        leads = leadsFromMarkdown(markdown, meta.interactionId || '');
      } catch {
        leads = [];
      }
      resolve({
        code,
        stderr: redactSecrets(stderr, [childEnv.WEBHOOK_SECRET, childEnv.GEMINI_API_KEY, childEnv.GEMINI_API_KEY_1, childEnv.GEMINI_API_KEY_2, childEnv.GEMINI_API_KEY_3, childEnv.GEMINI_API_KEY_4, childEnv.GEMINI_API_KEY_5, childEnv.DESK_TOKEN]),
        result,
        leads,
      });
    });
  });
}

export function executeDryRun(outputDir, env = process.env) {
  return executeRun(outputDir, env);
}

export function deskAuthorized(headerValue, expected, production = false) {
  if (!expected) return !production;
  return secretsMatch(headerValue || '', expected);
}
