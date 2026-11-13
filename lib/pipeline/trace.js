import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../desk-run.js';

export function writeTrace(root, id, trace) {
  const secrets = [process.env.GEMINI_API_KEY, process.env.WEBHOOK_SECRET, process.env.DESK_TOKEN].filter((item) => item && item.length > 3);
  const dir = path.join(root || process.cwd(), 'output', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace, null, 2));
  const line = redactSecrets(`pipeline leads=${trace.leadCount || 0} dropped=${trace.dropped || 0} quota=${trace.quota || 0} ms=${trace.ms || 0}`, secrets);
  console.log(line);
}
