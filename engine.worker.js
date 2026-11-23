/*
 * engine.worker.js — Stockfish 16 NNUE · single-thread only
 *
 * Root cause of previous "Script error." at stage=factory-locate:
 * ───────────────────────────────────────────────────────────────
 *  The multi-thread build (stockfish-nnue-16.js) spawns pthread workers
 *  at importScripts time.  Those workers attempt to load the same CDN
 *  script cross-origin.  In a cross-origin-isolated context (COOP+COEP),
 *  the browser hides the real error and reports "Script error." — the
 *  opaque mask browsers use for cross-origin script failures.
 *
 *  The single-thread build was also failing at factory-locate because
 *  importScripts with a cross-origin URL runs the script but any internal
 *  error propagates back as "Script error." too.
 *
 * Fix: two changes, nothing else modified.
 * ────────────────────────────────────────
 *  1. Single-thread build ONLY.  No multi-thread, no fallbacks to other
 *     Stockfish versions.  stockfish-nnue-16-single.js does not spawn
 *     pthread workers and has no cross-origin thread URL problem.
 *
 *  2. Blob URL loading.  Instead of:
 *       importScripts('https://cdn.jsdelivr.net/…/stockfish-nnue-16-single.js')
 *     we do:
 *       text  = await fetch(url).text()
 *       blob  = new Blob([text], {type:'text/javascript'})
 *       blobUrl = URL.createObjectURL(blob)
 *       importScripts(blobUrl)      ← same-origin
 *     Blob URLs are always same-origin.  Any error from the script now
 *     surfaces with the real message instead of the opaque "Script error.".
 *
 * UCI note:
 *   The single-thread build does not expose a Threads UCI option.
 *   Hash, MultiPV, and infinite analysis all work normally.
 *
 * Confirmed filenames (stockfish@16.0.0/src/):
 *   stockfish-nnue-16-single.js    ← only file we import
 *   stockfish-nnue-16-single.wasm  ← pre-fetched, passed as wasmBinary
 *
 * Protocol (main → worker):
 *   { type:'init' }             start loading
 *   { type:'cmd', cmd:'...' }   forward UCI string to engine
 *
 * Protocol (worker → main):
 *   { type:'status',  message } loading progress
 *   { type:'loaded',  version } Stockfish ready, uci handshake started
 *   { type:'uciok'  }           engine confirmed UCI mode
 *   { type:'readyok'}           engine ready for analysis
 *   { type:'output',  line }    raw UCI output line
 *   { type:'error',   message } fatal — real error, real stage, real URL
 */
'use strict';

const SF_JS   = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js';
const SF_WASM = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.wasm';
const SF_BASE = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/';

let engine = null;
let stage  = 'idle';

// ── TOP-LEVEL ERROR TRAPS ─────────────────────────────────────────────────────
// These catch anything that escapes every try/catch — including errors from
// scripts loaded via importScripts and unhandled promise rejections.
// returning true from self.onerror suppresses the opaque propagation that
// produced "Worker runtime error: undefined" on the main thread.

self.onerror = function (message, source, lineno, colno, error) {
  var text = (message || '(no message)');
  if (source)  text += '\nat ' + source + ':' + (lineno || '?') + ':' + (colno || '?');
  if (error)   text += '\n' + formatErr(error);
  emit('error', {
    message: 'Worker error at stage=' + stage + '\n' + text,
  });
  return true;   // suppress opaque propagation to main thread
};

self.onunhandledrejection = function (evt) {
  if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
  var reason = (evt && evt.reason !== undefined) ? evt.reason : evt;
  emit('error', {
    message: 'Unhandled rejection at stage=' + stage + '\n' + formatErr(reason),
  });
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function emit(type, extra) {
  self.postMessage(Object.assign({ type: type }, extra || {}));
}

function processLine(raw) {
  var line = (typeof raw === 'string'
    ? raw
    : String(raw && raw.data !== undefined ? raw.data : (raw || ''))
  ).trim();
  if (!line) return;
  emit('output', { line: line });
  if (line === 'uciok')    emit('uciok');
  if (line === 'readyok') emit('readyok');
}

/*
 * formatErr — convert any thrown value to a readable string.
 * Handles: Error, DOMException, WebAssembly.CompileError / RuntimeError,
 *          string, number, null, undefined, ErrorEvent-shaped objects.
 */
function formatErr(err) {
  if (err === null || err === undefined) return '(' + String(err) + ')';
  if (typeof err === 'string') return err;
  if (typeof err === 'number') return 'Error code: ' + err;

  var parts = [];
  var name  = err.name || (err.constructor && err.constructor.name) || '';
  if (name && name !== 'Error') parts.push('[' + name + ']');

  var msg = err.message;
  if (!msg && err.reason !== undefined) msg = formatErr(err.reason);
  if (!msg && err.error  !== undefined) msg = formatErr(err.error);
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

// ── INCOMING MESSAGES ─────────────────────────────────────────────────────────

self.onmessage = function (e) {
  var type = e.data && e.data.type;
  var cmd  = e.data && e.data.cmd;
  if (type === 'cmd' && engine) { engine.postMessage(cmd); return; }
  if (type === 'init') {
    doLoad().catch(function (err) {
      emit('error', {
        message: 'Load aborted at stage=' + stage + '\n' + formatErr(err),
      });
    });
  }
};

// ── LOAD ──────────────────────────────────────────────────────────────────────

async function doLoad() {

  // ── Step 1: Fetch WASM binary ─────────────────────────────────────────────
  stage = 'wasm-fetch';
  emit('status', { message: 'Fetching WASM…\n' + SF_WASM });

  var wasmBinary;
  try {
    var wr = await fetch(SF_WASM);

    if (!wr.ok) {
      throw new Error(
        'HTTP ' + wr.status + ' ' + wr.statusText + '\nURL: ' + SF_WASM
      );
    }
    var wct = wr.headers.get('content-type') || '';
    if (/text\/html/i.test(wct)) {
      throw new Error(
        'Server returned HTML instead of WASM binary.\n' +
        'URL: ' + SF_WASM + '\nContent-Type: ' + wct
      );
    }

    stage = 'wasm-read';
    wasmBinary = await wr.arrayBuffer();

  } catch (fetchErr) {
    throw new Error('WASM fetch failed\n' + formatErr(fetchErr));
  }

  // ── Step 2: Validate WASM magic bytes ─────────────────────────────────────
  // Valid WebAssembly files start with 0x00 0x61 0x73 0x6D (\0asm).
  // 0x3C 0x21 0x44 0x4F = "<!DO" = an HTML error page.
  stage = 'wasm-validate';

  var magic = new Uint8Array(wasmBinary, 0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 ||
      magic[2] !== 0x73 || magic[3] !== 0x6d) {
    var hex = Array.from(magic)
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join(' ');
    throw new Error(
      'Invalid WASM binary — magic bytes wrong.\n' +
      'URL:      ' + SF_WASM + '\n' +
      'Expected: 00 61 73 6d  (\\0asm)\n' +
      'Got:      ' + hex +
      (magic[0] === 0x3c
        ? '\n(0x3c = "<" — the CDN returned an HTML error page, not a WASM file)'
        : '')
    );
  }

  var mb = (wasmBinary.byteLength / 1048576).toFixed(1);
  emit('status', { message: 'WASM valid · ' + mb + ' MB\nFetching engine JS…' });

  // ── Step 3: Fetch JS as text, load via blob URL ───────────────────────────
  //
  // WHY BLOB URL:
  //   importScripts with a cross-origin CDN URL is subject to the browser's
  //   cross-origin error masking.  Any error inside the script — SyntaxError,
  //   RuntimeError, missing feature, etc. — arrives as the opaque "Script error."
  //   with no details.
  //
  //   Blob URLs are always same-origin.  By fetching the JS text ourselves
  //   (which only requires CORP from the CDN, which jsDelivr provides) and
  //   wrapping it in a Blob, we get full error details if the script throws.
  //
  stage = 'js-fetch';

  var jsText;
  try {
    var jr = await fetch(SF_JS);
    if (!jr.ok) {
      throw new Error(
        'HTTP ' + jr.status + ' ' + jr.statusText + '\nURL: ' + SF_JS
      );
    }
    var jct = jr.headers.get('content-type') || '';
    if (/text\/html/i.test(jct)) {
      throw new Error(
        'Server returned HTML instead of JavaScript.\n' +
        'URL: ' + SF_JS + '\nContent-Type: ' + jct
      );
    }
    stage = 'js-read';
    jsText = await jr.text();
  } catch (fetchErr) {
    throw new Error('JS fetch failed\n' + formatErr(fetchErr));
  }

  // Create the blob URL and clean it up whether importScripts succeeds or not.
  stage = 'blob-create';
  var blobUrl = URL.createObjectURL(
    new Blob([jsText], { type: 'text/javascript' })
  );

  // ── Step 4: Set Module BEFORE importScripts ───────────────────────────────
  // Some Emscripten builds read the global Module at parse time.
  // Providing wasmBinary here (and again to the factory in step 6) means
  // the engine never needs to fetch the WASM by URL — it uses our buffer.
  stage = 'module-setup';
  var printEnabled = true;
  self.Module = {
    wasmBinary:  wasmBinary,
    locateFile:  function (name) { return SF_BASE + name; },
    print:       function (line) { if (printEnabled) processLine(line); },
    printErr:    function () {},
  };

  // ── Step 5: importScripts via blob URL ────────────────────────────────────
  // Now same-origin → real error messages on failure.
  stage = 'js-import';
  try {
    importScripts(blobUrl);
  } catch (importErr) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(
      'importScripts failed for ' + SF_JS + '\n' + formatErr(importErr)
    );
  }
  URL.revokeObjectURL(blobUrl);

  // ── Step 6: Locate the factory ────────────────────────────────────────────
  // The build may set self.Stockfish, self.STOCKFISH, or overwrite self.Module
  // with a function (some Emscripten builds replace the Module object with
  // the factory function itself).
  stage = 'factory-locate';

  var origModuleIsFunc = typeof self.Module === 'function';
  var factory =
    (typeof self.Stockfish  === 'function' ? self.Stockfish  : null) ||
    (typeof self.STOCKFISH  === 'function' ? self.STOCKFISH  : null) ||
    (origModuleIsFunc                      ? self.Module     : null) ||
    null;

  if (!factory) {
    // Report all keys that appeared on self after importScripts
    var selfKeys = Object.keys(self)
      .filter(function (k) {
        return !['Module','onerror','onunhandledrejection','onmessage'].includes(k);
      });
    throw new Error(
      'No Stockfish factory found on self after importScripts.\n' +
      'URL: ' + SF_JS + '\n' +
      'self keys after import: ' + (selfKeys.length ? selfKeys.join(', ') : '(none added)') + '\n' +
      'typeof self.Stockfish: ' + typeof self.Stockfish + '\n' +
      'typeof self.STOCKFISH: ' + typeof self.STOCKFISH + '\n' +
      'typeof self.Module:    ' + typeof self.Module + '\n\n' +
      'Possible cause: the .js file uses ES module syntax (export/import)\n' +
      'and cannot be loaded by importScripts in a classic worker.\n' +
      'If this is the case, the engine.worker.js must be converted to a\n' +
      'module worker (new Worker(url, {type:"module"})) and use dynamic import().'
    );
  }

  // ── Step 7: Call factory ──────────────────────────────────────────────────
  stage = 'factory-call';
  var factoryResult;
  try {
    factoryResult = factory({
      wasmBinary:  wasmBinary,
      locateFile:  function (name) { return SF_BASE + name; },
      print:       function (line) { if (printEnabled) processLine(line); },
      printErr:    function () {},
    });
  } catch (callErr) {
    throw new Error('Factory call threw synchronously\n' + formatErr(callErr));
  }

  // ── Step 8: Await WASM instantiation ──────────────────────────────────────
  // SF16 NNUE: Stockfish() returns a Promise that resolves once the WASM
  // module is compiled and the engine has started.
  stage = 'wasm-instantiate';
  var sf;
  try {
    sf = (factoryResult && typeof factoryResult.then === 'function')
      ? await factoryResult
      : factoryResult;
  } catch (instErr) {
    throw new Error('WASM instantiation failed\n' + formatErr(instErr));
  }

  if (!sf || typeof sf.postMessage !== 'function') {
    throw new Error(
      'Factory resolved but engine object has no postMessage method.\n' +
      'URL: ' + SF_JS + '\n' +
      'Received type: ' + typeof sf + '  value: ' + String(sf)
    );
  }

  // ── Step 9: Wire UCI output listener ──────────────────────────────────────
  // addMessageListener is the standard nmrugg SF16 UCI output API.
  // If present, disable Module.print to avoid duplicate output lines.
  stage = 'wire-listener';
  if (typeof sf.addMessageListener === 'function') {
    printEnabled = false;
    sf.addMessageListener(processLine);
  } else if ('onmessage' in sf) {
    printEnabled = false;
    sf.onmessage = function (e) {
      processLine(typeof e === 'string' ? e : (e && e.data !== undefined ? e.data : ''));
    };
  }
  // If neither API is present, Module.print (wired in step 4) handles output.

  stage = 'ready';
  engine = sf;

  emit('loaded', {
    version:     'Stockfish 16 NNUE · single-thread',
    multiThread: false,
  });

  // Start UCI handshake — engine will respond with id lines then 'uciok'.
  sf.postMessage('uci');
}
