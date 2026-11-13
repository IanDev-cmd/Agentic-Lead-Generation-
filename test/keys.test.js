import assert from 'node:assert/strict';
import test from 'node:test';
import { deskText, geminiKeys, resetKeyRotation, rotatingAi } from '../lib/keys.js';

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
  assert.deepEqual(seen, ['k1', 'k2', 'k3', 'k4']);
  assert.equal(deskText({ message: '{"error":{"code":429}}' }), 'The research desk is busy. Try again in a minute. Nothing was written.');
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
