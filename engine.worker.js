/*
 * engine.worker.js
 *
 * Architecture (corrected)
 * ────────────────────────
 * stockfish-nnue-16-single.js is a Web Worker script, not a library.
 * The correct usage is:
 *
 *   const sf = new Worker('https://cdn.../stockfish-nnue-16-single.js')
 *   sf.postMessage('uci')          // plain-string UCI commands in
 *   sf.onmessage = e => e.data     // plain-string UCI lines out
 *
 * When run this way:
 *   · The Stockfish worker loads its own WASM via a path relative to
 *     its CDN URL.  The WASM is at the same CDN origin → same-origin
 *     fetch, no CORS needed, no COEP conflict.
 *   · No importScripts(), no factory function, no wasmBinary, no
 *     locateFile override.  The worker manages all of that internally.
 *
 * Why importScripts() failed:
 *   importScripts(CDN_URL) executes the script inside our wrapper
 *   worker's realm.  The script spawns sub-workers for WASM thread
 *   support using its own CDN URL.  Those sub-workers attempt to load
 *   a cross-origin script inside our cross-origin-isolated realm.
 *   The browser masks the real error as "Script error." — permanently.
 *   A blob URL did not help: the sub-worker spawn still used the CDN
 *   URL, so the same masking applied.
 *
 * Protocol (main → this worker):
 *   { type:'init' }             start loading
 *   { type:'cmd', cmd:'...' }   forward UCI string to Stockfish
 *
 * Protocol (this worker → main):
 *   { type:'status',  message } loading progress
 *   { type:'loaded',  version } Stockfish worker started, uci sent
 *   { type:'uciok'  }           engine confirmed UCI mode
 *   { type:'readyok'}           engine ready for analysis
 *   { type:'output',  line }    raw UCI output line
 *   { type:'error',   message } fatal — real reason and stage
 */
'use strict';

const SF_JS   = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js';
const SF_WASM = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.wasm';

let sfWorker  = null;
let stage     = 'idle';
let initTimer = null;

// ── HELPERS (defined first so every callback below can close over them) ──────

function emit(type, extra) {
  self.postMessage(Object.assign({ type: type }, extra || {}));
}

function fmt(err) {
  if (err === null || err === undefined) return '(' + String(err) + ')';
  if (typeof err === 'string') return err;
  if (typeof err === 'number') return 'Error code: ' + err;
  var parts = [];
  var name  = err.name || (err.constructor && err.constructor.name) || '';
  if (name && name !== 'Error') parts.push('[' + name + ']');
  var msg = err.message;
  if (!msg && err.reason !== undefined) msg = fmt(err.reason);
  if (!msg && err.error  !== undefined) msg = fmt(err.error);
  if (msg) parts.push(msg);
  if (err.filename) parts.push('at ' + err.filename + ':' + (err.lineno || '?'));
  if (!parts.length) {
    if (name) return '[' + name + ']';
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }
  if (err.stack && typeof err.stack === 'string') {
    var frames = err.stack.split('\n')
      .filter(function (l) { return l.trim().indexOf('at ') === 0; })
      .slice(0, 3);
    if (frames.length) parts.push('\n' + frames.join('\n'));
  }
  return parts.join(' ');
}

// ── TOP-LEVEL TRAPS (wrapper worker) ─────────────────────────────────────────
// Catch anything that escapes try/catch in this wrapper worker.
// Return true suppresses the opaque "Worker runtime error: undefined" that
// previously reached the main thread.

self.onerror = function (message, source, lineno, colno, error) {
  var text = (message || '(no message)');
  if (source) text += '\nat ' + source + ':' + (lineno || '?') + ':' + (colno || '?');
  if (error)  text += '\n' + fmt(error);
  emit('error', { message: 'Wrapper worker error at stage=' + stage + '\n' + text });
  return true;
};

self.onunhandledrejection = function (evt) {
  if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
  var r = (evt && evt.reason !== undefined) ? evt.reason : evt;
  emit('error', { message: 'Unhandled rejection at stage=' + stage + '\n' + fmt(r) });
};

// ── INCOMING (from main thread) ───────────────────────────────────────────────

self.onmessage = function (e) {
  var type = e.data && e.data.type;
  var cmd  = e.data && e.data.cmd;

  if (type === 'cmd') {
    if (sfWorker) sfWorker.postMessage(cmd);
    return;
  }
  if (type === 'init') {
    doLoad().catch(function (err) {
      emit('error', { message: 'Init failed at stage=' + stage + '\n' + fmt(err) });
    });
  }
};

// ── LOAD ──────────────────────────────────────────────────────────────────────

async function doLoad() {

  // ── 1. Verify both CDN URLs return HTTP 200 ───────────────────────────────
  // This surfaces wrong or missing URLs with a clear message before we try
  // to create the Worker, rather than a 30-second timeout or masked error.
  stage = 'url-check';
  emit('status', { message: 'Checking CDN URLs…' });

  await verifyUrl(SF_JS,   'JS');
  await verifyUrl(SF_WASM, 'WASM');

  emit('status', { message: 'URLs OK · creating Stockfish worker…' });

  // ── 2. Create the Stockfish worker ────────────────────────────────────────
  // The CDN script runs in its own Worker realm.
  // · Its WASM URL is resolved relative to its own CDN URL (same-origin
  //   from the WASM's perspective — no CORS needed).
  // · It is NOT cross-origin-isolated; that is fine for the single-thread
  //   build, which does not require SharedArrayBuffer.
  // · Message protocol: plain strings in both directions.
  stage = 'sf-worker-create';

  try {
    sfWorker = new Worker(SF_JS);
  } catch (err) {
    throw new Error(
      'new Worker(' + SF_JS + ') threw synchronously.\n' + fmt(err)
    );
  }

  // ── 3. Wire Stockfish worker handlers ─────────────────────────────────────

  // Timeout: if uciok does not arrive within 30 s the WASM silently failed.
  initTimer = setTimeout(function () {
    emit('error', {
      message:
        'Stockfish worker timed out waiting for uciok (30 s).\n' +
        'Stage at timeout: ' + stage + '\n' +
        'The WASM binary likely failed to load. Verify these URLs exist:\n' +
        '  JS:   ' + SF_JS + '\n' +
        '  WASM: ' + SF_WASM,
    });
    if (sfWorker) { sfWorker.terminate(); sfWorker = null; }
  }, 30000);

  sfWorker.onmessage = function (event) {
    // event.data is a plain UCI string line produced by the Stockfish worker
    var line = typeof event.data === 'string'
      ? event.data.trim()
      : (event.data !== null && event.data !== undefined
          ? String(event.data).trim()
          : '');
    if (!line) return;

    emit('output', { line: line });

    if (line === 'uciok') {
      clearTimeout(initTimer);
      emit('uciok');
    }
    if (line === 'readyok') {
      emit('readyok');
    }
  };

  sfWorker.onerror = function (errorEvent) {
    clearTimeout(initTimer);

    // Cross-origin worker errors may be masked by the browser.
    // Show what we have; include the URL so the user can diagnose.
    var msg =
      (errorEvent.message &&
       errorEvent.message !== 'Script error.' &&
       errorEvent.message !== 'undefined'
        ? errorEvent.message
        : null) ||
      (errorEvent.error ? fmt(errorEvent.error) : null) ||
      'Error details not available (cross-origin worker masking).\n' +
      'Most likely cause: WASM failed to load or is incompatible.\n' +
      '  Verify the WASM exists and is a valid binary at:\n' +
      '  ' + SF_WASM;

    if (errorEvent.filename && errorEvent.filename !== SF_JS) {
      msg += '\nError source: ' + errorEvent.filename + ':' + (errorEvent.lineno || '?');
    }

    emit('error', {
      message: 'Stockfish worker error at stage=' + stage + '\n' + msg,
    });
  };

  sfWorker.onmessageerror = function () {
    clearTimeout(initTimer);
    emit('error', {
      message: 'Stockfish worker message error at stage=' + stage +
               '\n(message payload could not be deserialized)',
    });
  };

  // ── 4. Start UCI handshake ────────────────────────────────────────────────
  // The Stockfish worker handles 'uci' by outputting engine id lines then
  // 'uciok'.  We catch 'uciok' in onmessage above.
  stage = 'uci-handshake';
  emit('loaded', {
    version:     'Stockfish 16 NNUE · single-thread',
    multiThread: false,
  });
  emit('status', { message: 'Stockfish worker started · waiting for uciok…' });
  sfWorker.postMessage('uci');
}

// ── URL CHECKER ───────────────────────────────────────────────────────────────

async function verifyUrl(url, label) {
  var resp;
  try {
    // HEAD is enough to confirm the file exists; avoids downloading the binary.
    // 405 means HEAD is not supported by the server — file still exists.
    resp = await fetch(url, { method: 'HEAD' });
  } catch (netErr) {
    throw new Error(
      label + ' network error — CDN unreachable.\n' +
      'URL: ' + url + '\n' + fmt(netErr)
    );
  }
  if (!resp.ok && resp.status !== 405) {
    throw new Error(
      label + ' returned HTTP ' + resp.status + ' ' + resp.statusText + '\n' +
      'URL: ' + url + '\n' +
      (resp.status === 404
        ? 'File not found on CDN. Verify the filename is correct.'
        : 'Unexpected response from CDN.')
    );
  }
}
