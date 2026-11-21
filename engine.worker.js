/*
 * engine.worker.js
 * Loads Stockfish 16 NNUE from npm CDN (cdn.jsdelivr.net).
 *
 * Confirmed filenames from stockfish@16.0.0/src/:
 *   stockfish-nnue-16.js        — multi-thread (requires SharedArrayBuffer)
 *   stockfish-nnue-16.wasm      — WASM for multi-thread build
 *   stockfish-nnue-16-single.js — single-thread (no SharedArrayBuffer needed)
 *   stockfish-nnue-16-single.wasm — WASM for single-thread build
 *
 * Loading strategy:
 *   1. If crossOriginIsolated → try multi-thread, fall back to single-thread.
 *   2. Otherwise             → try single-thread only.
 *   Both are full SF16 NNUE. No fallback to older weaker engines.
 *   Any failure shows the real error; nothing is faked or silently swapped.
 *
 * Message protocol (main → worker):
 *   { type:'init' }             start loading
 *   { type:'cmd', cmd:'...' }   forward UCI string to engine
 *
 * Message protocol (worker → main):
 *   { type:'status',  message } loading progress (human-readable)
 *   { type:'loaded',  version, multiThread } engine ready, UCI handshake starting
 *   { type:'uciok'  }           engine confirmed UCI mode
 *   { type:'readyok'}           engine processed all setoptions, ready to go
 *   { type:'output',  line }    raw UCI output line
 *   { type:'error',   message } fatal — real reason, nothing hidden
 */

'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const SF16_SRC = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/';

// Multi-thread build: Emscripten pthread, needs SharedArrayBuffer.
const MULTI = {
  label:       'Stockfish 16 NNUE · multi-thread',
  js:          SF16_SRC + 'stockfish-nnue-16.js',
  wasm:        SF16_SRC + 'stockfish-nnue-16.wasm',
  multiThread: true,
};

// Single-thread build: same NNUE evaluation, no SharedArrayBuffer.
const SINGLE = {
  label:       'Stockfish 16 NNUE · single-thread',
  js:          SF16_SRC + 'stockfish-nnue-16-single.js',
  wasm:        SF16_SRC + 'stockfish-nnue-16-single.wasm',
  multiThread: false,
};

// ── STATE ─────────────────────────────────────────────────────────────────────

let engine = null;

// ── INCOMING ──────────────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { type, cmd } = e.data;
  if (type === 'cmd' && engine) { engine.postMessage(cmd); return; }
  if (type === 'init') startLoad();
};

// ── EMIT HELPERS ──────────────────────────────────────────────────────────────

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
  // Determine which variant(s) to try based on cross-origin isolation.
  // self.crossOriginIsolated is true iff the page has COOP+COEP headers —
  // which the coi-serviceworker injects after its first activation.
  const coi = self.crossOriginIsolated === true;

  const queue = coi
    ? [MULTI, SINGLE]  // prefer multi; fall back to single on the same CDN
    : [SINGLE];        // skip multi entirely — SharedArrayBuffer unavailable

  const errors = [];

  for (const src of queue) {
    emit('status', { message: `Loading ${src.label}…` });
    try {
      await loadSource(src);
      // Success
      emit('loaded', { version: src.label, multiThread: src.multiThread });
      engine.postMessage('uci');
      return;
    } catch (err) {
      const reason = err?.message ?? String(err);
      errors.push(`[${src.label}] ${reason}`);
      emit('status', { message: `${src.label} failed — ${reason}` });
    }
  }

  // Both SF16 NNUE sources failed. Report accurately; never load a weaker engine.
  emit('error', {
    message:
      'Stockfish 16 NNUE could not be loaded.\n' +
      '\n' +
      'Failures:\n' +
      errors.join('\n') +
      '\n\n' +
      'Common causes:\n' +
      '  • No internet connection (CDN unreachable).\n' +
      '  • Browser blocks WebAssembly (rare on Android Chrome).\n' +
      '  • The page is served from a local file:// URL instead of https://.\n' +
      '\n' +
      'Fix: open the app from your GitHub Pages https:// URL and ensure\n' +
      'you have an active network connection on first load.',
  });
}

// ── SOURCE LOADER ─────────────────────────────────────────────────────────────

async function loadSource(src) {
  /*
   * How the stockfish-nnue-16-single build works in a Web Worker:
   *
   *   importScripts(src.js)
   *     → defines global Stockfish (the Emscripten factory function)
   *
   *   Stockfish({ locateFile })
   *     → returns a Promise that resolves once the WASM binary is fetched
   *       from the URL returned by locateFile and compiled.
   *     → resolves to an engine object with:
   *         engine.postMessage(str)        — send UCI command
   *         engine.addMessageListener(fn)  — subscribe to UCI output lines
   *
   * locateFile(filename, scriptDir)
   *   Emscripten calls this to resolve any asset path, including the WASM.
   *   We redirect every asset to the CDN src/ directory, which is where
   *   both .js and .wasm live in the stockfish@16.0.0 package.
   */

  // Module set BEFORE importScripts — covers builds that read it at parse time.
  let printEnabled = true;
  self.Module = {
    locateFile: (filename) => SF16_SRC + filename,
    print:      (line)     => { if (printEnabled) processLine(line); },
    printErr:   ()         => {},
  };

  // importScripts throws on 404 / network error — caught in startLoad.
  importScripts(src.js);

  // After importScripts, the build sets a global factory function.
  // In a real Web Worker, self IS the global scope, so self.Stockfish
  // and bare Stockfish are identical — but referencing it via self is
  // unambiguous and also handles builds that assign via `self.Stockfish = …`.
  const factory = self.Stockfish ?? self.STOCKFISH ?? null;

  if (typeof factory !== 'function') {
    throw new Error(
      'importScripts succeeded but neither self.Stockfish nor self.STOCKFISH ' +
      'is a function after loading ' + src.js + '. ' +
      'The file may use ES module syntax (incompatible with importScripts) ' +
      'or a different export name.'
    );
  }

  // Call the factory with our options.
  // locateFile is passed here so factory-argument-aware Emscripten builds
  // also route the WASM to CDN (belt-and-suspenders alongside self.Module).
  const factoryResult = factory({
    locateFile: (filename) => SF16_SRC + filename,
    print:      (line)     => { if (printEnabled) processLine(line); },
    printErr:   ()         => {},
  });

  // SF16 NNUE returns a Promise (WASM fetch+compile is async).
  // Older asm.js builds return the engine directly — handle both.
  const sf = (factoryResult && typeof factoryResult.then === 'function')
    ? await factoryResult
    : factoryResult;

  if (!sf || typeof sf.postMessage !== 'function') {
    throw new Error(
      'Factory resolved but the engine object is missing postMessage. ' +
      'Engine object keys: ' + Object.keys(sf || {}).join(', ')
    );
  }

  // Wire the output listener.
  // addMessageListener is the standard nmrugg SF16 UCI output API.
  if (typeof sf.addMessageListener === 'function') {
    printEnabled = false;           // Module.print covered above; disable to avoid duplicates
    sf.addMessageListener(processLine);
  } else if ('onmessage' in sf) {
    printEnabled = false;
    sf.onmessage = (e) => processLine(typeof e === 'string' ? e : (e?.data ?? ''));
  }
  // If neither API exists, Module.print (set above) handles output.

  engine = sf;
}
