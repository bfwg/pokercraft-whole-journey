// Save original references BEFORE anything else
const originalFetch = window.fetch.bind(window);
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;
const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
const originalCryptoSign = crypto.subtle.sign.bind(crypto.subtle);

// --- DPoP State ---

let capturedAuth = null; // { authorization, dpop }
let capturedPrivateKey = null;

// --- DPoP CryptoKey capture (hook crypto.subtle.sign early) ---

crypto.subtle.sign = async function (algorithm, key, data) {
  if (
    !capturedPrivateKey &&
    typeof algorithm === 'object' &&
    algorithm?.name === 'ECDSA'
  ) {
    capturedPrivateKey = key;
    log('Captured ECDSA CryptoKey from app');
  }
  return originalCryptoSign(algorithm, key, data);
};

// --- DPoP Signer ---

class DPoPSigner {
  constructor() {
    this.jwk = null;
  }

  extractFromToken(dpopToken) {
    try {
      const [headerB64] = dpopToken.split('.');
      // base64url decode
      const padded = headerB64.replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(padded));
      this.jwk = header.jwk;
      log('Extracted JWK from DPoP header:', JSON.stringify(this.jwk));
    } catch (err) {
      log('Failed to extract JWK from DPoP token:', err.message);
    }
  }

  async generateDPoP(method, url) {
    if (!capturedPrivateKey) {
      throw new Error('No CryptoKey captured yet');
    }
    if (!this.jwk) {
      throw new Error('No JWK extracted yet — wait for app to make a DPoP request first');
    }

    const header = {
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: this.jwk,
    };

    const payload = {
      htm: method,
      htu: url.split('?')[0],
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };

    const toB64Url = (str) =>
      btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const headerB64 = toB64Url(JSON.stringify(header));
    const payloadB64 = toB64Url(JSON.stringify(payload));
    const signingInput = new TextEncoder().encode(
      `${headerB64}.${payloadB64}`
    );

    const signature = await originalCryptoSign(
      { name: 'ECDSA', hash: 'SHA-256' },
      capturedPrivateKey,
      signingInput
    );

    const sigB64 = toB64Url(String.fromCharCode(...new Uint8Array(signature)));

    return `${headerB64}.${payloadB64}.${sigB64}`;
  }
}

const dpopSigner = new DPoPSigner();

// --- Proof sub-request ---

async function makeProofRequest() {
  if (!capturedAuth?.authorization) {
    log(
      'Cannot make proof request — no auth captured yet. Wait for app to make a request first.'
    );
    return;
  }

  // Small date range: last 7 days
  const to = Date.now();
  const from = to - 7 * 24 * 60 * 60 * 1000;
  const testUrl = `https://my.pokercraft.com/api/session/list/Holdem?from=${from}&to=${to}&currency=USD`;

  log('Making proof sub-request:', testUrl);

  try {
    const dpopToken = await dpopSigner.generateDPoP('GET', testUrl);
    const response = await originalFetch(testUrl, {
      headers: {
        authorization: capturedAuth.authorization,
        dpop: dpopToken,
      },
    });

    log('Proof request status:', response.status);
    if (response.ok) {
      const data = await response.clone().text();
      log('Proof request succeeded! Response length:', data.length);
      return { status: response.status, length: data.length, data };
    } else {
      const text = await response.text();
      log('Proof request failed:', response.status, response.statusText, text);
      return { status: response.status, error: text };
    }
  } catch (err) {
    log('Proof request error:', err.message);
    return { error: err.message };
  }
}

// --- Chunking Engine ---

function splitDateRange(fromMs, toMs, chunkDays = 25) {
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
  const chunks = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + chunkMs, toMs);
    chunks.push({ from: cursor, to: end });
    cursor = end;
  }
  return chunks;
}

async function fetchChunks(baseUrl, chunks) {
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const parsed = new URL(baseUrl, window.location.origin);
    parsed.searchParams.set('from', String(chunk.from));
    parsed.searchParams.set('to', String(chunk.to));
    const chunkUrl = parsed.toString();

    try {
      const dpopToken = await dpopSigner.generateDPoP('GET', chunkUrl);
      const response = await originalFetch(chunkUrl, {
        headers: {
          authorization: capturedAuth.authorization,
          dpop: dpopToken,
        },
      });

      if (response.status !== 200) {
        log(`Chunk ${i + 1}/${chunks.length}: HTTP ${response.status} — skipping`);
        continue;
      }

      const data = await response.json();
      const fromDate = new Date(chunk.from).toISOString().slice(0, 10);
      const toDate = new Date(chunk.to).toISOString().slice(0, 10);
      log(`Chunk ${i + 1}/${chunks.length}: ${fromDate} → ${toDate} — ${data.sessionIds?.length || 0} sessions`);
      results.push(data);
    } catch (err) {
      log(`Chunk ${i + 1}/${chunks.length}: Error — ${err.message}`);
    }

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return results;
}

function mergeResponses(responses, originalFromMs, originalToMs) {
  if (responses.length === 0) return { sessionIds: [], fromTime: originalFromMs, toTime: originalToMs, remain: 0 };

  const allIds = new Set();
  for (const r of responses) {
    if (r.sessionIds) {
      for (const id of r.sessionIds) allIds.add(id);
    }
  }

  const merged = { ...responses[0] };
  merged.sessionIds = [...allIds];
  merged.fromTime = originalFromMs;
  merged.toTime = originalToMs;
  merged.remain = 0;

  log(`Merged: ${merged.sessionIds.length} sessions from ${responses.length} chunks`);
  return merged;
}

// Expose for manual testing in DevTools console
window.__pokercraftUnlocker = { makeProofRequest, dpopSigner, log, splitDateRange, mergeResponses };

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

    // Capture auth headers from fetch requests (if app uses fetch path)
    if (!capturedAuth && init?.headers) {
      const headers =
        init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers);
      const auth = headers.get('authorization');
      const dpop = headers.get('dpop');
      if (auth && dpop) {
        capturedAuth = { authorization: auth };
        dpopSigner.extractFromToken(dpop);
        log('Captured auth headers from fetch request');
      }
    }

    if (isLargeRange(range.days) && capturedAuth) {
      const parsed = new URL(url, window.location.origin);
      const fromMs = Number(parsed.searchParams.get('from'));
      const toMs = Number(parsed.searchParams.get('to'));
      const chunks = splitDateRange(fromMs, toMs);
      log(`Splitting ${range.days}-day range into ${chunks.length} chunks`);
      const responses = await fetchChunks(url, chunks);
      const merged = mergeResponses(responses, fromMs, toMs);
      return new Response(JSON.stringify(merged), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } else if (isLargeRange(range.days)) {
      log('Large range detected but no auth captured yet — passing through');
    }
  }
  return originalFetch(input, init);
};

// --- XHR interception ---

// Hook setRequestHeader to capture auth headers from XHR (app's primary transport)
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  if (!this._pcHeaders) this._pcHeaders = {};
  this._pcHeaders[name.toLowerCase()] = value;
  return originalXHRSetRequestHeader.call(this, name, value);
};

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._pcMethod = method;
  this._pcUrl = url;
  this._pcHeaders = {};
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

    // Capture auth headers from XHR (primary path since app uses XHR)
    if (!capturedAuth && this._pcHeaders) {
      const auth = this._pcHeaders['authorization'];
      const dpop = this._pcHeaders['dpop'];
      if (auth && dpop) {
        capturedAuth = { authorization: auth };
        dpopSigner.extractFromToken(dpop);
        log('Captured auth headers from XHR request');
      }
    }

    if (isLargeRange(range.days) && capturedAuth) {
      const parsed = new URL(this._pcUrl, window.location.origin);
      const fromMs = Number(parsed.searchParams.get('from'));
      const toMs = Number(parsed.searchParams.get('to'));
      const chunks = splitDateRange(fromMs, toMs);
      log(`Splitting ${range.days}-day range into ${chunks.length} chunks`);

      const xhr = this;
      (async () => {
        try {
          const responses = await fetchChunks(xhr._pcUrl, chunks);
          const merged = mergeResponses(responses, fromMs, toMs);
          const mergedJson = JSON.stringify(merged);

          Object.defineProperty(xhr, 'readyState', { get: () => 4, configurable: true });
          Object.defineProperty(xhr, 'status', { get: () => 200, configurable: true });
          Object.defineProperty(xhr, 'statusText', { get: () => 'OK', configurable: true });
          Object.defineProperty(xhr, 'responseText', { get: () => mergedJson, configurable: true });
          Object.defineProperty(xhr, 'response', { get: () => mergedJson, configurable: true });

          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        } catch (err) {
          log('Chunking failed, falling back to original request:', err.message);
          originalXHRSend.call(xhr, body);
        }
      })();
      return; // Don't call originalXHRSend
    } else if (isLargeRange(range.days)) {
      log('Large range detected but no auth captured yet — passing through');
    }
  }
  return originalXHRSend.call(this, body);
};

// --- Init ---

log('Content script loaded — fetch/XHR interception active, DPoP capture enabled');
