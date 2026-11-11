import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

export function executeDryRun(outputDir, env = process.env) {
  mkdirSync(outputDir, { recursive: true });
  const childEnv = {
    ...env,
    DRY_RUN: 'true',
    DEMO_MODE: 'false',
    LEADGEN_ROUTE: '',
    LEADGEN_OUTPUT_DIR: outputDir,
    GOOGLE_WEBHOOK_URL: env.GOOGLE_WEBHOOK_URL || '',
    WEBHOOK_SECRET: env.WEBHOOK_SECRET || '',
    GEMINI_API_KEY: env.GEMINI_API_KEY || '',
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
      resolve({
        code,
        stderr: redactSecrets(stderr, [childEnv.WEBHOOK_SECRET, childEnv.GEMINI_API_KEY]),
        result,
      });
    });
  });
}

export function deskAuthorized(headerValue, expected, production = false) {
  if (!expected) return !production;
  return secretsMatch(headerValue || '', expected);
}
