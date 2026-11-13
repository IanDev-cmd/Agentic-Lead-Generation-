import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FREE_TEXT_MODELS, fallbackAi, isSwapModel, modelOrder, resetModelFallback } from '../lib/models.js';

describe('free model fallback', { concurrency: 1 }, () => {

test('a high-demand model falls through to the next free model', async () => {
  resetModelFallback();
  const seen = [];
  const ai = fallbackAi({
    models: {
      generateContent: async (request) => {
        seen.push(request.model);
        if (request.model === 'gemini-3.8-flash') {
          const error = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
          error.status = 503;
          throw error;
        }
        return { text: request.model };
      },
    },
  });
  const first = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: [] });
  const second = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: [] });
  assert.equal(first.text, 'gemini-3.6-flash');
  assert.equal(second.text, 'gemini-3.6-flash');
  assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);
});

test('a bad request does not walk the other models', async () => {
  resetModelFallback();
  const seen = [];
  const ai = fallbackAi({
    models: {
      generateContent: async (request) => {
        seen.push(request.model);
        const error = new Error('invalid argument');
        error.status = 400;
        throw error;
      },
    },
  });
  await assert.rejects(() => ai.models.generateContent({ model: 'gemini-3.8-flash' }), /invalid argument/);
  assert.deepEqual(seen, ['gemini-3.8-flash']);
  assert.equal(isSwapModel({ status: 503, message: 'high demand' }), true);
  assert.equal(isSwapModel({ status: 400, message: 'invalid argument' }), false);
});

test('the fallback list is the free text models and skips paid models', () => {
  resetModelFallback();
  const order = modelOrder('gemini-3.8-flash');
  assert.deepEqual(order, [...FREE_TEXT_MODELS]);
  assert.equal(order.includes('gemini-4-argon'), false);
  assert.equal(order.includes('gemini-4-carbon'), false);
  assert.equal(order.includes('gemini-3.1-pro-preview'), false);
  assert.equal(order.includes('gemini-2.5-flash'), false);
});
});
