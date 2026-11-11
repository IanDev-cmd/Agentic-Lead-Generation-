export async function postAppsScript(url, secret, payload, timeoutMs = 120000) {
  let current = url;
  const body = JSON.stringify(payload);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { status: 502, body: { ok: false, error: 'Apps Script redirected without a new address.' } };
      }
      current = new URL(location, current).href;
      continue;
    }
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 502, body: { ok: false, error: 'Apps Script returned a non-JSON response.' } };
    }
    if (!parsed.ok) return { status: parsed.error === 'Unauthorized webhook.' ? 401 : 409, body: parsed };
    return { status: 200, body: parsed };
  }
  return { status: 502, body: { ok: false, error: 'Apps Script redirected too many times.' } };
}
