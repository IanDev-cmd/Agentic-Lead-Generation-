const KEY_NAMES = ['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5'];

let cursor = 0;
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

export function deskText(error) {
  if (error?.code === 'no-key' || /GEMINI_API_KEY is empty/i.test(error?.message || '')) {
    return 'GEMINI_API_KEY is empty. Nothing was asked.';
  }
  return 'The research desk is busy. Try again in a minute. Nothing was written.';
}

function orderFrom(keys) {
  const now = Date.now();
  const ready = [];
  const waiting = [];
  for (let step = 0; step < keys.length; step += 1) {
    const key = keys[(cursor + step) % keys.length];
    if ((cooledUntil.get(key) || 0) <= now) ready.push(key);
    else waiting.push(key);
  }
  return ready.concat(waiting);
}

export function rotatingAi(keys = geminiKeys(), factory) {
  const list = keys.filter(Boolean);
  const clients = new Map();
  return {
    models: {
      async generateContent(request) {
        if (!list.length) {
          const error = new Error('GEMINI_API_KEY is empty. Nothing was asked.');
          error.code = 'no-key';
          throw error;
        }
        let last;
        for (const key of orderFrom(list)) {
          try {
            let ai = clients.get(key);
            if (!ai) {
              ai = factory ? await factory(key) : await liveClient(key);
              clients.set(key, ai);
            }
            const response = await ai.models.generateContent(request);
            cursor = (list.indexOf(key) + 1) % list.length;
            cooledUntil.delete(key);
            return response;
          } catch (error) {
            last = error;
            if (!isQuota(error)) throw error;
            cooledUntil.set(key, Date.now() + 60_000);
          }
        }
        const error = new Error(deskText(last));
        error.code = 'quota';
        throw error;
      },
    },
  };
}

async function liveClient(apiKey) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

export function resetKeyRotation() {
  cursor = 0;
  cooledUntil.clear();
}
