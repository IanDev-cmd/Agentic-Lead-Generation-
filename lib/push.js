import webpush from 'web-push';
import {
  allSubscriptions,
  removeSubscription,
  subscriptionsForUser,
} from './push-store.js';

const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
  'wns.windows.com',
];

function allowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export function validPushSubscription(body) {
  const source = body?.subscription && typeof body.subscription === 'object' ? body.subscription : body;
  const endpoint = String(source?.endpoint || '');
  const keys = source?.keys || {};
  const p256dh = String(keys.p256dh || body?.p256dh || '');
  const auth = String(keys.auth || body?.auth || '');
  const userId = String(body?.userId || '').trim();
  if (!allowedEndpoint(endpoint)) return null;
  if (p256dh.length < 20 || p256dh.length > 200) return null;
  if (auth.length < 10 || auth.length > 100) return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) return null;
  return {
    endpoint,
    p256dh,
    auth,
    userId,
    userAgent: String(body?.userAgent || '').slice(0, 300),
    createdAt: new Date().toISOString(),
  };
}

export function configureVapid() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:desk@localhost').trim();
  if (!publicKey || !privateKey) return '';
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return publicKey;
  } catch {
    return '';
  }
}

export function vapidPublicKey() {
  return configureVapid();
}

function payloadBody(payload) {
  const url = typeof payload?.data?.url === 'string' ? payload.data.url : '/';
  const safeUrl = url.startsWith('/') && !url.startsWith('//') ? url : '/';
  return JSON.stringify({
    title: String(payload?.title || 'Lead desk').slice(0, 80),
    body: String(payload?.body || '').slice(0, 240),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: safeUrl },
  });
}

async function defaultSender(subscription, body) {
  if (!configureVapid()) {
    const error = new Error('VAPID keys are not configured.');
    error.code = 'NO_VAPID';
    throw error;
  }
  return webpush.sendNotification(subscription, body);
}

export async function deliverPush(root, targets, payload, sender = defaultSender) {
  const body = payloadBody(payload);
  let sent = 0;
  let removed = 0;
  for (const item of targets || []) {
    try {
      await sender({
        endpoint: item.endpoint,
        keys: { p256dh: item.p256dh, auth: item.auth },
      }, body);
      sent += 1;
    } catch (error) {
      const status = Number(error?.statusCode || 0);
      if (status === 404 || status === 410) {
        removeSubscription(root, item.endpoint);
        removed += 1;
      }
    }
  }
  return { ok: true, sent, removed };
}

export async function sendPushNotification(root, userId, payload) {
  if (!configureVapid()) {
    return { ok: false, sent: 0, removed: 0, error: 'VAPID keys are not configured.' };
  }
  try {
    return await deliverPush(root, subscriptionsForUser(root, userId), payload);
  } catch {
    return { ok: false, sent: 0, removed: 0, error: 'The notification could not be sent.' };
  }
}

export async function broadcastPush(root, payload) {
  if (!configureVapid()) {
    return { ok: false, sent: 0, removed: 0, error: 'VAPID keys are not configured.' };
  }
  try {
    return await deliverPush(root, allSubscriptions(root), payload);
  } catch {
    return { ok: false, sent: 0, removed: 0, error: 'The notification could not be sent.' };
  }
}
