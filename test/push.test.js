import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deliverPush, validPushSubscription } from '../lib/push.js';
import { removeSubscription, subscriptionsForUser, upsertSubscription } from '../lib/push-store.js';

process.env.DESK_TOKEN = 'desk-token-value';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
process.env.GOOGLE_WEBHOOK_URL = '';
process.env.WEBHOOK_SECRET = '';

const sample = {
  userId: 'user-abc-1234',
  userAgent: 'test',
  subscription: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/pwa-test-endpoint',
    keys: { p256dh: 'B'.repeat(40), auth: 'a'.repeat(16) },
  },
};

test('a push subscription keeps the documented fields and drops a bad endpoint', () => {
  const saved = validPushSubscription(sample);
  assert.equal(saved.endpoint, sample.subscription.endpoint);
  assert.equal(saved.p256dh, sample.subscription.keys.p256dh);
  assert.equal(saved.auth, sample.subscription.keys.auth);
  assert.equal(saved.userId, sample.userId);
  assert.equal(saved.userAgent, 'test');
  assert.equal(typeof saved.createdAt, 'string');
  assert.equal(validPushSubscription({ ...sample, subscription: { ...sample.subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' } }), null);
  assert.equal(validPushSubscription({ ...sample, subscription: { ...sample.subscription, endpoint: 'https://evil.example/push' } }), null);
});

test('an expired push subscription is removed and a repeat keeps the original time', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lead-push-'));
  const first = upsertSubscription(root, validPushSubscription(sample));
  const second = upsertSubscription(root, { ...validPushSubscription(sample), userAgent: 'phone' });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.userAgent, 'phone');
  assert.equal(subscriptionsForUser(root, sample.userId).length, 1);
  let sentBody = '';
  const result = await deliverPush(root, subscriptionsForUser(root, sample.userId), {
    title: 'Lead desk',
    body: 'Gone',
    data: { url: 'https://evil.example/phish' },
  }, (_subscription, body) => {
    sentBody = body;
    const error = new Error('gone');
    error.statusCode = 410;
    throw error;
  });
  assert.equal(JSON.parse(sentBody).data.url, '/');
  assert.equal(result.removed, 1);
  assert.equal(result.sent, 0);
  assert.equal(subscriptionsForUser(root, sample.userId).length, 0);
  const stored = JSON.parse(readFileSync(path.join(root, 'output', 'push-subscriptions.json'), 'utf8'));
  assert.deepEqual(stored.subscriptions, []);
  assert.equal(removeSubscription(root, sample.subscription.endpoint), false);
});

test('the desk serves the manifest, the service worker, and push routes', async () => {
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    const manifestBody = await manifest.json();
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type').includes('application/manifest+json'), true);
    assert.equal(manifestBody.display, 'standalone');
    assert.equal(manifestBody.icons.some((icon) => icon.sizes === '192x192'), true);
    assert.equal(manifestBody.icons.some((icon) => icon.purpose === 'maskable'), true);
    const worker = await fetch(`${base}/sw.js`);
    assert.equal((await worker.text()).includes('showNotification'), true);
    const icon = await fetch(`${base}/icons/icon-192.png`);
    const bytes = Buffer.from(await icon.arrayBuffer());
    assert.equal(icon.status, 200);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const qr = await fetch(`${base}/api/qr.svg`);
    assert.equal((await qr.text()).includes('<svg'), true);
    const denied = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(denied.status, 401);
    const health = await fetch(`${base}/api/health`);
    const cookie = (health.headers.get('set-cookie') || '').match(/desk=[^;]+/)[0];
    const subscribed = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(sample),
    });
    assert.equal(subscribed.status, 200);
    const missingKeys = await fetch(`${base}/api/push/vapid`, { headers: { Cookie: cookie } });
    assert.equal(missingKeys.status, 424);
    const removed = await fetch(`${base}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ endpoint: sample.subscription.endpoint, userId: sample.userId }),
    });
    assert.equal(removed.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
