import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../desk-run.js';

export function writeTrace(root, id, trace) {
  const secrets = ['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5', 'WEBHOOK_SECRET', 'DESK_TOKEN']
    .map((name) => process.env[name])
    .filter((item) => item && item.length > 3);
  const dir = path.join(root || process.cwd(), 'output', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace, null, 2));
  const line = redactSecrets(`pipeline leads=${trace.leadCount || 0} dropped=${trace.dropped || 0} quota=${trace.quota || 0} ms=${trace.ms || 0}`, secrets);
  console.log(line);
}
