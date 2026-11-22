/*
 * engine.worker.js
 *
 * Root cause of the previous crash:
 *   Emscripten's internal WASM loader was ignoring the locateFile override
 *   and fetching from a URL that returned a 404 HTML page.
 *   Magic bytes: 00 61 73 6d  expected → 3c 21 44 4f ("<!DO") received.
 *
 * Fix:
 *   Pre-fetch the WASM binary ourselves → validate magic bytes before the
 *   engine sees it → pass the ArrayBuffer as wasmBinary to the factory.
 *   Emscripten skips its own URL fetch entirely when wasmBinary is provided.
 *   Every failure shows the actual URL + HTTP status + received bytes.
 *
 * Sources (filenames confirmed by AIwolfie from stockfish@16.0.0/src/):
 *   stockfish-nnue-16.js            multi-thread  (needs SharedArrayBuffer)
 *   stockfish-nnue-16.wasm
 *   stockfish-nnue-16-single.js     single-thread (no SharedArrayBuffer)
 *   stockfish-nnue-16-single.wasm
 *
 * Protocol (main → worker):
 *   { type:'init' }             start loading
 *   { type:'cmd', cmd:'...' }   forward UCI string to engine
 *
 * Protocol (worker → main):
 *   { type:'status',  message } loading progress, one line
 *   { type:'loaded',  version, multiThread } engine JS loaded, uci sent
 *   { type:'uciok'  }           engine confirmed UCI mode
 *   { type:'readyok'}           engine ready for analysis
 *   { type:'output',  line }    raw UCI output line
 *   { type:'error',   message } fatal — real reason, real URL, real bytes
 */
'use strict';

// ── CONFIRMED URLS ───────────────────────────────────────────────────────────
const BASE = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/';

const MULTI = {
  label:       'Stockfish 16 NNUE (multi-thread)',
  js:          BASE + 'stockfish-nnue-16.js',
  wasm:        BASE + 'stockfish-nnue-16.wasm',
  multiThread: true,
};

const SINGLE = {
  label:       'Stockfish 16 NNUE (single-thread)',
  js:          BASE + 'stockfish-nnue-16-single.js',
  wasm:        BASE + 'stockfish-nnue-16-single.wasm',
  multiThread: false,
};

// ── STATE ────────────────────────────────────────────────────────────────────
let engine = null;

// ── INCOMING ─────────────────────────────────────────────────────────────────
self.onmessage = function (e) {
  const { type, cmd } = e.data;
  if (type === 'cmd' && engine) { engine.postMessage(cmd); return; }
  if (type === 'init') startLoad();
};

// ── EMIT ─────────────────────────────────────────────────────────────────────
function emit(type, extra) {
  self.postMessage(Object.assign({ type }, extra));
}

function processLine(raw) {
  const line = (typeof raw === 'string'
    ? raw
    : String(raw?.data ?? raw ?? '')
  ).trim();
  if (!line) return;
  emit('output', { line });
  if (line === 'uciok')    emit('uciok');
  if (line === 'readyok') emit('readyok');
}

// ── LOAD SEQUENCE ─────────────────────────────────────────────────────────────
async function startLoad() {
  // Pick variant based on cross-origin isolation.
  // self.crossOriginIsolated is true iff COOP+COEP headers are present
  // (injected by coi-serviceworker after its first activation + page reload).
  const coi = self.crossOriginIsolated === true;

  // If not cross-origin-isolated, SharedArrayBuffer is unavailable,
  // so the multi-thread build would fail at instantiation — skip it.
  const queue = coi ? [MULTI, SINGLE] : [SINGLE];

  const errors = [];

  for (const src of queue) {
    try {
      await loadSource(src);
      // Success — engine is wired up and 'uci' has been sent.
      emit('loaded', { version: src.label, multiThread: src.multiThread });
      engine.postMessage('uci');
      return;
    } catch (err) {
      const msg = err?.message ?? String(err);
      errors.push({ label: src.label, msg });
      emit('status', { message: src.label + ' failed:\n' + msg });
    }
  }

  // Both SF16 NNUE sources failed.  Report every detail; never load a weaker engine.
  emit('error', {
    message:
      'Stockfish 16 NNUE could not be loaded.\n' +
      '\n' +
      errors.map(e => '▸ ' + e.label + '\n  ' + e.msg).join('\n\n') +
      '\n\n' +
      'Common causes:\n' +
      '  • No internet connection — CDN unreachable.\n' +
      '  • Browser blocks WebAssembly.\n' +
      '  • The page is opened as a local file:// URL instead of https://.\n' +
      '    Open your GitHub Pages URL: https://USERNAME.github.io/chess-analysis/',
  });
}

// ── SOURCE LOADER ─────────────────────────────────────────────────────────────
async function loadSource(src) {
  let printEnabled = true;

  // ── 1. Fetch the WASM ourselves ──────────────────────────────────────────
  //
  // Handing the ArrayBuffer directly to the Stockfish factory (wasmBinary)
  // means Emscripten never constructs or fetches a URL for it.
  // This is what prevents the "00 61 73 6d → 3c 21 44 4f" crash.
  //
  emit('status', { message: 'Fetching ' + src.wasm + ' …' });

  let wasmBinary;
  {
    let resp;
    try {
      resp = await fetch(src.wasm);
    } catch (netErr) {
      throw new Error(
        'Network error fetching ' + src.wasm + '\n' +
        'Detail: ' + netErr.message
      );
    }

    if (!resp.ok) {
      throw new Error(
        'HTTP ' + resp.status + ' ' + resp.statusText + '\n' +
        'URL: ' + src.wasm
      );
    }

    const ct = resp.headers.get('content-type') ?? '';
    if (/text\/html/i.test(ct)) {
      throw new Error(
        'Server returned HTML instead of WASM binary.\n' +
        'URL: ' + src.wasm + '\n' +
        'Content-Type: ' + ct + '\n' +
        'This usually means the CDN returned a 404 error page.'
      );
    }

    wasmBinary = await resp.arrayBuffer();
  }

  // ── 2. Validate magic bytes ──────────────────────────────────────────────
  //
  // Every valid WebAssembly binary starts with 0x00 0x61 0x73 0x6D (\0asm).
  // 0x3c 0x21 0x44 0x4f = "<!DO" = start of an HTML page → wrong URL.
  //
  const magic = new Uint8Array(wasmBinary, 0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 ||
      magic[2] !== 0x73 || magic[3] !== 0x6d) {
    const hex = Array.from(magic).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const isHtml = magic[0] === 0x3c; // '<' — almost certainly an HTML page
    throw new Error(
      'WASM magic bytes invalid.\n' +
      'URL: ' + src.wasm + '\n' +
      'Expected: 00 61 73 6d  (\\0asm)\n' +
      'Got:      ' + hex +
      (isHtml ? '  ← HTML page — URL returned an error page, not a WASM file.' : '')
    );
  }

  const sizeMB = (wasmBinary.byteLength / 1048576).toFixed(1);
  emit('status', { message: 'WASM valid (' + sizeMB + ' MB). Loading engine JS…' });

  // ── 3. Set Module BEFORE importScripts ──────────────────────────────────
  //
  // Some Emscripten builds read the global Module object at parse time
  // (before the factory function is returned).  Setting it here is the
  // belt-and-suspenders approach alongside passing options to the factory.
  //
  self.Module = {
    wasmBinary,                                 // ← the pre-fetched binary
    print:      line => { if (printEnabled) processLine(line); },
    printErr:   ()   => {},
    locateFile: name => BASE + name,            // fallback for any other asset
  };

  // ── 4. Load the factory JS ───────────────────────────────────────────────
  importScripts(src.js);

  const factory = self.Stockfish ?? self.STOCKFISH ?? null;
  if (typeof factory !== 'function') {
    throw new Error(
      'importScripts succeeded but no Stockfish/STOCKFISH factory found.\n' +
      'URL: ' + src.js + '\n' +
      'The file may use ES module syntax (incompatible with importScripts).'
    );
  }

  // ── 5. Call factory with the pre-fetched binary ──────────────────────────
  //
  // Passing wasmBinary here overrides Emscripten's internal URL fetch.
  // The engine never touches the WASM URL after this point.
  //
  const factoryResult = factory({
    wasmBinary,
    print:      line => { if (printEnabled) processLine(line); },
    printErr:   ()   => {},
    locateFile: name => BASE + name,
  });

  // SF16 NNUE returns a Promise; asm.js builds return directly.
  const sf = (factoryResult && typeof factoryResult.then === 'function')
    ? await factoryResult
    : factoryResult;

  if (!sf || typeof sf.postMessage !== 'function') {
    throw new Error(
      'Factory did not return a valid engine object.\n' +
      'URL: ' + src.js
    );
  }

  // ── 6. Wire the output listener ─────────────────────────────────────────
  //
  // addMessageListener is the standard nmrugg SF16 UCI output API.
  // If present, it replaces Module.print to avoid duplicate lines.
  //
  if (typeof sf.addMessageListener === 'function') {
    printEnabled = false;
    sf.addMessageListener(processLine);
  } else if ('onmessage' in sf) {
    printEnabled = false;
    sf.onmessage = e => processLine(typeof e === 'string' ? e : (e?.data ?? ''));
  }
  // Else: Module.print (already wired) handles output.

  engine = sf;
}
