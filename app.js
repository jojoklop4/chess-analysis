/*
 * app.js  — Chess Analysis
 * ES module. Requires chess.js@1.x from CDN.
 */

// If this import fails (404), try replacing @1.0.0 with @1.0.0-beta.6
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/dist/esm/chess.js';

// ── PIECE ASSETS ─────────────────────────────────────────────────────────────
// Primary: CBurnett pieces from lichess CDN (sends CORP: cross-origin).
// Fallback: Unicode glyphs if the image fails to load.

const PIECE_CDN = 'https://lichess1.org/assets/piece/cburnett/';

// { 'wk': '♔', ... }
const UNICODE = {
  wk:'♔', wq:'♕', wr:'♖', wb:'♗', wn:'♘', wp:'♙',
  bk:'♚', bq:'♛', br:'♜', bb:'♝', bn:'♞', bp:'♟',
};

function pieceUrl(color, type) {
  // color: 'w'|'b'  type: 'k'|'q'|'r'|'b'|'n'|'p'
  return `${PIECE_CDN}${color}${type.toUpperCase()}.svg`;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let chess     = new Chess();
let worker    = null;
let analyzing = false;
let engReady  = false;
let flipped   = false;
let selSq     = null;        // currently selected square string e.g. 'e4'
let legalMvs  = [];          // verbose move objects for selSq
let lastMove  = null;        // { from, to } of last played move
let startFen  = null;        // null = standard start, string = custom FEN
let pvData    = {};          // multipv index → parsed info object
let stats     = { depth: 0, seldepth: 0, nodes: 0, nps: 0 };

// ── SETTINGS ──────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  threads:  1,
  hash:     64,
  multiPV:  1,
  depth:    0,   // 0 = infinite
};
let settings = { ...DEFAULT_SETTINGS };

function saveSettings() {
  try { localStorage.setItem('chessSettings', JSON.stringify(settings)); } catch {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('chessSettings') || 'null');
    if (s) settings = { ...DEFAULT_SETTINGS, ...s };
  } catch {}
}

// ── WEB WORKER BRIDGE ─────────────────────────────────────────────────────────
let engineVersion = 'Engine';   // updated when worker reports which CDN source loaded

function initWorker() {
  worker = new Worker('./engine.worker.js');

  worker.onmessage = e => {
    switch (e.data.type) {

      case 'status':
        // Loading progress from the CDN fallback chain
        setStatus('loading', e.data.message);
        break;

      case 'loaded':
        // A CDN source loaded successfully; UCI handshake is now starting
        engineVersion = e.data.version ?? 'Engine';
        setStatus('loading', `${engineVersion} — handshaking…`);
        break;

      case 'uciok':
        applyOptions();
        wSend('isready');
        break;

      case 'readyok':
        engReady = true;
        setStatus('ready', engineVersion + ' — Ready');
        setControlsReady(true);
        break;

      case 'output':
        parseUCI(e.data.line);
        break;

      case 'error':
        showError(e.data.message);
        setStatus('error', 'Engine failed — see banner');
        break;
    }
  };

  worker.onerror = e => {
    showError('Worker runtime error: ' + e.message);
    setStatus('error', 'Worker failed');
  };

  setStatus('loading', 'Connecting to CDN…');
  // No path needed — the worker loads Stockfish from CDN directly
  worker.postMessage({ type: 'init' });
}

function wSend(cmd) {
  if (worker) worker.postMessage({ type: 'cmd', cmd });
}

function applyOptions() {
  const maxT = window.crossOriginIsolated
    ? Math.max(1, Math.min(settings.threads, navigator.hardwareConcurrency || 1))
    : 1;

  if (window.crossOriginIsolated && maxT > 1) {
    wSend(`setoption name Threads value ${maxT}`);
  }
  wSend(`setoption name Hash value ${settings.hash}`);
  wSend(`setoption name MultiPV value ${settings.multiPV}`);
  wSend('setoption name UCI_AnalyseMode value true');
}

// ── UCI PARSING ───────────────────────────────────────────────────────────────
function parseUCI(line) {
  if (!line) return;

  if (line.startsWith('info ') && /\bdepth\b/.test(line)) {
    parseInfo(line);
    return;
  }
  if (line.startsWith('bestmove ')) {
    // bestmove is emitted after stop — no special handling needed beyond UI
    if (!analyzing) setStatus('ready', 'Ready');
    return;
  }
}

function parseInfo(line) {
  const tok = line.split(' ');
  const info = {};

  for (let i = 1; i < tok.length; i++) {
    switch (tok[i]) {
      case 'depth':     info.depth    = +tok[++i]; break;
      case 'seldepth':  info.seldepth = +tok[++i]; break;
      case 'multipv':   info.multipv  = +tok[++i]; break;
      case 'nodes':     info.nodes    = +tok[++i]; break;
      case 'nps':       info.nps      = +tok[++i]; break;
      case 'time':      info.time     = +tok[++i]; break;
      case 'score': {
        const st = tok[++i];
        info.score = +tok[++i];
        info.scoreType = st; // 'cp' or 'mate'
        if (tok[i + 1] === 'lowerbound' || tok[i + 1] === 'upperbound') i++;
        break;
      }
      case 'pv':
        info.pv = tok.slice(i + 1).join(' ');
        i = tok.length; // stop — pv is rest of line
        break;
    }
  }

  if (info.score === undefined) return;

  const idx = info.multipv ?? 1;
  pvData[idx] = info;

  if (idx === 1) {
    stats = {
      depth:    info.depth    ?? 0,
      seldepth: info.seldepth ?? 0,
      nodes:    info.nodes    ?? 0,
      nps:      info.nps      ?? 0,
    };
  }

  renderAnalysis();
}

// ── ANALYSIS CONTROL ──────────────────────────────────────────────────────────
function positionCmd() {
  const history = chess.history({ verbose: true });
  const moves = history.map(m => m.from + m.to + (m.promotion || '')).join(' ');

  if (!startFen) {
    return moves ? `position startpos moves ${moves}` : 'position startpos';
  }
  return moves
    ? `position fen ${startFen} moves ${moves}`
    : `position fen ${startFen}`;
}

function startAnalysis() {
  if (!engReady) return;

  // Stop any running analysis first (engine ignores stop if idle)
  wSend('stop');
  pvData = {};

  // Re-apply options (user may have changed them)
  applyOptions();
  wSend('isready');   // ensure setoption is processed before go

  wSend(positionCmd());

  if (settings.depth > 0) {
    wSend(`go depth ${settings.depth}`);
  } else {
    wSend('go infinite');
  }

  analyzing = true;
  setStatus('analyzing', 'Analyzing…');
  updateButtons();
}

function stopAnalysis() {
  wSend('stop');
  analyzing = false;
  setStatus('ready', 'Ready');
  updateButtons();
}

// ── BOARD CONSTRUCTION ────────────────────────────────────────────────────────
function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  for (let ri = 0; ri < 8; ri++) {
    for (let fi = 0; fi < 8; fi++) {
      const sq = document.createElement('div');
      sq.className = `sq ${(ri + fi) % 2 === 0 ? 'light' : 'dark'}`;
      sq.dataset.sq = squareName(ri, fi);

      // Rank label — left column only
      if (fi === 0) {
        const rl = document.createElement('span');
        rl.className = 'coord coord-rank';
        rl.textContent = flipped ? String(ri + 1) : String(8 - ri);
        sq.appendChild(rl);
      }
      // File label — bottom row only
      if (ri === 7) {
        const fl = document.createElement('span');
        fl.className = 'coord coord-file';
        fl.textContent = 'abcdefgh'[flipped ? 7 - fi : fi];
        sq.appendChild(fl);
      }

      board.appendChild(sq);
    }
  }

  // Single delegated click handler on the board
  board.addEventListener('click', onBoardClick);
  board.addEventListener('touchstart', onTouchStart, { passive: false });
  board.addEventListener('touchmove',  onTouchMove,  { passive: false });
  board.addEventListener('touchend',   onTouchEnd,   { passive: false });

  renderPieces();
}

function squareName(rankIdx, fileIdx) {
  const file = 'abcdefgh'[flipped ? 7 - fileIdx : fileIdx];
  const rank = flipped ? String(rankIdx + 1) : String(8 - rankIdx);
  return file + rank;
}

function getSqEl(sq) {
  return document.querySelector(`[data-sq="${sq}"]`);
}

// ── PIECE RENDERING ───────────────────────────────────────────────────────────
function renderPieces() {
  // Remove existing piece elements
  document.querySelectorAll('.piece-img, .piece-unicode').forEach(p => p.remove());

  const boardArr = chess.board();

  boardArr.forEach((row, ri) => {
    row.forEach((piece, fi) => {
      if (!piece) return;
      const sqName = 'abcdefgh'[fi] + String(8 - ri);
      const sqEl = getSqEl(sqName);
      if (!sqEl) return;

      const key = piece.color + piece.type; // e.g. 'wk'

      const img = document.createElement('img');
      img.className = 'piece-img';
      img.crossOrigin = 'anonymous';
      img.alt = key;
      img.src = pieceUrl(piece.color, piece.type);

      img.onerror = () => {
        img.style.display = 'none';
        const fb = document.createElement('span');
        fb.className = `piece-unicode ${piece.color}`;
        fb.textContent = UNICODE[key] ?? '?';
        sqEl.appendChild(fb);
      };

      sqEl.appendChild(img);
    });
  });

  refreshHighlights();
}

function refreshHighlights() {
  document.querySelectorAll('.sq').forEach(sq => {
    sq.classList.remove('last-from', 'last-to', 'in-check', 'selected', 'legal', 'legal-cap');
  });

  if (lastMove) {
    getSqEl(lastMove.from)?.classList.add('last-from');
    getSqEl(lastMove.to)?.classList.add('last-to');
  }

  if (chess.inCheck()) {
    const turn = chess.turn();
    chess.board().forEach((row, ri) => {
      row.forEach((piece, fi) => {
        if (piece?.type === 'k' && piece.color === turn) {
          getSqEl('abcdefgh'[fi] + String(8 - ri))?.classList.add('in-check');
        }
      });
    });
  }

  if (selSq) {
    getSqEl(selSq)?.classList.add('selected');
    legalMvs.forEach(m => {
      const target = getSqEl(m.to);
      if (!target) return;
      const isCapture = m.flags.includes('c') || m.flags.includes('e');
      target.classList.add(isCapture ? 'legal-cap' : 'legal');
    });
  }
}

// ── MOVE LOGIC ────────────────────────────────────────────────────────────────
function selectSquare(sq) {
  selSq = sq;
  legalMvs = chess.moves({ square: sq, verbose: true });
  refreshHighlights();
}

function clearSelect() {
  selSq = null;
  legalMvs = [];
  refreshHighlights();
}

function handleSquareAction(sq) {
  const piece = chess.get(sq);

  if (selSq) {
    const mv = legalMvs.find(m => m.to === sq);

    if (mv) {
      // Promotion?
      if (mv.piece === 'p' && (sq[1] === '8' || sq[1] === '1')) {
        openPromotion(selSq, sq);
        return;
      }
      doMove(selSq, sq);
      return;
    }

    // Clicked own piece → re-select
    if (piece && piece.color === chess.turn()) {
      selectSquare(sq);
      return;
    }

    clearSelect();
    return;
  }

  // No selection: select if own piece
  if (piece && piece.color === chess.turn()) {
    selectSquare(sq);
  }
}

function doMove(from, to, promotion) {
  const mv = chess.move({ from, to, promotion: promotion ?? undefined });
  if (!mv) return false;

  lastMove = { from: mv.from, to: mv.to };
  clearSelect();
  renderPieces();
  updateFenDisplay();

  if (analyzing) startAnalysis(); // Restart engine from new position

  if (chess.isGameOver()) {
    const msg = chess.isCheckmate()
      ? (chess.turn() === 'w' ? '0–1  Black wins by checkmate' : '1–0  White wins by checkmate')
      : chess.isDraw()
      ? '½–½  Draw'
      : 'Game over';
    toast(msg, 4000);
    stopAnalysis();
  }

  return true;
}

// ── PROMOTION DIALOG ──────────────────────────────────────────────────────────
let pendingPromo = null;

function openPromotion(from, to) {
  pendingPromo = { from, to };
  const overlay = document.getElementById('promo-overlay');
  const container = overlay.querySelector('.promo-pieces');
  container.innerHTML = '';

  const color = chess.turn();
  ['q', 'r', 'b', 'n'].forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'promo-btn';

    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = pieceUrl(color, type);
    img.alt = type;

    img.onerror = () => {
      img.style.display = 'none';
      const span = document.createElement('span');
      span.className = `piece-unicode ${color}`;
      span.textContent = UNICODE[color + type] ?? type;
      btn.appendChild(span);
    };

    btn.appendChild(img);
    btn.addEventListener('click', () => {
      overlay.classList.remove('open');
      doMove(pendingPromo.from, pendingPromo.to, type);
      pendingPromo = null;
    });
    container.appendChild(btn);
  });

  overlay.classList.add('open');
}

// ── MOUSE CLICK ───────────────────────────────────────────────────────────────
function onBoardClick(e) {
  const sqEl = e.target.closest('[data-sq]');
  if (!sqEl) return;
  if (dragJustEnded) return; // block the synthetic click that follows a touch-drag
  handleSquareAction(sqEl.dataset.sq);
}

// ── TOUCH DRAG ────────────────────────────────────────────────────────────────
let dragging      = false;
let dragJustEnded = false;
let dragFrom      = null;
let dragGhost     = null;

function onTouchStart(e) {
  const sqEl = e.target.closest('[data-sq]');
  if (!sqEl) return;

  const sq = sqEl.dataset.sq;
  const piece = chess.get(sq);
  if (!piece || piece.color !== chess.turn()) {
    // Not draggable, let click handle it
    return;
  }

  e.preventDefault();

  dragging = true;
  dragFrom = sq;

  dragGhost = document.getElementById('drag-ghost');
  const ghostImg = dragGhost.querySelector('img');
  ghostImg.src = pieceUrl(piece.color, piece.type);
  ghostImg.onerror = () => { ghostImg.alt = UNICODE[piece.color + piece.type]; };

  const t = e.touches[0];
  dragGhost.style.left = t.clientX + 'px';
  dragGhost.style.top  = t.clientY + 'px';
  dragGhost.style.display = 'block';

  // Visual: dim the original square piece
  sqEl.querySelectorAll('.piece-img, .piece-unicode').forEach(p => {
    p.style.opacity = '0.35';
  });

  selectSquare(sq);
}

function onTouchMove(e) {
  if (!dragging) return;
  e.preventDefault();
  const t = e.touches[0];
  dragGhost.style.left = t.clientX + 'px';
  dragGhost.style.top  = t.clientY + 'px';
}

function onTouchEnd(e) {
  if (!dragging) return;
  e.preventDefault();

  dragGhost.style.display = 'none';

  // Restore opacity on the source square
  getSqEl(dragFrom)?.querySelectorAll('.piece-img, .piece-unicode').forEach(p => {
    p.style.opacity = '';
  });

  const t = e.changedTouches[0];

  // Find the element under the finger (ghost is hidden so it won't interfere)
  const el = document.elementFromPoint(t.clientX, t.clientY);
  const toEl = el?.closest('[data-sq]');
  const to = toEl?.dataset.sq;

  dragging      = false;
  dragJustEnded = true;
  setTimeout(() => { dragJustEnded = false; }, 350);

  if (to && to !== dragFrom) {
    const mv = legalMvs.find(m => m.to === to);
    if (mv) {
      if (mv.piece === 'p' && (to[1] === '8' || to[1] === '1')) {
        openPromotion(dragFrom, to);
        dragFrom = null;
        return;
      }
      doMove(dragFrom, to);
      dragFrom = null;
      return;
    }
  }

  // Not a valid drop — treat as tap on the square under finger
  clearSelect();
  if (to) handleSquareAction(to);
  dragFrom = null;
}

// ── ANALYSIS RENDERING ────────────────────────────────────────────────────────
function renderAnalysis() {
  const pv1 = pvData[1];
  if (!pv1) return;

  updateEvalBar(pv1);
  updateStats();
  renderPVLines();

  if (analyzing) {
    setStatus('analyzing', `Depth ${stats.depth}`);
  }
}

function cpToPct(cp) {
  // Map centipawns to 0–100% (white fill).
  // Uses sigmoid-like mapping: ±500cp → ~90%, capped at 95/5.
  const pawns = cp / 100;
  const pct = 50 + 46 * Math.tanh(pawns / 4);
  return Math.max(5, Math.min(95, pct));
}

function updateEvalBar(pv) {
  const fill = document.getElementById('eval-fill');
  const scoreEl = document.getElementById('eval-score');

  // Negate if black to move (engine reports from side-to-move perspective)
  const side = chess.turn() === 'b' ? -1 : 1;

  if (pv.scoreType === 'mate') {
    const m = pv.score * side;
    fill.style.width = (m > 0 ? 93 : 7) + '%';
    scoreEl.textContent = m > 0 ? `M${pv.score}` : `M${pv.score}`;
    scoreEl.className = 'mate';
  } else {
    const cp = pv.score * side;
    fill.style.width = cpToPct(cp) + '%';
    const disp = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
    scoreEl.textContent = disp;
    scoreEl.className = cp > 20 ? 'pos' : cp < -20 ? 'neg' : '';
  }
}

function updateStats() {
  document.getElementById('stat-depth').textContent    = stats.depth    || '—';
  document.getElementById('stat-seldepth').textContent = stats.seldepth || '—';
  document.getElementById('stat-nodes').textContent    = fmtNodes(stats.nodes);
  document.getElementById('stat-nps').textContent      = fmtNPS(stats.nps);
}

function renderPVLines() {
  const container = document.getElementById('pv-lines');
  container.innerHTML = '';

  const count = settings.multiPV;

  for (let i = 1; i <= count; i++) {
    const pv = pvData[i];
    if (!pv) continue;

    const side = chess.turn() === 'b' ? -1 : 1;

    const line = document.createElement('div');
    line.className = 'pv-line';

    // Score column
    const scoreEl = document.createElement('div');
    scoreEl.className = 'pv-score';
    if (pv.scoreType === 'mate') {
      const m = pv.score * side;
      scoreEl.textContent = `M${m > 0 ? pv.score : pv.score}`;
      scoreEl.classList.add('mate');
    } else {
      const cp = pv.score * side;
      scoreEl.textContent = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
      scoreEl.classList.add(cp > 20 ? 'pos' : cp < -20 ? 'neg' : 'eq');
    }
    line.appendChild(scoreEl);

    // PV moves in SAN
    const movesEl = document.createElement('div');
    movesEl.className = 'pv-moves';

    if (pv.pv) {
      const uciMoves = pv.pv.split(' ').slice(0, 14);
      const sanArr = uciToSAN(uciMoves, chess.fen());
      if (sanArr.length > 0) {
        const first = document.createElement('span');
        first.className = 'best';
        first.textContent = sanArr[0];
        movesEl.appendChild(first);
        if (sanArr.length > 1) {
          movesEl.append(' ' + sanArr.slice(1).join(' '));
        }
      }
    }

    line.appendChild(movesEl);
    container.appendChild(line);
  }
}

function uciToSAN(uciMoves, fen) {
  const tmp = new Chess(fen);
  const result = [];
  for (const uci of uciMoves) {
    try {
      const mv = tmp.move({
        from:      uci.substring(0, 2),
        to:        uci.substring(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (mv) result.push(mv.san);
      else break;
    } catch { break; }
  }
  return result;
}

// ── FORMATTING ────────────────────────────────────────────────────────────────
function fmtNodes(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}
function fmtNPS(n) {
  if (!n) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M/s';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K/s';
  return n + '/s';
}

// ── FEN / PGN ─────────────────────────────────────────────────────────────────
function loadFEN(fen) {
  if (!fen) return;
  try {
    const tmp = new Chess();
    tmp.load(fen); // throws on invalid FEN
    chess   = tmp;
    startFen = fen;
    lastMove = null;
    clearSelect();
    pvData = {};
    renderPieces();
    updateFenDisplay();
    if (analyzing) startAnalysis();
    toast('FEN loaded');
  } catch (e) {
    toast('Invalid FEN — ' + e.message);
  }
}

function loadPGN(pgn) {
  if (!pgn) return;
  try {
    const tmp = new Chess();
    tmp.loadPgn(pgn.trim());
    chess = tmp;
    // Check if PGN had a [FEN "..."] header (for custom starting positions)
    let headers = {};
    try { headers = chess.header() || {}; } catch {}
    startFen = headers.FEN || headers.Fen || null;
    // Rewind to get starting position for history
    const history = chess.history({ verbose: true });
    // We want to keep chess at the final position but know the start
    // history is correct since loadPgn replays from startFen (or startpos)

    lastMove = history.length > 0
      ? { from: history[history.length - 1].from, to: history[history.length - 1].to }
      : null;

    clearSelect();
    pvData = {};
    renderPieces();
    updateFenDisplay();
    if (analyzing) startAnalysis();
    toast(`PGN loaded — ${history.length} moves`);
  } catch (e) {
    toast('Invalid PGN — ' + e.message);
  }
}

function exportPGN() {
  return chess.pgn();
}

function updateFenDisplay() {
  const inp = document.getElementById('fen-input');
  if (inp) inp.value = chess.fen();
}

// ── SETTINGS UI ───────────────────────────────────────────────────────────────
function initSettingsUI() {
  const coi = window.crossOriginIsolated;
  const maxThreads = coi
    ? Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 16))
    : 1;

  // Show COI warning if not isolated
  if (!coi) {
    document.getElementById('coi-warn').classList.add('visible');
    settings.threads = 1;
  }

  // Threads
  const tSlider = document.getElementById('s-threads');
  const tVal    = document.getElementById('v-threads');
  tSlider.max   = maxThreads;
  tSlider.value = Math.min(settings.threads, maxThreads);
  tSlider.disabled = !coi;
  tVal.textContent  = coi ? tSlider.value : '1';
  tSlider.oninput = () => {
    settings.threads = +tSlider.value;
    tVal.textContent = settings.threads;
    saveSettings();
  };

  // Hash
  const hSlider = document.getElementById('s-hash');
  const hVal    = document.getElementById('v-hash');
  hSlider.value = settings.hash;
  hVal.textContent = settings.hash + 'MB';
  hSlider.oninput = () => {
    settings.hash = +hSlider.value;
    hVal.textContent = settings.hash + 'MB';
    saveSettings();
  };

  // MultiPV
  const mSlider = document.getElementById('s-multipv');
  const mVal    = document.getElementById('v-multipv');
  mSlider.value = settings.multiPV;
  mVal.textContent = settings.multiPV;
  mSlider.oninput = () => {
    settings.multiPV = +mSlider.value;
    mVal.textContent = settings.multiPV;
    saveSettings();
  };

  // Depth (0 = infinite)
  const dSlider = document.getElementById('s-depth');
  const dVal    = document.getElementById('v-depth');
  dSlider.value = settings.depth;
  dVal.textContent = settings.depth === 0 ? '∞' : settings.depth;
  dSlider.oninput = () => {
    settings.depth = +dSlider.value;
    dVal.textContent = settings.depth === 0 ? '∞' : settings.depth;
    saveSettings();
  };
}

// ── COLLAPSIBLE PANELS ────────────────────────────────────────────────────────
function initCollapsibles() {
  document.querySelectorAll('.coll-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('open');
      header.nextElementSibling.classList.toggle('open');
    });
  });
}

// ── GLOBAL EVENT WIRING ───────────────────────────────────────────────────────
function initEvents() {
  document.getElementById('btn-start').addEventListener('click', startAnalysis);
  document.getElementById('btn-stop').addEventListener('click', stopAnalysis);

  document.getElementById('btn-flip').addEventListener('click', () => {
    flipped = !flipped;
    buildBoard();
    if (analyzing) startAnalysis();
  });

  document.getElementById('btn-new').addEventListener('click', () => {
    if (analyzing) stopAnalysis();
    chess    = new Chess();
    startFen = null;
    lastMove = null;
    clearSelect();
    pvData = {};
    renderPieces();
    updateFenDisplay();
    document.getElementById('pv-lines').innerHTML = '';
    document.getElementById('eval-fill').style.width  = '50%';
    document.getElementById('eval-score').textContent = '—';
    document.getElementById('eval-score').className   = '';
    ['stat-depth','stat-seldepth','stat-nodes','stat-nps'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
  });

  // Promotion overlay close on backdrop click
  document.getElementById('promo-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('promo-overlay')) {
      document.getElementById('promo-overlay').classList.remove('open');
      pendingPromo = null;
      clearSelect();
    }
  });

  // FEN
  document.getElementById('btn-fen-load').addEventListener('click', () => {
    loadFEN(document.getElementById('fen-input').value.trim());
  });
  document.getElementById('btn-fen-copy').addEventListener('click', () => {
    const fen = chess.fen();
    navigator.clipboard?.writeText(fen)
      .then(() => toast('FEN copied'))
      .catch(() => { document.getElementById('fen-input').value = fen; toast('FEN in input'); });
  });

  // PGN
  document.getElementById('btn-pgn-load').addEventListener('click', () => {
    loadPGN(document.getElementById('pgn-input').value.trim());
  });
  document.getElementById('btn-pgn-export').addEventListener('click', () => {
    const pgn = exportPGN();
    document.getElementById('pgn-input').value = pgn;
    navigator.clipboard?.writeText(pgn)
      .then(() => toast('PGN copied'))
      .catch(() => toast('PGN in textarea'));
  });
}

// ── UI STATE ──────────────────────────────────────────────────────────────────
function setStatus(state, label) {
  document.getElementById('status-dot').className   = `status-dot ${state}`;
  document.getElementById('status-label').textContent = label;
}

function setControlsReady(ready) {
  document.getElementById('btn-start').disabled = !ready;
  document.getElementById('btn-stop').disabled  = true;
}

function updateButtons() {
  document.getElementById('btn-start').disabled = !engReady || analyzing;
  document.getElementById('btn-stop').disabled  = !analyzing;
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.add('visible');
}

function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────────
function init() {
  loadSettings();
  buildBoard();
  initSettingsUI();
  initCollapsibles();
  initEvents();
  updateFenDisplay();
  setControlsReady(false);

  initWorker();
}

document.addEventListener('DOMContentLoaded', init);
