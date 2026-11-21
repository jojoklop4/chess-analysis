# Chess Analysis — Stockfish WASM PWA

Local Stockfish engine analysis in a mobile-first Progressive Web App.
No server. No files to download manually. Engine loads from CDN at runtime.

---

## How it works

The app loads Stockfish from the **jsDelivr CDN** directly inside a Web Worker.
No `.js` or `.wasm` files need to be in this repository. The worker tries
multiple CDN URLs in order (Stockfish 16 first, then older fallbacks) and uses
whichever loads successfully. The status bar shows which version is running.

---

## Deploy from Android — step by step

You need: a GitHub account, Chrome on Android, and a network connection.
No PC, no terminal, no npm, no file downloading.

---

### Step 1 — Download the app files from Claude

1. In the Claude conversation where you received these files, tap each
   **file card** to open it, then tap the **download icon** (↓).
2. The 7 files will appear in your phone's **Downloads** folder:
   - `index.html`
   - `app.js`
   - `style.css`
   - `engine.worker.js`
   - `coi-serviceworker.js`
   - `manifest.json`
   - `icon.svg`

---

### Step 2 — Create a GitHub repository

1. Open **https://github.com** in Chrome.
2. Tap **Sign in** if needed.
3. Tap the **+** icon (top right) → **New repository**.
4. Repository name: `chess-analysis` (or any name — it becomes your URL).
5. Set to **Public**.
6. Leave all checkboxes unchecked (no README, no .gitignore).
7. Tap **Create repository**.

---

### Step 3 — Upload the files

1. Inside your empty new repository, tap **Add file → Upload files**.
2. Tap **Choose your files**.
3. Navigate to your **Downloads** folder and select **all 7 files at once**
   (long-press one, then tap the others to multi-select, then tap Open).
4. Scroll down and tap **Commit changes**.

All 7 files should now appear in your repository.

---

### Step 4 — Enable GitHub Pages

1. Tap the **Settings** tab of your repository.
2. Scroll down to **Pages** in the left-hand sidebar.
3. Under **Source**, choose **Deploy from a branch**.
4. Branch: **main**, folder: **/ (root)**.
5. Tap **Save**.

Your app URL will be:
```
https://YOUR-GITHUB-USERNAME.github.io/chess-analysis/
```
GitHub Pages usually goes live within **1–2 minutes**.

---

### Step 5 — Open and install

1. Open the Pages URL in **Chrome on Android** (wait the 1–2 minutes first).
2. The page loads and the service worker registers — it will **reload once**
   automatically to activate cross-origin isolation (required for Stockfish
   multi-threading). This is normal.
3. After the reload, Stockfish begins loading from CDN. The status bar shows
   which version is loading. It may take 5–15 seconds on first visit.
4. Once the status shows **"Ready"**, tap **▶ Start** to begin analysis.

**Install as PWA (play full-screen, no browser bar):**
1. Tap Chrome's **⋮ menu → Add to Home screen**.
2. Tap **Add** in the dialog.
3. The chess icon appears on your home screen.
4. Launch from there — it opens full-screen like a native app.

**Offline use:** After the first successful load, all app files and the
Stockfish engine are cached. The app works offline on subsequent visits.

---

## Engine settings explained

| Setting | What it does |
|---|---|
| **Threads** | CPU cores used by Stockfish. Requires cross-origin isolation (see below). Mid-range Android: use 2–4. |
| **Hash (MB)** | Transposition table. 64–128 MB is fine. Don't exceed ~40% of device RAM. |
| **Lines (Multi-PV)** | How many candidate moves to show. 1 = strongest. 3+ shows alternatives but slows analysis. |
| **Max Depth** | 0 = infinite (run until Stop). Any number = stop at that ply. |

---

## Threads and cross-origin isolation

Multi-threading requires the page to be **cross-origin-isolated**
(`SharedArrayBuffer` must be available). The `coi-serviceworker.js` file
handles this automatically:

1. **First visit**: the service worker registers and the page reloads once.
2. **After reload**: COOP/COEP headers are injected → `crossOriginIsolated = true`.
3. **Threads slider becomes active** and Stockfish uses multiple cores.

If the yellow warning **"Not cross-origin-isolated — Threads locked to 1"**
stays visible after one reload, try force-refreshing (swipe down or pull-to-
refresh). The engine still works at 1 thread; it's just slower.

---

## What loads from CDN

| Resource | CDN |
|---|---|
| Stockfish engine JS | `cdn.jsdelivr.net` (npm package `stockfish`) |
| Stockfish WASM binary | `cdn.jsdelivr.net` (same package, same directory) |
| chess.js (move logic) | `cdn.jsdelivr.net` (npm package `chess.js`) |
| Piece images | `lichess1.org` (CBurnett SVG set) |

If piece images fail to load (network block or COEP issue), the app
automatically falls back to Unicode chess symbols. All other functionality
is unaffected.

---

## Honest limitations

| Feature | Status |
|---|---|
| Engine version | Shows in status bar — SF 16 if available, falls back to older |
| 3-fold repetition via history | The engine receives `position fen` only, not full game history. Engine analysis is correct from current position; prior-game repetition is not tracked. |
| iOS Safari | App installs and runs, but cross-origin isolation may not activate on iOS 15 and earlier, locking threads to 1. iOS 16+ works. |
| Offline on first visit | Requires a network connection to cache the engine. After that, fully offline. |

---

## Troubleshooting

**Status stuck at "Connecting to CDN…" / "Trying Stockfish 16…"**
→ The CDN fetch is blocked or slow. Check that you are on the
`https://USERNAME.github.io/...` URL (not a local file). Check mobile data or
Wi-Fi connection. Try reloading the page.

**Status shows "All Stockfish CDN sources failed"**
→ No CDN source could be reached. This is a network issue. The app requires
internet for the first load. After first load it is fully cached for offline
use.

**Analysis numbers don't update (depth stays at 0 or 1)**
→ Make sure you tapped **▶ Start**. If the engine shows Ready but analysis
doesn't run, tap Stop then Start again.

**Pieces not showing (empty squares)**
→ The piece images are loading from lichess CDN. If they're blocked, the app
falls back to Unicode symbols (♟ ♙ etc.). This is automatic — no action needed.
