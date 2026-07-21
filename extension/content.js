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

// --- AES-CBC Decryption (mirrors decode.js) ---

// node-forge uses first 16 bytes of the 32-char IV string; Web Crypto requires exactly 16
const DECRYPT_IV = 'tE5_yR0~uI2-oP4a';

// The 2026 site update changed the AES-CBC IV, so the first 16-byte block of
// every response now decrypts to garbage while the rest is intact (the classic
// CBC IV-mismatch signature). The real payload always begins with this wrapper,
// so we repair the first block and, from it, recover the IV the app actually
// uses — then reuse that IV when re-encrypting our merged result for the app.
const KNOWN_PREFIX = '{"vm":[{"isSessi'; // exactly 16 bytes
let lastIvCorrect = null; // Uint8Array(16), recovered during decryption

function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function decryptResponse(headerA, hexData) {
  // Extract AES key: strip first 8 and last 8 chars from header 'a'
  const keyStr = headerA.substring(8, headerA.length - 8);
  const keyBytes = new TextEncoder().encode(keyStr);
  const ivBytes = new TextEncoder().encode(DECRYPT_IV);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
  );

  const encrypted = hexToBytes(hexData);
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, cryptoKey, encrypted)
  );

  // Fast path: if the whole thing parses, the fixed IV was correct after all.
  const rawText = new TextDecoder().decode(decrypted).replace(/[\x00-\x1f]+$/, '');
  try {
    const obj = JSON.parse(rawText);
    lastHeaderA = headerA;
    lastIvCorrect = ivBytes; // fixed IV worked for this header
    return obj;
  } catch {}

  // Slow path: the first CBC block is corrupted by the changed IV. Replace the
  // first 16 bytes with the known wrapper to recover valid JSON, and derive the
  // IV the app actually uses for this header 'a' so we can re-encrypt correctly.
  if (decrypted.length >= 16) {
    const realP0 = new TextEncoder().encode(KNOWN_PREFIX); // 16 bytes
    const repaired = new Uint8Array(decrypted.length);
    repaired.set(realP0, 0);
    repaired.set(decrypted.slice(16), 16);
    const repairedText = new TextDecoder().decode(repaired).replace(/[\x00-\x1f]+$/, '');
    try {
      const obj = JSON.parse(repairedText);
      // AES_dec(C0) = (our block0 decrypted with fixed IV) XOR fixed IV.
      // IV_app = AES_dec(C0) XOR realP0.
      lastIvCorrect = xorBytes(xorBytes(decrypted.slice(0, 16), ivBytes), realP0);
      lastHeaderA = headerA;
      return obj;
    } catch (err) {
      log('Decrypt repair failed:', err.message);
    }
  }
  // Genuinely empty or unrecognised — treat as no sessions.
  return { vm: [] };
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptData(keyStr, plaintext) {
  const keyBytes = new TextEncoder().encode(keyStr);
  // Encrypt with the IV recovered during decryption (matches the app's current
  // scheme) so the app decrypts our merged response correctly; fall back to the
  // legacy fixed IV only if we never decrypted a real response.
  const ivBytes = lastIvCorrect || new TextEncoder().encode(DECRYPT_IV);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']
  );

  const data = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: ivBytes }, cryptoKey, data
  );

  return bytesToHex(new Uint8Array(encrypted));
}

// Store the last seen header 'a' so we can re-encrypt merged data
let lastHeaderA = null;

// --- Chunking Engine ---

function splitDateRange(fromMs, toMs, chunkDays = 85) {
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

async function fetchChunks(baseUrl, chunks, onProgress) {
  const results = [];
  let sessionsSoFar = 0;
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
      } else {
        // Response is encrypted: { data: "<hex>" } with key in header 'a'.
        // decryptResponse pins lastHeaderA + lastIvCorrect together on success.
        const headerA = response.headers.get('a');
        const envelope = await response.json();

        let data;
        if (headerA && envelope.data && typeof envelope.data === 'string') {
          // Encrypted response — decrypt it
          data = await decryptResponse(headerA, envelope.data);
          log(`Chunk ${i + 1}/${chunks.length}: decrypted OK`);
        } else {
          // Unencrypted or unexpected format — use as-is
          data = envelope;
        }

        const fromDate = new Date(chunk.from).toISOString().slice(0, 10);
        const toDate = new Date(chunk.to).toISOString().slice(0, 10);
        const n = data.vm?.length || data.sessionIds?.length || 0;
        sessionsSoFar += n;
        log(`Chunk ${i + 1}/${chunks.length}: ${fromDate} → ${toDate} — ${n} sessions`);
        results.push(data);
      }
    } catch (err) {
      log(`Chunk ${i + 1}/${chunks.length}: Error — ${err.message}`);
    }

    if (onProgress) onProgress(i + 1, chunks.length, sessionsSoFar);

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return results;
}

function mergeResponses(responses, originalFromMs, originalToMs) {
  if (responses.length === 0) return { vm: [] };

  // Deduplicate sessions by sessionId, keeping a real response as a template so
  // we hand the app back the same envelope shape (with every session merged in).
  const sessionMap = new Map();
  let template = null;
  for (const r of responses) {
    if (r && typeof r === 'object' && Array.isArray(r.vm) && !template) template = r;
    const sessions = (r && (r.vm || r.sessionIds)) || [];
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        const id = typeof s === 'object' ? s.sessionId : s;
        if (id && !sessionMap.has(id)) {
          sessionMap.set(id, s);
        }
      }
    }
  }

  const merged = [...sessionMap.values()];
  log(`Merged: ${merged.length} sessions from ${responses.length} chunks`);
  const out = template ? { ...template } : {};
  out.vm = merged;
  return out;
}

// Expose for manual testing in DevTools console
window.__pokercraftUnlocker = { makeProofRequest, dpopSigner, log, splitDateRange, mergeResponses, debugFetchChunk, fetchWholeJourney, setWholeJourneyActive, isWholeJourneyActive };

async function debugFetchChunk() {
  if (!capturedAuth?.authorization) { log('No auth yet'); return; }
  const to = Date.now();
  const from = to - 7 * 24 * 60 * 60 * 1000;
  const url = `https://my.pokercraft.com/api/session/list/Holdem?from=${from}&to=${to}&currency=USD`;
  const dpopToken = await dpopSigner.generateDPoP('GET', url);
  const response = await originalFetch(url, {
    headers: { authorization: capturedAuth.authorization, dpop: dpopToken },
  });
  const headerA = response.headers.get('a');
  const envelope = await response.json();
  log('Raw envelope keys:', Object.keys(envelope));
  log('Header a present:', !!headerA);
  if (headerA && envelope.data) {
    const decrypted = await decryptResponse(headerA, envelope.data);
    log('Decrypted type:', typeof decrypted);
    log('Decrypted keys:', typeof decrypted === 'object' ? Object.keys(decrypted) : 'N/A');
    log('Decrypted preview:', JSON.stringify(decrypted).substring(0, 500));
    return decrypted;
  }
  log('No encryption detected, raw:', JSON.stringify(envelope).substring(0, 500));
  return envelope;
}

// --- Helpers ---

const DEBUG = false; // Set to true to enable console logging

// Temporarily forced on while the "Load all records" button runs, so the user
// gets chunk-by-chunk diagnostics in the console without editing this file.
let FORCE_LOG = false;

function log(...args) {
  if (DEBUG || FORCE_LOG) console.log('[PokerCraft Whole Journey]', ...args);
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
  return days > 85;
}

// Derive a stable per-filter cache key from a session-list URL: strips the
// from/to range (which varies per chunk/request) and sorts the remaining
// params (currency, game type, stakes, etc.) so any filter the app adds is
// captured automatically, with no param names hardcoded.
function filterSignature(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.delete('from');
    parsed.searchParams.delete('to');
    const sortedParams = [...parsed.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`);
    return parsed.pathname + '?' + sortedParams.join('&');
  } catch {
    return url;
  }
}

// --- Whole Journey state ---
//
// The "Load all records" button (see injectLoadButton) fetches everything
// from WHOLE_JOURNEY_START → now in 85-day chunks and stitches it
// together. The merged result is cached and served to the app by the fetch/XHR
// interceptors, so PokerCraft renders the full history on its next session-list
// request. Purely network-layer: no DOM / Angular coupling, so it survives
// PokerCraft UI and Angular Material upgrades (which is exactly what repeatedly
// broke the old DOM-based date-picker unlock).
//
// Change WHOLE_JOURNEY_START to load from a different date.
const WHOLE_JOURNEY_START = '2025-03-01T00:00:00';
const WHOLE_JOURNEY_START_MS = new Date(WHOLE_JOURNEY_START).getTime();
const WJ_FLAG_KEY = 'pcWholeJourney';

// In-memory merged whole-journey results, keyed per filter signature (see
// filterSignature). While the mode is active, the interceptor lazily fetches
// the entry for the intercepted request's own filter on first sight and
// serves it to every subsequent request with that same signature — so the
// full history appears with no calendar interaction, and switching the
// stakes/currency/game-type filter triggers its own independent fetch instead
// of reusing another filter's cached result.
let wholeJourneyCache = new Map(); // signature -> merged result
let wholeJourneyPromise = new Map(); // signature -> in-flight de-dupe promise

// Exact session-list URL the app last used (preserves currency / game-type /
// other params). Reused as the base for our chunk requests.
let lastTargetUrl = null;

function isWholeJourneyActive() {
  try {
    return sessionStorage.getItem(WJ_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function setWholeJourneyActive(on) {
  try {
    if (on) sessionStorage.setItem(WJ_FLAG_KEY, '1');
    else sessionStorage.removeItem(WJ_FLAG_KEY);
  } catch {}
}

// Update the floating button's status line, if it's mounted.
function setWjStatus(text, bg) {
  const el = document.getElementById('pc-wj-status');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = text;
  if (bg) el.style.background = bg;
}

// Fetch + stitch the whole journey for the given request URL's filter, caching
// the result per filter signature. De-duped per signature so several
// simultaneous session-list requests with the same filter share a single fetch.
function ensureWholeJourney(url) {
  const sig = filterSignature(url);
  if (wholeJourneyCache.has(sig)) {
    return Promise.resolve(wholeJourneyCache.get(sig));
  }
  if (!wholeJourneyPromise.has(sig)) {
    const promise = fetchWholeJourney(url, sig).catch((err) => {
      wholeJourneyPromise.delete(sig); // allow retry on the next request
      throw err;
    });
    wholeJourneyPromise.set(sig, promise);
  }
  return wholeJourneyPromise.get(sig);
}

async function fetchWholeJourney(baseUrl, sig) {
  FORCE_LOG = true;
  baseUrl =
    baseUrl ||
    'https://my.pokercraft.com/api/session/list/Holdem?from=0&to=0&currency=USD';
  const chunks = splitDateRange(WHOLE_JOURNEY_START_MS, Date.now());
  setWjStatus(`⏳ 正在加载全部历史… 0/${chunks.length} 块`, '#f9a825');
  console.log(
    `[PokerCraft Whole Journey] loading ${chunks.length} chunks since ${WHOLE_JOURNEY_START.slice(0, 10)}…`
  );
  const responses = await fetchChunks(baseUrl, chunks, (done, total, sessions) => {
    setWjStatus(`⏳ 加载中… ${done}/${total} 块 · 已拉取 ${sessions} 条`, '#f9a825');
  });
  const merged = mergeResponses(responses, WHOLE_JOURNEY_START_MS, Date.now());
  wholeJourneyCache.set(sig, merged);
  const count = merged.vm ? merged.vm.length : 0;
  window.__pokercraftWholeJourney = { merged, responses, signature: sig };
  console.log(
    `[PokerCraft Whole Journey] cached ${count} sessions from ${responses.length}/${chunks.length} chunks`
  );
  setWjStatus(
    count > 0 ? `✓ 已加载 ${count} 条历史记录` : '✗ 加载到 0 条 — 见 Console',
    count > 0 ? '#2e7d32' : '#c62828'
  );
  FORCE_LOG = false;
  return merged;
}

// Fabricate a successful XHR response carrying responseBody, firing the events
// Angular/Zone.js listens for (both property handlers and dispatched events).
function serveXhrResponse(xhr, responseBody, onreadystatechangeHandler, onloadHandler, onloadendHandler) {
  Object.defineProperty(xhr, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(xhr, 'status', { get: () => 200, configurable: true });
  Object.defineProperty(xhr, 'statusText', { get: () => 'OK', configurable: true });
  Object.defineProperty(xhr, 'responseText', { get: () => responseBody, configurable: true });
  Object.defineProperty(xhr, 'response', { get: () => responseBody, configurable: true });
  Object.defineProperty(xhr, 'responseURL', { get: () => xhr._pcUrl, configurable: true });

  xhr.getResponseHeader = function (name) {
    if (name.toLowerCase() === 'a' && lastHeaderA) return lastHeaderA;
    if (name.toLowerCase() === 'content-type') return 'application/json';
    return null;
  };
  xhr.getAllResponseHeaders = function () {
    return `content-type: application/json\r\na: ${lastHeaderA || ''}\r\n`;
  };

  if (typeof onreadystatechangeHandler === 'function') onreadystatechangeHandler.call(xhr);
  xhr.dispatchEvent(new Event('readystatechange'));
  if (typeof onloadHandler === 'function') onloadHandler.call(xhr, new ProgressEvent('load'));
  xhr.dispatchEvent(new ProgressEvent('load'));
  if (typeof onloadendHandler === 'function') onloadendHandler.call(xhr, new ProgressEvent('loadend'));
  xhr.dispatchEvent(new ProgressEvent('loadend'));
}

// Build a 200 OK body for a merged result, re-encrypting if we have a key so
// the app's own decryption layer processes it transparently.
async function buildMergedBody(merged) {
  if (lastHeaderA) {
    const aesKey = lastHeaderA.substring(8, lastHeaderA.length - 8);
    const encryptedHex = await encryptData(aesKey, JSON.stringify(merged));
    return { body: JSON.stringify({ data: encryptedHex }), encrypted: true };
  }
  log('Warning: no encryption key available, returning plaintext');
  return { body: JSON.stringify(merged), encrypted: false };
}

// --- Fetch interception ---

window.fetch = async function (input, init) {
  const url = input instanceof Request ? input.url : String(input);

  if (isTargetRequest(url)) {
    log('Intercepted fetch:', url);
    lastTargetUrl = url;

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

    // Whole Journey mode: lazily fetch the full history, then serve it.
    if (isWholeJourneyActive() && capturedAuth) {
      try {
        const merged = await ensureWholeJourney(url);
        const { body, encrypted } = await buildMergedBody(merged);
        return new Response(body, {
          status: 200,
          headers: encrypted
            ? { 'content-type': 'application/json', 'a': lastHeaderA }
            : { 'content-type': 'application/json' },
        });
      } catch (err) {
        log('Whole Journey fetch failed (fetch path), passing through:', err.message);
      }
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
    log('Intercepted XHR:', this._pcMethod, this._pcUrl);
    lastTargetUrl = this._pcUrl;

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

    // Whole Journey mode: lazily fetch the full history, then serve it.
    if (isWholeJourneyActive() && capturedAuth) {
      const xhr = this;
      const onloadHandler = xhr.onload;
      const onreadystatechangeHandler = xhr.onreadystatechange;
      const onloadendHandler = xhr.onloadend;

      (async () => {
        try {
          const merged = await ensureWholeJourney(xhr._pcUrl);
          const { body: responseBody } = await buildMergedBody(merged);
          serveXhrResponse(xhr, responseBody, onreadystatechangeHandler, onloadHandler, onloadendHandler);
        } catch (err) {
          log('Whole Journey fetch failed (XHR path), falling back:', err.message);
          originalXHRSend.call(xhr, body);
        }
      })();
      return; // Don't call originalXHRSend
    }
  }
  return originalXHRSend.call(this, body);
};

// --- Load button (UI) ---
//
// A self-contained floating button appended to <body>, deliberately outside
// Angular's component tree so SPA navigation never touches it and no UI/Material
// version assumptions are baked in. Clicking toggles Whole Journey mode and
// reloads; after the reload the interceptor serves the app's own first
// session-list request from the full history — no calendar interaction needed.
function injectLoadButton() {
  if (!document.body || document.getElementById('pc-wj-box')) return;

  const active = isWholeJourneyActive();

  const box = document.createElement('div');
  box.id = 'pc-wj-box';
  Object.assign(box.style, {
    position: 'fixed',
    zIndex: '2147483647',
    bottom: '16px',
    right: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px',
    maxWidth: '320px',
  });

  const btn = document.createElement('button');
  btn.textContent = active ? '✓ 全部历史已加载 · 点此恢复默认' : '📥 加载全部历史记录';
  btn.title = active
    ? '当前正显示 2025-03-01 至今的全部记录。点击恢复 PokerCraft 默认范围。'
    : `点击加载 ${WHOLE_JOURNEY_START.slice(0, 10)} 至今的全部 session,无需手动选日期(会刷新一次页面)。`;
  Object.assign(btn.style, {
    padding: '10px 14px',
    background: active ? '#2e7d32' : '#1565c0',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    font: '600 13px/1.2 system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,.3)',
  });

  const status = document.createElement('div');
  status.id = 'pc-wj-status';
  Object.assign(status.style, {
    display: 'none',
    font: '500 12px/1.4 system-ui, -apple-system, sans-serif',
    color: '#fff',
    background: '#37474f',
    padding: '6px 10px',
    borderRadius: '6px',
  });

  btn.addEventListener('click', () => {
    setWholeJourneyActive(!active);
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.textContent = active ? '恢复中…' : '加载中…';
    location.reload();
  });

  box.appendChild(btn);
  box.appendChild(status);
  document.body.appendChild(box);
  log('Load button injected (active=' + active + ')');
}

// --- Init ---

if (document.body) {
  injectLoadButton();
} else {
  const waitForBody = new MutationObserver(() => {
    if (document.body) {
      waitForBody.disconnect();
      injectLoadButton();
    }
  });
  waitForBody.observe(document.documentElement, { childList: true });
}
log('Content script loaded — fetch/XHR interception active, DPoP capture enabled, Load button active');
