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
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes }, cryptoKey, encrypted
  );

  // Remove PKCS7 padding and parse JSON
  const text = new TextDecoder().decode(decrypted);
  // Trim any trailing padding/null bytes
  const trimmed = text.replace(/[\x00-\x1f]+$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptData(keyStr, plaintext) {
  const keyBytes = new TextEncoder().encode(keyStr);
  const ivBytes = new TextEncoder().encode(DECRYPT_IV);

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

      // Response is encrypted: { data: "<hex>" } with key in header 'a'
      const headerA = response.headers.get('a');
      if (headerA) lastHeaderA = headerA;
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
      log(`Chunk ${i + 1}/${chunks.length}: ${fromDate} → ${toDate} — ${data.vm?.length || data.sessionIds?.length || 0} sessions`);
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
  if (responses.length === 0) return { vm: [] };

  // Deduplicate sessions by sessionId
  const sessionMap = new Map();
  for (const r of responses) {
    const sessions = r.vm || r.sessionIds || [];
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
  return { vm: merged };
}

// Expose for manual testing in DevTools console
window.__pokercraftUnlocker = { makeProofRequest, dpopSigner, log, splitDateRange, mergeResponses, debugFetchChunk, patchDatePicker };

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
  return days > 85;
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

      // Re-encrypt so the app's decryption layer handles it
      if (lastHeaderA) {
        const aesKey = lastHeaderA.substring(8, lastHeaderA.length - 8);
        const encryptedHex = await encryptData(aesKey, JSON.stringify(merged));
        return new Response(JSON.stringify({ data: encryptedHex }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'a': lastHeaderA },
        });
      }
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
      // Save all event listeners/handlers the app may have set
      const onloadHandler = xhr.onload;
      const onreadystatechangeHandler = xhr.onreadystatechange;
      const onloadendHandler = xhr.onloadend;

      (async () => {
        try {
          const responses = await fetchChunks(xhr._pcUrl, chunks);
          const merged = mergeResponses(responses, fromMs, toMs);

          // Re-encrypt merged data so the app's decryption layer handles it normally
          let responseBody;
          if (lastHeaderA) {
            const aesKey = lastHeaderA.substring(8, lastHeaderA.length - 8);
            const encryptedHex = await encryptData(aesKey, JSON.stringify(merged));
            responseBody = JSON.stringify({ data: encryptedHex });
          } else {
            responseBody = JSON.stringify(merged);
            log('Warning: no encryption key available, returning plaintext');
          }

          // Override all response-related properties
          Object.defineProperty(xhr, 'readyState', { get: () => 4, configurable: true });
          Object.defineProperty(xhr, 'status', { get: () => 200, configurable: true });
          Object.defineProperty(xhr, 'statusText', { get: () => 'OK', configurable: true });
          Object.defineProperty(xhr, 'responseText', { get: () => responseBody, configurable: true });
          Object.defineProperty(xhr, 'response', { get: () => responseBody, configurable: true });
          Object.defineProperty(xhr, 'responseURL', { get: () => xhr._pcUrl, configurable: true });

          // Fake the response headers so the app can read header 'a' for decryption
          xhr.getResponseHeader = function(name) {
            if (name.toLowerCase() === 'a' && lastHeaderA) return lastHeaderA;
            if (name.toLowerCase() === 'content-type') return 'application/json';
            return null;
          };
          xhr.getAllResponseHeaders = function() {
            return `content-type: application/json\r\na: ${lastHeaderA || ''}\r\n`;
          };

          // Trigger callbacks — Angular/Zone.js uses both property handlers and events
          if (typeof onreadystatechangeHandler === 'function') {
            onreadystatechangeHandler.call(xhr);
          }
          xhr.dispatchEvent(new Event('readystatechange'));

          if (typeof onloadHandler === 'function') {
            onloadHandler.call(xhr, new ProgressEvent('load'));
          }
          xhr.dispatchEvent(new ProgressEvent('load'));

          if (typeof onloadendHandler === 'function') {
            onloadendHandler.call(xhr, new ProgressEvent('loadend'));
          }
          xhr.dispatchEvent(new ProgressEvent('loadend'));
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

// --- Date Picker Unlock ---

function unlockDateCells(container) {
  // Find disabled cells within calendar-related containers
  const selectors = [
    '[aria-disabled="true"]',
    '[disabled]',
    '.mat-calendar-body-disabled',
  ];
  const cells = container.querySelectorAll(selectors.join(','));
  let count = 0;
  for (const cell of cells) {
    cell.removeAttribute('aria-disabled');
    cell.removeAttribute('disabled');
    // Remove any class containing 'disabled'
    const disabledClasses = [...cell.classList].filter(c => c.includes('disabled'));
    for (const cls of disabledClasses) {
      cell.classList.remove(cls);
    }
    // Remove pointer-events restriction
    if (cell.style.pointerEvents === 'none') {
      cell.style.pointerEvents = '';
    }
    count++;
  }
  if (count > 0) {
    log(`Unlocked ${count} date cells`);
  }
}

function patchDatePicker() {
  let calendarObserver = null;

  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // Check if the added node is or contains a calendar element
        const calendarEl =
          node.matches?.('mat-calendar, .mat-calendar, mat-datepicker-content, .mat-datepicker-content, .cdk-overlay-container, [class*="calendar"]')
            ? node
            : node.querySelector?.('mat-calendar, .mat-calendar, mat-datepicker-content, .mat-datepicker-content, [class*="calendar"]');

        if (calendarEl) {
          log('Calendar popup detected — unlocking date cells');
          unlockDateCells(calendarEl);

          // Disconnect previous calendar observer if any
          if (calendarObserver) {
            calendarObserver.disconnect();
          }

          // Watch for month navigation re-renders within the calendar
          calendarObserver = new MutationObserver(() => {
            unlockDateCells(calendarEl);
          });
          calendarObserver.observe(calendarEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-disabled', 'class', 'disabled'],
          });
        }
      }

      // Clean up calendar observer when overlay is removed
      for (const node of mutation.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (
          node.matches?.('mat-datepicker-content, .mat-datepicker-content, .cdk-overlay-container') ||
          node.querySelector?.('mat-calendar')
        ) {
          if (calendarObserver) {
            calendarObserver.disconnect();
            calendarObserver = null;
            log('Calendar removed — secondary observer disconnected');
          }
        }
      }
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
  log('Date picker unlock observer active');
}

// --- Init ---

patchDatePicker();
log('Content script loaded — fetch/XHR interception active, DPoP capture enabled, date picker unlock active');
