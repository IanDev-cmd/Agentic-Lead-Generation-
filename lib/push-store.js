import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// One JSON document is the push subscription store. This desk has no SQL database.
// The file is created on the first subscribe. Shape:
// { subscriptions: [{ endpoint, p256dh, auth, userId, userAgent, createdAt }] }

function storePath(root) {
  return path.join(root, 'output', 'push-subscriptions.json');
}

function readAll(root) {
  try {
    const parsed = JSON.parse(readFileSync(storePath(root), 'utf8'));
    return Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

function writeAll(root, subscriptions) {
  mkdirSync(path.join(root, 'output'), { recursive: true });
  writeFileSync(storePath(root), JSON.stringify({ subscriptions }, null, 2));
}

export function upsertSubscription(root, record) {
  const subscriptions = readAll(root);
  const index = subscriptions.findIndex((item) => item.endpoint === record.endpoint);
  if (index >= 0) {
    subscriptions[index] = {
      ...subscriptions[index],
      ...record,
      createdAt: subscriptions[index].createdAt || record.createdAt,
    };
  } else {
    subscriptions.push(record);
  }
  writeAll(root, subscriptions);
  return index >= 0 ? subscriptions[index] : record;
}

export function removeSubscription(root, endpoint) {
  const subscriptions = readAll(root);
  const next = subscriptions.filter((item) => item.endpoint !== endpoint);
  if (next.length === subscriptions.length) return false;
  writeAll(root, next);
  return true;
}

export function removeSubscriptionsForUser(root, userId) {
  const subscriptions = readAll(root);
  const next = subscriptions.filter((item) => item.userId !== userId);
  const removed = subscriptions.length - next.length;
  if (removed) writeAll(root, next);
  return removed;
}

export function subscriptionsForUser(root, userId) {
  return readAll(root).filter((item) => item.userId === userId);
}

export function allSubscriptions(root) {
  return readAll(root);
}
