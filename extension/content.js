// Save original references BEFORE anything else
const originalFetch = window.fetch.bind(window);
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

// --- Helpers ---

function log(...args) {
  console.log('[Pokercraft Unlocker]', ...args);
}

function isTargetRequest(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return (
      parsed.hostname === 'my.pokercraft.com' &&
      parsed.pathname.includes('/api/session/list/Holdem') &&
      parsed.searchParams.has('from') &&
      parsed.searchParams.has('to')
    );
  } catch {
    return false;
  }
}

function parseDateRange(url) {
  const parsed = new URL(url, window.location.origin);
  const from = new Date(Number(parsed.searchParams.get('from')));
  const to = new Date(Number(parsed.searchParams.get('to')));
  const days = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return { from, to, days };
}

function isLargeRange(days) {
  return days > 25;
}

// --- Fetch interception ---

window.fetch = async function (input, init) {
  const url = input instanceof Request ? input.url : String(input);
  if (isTargetRequest(url)) {
    const range = parseDateRange(url);
    log('Intercepted fetch:', url);
    log(
      'Date range:',
      range.from.toISOString(),
      '→',
      range.to.toISOString(),
      `(${range.days} days)`
    );
    if (isLargeRange(range.days)) {
      log('Large range detected — will need chunking (Phase 2)');
      // For now, pass through even large ranges
    }
  }
  return originalFetch(input, init);
};

// --- XHR interception ---

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._pcMethod = method;
  this._pcUrl = url;
  return originalXHROpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (body) {
  if (this._pcUrl && isTargetRequest(this._pcUrl)) {
    const range = parseDateRange(this._pcUrl);
    log('Intercepted XHR:', this._pcMethod, this._pcUrl);
    log(
      'Date range:',
      range.from.toISOString(),
      '→',
      range.to.toISOString(),
      `(${range.days} days)`
    );
    if (isLargeRange(range.days)) {
      log('Large range detected — will need chunking (Phase 2)');
    }
  }
  return originalXHRSend.call(this, body);
};

// --- Init ---

log('Content script loaded — fetch/XHR interception active');
