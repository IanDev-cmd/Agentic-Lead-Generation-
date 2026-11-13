import assert from 'node:assert/strict';
import test from 'node:test';
import { askSources } from '../lib/ask.js';
import { narrateTerritory } from '../lib/territory-brief.js';
import {
  FREE_TIER_MODELS,
  configuredModel,
  generateWithFallback,
  httpStatus,
  modelChain,
} from '../lib/pipeline/gemini.js';

function statusError(status, message = '') {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  return error;
}

test('the free-tier chain is the six models in capability order', () => {
  assert.deepEqual(modelChain('gemini-2.5-flash'), [...FREE_TIER_MODELS]);
  assert.deepEqual(modelChain(''), [...FREE_TIER_MODELS]);
  assert.equal(configuredModel('gemini-2.5-flash'), 'gemini-3.8-flash');
  assert.deepEqual(modelChain('gemini-3.5-flash-lite'), [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemma-4-27b-it',
  ]);
  assert.equal(FREE_TIER_MODELS.length, 6);
});

test('a retired model error is read from the JSON body', () => {
  const error = new Error('{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash."}}');
  assert.equal(httpStatus(error), 404);
  assert.equal(httpStatus(statusError(503, 'UNAVAILABLE')), 503);
  assert.equal(httpStatus(statusError(429)), 429);
  assert.equal(httpStatus({ status: 'NOT_FOUND' }), 404);
  assert.equal(httpStatus(statusError(401)), 401);
});

test('404, 429, and 503 try the next model with the same request', async () => {
  const seen = [];
  const request = {
    contents: [{ role: 'user', parts: [{ text: 'find buyers' }] }],
    config: { tools: [{ googleSearch: {} }] },
  };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const ai = {
      models: {
        generateContent: async (body) => {
          seen.push(body.model);
          assert.deepEqual(body.contents, request.contents);
          assert.deepEqual(body.config, request.config);
          if (body.model === 'gemini-3.8-flash') throw statusError(404);
          if (body.model === 'gemini-3.7-flash') throw statusError(503);
          if (body.model === 'gemini-3.6-flash') throw statusError(429);
          return { text: 'ok' };
        },
      },
    };
    const response = await generateWithFallback(ai, request, { model: 'gemini-2.5-flash' });
    assert.equal(response.text, 'ok');
    assert.deepEqual(seen, [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    assert.match(warnings[0], /gemini-3\.8-flash failed with HTTP 404/);
    assert.match(warnings[1], /gemini-3\.7-flash failed with HTTP 503/);
    assert.match(warnings[2], /gemini-3\.6-flash failed with HTTP 429/);
  } finally {
    console.warn = original;
  }
});

test('authentication and a primary bad request stop the chain', async () => {
  let calls = 0;
  const ai = {
    models: {
      generateContent: async () => {
        calls += 1;
        throw statusError(401);
      },
    },
  };
  await assert.rejects(
    () => generateWithFallback(ai, { contents: 'lead' }, { models: [...FREE_TIER_MODELS] }),
    (error) => httpStatus(error) === 401,
  );
  assert.equal(calls, 1);

  calls = 0;
  ai.models.generateContent = async () => {
    calls += 1;
    throw statusError(400);
  };
  await assert.rejects(
    () => generateWithFallback(ai, {
      contents: 'lead',
      config: { tools: [{ googleSearch: {} }] },
    }, { models: [...FREE_TIER_MODELS] }),
    (error) => httpStatus(error) === 400,
  );
  assert.equal(calls, 1);
});

test('a fallback model that rejects grounding is retried once without tools', async () => {
  const seen = [];
  const ai = {
    models: {
      generateContent: async (body) => {
        seen.push({ model: body.model, tools: body.config?.tools || null });
        if (body.model === 'gemini-3.8-flash') throw statusError(503);
        if (body.config?.tools) throw statusError(400);
        return { text: 'ungrounded' };
      },
    },
  };
  const response = await generateWithFallback(ai, {
    contents: [{ text: 'same request' }],
    config: { tools: [{ googleSearch: {} }], temperature: 1 },
  });
  assert.equal(response.text, 'ungrounded');
  assert.deepEqual(seen, [
    { model: 'gemini-3.8-flash', tools: [{ googleSearch: {} }] },
    { model: 'gemini-3.7-flash', tools: [{ googleSearch: {} }] },
    { model: 'gemini-3.7-flash', tools: null },
  ]);
  assert.equal(seen[2].model, 'gemini-3.7-flash');
});

test('a tool-free 400 on a fallback model is returned immediately', async () => {
  let calls = 0;
  const ai = {
    models: {
      generateContent: async () => {
        calls += 1;
        throw calls === 1 ? statusError(404) : statusError(400);
      },
    },
  };
  await assert.rejects(
    () => generateWithFallback(ai, { contents: 'lead' }, { models: [...FREE_TIER_MODELS] }),
    (error) => httpStatus(error) === 400,
  );
  assert.equal(calls, 2);
});

test('ask and the territory brief use the next model after a 404', async () => {
  const previous = process.env.PIPELINE_ENABLED;
  process.env.PIPELINE_ENABLED = 'false';
  const models = [];
  const ai = {
    models: {
      generateContent: async (body) => {
        models.push(body.model);
        if (body.model === 'gemini-3.8-flash') {
          const error = new Error('{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users."}}');
          error.status = 404;
          throw error;
        }
        return { text: 'EXPLANATION:\nHarbor Desk sells routing software. These 1 companies are possible buyers.\nLEADS:\n| Company | Domain |\n| --- | --- |\n| Harbor One | harbor.example |' };
      },
    },
  };
  try {
    const answer = await askSources({
      model: 'gemini-2.5-flash',
      question: 'Generate leads',
      profile: { MAX_LEADS: 4 },
      parts: [{ text: 'Harbor Desk sells routing software.' }],
      ai,
    });
    assert.equal(answer.leads[0].company, 'Harbor One');
    assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.7-flash']);

    models.length = 0;
    ai.models.generateContent = async (body) => {
      models.push(body.model);
      if (models.length === 1) throw statusError(429);
      return { text: 'Two clusters, both already on the map.' };
    };
    const brief = await narrateTerritory({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      facts: { placed: 2 },
      ai,
    });
    assert.match(brief, /Two clusters/);
    assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.7-flash']);
  } finally {
    if (previous == null) delete process.env.PIPELINE_ENABLED;
    else process.env.PIPELINE_ENABLED = previous;
  }
});
