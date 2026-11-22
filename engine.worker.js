/*
 * engine.worker.js
 *
 * "Worker runtime error: undefined" means worker.onerror fired with
 * ErrorEvent.message === undefined.  This happens when an error propagates
 * to the main thread without being caught inside the worker — often from
 * unhandled promise rejections or errors in async code that escape try/catch.
 *
 * Fix strategy
 * ────────────
 *  1. self.onerror  — intercepts every sync error; returns true to suppress
 *                     the opaque "undefined" that reaches the main thread.
 *  2. self.onunhandledrejection — intercepts every async rejection that
 *                     escaped a try/catch.
 *  3. doLoad() is always awaited inside a .catch() — no rejection can escape.
 *  4. formatErr()   — safely extracts text from Error, DOMException,
 *                     WebAssembly.CompileError / RuntimeError, string,
 *                     undefined, ErrorEvent, PromiseRejectionEvent.
 *  5. stage         — a string updated at every loading step; appended to
 *                     every error so the exact point of failure is visible.
 *  6. Pre-fetch the WASM and validate magic bytes ourselves; pass the buffer
 *     directly as wasmBinary so Emscripten never constructs a URL for it.
 *  7. Try the single-thread build first (simpler, no SharedArrayBuffer for
 *     WASM itself); then the multi-thread build when crossOriginIsolated.
 *     Both are Stockfish 16 NNUE — same evaluation strength.
 *
 * Confirmed filenames (stockfish@16.0.0/src/):
 *   stockfish-nnue-16-single.js / .wasm   — 1-thread, no SharedArrayBuffer
 *   stockfish-nnue-16.js / .wasm          — multi-thread, needs SharedArrayBuffer
 *
 * Protocol (main → worker):
 *   { type:'init' }             start loading
 *   { type:'cmd', cmd:'...' }   forward UCI string to engine
 *
 * Protocol (worker → main):
 *   { type:'status',  message } loading progress
 *   { type:'loaded',  version, multiThread } engine initialised, uci sent
 *   { type:'uciok'  }           engine confirmed UCI mode
 *   { type:'readyok'}           engine ready for analysis commands
 *   { type:'output',  line }    raw UCI output line
 *   { type:'error',   message } fatal — real reason, real stage, real URL
 */
'use strict';

// ── CONFIRMED CDN URLS ────────────────────────────────────────────────────────
const BASE = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/';

const SINGLE = {
  label:       'Stockfish 16 NNUE · single-thread',
  js:          BASE + 'stockfish-nnue-16-single.js',
  wasm:        BASE + 'stockfish-nnue-16-single.wasm',
  multiThread: false,
};

const MULTI = {
  label:       'Stockfish 16 NNUE · multi-thread',
  js:          BASE + 'stockfish-nnue-16.js',
  wasm:        BASE + 'stockfish-nnue-16.wasm',
  multiThread: true,
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let engine = null;
let stage  = 'idle';        // updated at every step — appended to errors

// ── TOP-LEVEL WORKER ERROR TRAPS ──────────────────────────────────────────────
// These run BEFORE any user code and catch errors that escape every try/catch.
// Returning true from self.onerror suppresses the opaque ErrorEvent that
// reaches the main thread as "Worker runtime error: undefined".

self.onerror = function (message, source, lineno, colno, error) {
  var text = message || '(no message)';
  if (source)  text += '\nat ' + source + ':' + lineno + ':' + colno;
  if (error)   text += '\n' + formatErr(error);
  emit('error', { message: '[Worker onerror / stage=' + stage + ']\n' + text });
  return true;   // ← suppress propagation to main thread's worker.onerror
};

self.onunhandledrejection = function (evt) {
  if (evt && evt.preventDefault) evt.preventDefault();
  var reason = evt && evt.reason !== undefined ? evt.reason : evt;
  emit('error', {
    message: '[Unhandled rejection / stage=' + stage + ']\n' + formatErr(reason),
  });
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function emit(type, extra) {
  self.postMessage(Object.assign({ type: type }, extra));
}

function processLine(raw) {
  var line = (typeof raw === 'string'
    ? raw
    : String(raw && raw.data !== undefined ? raw.data : raw)
  ).trim();
  if (!line) return;
  emit('output', { line: line });
  if (line === 'uciok')    emit('uciok');
  if (line === 'readyok') emit('readyok');
}

/*
 * formatErr — safely convert any thrown value to a human-readable string.
 * Handles: Error, DOMException, WebAssembly.CompileError / RuntimeError,
 *          string, number, null, undefined, plain objects, ErrorEvent.
 */
function formatErr(err) {
  if (err === null || err === undefined) {
    return '(error value is ' + String(err) + ')';
  }
  if (typeof err === 'string') return err;
  if (typeof err === 'number') return 'Error code: ' + err;

  // Object — build a comprehensive string
  var parts = [];

  var name = err.name || (err.constructor && err.constructor.name) || '';
  if (name && name !== 'Error') parts.push('[' + name + ']');

  var msg = err.message;
  if (msg === undefined && err.reason) msg = formatErr(err.reason);   // PromiseRejectionEvent
  if (msg === undefined && err.error)  msg = formatErr(err.error);    // ErrorEvent
  if (msg !== undefined && msg !== '') parts.push(msg);

  // ErrorEvent / onunhandledrejection carry source location
  if (err.filename) parts.push('at ' + err.filename + ':' + (err.lineno || '?'));

  if (parts.length === 0) {
    // No name or message populated yet — use the name regardless of value,
    // then fall back to JSON / String.
    if (name) return '[' + name + ']';
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }

  // Append a short stack excerpt if available
  if (err.stack && typeof err.stack === 'string') {
    var lines = err.stack.split('\n').filter(function(l){ return l.trim(); });
    // Skip lines that just repeat the message
    var frames = lines.filter(function(l){ return l.trim().startsWith('at '); });
    if (frames.length) parts.push('\n' + frames.slice(0, 3).join('\n'));
  }

  return parts.join(' ');
}

// ── INCOMING MESSAGES ─────────────────────────────────────────────────────────
self.onmessage = function (e) {
  var type = e.data && e.data.type;
  var cmd  = e.data && e.data.cmd;
  if (type === 'cmd' && engine) { engine.postMessage(cmd); return; }
  if (type === 'init') startLoad();
};

// ── LOAD ENTRY POINT ──────────────────────────────────────────────────────────
// doLoad is always awaited inside .catch() — no rejection can escape to
// self.onunhandledrejection and produce a second error message.
function startLoad() {
  stage = 'starting';
  doLoad().catch(function (err) {
    emit('error', {
      message: '[Escaped load error / stage=' + stage + ']\n' + formatErr(err),
    });
  });
}

async function doLoad() {
  // Try single-thread first — it has fewer runtime dependencies.
  // Add multi-thread as a second candidate when crossOriginIsolated is true
  // (SharedArrayBuffer available, so pthreads can run).
  var coi   = self.crossOriginIsolated === true;
  var queue = coi ? [SINGLE, MULTI] : [SINGLE];
  var failures = [];

  for (var i = 0; i < queue.length; i++) {
    var src = queue[i];
    try {
      await loadSource(src);
      // Success
      emit('loaded', { version: src.label, multiThread: src.multiThread });
      engine.postMessage('uci');
      return;
    } catch (err) {
      var detail = formatErr(err);
      failures.push('▸ ' + src.label + '\n  Stage: ' + stage + '\n  ' + detail.replace(/\n/g, '\n  '));
      emit('status', { message: src.label + ' failed at stage [' + stage + ']:\n' + detail });
    }
  }

  // All sources failed — report every URL and failure
  emit('error', {
    message:
      'Stockfish 16 NNUE could not be loaded.\n\n' +
      failures.join('\n\n') +
      '\n\nURLs attempted:\n' +
      queue.map(function(s){ return '  JS:   ' + s.js + '\n  WASM: ' + s.wasm; }).join('\n') +
      '\n\nCommon causes:\n' +
      '  • No internet connection (CDN unreachable on first load).\n' +
      '  • Browser blocks WebAssembly.\n' +
      '  • The page is opened as a local file:// URL — use the https:// URL.\n' +
      '  • GitHub Pages not yet deployed (wait 2 minutes after commit).',
  });
}

// ── SOURCE LOADER ─────────────────────────────────────────────────────────────
async function loadSource(src) {
  var printEnabled = true;

  // ── Step 1: Fetch the WASM binary ─────────────────────────────────────────
  stage = 'wasm-fetch · ' + src.wasm;
  emit('status', { message: 'Fetching WASM…\n' + src.wasm });

  var wasmBinary;
  try {
    var resp = await fetch(src.wasm);

    if (!resp.ok) {
      throw new Error(
        'HTTP ' + resp.status + ' ' + resp.statusText + '\nURL: ' + src.wasm
      );
    }

    var ct = resp.headers.get('content-type') || '';
    if (/text\/html/i.test(ct)) {
      throw new Error(
        'Server returned HTML instead of a WASM binary (likely a 404 page).\n' +
        'URL: ' + src.wasm + '\nContent-Type: ' + ct
      );
    }

    stage = 'wasm-read · ' + src.wasm;
    wasmBinary = await resp.arrayBuffer();

  } catch (fetchErr) {
    // Re-throw with stage context
    throw new Error(
      'WASM fetch failed.\nStage: ' + stage + '\n' + formatErr(fetchErr)
    );
  }

  // ── Step 2: Validate magic bytes ──────────────────────────────────────────
  // Valid WASM starts with 0x00 0x61 0x73 0x6D (\0asm).
  // 0x3C 0x21 0x44 0x4F = "<!DO" = an HTML page.
  stage = 'wasm-validate · ' + src.wasm;

  var magic = new Uint8Array(wasmBinary, 0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 ||
      magic[2] !== 0x73 || magic[3] !== 0x6d) {

    var hex = Array.from(magic)
      .map(function(b){ return b.toString(16).padStart(2, '0'); }).join(' ');
    var isHtml = magic[0] === 0x3c;   // '<'
    throw new Error(
      'Invalid WASM binary — magic bytes wrong.\n' +
      'URL:      ' + src.wasm + '\n' +
      'Expected: 00 61 73 6d\n' +
      'Got:      ' + hex +
      (isHtml ? '\n(leading 0x3c = "<" — server returned an HTML error page)' : '')
    );
  }

  var sizeMB = (wasmBinary.byteLength / 1048576).toFixed(1);
  emit('status', { message: 'WASM OK · ' + sizeMB + ' MB · loading JS…' });

  // ── Step 3: Set global Module BEFORE importScripts ────────────────────────
  // Some Emscripten builds read the global Module at parse time.
  // We pass wasmBinary here so if the build reads it at load time, it uses it.
  stage = 'module-setup';
  self.Module = {
    wasmBinary:  wasmBinary,
    print:       function(line) { if (printEnabled) processLine(line); },
    printErr:    function() {},
    locateFile:  function(name) { return BASE + name; },
  };

  // ── Step 4: importScripts — loads the factory JS ──────────────────────────
  stage = 'js-import · ' + src.js;
  importScripts(src.js);   // synchronous; throws on network error or HTTP 4xx

  // ── Step 5: Locate the factory function ───────────────────────────────────
  // The build may set self.Stockfish, self.STOCKFISH, or overwrite self.Module.
  // We saved preModule above; if self.Module is now a function, the script
  // replaced it with the factory (classic Emscripten output pattern).
  stage = 'factory-locate · ' + src.js;

  var factory =
    (typeof self.Stockfish  === 'function' ? self.Stockfish  : null) ||
    (typeof self.STOCKFISH  === 'function' ? self.STOCKFISH  : null) ||
    null;

  if (!factory) {
    // Log what keys were added to self after importScripts
    var selfKeys = Object.keys(self)
      .filter(function(k){ return k !== 'Module'; })
      .join(', ');
    throw new Error(
      'No Stockfish/STOCKFISH factory found after importScripts.\n' +
      'URL: ' + src.js + '\n' +
      'self keys: ' + (selfKeys || '(none)') + '\n' +
      'The file may use ES module syntax (incompatible with importScripts), ' +
      'or export the factory under a different name.'
    );
  }

  // ── Step 6: Call the factory with pre-fetched wasmBinary ─────────────────
  // Emscripten skips its internal WASM URL fetch when wasmBinary is provided.
  // This is what prevented the previous "3c 21 44 4f" crash.
  stage = 'factory-call · ' + src.js;

  var factoryResult;
  try {
    factoryResult = factory({
      wasmBinary:  wasmBinary,
      print:       function(line) { if (printEnabled) processLine(line); },
      printErr:    function() {},
      locateFile:  function(name) { return BASE + name; },
    });
  } catch (callErr) {
    throw new Error(
      'Factory call threw synchronously.\n' + formatErr(callErr)
    );
  }

  // ── Step 7: Await WASM instantiation ──────────────────────────────────────
  // SF16 NNUE: Stockfish() returns a Promise that resolves once the WASM
  // module is compiled and the engine is ready.
  stage = 'wasm-instantiate · ' + src.wasm;

  var sf;
  try {
    sf = (factoryResult && typeof factoryResult.then === 'function')
      ? await factoryResult
      : factoryResult;
  } catch (instantiateErr) {
    throw new Error(
      'WASM instantiation failed.\n' + formatErr(instantiateErr)
    );
  }

  if (!sf || typeof sf.postMessage !== 'function') {
    throw new Error(
      'Factory resolved but engine object has no postMessage method.\n' +
      'URL: ' + src.js + '\n' +
      'Received: ' + String(sf)
    );
  }

  // ── Step 8: Wire the UCI output listener ──────────────────────────────────
  // addMessageListener is the standard nmrugg SF16 API.
  // If present, disable Module.print to prevent duplicate lines.
  stage = 'wire-listener';

  if (typeof sf.addMessageListener === 'function') {
    printEnabled = false;
    sf.addMessageListener(processLine);
  } else if ('onmessage' in sf) {
    printEnabled = false;
    sf.onmessage = function(e) {
      processLine(typeof e === 'string' ? e : (e && e.data !== undefined ? e.data : ''));
    };
  }
  // If neither API exists, Module.print (wired above) handles output.

  stage = 'ready · ' + src.label;
  engine = sf;
}
