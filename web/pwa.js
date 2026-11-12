let deferredInstall = null;

function deskUserId() {
  const key = 'lead-desk-user';
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{8,80}$/.test(saved)) return saved;
    const created = (crypto.randomUUID && crypto.randomUUID()) || `user-${Date.now()}`;
    const compact = created.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    localStorage.setItem(key, compact);
    return compact;
  } catch {
    return 'desk-user-local';
  }
}

function iosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function closeSettings() {
  const pop = document.getElementById('settingsPop');
  if (pop) pop.hidden = true;
  document.querySelectorAll('.settings-btn').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}
window.closeSettings = closeSettings;

function placeSettings(anchor) {
  const pop = document.getElementById('settingsPop');
  const fromGate = anchor.id === 'gateSettingsBtn';
  const qr = document.getElementById('popQrWrap');
  if (qr) qr.hidden = fromGate;
  pop.hidden = false;
  const target = fromGate ? document.querySelector('.edge-tools') : anchor;
  const rect = target.getBoundingClientRect();
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  document.querySelectorAll('.settings-btn').forEach((button) => {
    button.setAttribute('aria-expanded', String(button === anchor));
  });
}

function openSettings(anchor) {
  if (typeof setMenu === 'function') setMenu(false);
  placeSettings(anchor);
  refreshNotify().catch(() => {});
}

function setNotify(text, on) {
  const state = document.getElementById('notifyState');
  const toggle = document.getElementById('notifyToggle');
  if (state) state.textContent = text;
  if (!toggle) return;
  toggle.setAttribute('aria-pressed', String(Boolean(on)));
  toggle.textContent = on ? 'Turn off notifications' : 'Turn on notifications';
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

async function refreshNotify() {
  const iosNote = document.getElementById('iosInstall');
  const test = document.getElementById('notifyTest');
  if (iosNote) iosNote.hidden = !(iosDevice() && !standaloneApp());
  if (!('Notification' in window)) {
    setNotify('This browser cannot show desk notifications.', false);
    if (test) test.hidden = true;
    return;
  }
  if (Notification.permission === 'denied') {
    setNotify('Notifications are blocked. Open the lock icon in the address bar, set Notifications to Allow, then reload this page.', false);
    if (test) test.hidden = true;
    return;
  }
  try {
    const subscription = await currentSubscription();
    if (Notification.permission === 'granted' && subscription) {
      setNotify('On. You will get an alert when a batch is accepted or a draft is saved.', true);
      if (test) test.hidden = false;
      return;
    }
  } catch { /* show the off state */ }
  if (test) test.hidden = true;
  setNotify('Alerts for an accepted batch and a saved Gmail draft. Nothing is sent until you turn this on.', false);
}

async function enableNotifications() {
  if (!window.isSecureContext) {
    setNotify('Notifications need a secure page (HTTPS or localhost).', false);
    return;
  }
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    setNotify('This browser cannot show desk notifications.', false);
    return;
  }
  if (iosDevice() && !standaloneApp()) {
    const iosNote = document.getElementById('iosInstall');
    if (iosNote) iosNote.hidden = false;
    setNotify('Add Lead desk to the home screen first. Alerts work from that icon on iOS 16.4 or newer.', false);
    return;
  }
  if (Notification.permission === 'denied') {
    setNotify('Notifications are blocked. Open the lock icon in the address bar, set Notifications to Allow, then reload this page.', false);
    return;
  }
  try {
    let permission = Notification.permission;
    if (permission !== 'granted') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setNotify('Notifications stay off until you allow them.', false);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const keyResponse = await fetch('/api/push/vapid', { credentials: 'same-origin' });
    const keyBody = await keyResponse.json().catch(() => ({}));
    if (!keyResponse.ok || !keyBody.publicKey) {
      setNotify(keyBody.error || 'Notification keys are not configured on the server.', false);
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyBody.publicKey),
    });
    const saved = await postDesk('/api/push/subscribe', {
      userId: deskUserId(),
      userAgent: navigator.userAgent,
      subscription: subscription.toJSON(),
    });
    const body = await saved.json().catch(() => ({}));
    if (!saved.ok || !body.ok) {
      setNotify(body.error || 'The desk could not save this device.', false);
      return;
    }
    setNotify('On. You will get an alert when a batch is accepted or a draft is saved.', true);
    const test = document.getElementById('notifyTest');
    if (test) test.hidden = false;
  } catch (error) {
    setNotify(error && error.message ? error.message : 'This device could not subscribe.', false);
  }
}

async function disableNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postDesk('/api/push/unsubscribe', { endpoint: subscription.endpoint, userId: deskUserId() });
      await subscription.unsubscribe();
    }
    setNotify('Off. The desk will stay quiet on this device.', false);
    const test = document.getElementById('notifyTest');
    if (test) test.hidden = true;
  } catch {
    setNotify('The desk could not turn notifications off.', false);
  }
}

function showInstallBanner(mode) {
  if (standaloneApp()) return;
  try {
    if (localStorage.getItem('lead-desk-install-dismissed') === '1') return;
  } catch { /* still show the banner */ }
  const banner = document.getElementById('installBanner');
  const copy = document.getElementById('installCopy');
  const now = document.getElementById('installNow');
  if (!banner || !copy || !now) return;
  if (mode === 'ios') {
    copy.textContent = 'Tap Share, then Add to Home Screen.';
    now.hidden = true;
  } else {
    copy.textContent = 'Install Lead desk on this device.';
    now.hidden = false;
  }
  banner.hidden = false;
}

async function promptInstall() {
  if (!deferredInstall) return;
  try {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
  } catch { /* the browser dismissed the prompt */ }
  deferredInstall = null;
  const banner = document.getElementById('installBanner');
  const button = document.getElementById('settingsInstall');
  if (banner) banner.hidden = true;
  if (button) button.hidden = true;
}

function bindPwa() {
  document.querySelectorAll('.settings-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (button.getAttribute('aria-expanded') === 'true') closeSettings();
      else openSettings(button);
    });
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#settingsPop') || event.target.closest('.settings-btn')) return;
    closeSettings();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettings();
  });
  const toggle = document.getElementById('notifyToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (toggle.getAttribute('aria-pressed') === 'true') disableNotifications();
      else enableNotifications();
    });
  }
  const test = document.getElementById('notifyTest');
  if (test) {
    test.addEventListener('click', async () => {
      try {
        const response = await postDesk('/api/push/test', { userId: deskUserId() });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) {
          toast(body.error || 'The test alert was not sent.');
          return;
        }
        toast(body.sent ? 'Test alert sent.' : 'No device is subscribed.');
      } catch {
        toast('The test alert was not sent.');
      }
    });
  }
  const install = document.getElementById('settingsInstall');
  if (install) install.addEventListener('click', () => promptInstall());
  const now = document.getElementById('installNow');
  if (now) now.addEventListener('click', () => promptInstall());
  const dismiss = document.getElementById('installDismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      try { localStorage.setItem('lead-desk-install-dismissed', '1'); } catch { /* hide it for this visit */ }
      document.getElementById('installBanner').hidden = true;
    });
  }
  ['gateQr', 'deskQr'].forEach((id) => {
    const image = document.getElementById(id);
    if (!image) return;
    image.addEventListener('error', () => {
      const note = document.createElement('p');
      note.className = 'qr-caption';
      note.textContent = 'QR code unavailable.';
      image.replaceWith(note);
    });
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
    const button = document.getElementById('settingsInstall');
    if (button) button.hidden = false;
    showInstallBanner('native');
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    const banner = document.getElementById('installBanner');
    const button = document.getElementById('settingsInstall');
    if (banner) banner.hidden = true;
    if (button) button.hidden = true;
  });
  if (iosDevice() && !standaloneApp()) showInstallBanner('ios');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

bindPwa();
