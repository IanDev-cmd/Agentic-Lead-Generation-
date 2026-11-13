// Free-tier text models from the Gemini Developer API pricing page.
// Paid-only models (Argon, Carbon, Pro, image, video, live, and TTS) are omitted.
export const FREE_TEXT_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-4-hydrogen',
]);

let pinned = '';

export function modelOrder(preferred = process.env.FREE_MODEL) {
  const first = String(preferred || '').trim();
  const order = [];
  for (const name of [pinned, first, ...FREE_TEXT_MODELS]) {
    if (name && !order.includes(name)) order.push(name);
  }
  return order;
}

export function isSwapModel(error) {
  const status = Number(error?.status || error?.code || error?.error?.code || 0);
  const text = `${error?.message || error || ''} ${error?.status || ''}`;
  if (status === 400 || status === 401 || status === 403) return false;
  return status === 404 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
    || /unavailable|high demand|overloaded|no longer available|not found|resource_exhausted|quota/i.test(text);
}

export function fallbackAi(ai) {
  return {
    models: {
      async generateContent(request) {
        const order = modelOrder(request?.model);
        let last;
        for (const model of order) {
          try {
            const response = await ai.models.generateContent({ ...request, model });
            pinned = model;
            return response;
          } catch (error) {
            last = error;
            if (!isSwapModel(error)) throw error;
            if (pinned === model) pinned = '';
          }
        }
        throw last;
      },
    },
  };
}

export function resetModelFallback() {
  pinned = '';
}
