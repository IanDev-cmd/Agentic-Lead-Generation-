function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function outcome(status, parsed) {
  if (!parsed.ok) {
    const unauthorized = String(parsed.error || '').startsWith('Unauthorized webhook');
    return { status: unauthorized ? 401 : 409, body: parsed };
  }
  return { status: status >= 200 && status < 300 ? 200 : status, body: parsed };
}

function unreadable(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (/<!doctype html|<html/i.test(text)) {
    return 'Google returned an HTML page instead of JSON. Deploy the web app as yourself, with access set to Anyone.';
  }
  if (!text) return 'Apps Script returned an empty response.';
  return 'Apps Script returned a non-JSON response.';
}

async function request(url, { method, headers, body, timeoutMs }) {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, location: response.headers.get('location'), raw: '' };
  }
  return { status: response.status, location: '', raw: await response.text() };
}

export async function postAppsScript(url, secret, payload, timeoutMs = 120000) {
  // Apps Script cannot read headers. The same body, including secret, is sent on both POSTs.
  const body = JSON.stringify({ ...payload, secret });
  const headers = {
    'Content-Type': 'application/json',
  };
  const first = await request(url, { method: 'POST', headers, body, timeoutMs });
  if (first.status < 300 || first.status >= 400) {
    const parsed = parseJson(first.raw);
    if (!parsed) return { status: 502, body: { ok: false, error: unreadable(first.raw) } };
    return outcome(first.status, parsed);
  }
  if (!first.location) {
    return { status: 502, body: { ok: false, error: 'Apps Script redirected without a new address.' } };
  }
  const next = new URL(first.location, url).href;
  // The echo address stores the POST result. A second POST is an HTML page.
  const echoed = await request(next, { method: 'GET', timeoutMs });
  const echoedJson = parseJson(echoed.raw);
  if (echoedJson?.ok) return outcome(echoed.status, echoedJson);
  const posted = await request(next, { method: 'POST', headers, body, timeoutMs });
  const postedJson = parseJson(posted.raw);
  if (postedJson?.ok) return outcome(posted.status, postedJson);
  if (postedJson) return outcome(posted.status, postedJson);
  if (echoedJson) return outcome(echoed.status, echoedJson);
  return { status: 502, body: { ok: false, error: unreadable(posted.raw || echoed.raw) } };
}
