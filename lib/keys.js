const KEY_NAMES = ['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5'];

let cursor = 0;
let pinned = -1;
let lane = Promise.resolve();
const cooledUntil = new Map();

export function geminiKeys(env = process.env) {
  const seen = new Set();
  const keys = [];
  for (const name of KEY_NAMES) {
    const value = String(env[name] || '').trim();
    if (!value || /^(your-|paste-)/i.test(value) || seen.has(value)) continue;
    seen.add(value);
    keys.push(value);
  }
  return keys;
}

export function isQuota(error) {
  const status = Number(error?.status || error?.code || error?.error?.code || 0);
  const text = `${error?.message || error || ''} ${status}`;
  return status === 429 || /429|quota|resource_exhausted|rate.?limit|exceeded your current/i.test(text);
}

export function isRejectedKey(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''}`;
  return status === 401 || status === 403 || /api[_ ]key not valid|api_key_invalid|permission denied|unregistered|consumer[_ -]?invalid/i.test(text);
}

export function isTransient(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''}`;
  return status === 500 || status === 502 || status === 503 || status === 504
    || /unavailable|overloaded|high demand|timeout|fetch failed|econnreset/i.test(text);
}

export function deskText(error) {
  if (error?.code === 'no-key' || /GEMINI_API_KEY is empty/i.test(error?.message || '')) {
    return 'GEMINI_API_KEY is empty. Nothing was asked.';
  }
  if (error?.code === 'model-not-found') {
    return 'The AI model configured for this desk is no longer available. Update FREE_MODEL. Nothing was written.';
  }
  if (error?.code === 'bad-request') {
    return 'Gemini rejected the request, often because of a source file that is too large or unreadable. Try removing the PDF. Nothing was written.';
  }
  if (error?.code === 'transient') {
    return 'Gemini is overloaded right now. Try again in a minute. Nothing was written.';
  }
  if (error?.code === 'quota' || isQuota(error)) {
    return 'The research desk is busy. Try again in a minute. Nothing was written.';
  }
  return 'That search did not finish. Nothing was written.';
}

const COOLDOWN_MS = { quota: 60_000, transient: 15_000, rejected: 600_000 };
let stallCode = 'quota';

export function keyCoolingMs(key, now = Date.now()) {
  return Math.max(0, (cooledUntil.get(key) || 0) - now);
}

function openKeys(list) {
  const now = Date.now();
  const start = pinned >= 0 && (cooledUntil.get(list[pinned]) || 0) <= now ? pinned : cursor;
  const order = [];
  for (let step = 0; step < list.length; step += 1) {
    const index = (start + step) % list.length;
    const key = list[index];
    if ((cooledUntil.get(key) || 0) <= now) order.push({ key, index });
  }
  return order;
}

function enqueue(work) {
  const run = lane.then(work, work);
  lane = run.then(() => undefined, () => undefined);
  return run;
}

export function rotatingAi(keys = geminiKeys(), factory) {
  const list = keys.filter(Boolean);
  const clients = new Map();
  return {
    models: {
      generateContent(request) {
        return enqueue(() => callNext(list, clients, factory, request));
      },
    },
  };
}

async function callNext(list, clients, factory, request) {
  if (!list.length) {
    const error = new Error('GEMINI_API_KEY is empty. Nothing was asked.');
    error.code = 'no-key';
    throw error;
  }
  const order = openKeys(list);
  if (!order.length) {
    const error = new Error(deskText({ code: stallCode }));
    error.code = stallCode;
    throw error;
  }
  let last;
  let transientOnly = true;
  for (const { key, index } of order) {
    try {
      let ai = clients.get(key);
      if (!ai) {
        ai = factory ? await factory(key) : await liveClient(key);
        clients.set(key, ai);
      }
      const response = await ai.models.generateContent(request);
      pinned = index;
      cursor = index;
      cooledUntil.delete(key);
      return response;
    } catch (error) {
      last = error;
      const status = Number(error?.status || 0);
      if (status === 404) {
        error.code = 'model-not-found';
        throw error;
      }
      if (status === 400) {
        error.code = 'bad-request';
        throw error;
      }
      const kind = isQuota(error) ? 'quota' : isTransient(error) ? 'transient' : isRejectedKey(error) ? 'rejected' : '';
      if (!kind) throw error;
      if (kind !== 'transient') transientOnly = false;
      cooledUntil.set(key, Date.now() + COOLDOWN_MS[kind]);
      if (pinned === index) pinned = -1;
      cursor = (index + 1) % list.length;
    }
  }
  stallCode = transientOnly ? 'transient' : 'quota';
  const error = new Error(deskText({ code: stallCode }));
  error.code = stallCode;
  error.cause = last;
  throw error;
}

async function liveClient(apiKey) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

export function resetKeyRotation() {
  cursor = 0;
  pinned = -1;
  stallCode = 'quota';
  cooledUntil.clear();
  lane = Promise.resolve();
}
