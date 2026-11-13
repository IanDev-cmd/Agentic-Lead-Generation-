import assert from 'node:assert/strict';
import test from 'node:test';
import { deskText, geminiKeys, keyCoolingMs, resetKeyRotation, rotatingAi } from '../lib/keys.js';

test('six configured keys rotate after a quota refusal', async () => {
  resetKeyRotation();
  const seen = [];
  const ai = rotatingAi(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'], async (key) => ({
    models: {
      generateContent: async () => {
        seen.push(key);
        if (key === 'k1' || key === 'k2') {
          const error = new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
          error.status = 429;
          throw error;
        }
        return { text: 'buyers' };
      },
    },
  }));
  const first = await ai.models.generateContent({ model: 'gemini-2.5-flash' });
  const second = await ai.models.generateContent({ model: 'gemini-2.5-flash' });
  assert.equal(first.text, 'buyers');
  assert.equal(second.text, 'buyers');
  assert.deepEqual(seen, ['k1', 'k2', 'k3', 'k3']);
  assert.equal(deskText({ code: 'quota' }), 'The research desk is busy. Try again in a minute. Nothing was written.');
  assert.equal(deskText(new Error('model refused the schema')), 'That search did not finish. Nothing was written.');
});

test('parallel calls stay on the account that answered', async () => {
  resetKeyRotation();
  const seen = [];
  const ai = rotatingAi(['k1', 'k2', 'k3'], async (key) => ({
    models: {
      generateContent: async () => {
        seen.push(key);
        if (key === 'k1') {
          const error = new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
          error.status = 429;
          throw error;
        }
        return { text: key };
      },
    },
  }));
  const [first, second] = await Promise.all([
    ai.models.generateContent({}),
    ai.models.generateContent({}),
  ]);
  assert.equal(first.text, 'k2');
  assert.equal(second.text, 'k2');
  assert.deepEqual(seen, ['k1', 'k2', 'k2']);
});

test('a rejected key is skipped and a request error is not', async () => {
  resetKeyRotation();
  const seen = [];
  const ai = rotatingAi(['bad', 'good'], async (key) => ({
    models: {
      generateContent: async () => {
        seen.push(key);
        if (key === 'bad') {
          const error = new Error('API key not valid');
          error.status = 403;
          throw error;
        }
        return { text: 'ok' };
      },
    },
  }));
  assert.equal((await ai.models.generateContent({})).text, 'ok');
  assert.deepEqual(seen, ['bad', 'good']);
  resetKeyRotation();
  const walked = [];
  const stuck = rotatingAi(['a', 'b'], async (key) => ({
    models: {
      generateContent: async () => {
        walked.push(key);
        const error = new Error('invalid argument');
        error.status = 400;
        throw error;
      },
    },
  }));
  await assert.rejects(() => stuck.models.generateContent({}), (error) => {
    assert.equal(error.code, 'bad-request');
    assert.match(error.message, /invalid argument/);
    return true;
  });
  assert.deepEqual(walked, ['a']);
});

test('the key list reads the primary key and the five spares', () => {
  const keys = geminiKeys({
    GEMINI_API_KEY: 'primary',
    GEMINI_API_KEY_1: 'one',
    GEMINI_API_KEY_2: 'two',
    GEMINI_API_KEY_3: 'your-ai-studio-key',
    GEMINI_API_KEY_4: 'four',
    GEMINI_API_KEY_5: 'four',
  });
  assert.deepEqual(keys, ['primary', 'one', 'two', 'four']);
});

test('a 503 moves to the next account for 15 seconds', async () => {
  resetKeyRotation();
  const seen = [];
  const ai = rotatingAi(['A', 'B'], async (key) => ({
    models: {
      generateContent: async () => {
        seen.push(key);
        if (key === 'A') {
          const error = new Error('The model is overloaded');
          error.status = 503;
          throw error;
        }
        return { text: 'from-b' };
      },
    },
  }));
  const response = await ai.models.generateContent({});
  assert.equal(response.text, 'from-b');
  assert.deepEqual(seen, ['A', 'B']);
  const cooling = keyCoolingMs('A');
  assert.ok(cooling >= 14_000 && cooling <= 15_000);
});

test('every key returning 503 is a transient failure', async () => {
  resetKeyRotation();
  const ai = rotatingAi(['A', 'B'], async () => ({
    models: {
      generateContent: async () => {
        const error = new Error('unavailable');
        error.status = 503;
        throw error;
      },
    },
  }));
  await assert.rejects(() => ai.models.generateContent({}), (error) => {
    assert.equal(error.code, 'transient');
    return true;
  });
});

test('a 404 does not rotate and a 400 stops immediately', async () => {
  resetKeyRotation();
  const missing = [];
  const retired = rotatingAi(['A', 'B'], async (key) => ({
    models: {
      generateContent: async () => {
        missing.push(key);
        const error = new Error('models/gemini-2.5-flash is not found');
        error.status = 404;
        throw error;
      },
    },
  }));
  await assert.rejects(() => retired.models.generateContent({}), (error) => {
    assert.equal(error.code, 'model-not-found');
    assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(missing, ['A']);

  resetKeyRotation();
  const bad = [];
  const rejected = rotatingAi(['A', 'B'], async (key) => ({
    models: {
      generateContent: async () => {
        bad.push(key);
        const error = new Error('invalid pdf');
        error.status = 400;
        throw error;
      },
    },
  }));
  await assert.rejects(() => rejected.models.generateContent({}), (error) => {
    assert.equal(error.code, 'bad-request');
    return true;
  });
  assert.deepEqual(bad, ['A']);
});

test('every key returning 429 stays a quota failure', async () => {
  resetKeyRotation();
  const ai = rotatingAi(['A', 'B'], async () => ({
    models: {
      generateContent: async () => {
        const error = new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
        error.status = 429;
        throw error;
      },
    },
  }));
  await assert.rejects(() => ai.models.generateContent({}), (error) => {
    assert.equal(error.code, 'quota');
    return true;
  });
});

test('deskText names the failure', () => {
  assert.equal(deskText({ code: 'model-not-found' }), 'The AI model configured for this desk is no longer available. Update FREE_MODEL. Nothing was written.');
  assert.equal(deskText({ code: 'bad-request' }), 'Gemini rejected the request, often because of a source file that is too large or unreadable. Try removing the PDF. Nothing was written.');
  assert.equal(deskText({ code: 'transient' }), 'Gemini is overloaded right now. Try again in a minute. Nothing was written.');
  assert.equal(deskText({ code: 'quota' }), 'The research desk is busy. Try again in a minute. Nothing was written.');
  assert.equal(deskText({ code: 'no-key' }), 'GEMINI_API_KEY is empty. Nothing was asked.');
  assert.equal(deskText(new Error('model refused the schema')), 'That search did not finish. Nothing was written.');
});
