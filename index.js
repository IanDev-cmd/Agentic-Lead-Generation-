import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { postAppsScript } from './lib/webhook.js';
import { shouldDelegate } from './lib/route.js';

/**
 * Local half of the lead pipeline.
 *
 * 1. Start Deep Research with background=true (store=true is required).
 * 2. Poll interactions.get with exponential backoff until completed, failed, or cancelled.
 * 3. Save the markdown, then POST it to the Apps Script web app.
 *
 * REPORT_FILE and DRY_RUN never call Gemini. RESUME_INTERACTION_ID polls an
 * existing run so a failed webhook does not start a second research task.
 */

const FIXTURE_REPORT = `
| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Northwind Analytics | northwind.example | 1 Market Street, San Francisco, CA | unknown | VP Operations | unknown | Public job posts describe account research as a full-day manual task | Careers page lists a new RevOps role opened this month | High | https://example.com/northwind |
| Contoso Fabrication | contoso.example | 500 West Madison Street, Chicago, IL | unknown | unknown | unknown | unknown | unknown | Low | https://example.com/contoso |

## Briefing: Northwind Analytics

Northwind Analytics publishes operations and revenue-operations roles and describes its account workflow in public job posts.

The sourced pain point is manual account research that their own posting says takes a full day.

The hook a salesperson can mention is the RevOps role opened this month. No contact email is public, so the draft stays in the owner's mailbox until a real recipient is known.
`.trim();

let activeInteractionId = null;

process.on('SIGINT', () => {
  const resume = activeInteractionId
    ? ` Research keeps running. Resume with RESUME_INTERACTION_ID=${activeInteractionId}`
    : '';
  console.error(`Interrupted.${resume}`);
  process.exit(130);
});

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function isPlaceholder(value) {
  return /your-|paste-|changeme/i.test(value);
}

function readPositiveNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig() {
  const flag = (name) => /^(1|true|yes)$/i.test(process.env[name] || '');
  const maxLeads = Math.min(15, Math.max(1, Math.round(readPositiveNumber('MAX_LEADS', 8))));
  return {
    dryRun: flag('DRY_RUN'),
    reportFile: (process.env.REPORT_FILE || '').trim(),
    resumeId: (process.env.RESUME_INTERACTION_ID || '').trim(),
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    webhookUrl: (process.env.GOOGLE_WEBHOOK_URL || '').trim(),
    webhookSecret: (process.env.WEBHOOK_SECRET || '').trim(),
    agent: (process.env.DEEP_RESEARCH_AGENT || 'deep-research-preview-04-2026').trim(),
    industry: cleanText(process.env.TARGET_INDUSTRY, 200),
    region: cleanText(process.env.TARGET_REGION, 200) || 'any region',
    offering: cleanText(process.env.SELLER_OFFERING, 500),
    sellerName: cleanText(process.env.SELLER_NAME, 120),
    icp: cleanText(process.env.IDEAL_CUSTOMER_PROFILE, 500)
      || 'Operating companies with a public signal of the problem this offering addresses',
    researchCompany: cleanText(process.env.RESEARCH_COMPANY, 200),
    researchDomain: cleanText(process.env.RESEARCH_DOMAIN, 200),
    maxLeads,
    pollInitialDelayMs: readPositiveNumber('POLL_INITIAL_DELAY_MS', 5000),
    pollMaxDelayMs: readPositiveNumber('POLL_MAX_DELAY_MS', 60000),
    pollBackoffFactor: Math.min(3, Math.max(1.1, Number(process.env.POLL_BACKOFF_FACTOR) || 1.5)),
    pollMaxWaitMs: Math.min(60 * 60 * 1000, Math.max(60_000, readPositiveNumber('POLL_MAX_WAIT_MS', 60 * 60 * 1000))),
    pollMaxTransientErrors: Math.round(readPositiveNumber('POLL_MAX_TRANSIENT_ERRORS', 8)),
    requestTimeoutMs: readPositiveNumber('REQUEST_TIMEOUT_MS', 120000),
    outputDir: path.resolve(process.env.LEADGEN_OUTPUT_DIR || 'output'),
  };
}

function assertConfig(config) {
  const needsGemini = !config.dryRun && !config.reportFile;
  if (needsGemini && (!config.apiKey || isPlaceholder(config.apiKey))) {
    throw new Error('Set GEMINI_API_KEY in .env before a live or resumed research run.');
  }
  if (needsGemini && !config.resumeId && (!config.offering || isPlaceholder(config.offering))) {
    throw new Error('Set SELLER_OFFERING in .env before starting research.');
  }
  if (needsGemini && !config.resumeId && (!config.industry || isPlaceholder(config.industry))) {
    throw new Error('Set TARGET_INDUSTRY in .env before starting research.');
  }
  if (config.pollMaxDelayMs < config.pollInitialDelayMs) {
    throw new Error('POLL_MAX_DELAY_MS must be greater than or equal to POLL_INITIAL_DELAY_MS.');
  }
  if (!config.webhookUrl) {
    if (!config.dryRun) {
      throw new Error('Set GOOGLE_WEBHOOK_URL to the Apps Script deployment URL ending in /exec.');
    }
    return;
  }
  let parsed;
  try {
    parsed = new URL(config.webhookUrl);
  } catch {
    throw new Error('GOOGLE_WEBHOOK_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' || isPlaceholder(config.webhookUrl)) {
    throw new Error('GOOGLE_WEBHOOK_URL must be the https Apps Script /exec URL from your deployment.');
  }
  if (!config.webhookUrl.endsWith('/exec')) {
    console.warn('GOOGLE_WEBHOOK_URL does not end in /exec. Apps Script accepts POSTs on the deployment URL, not /dev.');
  }
  if (!config.webhookSecret || isPlaceholder(config.webhookSecret) || config.webhookSecret.length < 16) {
    throw new Error('Set WEBHOOK_SECRET to a random string of at least 16 characters, matching the Apps Script property.');
  }
}

function buildLeadPrompt(config) {
  return [
    'Research publicly available information and build a B2B lead list.',
    `Seller offering: ${config.offering}`,
    `Ideal customer: ${config.icp}`,
    `Industry: ${config.industry}`,
    `Region: ${config.region}`,
    `Maximum companies: ${config.maxLeads}`,
    config.researchCompany
      ? `Focus this run on one company: ${config.researchCompany}${config.researchDomain ? ` (${config.researchDomain})` : ''}. Use public sources about that company.`
      : '',
    '',
    'Rules:',
    '- Use only information a member of the public could find on the open web.',
    '- If a field is not publicly available, write exactly "unknown". Never guess an email address, phone number, or quotation.',
    '- Prefer companies with a current, sourced operational problem the offering can speak to.',
    '- Mark Priority as High only when both the pain point and the hook cite a public source. Otherwise use Medium or Low.',
    `- Return at most ${config.maxLeads} companies.`,
    '',
    'Output format:',
    'Start with a GitHub-flavored markdown table and no prose before it. Use these headers verbatim:',
    '',
    '| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |',
    '',
    'After the table, for every High priority company, add:',
    '',
    '## Briefing: {Company}',
    '',
    'Three short paragraphs: what the company does, the sourced pain point, and the specific public hook a salesperson can mention. Do not brief companies that are absent from the table.',
  ].join('\n');
}

function cell(value) {
  return String(value || 'unknown').replace(/\|/g, ' ').replace(/[\r\n]+/g, ' ').trim() || 'unknown';
}

function focusedDryRun(config) {
  return [
    '| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${cell(config.researchCompany)} | ${cell(config.researchDomain)} | unknown | unknown | unknown | unknown | unknown | unknown | Low | dry-run |`,
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(current, config) {
  const grown = current * config.pollBackoffFactor;
  const jitter = grown * 0.2 * Math.random();
  return Math.min(config.pollMaxDelayMs, Math.max(config.pollInitialDelayMs, Math.round(grown + jitter)));
}

function formatError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.message || error.status || JSON.stringify(error);
}

function isRetryable(error) {
  const status = Number(error?.status || error?.code || error?.error?.code);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(error?.message || error).toLowerCase();
  return /timeout|econnreset|etimedout|socket hang up|network|fetch failed|429|503|502|504/.test(message);
}

function textsFromContent(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item && typeof item.text === 'string')
    .map((item) => item.text);
}

function extractReport(interaction) {
  const chunks = [];
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  const modelSteps = steps.filter((step) => step && (step.type === 'model_output' || step.type === 'output'));
  const chosen = modelSteps.at(-1) || steps.at(-1);
  if (chosen) chunks.push(...textsFromContent(chosen.content));

  if (!chunks.length && Array.isArray(interaction.outputs)) {
    for (const output of interaction.outputs) {
      if (typeof output === 'string') chunks.push(output);
      else if (typeof output?.text === 'string') chunks.push(output.text);
      else chunks.push(...textsFromContent(output?.content));
    }
  }

  const markdown = chunks.map((chunk) => chunk.trim()).filter(Boolean).join('\n\n').trim();
  if (!markdown) {
    throw new Error(`Interaction ${interaction.id || 'unknown'} completed with no text output.`);
  }
  return markdown;
}

function assertLeadTable(markdown) {
  const found = markdown.split(/\r?\n/).some((line) => {
    const normalized = line.toLowerCase();
    return normalized.includes('|') && normalized.includes('company') && normalized.includes('pain');
  });
  if (!found) {
    throw new Error('Report has no lead table. The markdown is in output/last-report.md. Fix or replay it with REPORT_FILE. The webhook was not called.');
  }
}

async function createClient(apiKey) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

const AGENT_CONFIG = Object.freeze({
  type: 'deep-research',
  thinking_summaries: 'none',
  visualization: 'off',
  collaborative_planning: false,
});

async function pollInteraction(client, interactionId, config) {
  const started = Date.now();
  let delay = config.pollInitialDelayMs;
  let transientFailures = 0;
  let continuations = 0;
  let currentId = interactionId;

  while (true) {
    if (Date.now() - started > config.pollMaxWaitMs) {
      throw new Error(`Polling timed out after ${config.pollMaxWaitMs}ms. Resume with RESUME_INTERACTION_ID=${currentId}`);
    }

    let interaction;
    try {
      interaction = await client.interactions.get(currentId);
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      if (!isRetryable(error) || transientFailures > config.pollMaxTransientErrors) throw error;
      console.warn(`Poll error ${transientFailures}/${config.pollMaxTransientErrors}: ${formatError(error)}`);
      await sleep(delay);
      delay = nextDelay(delay, config);
      continue;
    }

    const status = String(interaction.status || '').toLowerCase();
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`status=${status} elapsed=${elapsed}s nextDelayMs=${delay} id=${currentId}`);

    if (status === 'completed') return interaction;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Interaction ${currentId} ${status}: ${formatError(interaction.error)}`);
    }

    if (status === 'requires_continuation') {
      if (!interaction.continuation_token || continuations >= 3) {
        throw new Error(`Interaction ${currentId} requires continuation and cannot be resumed automatically.`);
      }
      continuations += 1;
      const continued = await client.interactions.create({
        agent: config.agent,
        background: true,
        store: true,
        continuation_token: interaction.continuation_token,
        agent_config: AGENT_CONFIG,
      });
      if (!continued?.id) {
        throw new Error(`Continuation ${continuations} did not return an interaction id.`);
      }
      currentId = continued.id;
      activeInteractionId = currentId;
      console.log(`Continued research as ${currentId}`);
      continue;
    }

    await sleep(delay);
    delay = nextDelay(delay, config);
  }
}

async function runResearch(config) {
  const client = await createClient(config.apiKey);
  let interactionId = config.resumeId;
  const prompt = buildLeadPrompt(config);

  if (!interactionId) {
    const created = await client.interactions.create({
      input: prompt,
      agent: config.agent,
      background: true,
      store: true,
      agent_config: AGENT_CONFIG,
    });
    if (!created?.id) throw new Error('interactions.create did not return an interaction id.');
    interactionId = created.id;
    console.log(`Research started. Interaction ID: ${interactionId}`);
  } else {
    console.log(`Resuming interaction ${interactionId}`);
  }

  activeInteractionId = interactionId;
  const completed = await pollInteraction(client, interactionId, config);
  return {
    interactionId,
    agent: config.agent,
    generatedAt: new Date().toISOString(),
    query: config.resumeId ? `resume:${config.resumeId}` : prompt,
    markdown: extractReport(completed),
  };
}

async function obtainReport(config) {
  if (config.reportFile) {
    const markdown = readFileSync(config.reportFile, 'utf8');
    return {
      interactionId: `replay-${Date.now()}`,
      agent: 'replay',
      generatedAt: new Date().toISOString(),
      query: config.reportFile,
      markdown,
    };
  }

  if (config.dryRun) {
    console.log('DRY_RUN is set. Gemini will not be called.');
    const focused = config.researchCompany ? focusedDryRun(config) : FIXTURE_REPORT;
    return {
      interactionId: `dry-run-${Date.now()}`,
      agent: 'dry-run',
      generatedAt: new Date().toISOString(),
      query: config.researchCompany ? `dry-run:${config.researchCompany}` : 'dry-run fixture',
      markdown: focused,
    };
  }

  return runResearch(config);
}

function saveReport(config, record) {
  mkdirSync(config.outputDir, { recursive: true });
  const markdownPath = path.join(config.outputDir, 'last-report.md');
  const metaPath = path.join(config.outputDir, 'last-report.json');
  writeFileSync(markdownPath, record.markdown, 'utf8');
  writeFileSync(metaPath, JSON.stringify({
    interactionId: record.interactionId,
    agent: record.agent,
    generatedAt: record.generatedAt,
    query: record.query,
    seller: { name: config.sellerName, offering: config.offering },
  }, null, 2));
  return markdownPath;
}

function hideSecret(text, secret) {
  const value = String(text ?? '');
  if (!secret) return value;
  return value.split(secret).join('[redacted]');
}

async function postWebhook(config, payload) {
  let delay = 1000;
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const outcome = await postAppsScript(config.webhookUrl, config.webhookSecret, payload, config.requestTimeoutMs);
      const body = outcome.body || {};
      if (outcome.status >= 500 || body.ok === false) {
        const error = new Error(body.error || `Webhook failed with HTTP ${outcome.status}`);
        error.retryable = Boolean(body.retryable) || outcome.status === 429 || outcome.status >= 500;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      const retryable = Boolean(error.retryable) || isRetryable(error);
      if (!retryable || attempt === 4) break;
      console.warn(`Webhook attempt ${attempt} failed: ${hideSecret(error.message, config.webhookSecret)}. Retrying in ${delay}ms.`);
      await sleep(delay);
      delay = Math.min(16_000, delay * 2);
    }
  }

  throw lastError;
}

function writeWebhookResult(config, payload) {
  mkdirSync(config.outputDir, { recursive: true });
  const safe = { ...payload };
  delete safe.secret;
  writeFileSync(
    path.join(config.outputDir, 'last-webhook.json'),
    hideSecret(JSON.stringify(safe, null, 2), config.webhookSecret),
  );
}

function delegateToFallback() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, ['-m', 'fallback'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Free-tier fallback exited with status ${result.status ?? 'unknown'}.`);
    }
    return;
  }
  throw new Error('Python was not found on PATH. Install Python 3.11 or newer to use the free-tier fallback.');
}

async function main() {
  const config = loadConfig();
  if (shouldDelegate(config)) {
    delegateToFallback();
    return;
  }
  assertConfig(config);

  if (config.agent !== 'deep-research-preview-04-2026' && !config.dryRun && !config.reportFile) {
    console.warn(`DEEP_RESEARCH_AGENT=${config.agent}. The smaller preview agent is the one this skeleton is sized for.`);
  }

  const record = await obtainReport(config);
  const savedPath = saveReport(config, record);
  console.log(`Saved report (${record.markdown.length} chars) to ${savedPath}`);
  assertLeadTable(record.markdown);

  if (!config.webhookUrl) {
    const skipped = { ok: false, synced: false, error: 'GOOGLE_WEBHOOK_URL is empty. Nothing was written to Sheets.' };
    writeWebhookResult(config, skipped);
    console.log(skipped.error);
    return;
  }

  try {
    const result = await postWebhook(config, {
      interactionId: record.interactionId,
      agent: record.agent,
      generatedAt: record.generatedAt,
      query: record.query,
      seller: { name: config.sellerName, offering: config.offering },
      markdown: record.markdown,
    });
    writeWebhookResult(config, { ok: true, synced: true, interactionId: record.interactionId, appsScript: result });
    console.log(hideSecret(JSON.stringify(result, null, 2), config.webhookSecret));
  } catch (error) {
    writeWebhookResult(config, {
      ok: false,
      synced: false,
      error: hideSecret(error.message || 'Webhook failed.', config.webhookSecret),
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const secret = (process.env.WEBHOOK_SECRET || '').trim();
    console.error(hideSecret(error?.stack || error?.message || error, secret));
    if (activeInteractionId) {
      console.error(`Resume with RESUME_INTERACTION_ID=${activeInteractionId}`);
    }
    process.exit(1);
  });
}
