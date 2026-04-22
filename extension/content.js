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
  console.log('[PokerCraft Whole Journey]', ...args);
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

/**
 * DOM structure (from diagnostics):
 *   div.cdk-overlay-pane.mat-datepicker-popup
 *     mat-datepicker-content
 *       mat-calendar
 *         mat-calendar-header
 *           button.mat-calendar-previous-button (prev month)
 *           button.mat-calendar-next-button (next month, disabled="true" + mat-button-disabled)
 *         mat-month-view
 *           table > tbody > tr > td.mat-calendar-body-cell-container
 *             > button.mat-calendar-body-cell (aria-label="2026-04-23T00:00:00-07:00")
 *               Disabled cells: + class mat-calendar-body-disabled + aria-disabled="true"
 *               (NO html disabled attr on cells — only on nav buttons)
 *
 * Angular component hierarchy (from __ngContext__):
 *   MatDatepickerContent { _calendar, datepicker }
 *     _calendar (MatCalendar) { monthView, _minDate, _maxDate, dateFilter, _currentView }
 *       monthView (MatMonthView) { _weeks, _matCalendarBody, _dateAdapter, activeDate,
 *                                   selectedChange, _userSelection, _minDate, _maxDate, dateFilter }
 */

function getComponentsFromContext(el) {
  const ctx = el.__ngContext__;
  if (!ctx || !Array.isArray(ctx)) return [];
  const results = [];
  for (const item of ctx) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      results.push(item);
    }
  }
  return results;
}

/**
 * Find the MatMonthView component instance from the calendar popup.
 */
function findMonthView(popup) {
  const allEls = [popup, ...popup.querySelectorAll('*')];
  for (const el of allEls) {
    for (const comp of getComponentsFromContext(el)) {
      if ('_weeks' in comp && 'selectedChange' in comp && '_dateAdapter' in comp) {
        return comp;
      }
    }
  }
  return null;
}

/**
 * Find the MatCalendar component instance from the calendar popup.
 */
function findCalendar(popup) {
  const allEls = [popup, ...popup.querySelectorAll('*')];
  for (const el of allEls) {
    for (const comp of getComponentsFromContext(el)) {
      if ('monthView' in comp && '_currentView' in comp && '_minDate' in comp) {
        return comp;
      }
    }
  }
  return null;
}

/**
 * Unlock the calendar:
 * 1. Remove disabled state from nav buttons (prev/next month) — these have real HTML disabled
 * 2. Remove disabled styling from date cells — these use aria-disabled + CSS class
 * 3. Install click interceptor that reads aria-label date and forces selection via Angular
 */
function unlockCalendar(popup) {
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // --- Nav buttons ---
  const nextBtn = popup.querySelector('button.mat-calendar-next-button');
  const prevBtn = popup.querySelector('button.mat-calendar-previous-button');

  // Previous button: always unlock
  if (prevBtn && (prevBtn.disabled || prevBtn.classList.contains('mat-button-disabled'))) {
    prevBtn.disabled = false;
    prevBtn.classList.remove('mat-button-disabled');
    prevBtn.removeAttribute('aria-disabled');
    log(`Unlocked nav button: ${prevBtn.getAttribute('aria-label')}`);
  }

  // Next button: unlock unless navigating would go to a future month
  if (nextBtn) {
    const cal = findCalendar(popup);
    let shouldDisableNext = false;
    if (cal) {
      const adapter = cal.monthView?._dateAdapter || cal._dateAdapter;
      const active = cal._clampedActiveDate || cal.activeDate;
      if (adapter && active) {
        const displayedYear = adapter.getYear(active);
        const displayedMonth = adapter.getMonth(active);
        // If next month would be after current month, disable
        if (displayedYear > today.getFullYear() ||
            (displayedYear === today.getFullYear() && displayedMonth >= today.getMonth())) {
          shouldDisableNext = true;
        }
      }
    }

    if (shouldDisableNext) {
      nextBtn.disabled = true;
      nextBtn.classList.add('mat-button-disabled');
    } else if (nextBtn.disabled || nextBtn.classList.contains('mat-button-disabled')) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('mat-button-disabled');
      nextBtn.removeAttribute('aria-disabled');
      log(`Unlocked nav button: ${nextBtn.getAttribute('aria-label')}`);
    }
  }

  // --- Date cells ---
  const disabledCells = popup.querySelectorAll('button.mat-calendar-body-cell.mat-calendar-body-disabled');
  let unlockCount = 0;
  for (const cell of disabledCells) {
    const ariaLabel = cell.getAttribute('aria-label');
    if (!ariaLabel) continue;
    const cellDate = new Date(ariaLabel);
    if (isNaN(cellDate.getTime())) continue;

    // Only unlock past/today dates
    if (cellDate <= todayMidnight) {
      cell.classList.remove('mat-calendar-body-disabled');
      cell.removeAttribute('aria-disabled');
      cell._wasDisabled = true;
      unlockCount++;
    }
  }
  if (unlockCount > 0) {
    log(`Unlocked ${unlockCount} past date cells`);
  }

  // Disable any future date cells that Angular left enabled
  // (can happen after we clear _maxDate during navigation)
  const enabledCells = popup.querySelectorAll('button.mat-calendar-body-cell:not(.mat-calendar-body-disabled)');
  let disableCount = 0;
  for (const cell of enabledCells) {
    const ariaLabel = cell.getAttribute('aria-label');
    if (!ariaLabel) continue;
    const cellDate = new Date(ariaLabel);
    if (isNaN(cellDate.getTime())) continue;

    if (cellDate > todayMidnight) {
      cell.classList.add('mat-calendar-body-disabled');
      cell.setAttribute('aria-disabled', 'true');
      disableCount++;
    }
  }
  if (disableCount > 0) {
    log(`Disabled ${disableCount} future date cells`);
  }

  // --- Click interceptor ---
  installClickInterceptor(popup);
}

function installClickInterceptor(popup) {
  if (popup._dateClickInterceptor) return;
  popup._dateClickInterceptor = true;

  popup.addEventListener('click', (e) => {
    // --- Handle nav button clicks ---
    // Always intercept ALL nav button clicks because Angular's internal handler
    // checks min/max and will either crash or refuse to navigate.
    // After selecting a start date, Angular re-creates buttons with new restrictions.
    const navBtn = e.target.closest('button.mat-calendar-previous-button, button.mat-calendar-next-button');
    if (navBtn) {
      // Stop Angular's handler from running
      e.stopImmediatePropagation();
      e.preventDefault();

      const cal = findCalendar(popup);
      if (!cal) {
        log('Nav interceptor: could not find Calendar component');
        return;
      }

      const isPrev = navBtn.classList.contains('mat-calendar-previous-button');
      const adapter = cal.monthView?._dateAdapter || cal._dateAdapter;
      if (!adapter) return;

      const currentActive = cal._clampedActiveDate || cal.activeDate;
      if (!currentActive) return;

      const newActive = isPrev
        ? adapter.addCalendarMonths(currentActive, -1)
        : adapter.addCalendarMonths(currentActive, 1);

      // Block forward navigation into future months
      if (!isPrev) {
        const newYear = adapter.getYear(newActive);
        const newMonth = adapter.getMonth(newActive);
        const now = new Date();
        if (newYear > now.getFullYear() ||
            (newYear === now.getFullYear() && newMonth > now.getMonth())) {
          log('Nav interceptor: blocked — cannot navigate to future month');
          return;
        }
      }

      // Clear min/max so the activeDate setter doesn't clamp
      cal._minDate = null;
      cal._maxDate = null;
      if (cal.monthView) {
        cal.monthView._minDate = null;
        cal.monthView._maxDate = null;
      }

      if ('_clampedActiveDate' in cal) {
        cal._clampedActiveDate = newActive;
      }
      cal.activeDate = newActive;

      if (cal._changeDetectorRef?.detectChanges) {
        try { cal._changeDetectorRef.detectChanges(); } catch(err) {
          log(`Nav detectChanges error: ${err.message}`);
        }
      }

      log(`Nav interceptor: moved to ${isPrev ? 'previous' : 'next'} month`);

      // Re-unlock after Angular re-renders the new month
      setTimeout(() => unlockCalendar(popup), 200);
      return;
    }

    // --- Handle date cell clicks on cells we unlocked ---
    const cellBtn = e.target.closest('button.mat-calendar-body-cell');
    if (!cellBtn || !cellBtn._wasDisabled) return;

    const ariaLabel = cellBtn.getAttribute('aria-label');
    if (!ariaLabel) return;

    const mv = findMonthView(popup);
    if (!mv) {
      log('Click interceptor: could not find MonthView component');
      return;
    }

    const parsed = new Date(ariaLabel);
    if (isNaN(parsed.getTime())) return;

    // Find the cell data object in _weeks and enable it BEFORE Angular's handler runs.
    // This way Angular's native click handler will process it normally — no delay.
    const dayOfMonth = parsed.getDate();
    let enabled = false;
    if (mv._weeks) {
      for (const row of mv._weeks) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (cell && cell.value === dayOfMonth && !cell.enabled) {
            cell.enabled = true;
            enabled = true;
          }
        }
      }
    }
    // Also enable in _matCalendarBody.rows if present
    if (mv._matCalendarBody?.rows) {
      for (const row of mv._matCalendarBody.rows) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (cell && cell.value === dayOfMonth && !cell.enabled) {
            cell.enabled = true;
          }
        }
      }
    }

    if (enabled) {
      log(`Click interceptor: enabled cell for day ${dayOfMonth}, letting Angular handle click`);
      // Don't stop propagation — let Angular's handler process the click natively
      return;
    }

    // Fallback: if we couldn't find the cell data, use the selection model directly
    log(`Click interceptor: fallback — forcing selection for ${parsed.toISOString().slice(0, 10)}`);

    const date = mv._dateAdapter.createDate(
      parsed.getFullYear(), parsed.getMonth(), parsed.getDate()
    );

    const allEls = [popup, ...popup.querySelectorAll('*')];
    for (const el of allEls) {
      for (const comp of getComponentsFromContext(el)) {
        if ('_model' in comp && '_calendar' in comp && '_rangeSelectionStrategy' in comp) {
          const model = comp._model;
          const strategy = comp._rangeSelectionStrategy;

          if (strategy && typeof strategy.selectionFinished === 'function') {
            const newSelection = strategy.selectionFinished(date, model.selection, e);
            if (newSelection) {
              model.updateSelection(newSelection, comp);
              return;
            }
          }

          if (typeof model.add === 'function') {
            model.add(date);
            return;
          }
          break;
        }
      }
    }

    mv.selectedChange.emit(date);
  }, true); // capture phase

  log('Click interceptor installed');
}

function patchDatePicker() {
  let calendarObserver = null;
  let debounceTimer = null;

  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // The popup is: div.cdk-overlay-pane.mat-datepicker-popup
        const popup =
          node.matches?.('.mat-datepicker-popup')
            ? node
            : node.querySelector?.('.mat-datepicker-popup') ||
              node.querySelector?.('mat-datepicker-content');

        if (popup) {
          log('Calendar popup detected');

          // Wait for Angular to finish rendering
          setTimeout(() => unlockCalendar(popup), 150);

          // Watch for month navigation re-renders (childList only)
          if (calendarObserver) calendarObserver.disconnect();
          calendarObserver = new MutationObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              // Disconnect during patching to avoid loops
              if (calendarObserver) {
                calendarObserver.disconnect();
              }
              unlockCalendar(popup);
              if (calendarObserver) {
                calendarObserver.observe(popup, { childList: true, subtree: true });
              }
            }, 150);
          });
          calendarObserver.observe(popup, { childList: true, subtree: true });
        }
      }

      for (const node of mutation.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('.mat-datepicker-popup') || node.querySelector?.('.mat-datepicker-popup')) {
          if (calendarObserver) {
            calendarObserver.disconnect();
            calendarObserver = null;
            log('Calendar removed — observer disconnected');
          }
        }
      }
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
  log('Date picker unlock observer active');
}

// --- Init ---

if (document.body) {
  patchDatePicker();
} else {
  const waitForBody = new MutationObserver(() => {
    if (document.body) {
      waitForBody.disconnect();
      patchDatePicker();
    }
  });
  waitForBody.observe(document.documentElement, { childList: true });
}
log('Content script loaded — fetch/XHR interception active, DPoP capture enabled, date picker unlock active');
