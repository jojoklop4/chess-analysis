/*
 * engine.worker.js
 * Loads Stockfish from CDN with an ordered fallback chain.
 * No local stockfish.js / stockfish.wasm files required.
 *
 * Message protocol (main → worker):
 *   { type: 'init' }             — start loading
 *   { type: 'cmd', cmd: '...' } — forward UCI command to engine
 *
 * Message protocol (worker → main):
 *   { type: 'status',  message } — human-readable load progress
 *   { type: 'loaded',  version } — engine JS loaded, UCI handshake started
 *   { type: 'uciok'   }          — engine confirmed UCI mode
 *   { type: 'readyok' }          — engine ready for analysis
 *   { type: 'output',  line }    — raw UCI output line
 *   { type: 'error',   message } — fatal, all sources failed
 */
'use strict';

let engine      = null;
let printActive = true;   // Module.print guard: disabled when addMessageListener takes over

// ── CDN CANDIDATES ───────────────────────────────────────────────────────────
// Tried in order. First one that fully initialises and returns a working
// engine object wins. Each failure logs a status message and moves on.
//
// base  = directory the .wasm lives in; fed to locateFile so Emscripten finds
//         it without us having to know the filename.
//
const SOURCES = [
  // ── Stockfish 16 candidates ──────────────────────────────────────────────
  {
    label: 'Stockfish 16 · npm@16.0.0 root',
    js:   'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/',
  },
  {
    label: 'Stockfish 16 · npm@16.0.0 src/',
    js:   'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/',
  },
  {
    label: 'Stockfish 16.1 · npm@16.1.1 src/',
    js:   'https://cdn.jsdelivr.net/npm/stockfish@16.1.1/src/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish@16.1.1/src/',
  },
  // ── Latest published version (whatever npm says is @latest) ─────────────
  {
    label: 'Stockfish latest · npm',
    js:   'https://cdn.jsdelivr.net/npm/stockfish/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish/',
  },
  // ── Known-good older versions (asm.js, no WASM dependency) ──────────────
  {
    label: 'Stockfish 11 · npm@11.0.0',
    js:   'https://cdn.jsdelivr.net/npm/stockfish@11.0.0/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish@11.0.0/',
  },
  {
    label: 'Stockfish 10 · npm@10.0.0',
    js:   'https://cdn.jsdelivr.net/npm/stockfish@10.0.0/stockfish.js',
    base: 'https://cdn.jsdelivr.net/npm/stockfish@10.0.0/',
  },
];

// ── INCOMING MESSAGES ────────────────────────────────────────────────────────
self.onmessage = function (e) {
  const { type, cmd } = e.data;
  if (type === 'cmd') { if (engine) engine.postMessage(cmd); return; }
  if (type === 'init') tryLoad(0);
};

// ── OUTPUT ───────────────────────────────────────────────────────────────────
function processLine(raw) {
  const line = (typeof raw === 'string'
    ? raw
    : String(raw?.data ?? raw ?? '')
  ).trim();
  if (!line) return;
  self.postMessage({ type: 'output', line });
  if (line === 'uciok')    self.postMessage({ type: 'uciok' });
  if (line === 'readyok') self.postMessage({ type: 'readyok' });
}

function status(msg)  { self.postMessage({ type: 'status', message: msg }); }
function fatal(msg)   { self.postMessage({ type: 'error',  message: msg }); }

// ── LOAD CHAIN ───────────────────────────────────────────────────────────────
async function tryLoad(idx) {
  if (idx >= SOURCES.length) {
    fatal('All Stockfish CDN sources failed.\n' +
          'Check your internet connection and try reloading the page.\n' +
          'GitHub Pages deployment requires the page to be opened at the ' +
          'https://USERNAME.github.io/... URL, not from a local file.');
    return;
  }

  const src = SOURCES[idx];
  status(`Trying ${src.label}…`);

  try {
    await loadSource(src);
    // ── Success ──────────────────────────────────────────────────────────
    self.postMessage({ type: 'loaded', version: src.label });
    engine.postMessage('uci');

  } catch (err) {
    status(`${src.label} failed: ${err.message}`);
    tryLoad(idx + 1);
  }
}

async function loadSource(src) {
  /*
   * Strategy:
   * 1. Set global Module BEFORE importScripts so builds that read it at load
   *    time get our locateFile and print callbacks.
   * 2. importScripts(url) — synchronous, sets the Stockfish symbol.
   * 3. Call Stockfish(options) — also passes options in case the build is
   *    a factory that ignores the global Module.
   * 4. Await the result if it's a Promise (WASM builds), or use it directly
   *    (asm.js builds).
   * 5. Wire up the output listener.
   */

  // Reset print guard for this attempt
  printActive = true;

  const moduleOpts = {
    print:    function (line) { if (printActive) processLine(line); },
    printErr: function () {},
    locateFile: function (filename) { return src.base + filename; },
  };

  // Belt-and-suspenders: set global Module before importScripts
  self.Module = { ...moduleOpts };

  // Load the script. Throws on network error or syntax error.
  importScripts(src.js);

  // Locate the factory function (name varies across builds)
  const factory = self.Stockfish ?? self.STOCKFISH ?? null;
  if (typeof factory !== 'function') {
    throw new Error('No Stockfish/STOCKFISH function found after importScripts.');
  }

  // Call factory. Some builds accept a Module-like object as the argument.
  let result;
  try {
    result = factory({ ...moduleOpts });
  } catch (_) {
    // Some builds take no arguments
    result = factory();
  }

  // Resolve the engine instance (Promise for WASM, direct for asm.js)
  const sf = (result && typeof result.then === 'function')
    ? await result
    : result;

  if (!sf || typeof sf.postMessage !== 'function') {
    throw new Error('Factory did not return an engine object with postMessage.');
  }

  // Wire the best available output listener.
  if (typeof sf.addMessageListener === 'function') {
    // Newer nmrugg API — disable Module.print to avoid duplicate lines
    printActive = false;
    sf.addMessageListener(processLine);
  } else if (typeof sf.onmessage !== 'undefined') {
    printActive = false;
    sf.onmessage = function (e) {
      processLine(typeof e === 'string' ? e : (e?.data ?? ''));
    };
  }
  // Else: rely solely on Module.print (already wired above).

  engine = sf;
}
