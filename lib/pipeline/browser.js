import { spawn } from 'node:child_process';
import path from 'node:path';

export function browserAgentEnabled() {
  return String(process.env.USE_BROWSER_AGENT || 'false').toLowerCase() === 'true';
}

export function browseCompanies(companies, { timeoutMs = 60000, root = process.cwd() } = {}) {
  if (!browserAgentEnabled()) return Promise.resolve([]);
  const script = path.join(root, 'agents', 'web-agent-stack', 'integration', 'browse_readonly.py');
  return new Promise((resolve) => {
    let child;
    const timer = setTimeout(() => {
      if (child) child.kill();
      resolve([]);
    }, timeoutMs);
    try {
      child = spawn('python3', [script, String((companies || []).length)], {
        cwd: path.join(root, 'output', 'runs'),
        timeout: timeoutMs,
      });
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}
