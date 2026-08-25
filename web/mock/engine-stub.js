// THE ENGINE, stood in for — a Worker that speaks UCI and holds no chess at all.
//
// The real engine is 7.3 MB of WebAssembly the backend fetches on the user's press (see
// src/chess_engine.rs). A suite that downloaded it would be a suite nobody runs, and one that
// SHIPPED it would put 7.3 MB in the repository — so the E2E run serves this instead: a few hundred
// bytes that answer the same three commands the page sends.
//
// **IT ASKS THE MOCK FOR THE MOVE**, rather than pretending to know one. A stub that answered a
// fixed move would answer an ILLEGAL move in almost every position, and the board refuses one of
// those (it must — a ledger with an illegal ply in it is a game neither machine can replay), so the
// game would stall and the test would pass for the wrong reason. The mock already holds `chess.js`
// to play the human opponent; here it plays the engine too, which keeps ONE source of legal moves
// in the harness.
//
// **IT CAN ONLY EVER BE REACHED BY A TEST.** The page loads the engine from the path the BACKEND
// names, out of the directory `TEAMS_LITE_ENGINE_DIR` points at — and the real backend verifies
// every file it installs against a digest it pins, so this file cannot be installed by one. The
// suite writes it into a temporary directory of its own (see e2e/global-setup.ts) and points that
// variable at it; production reads the cache, where only verified bytes ever land.

const MOCK_ORIGIN = "__MOCK_ORIGIN__";

/** The position the page last set. `startpos` until it says otherwise. */
let fen = "";

self.onmessage = (event) => {
  const command = String(event.data ?? "");
  if (command === "uci") {
    // The four options the page's own setup writes to, so a `setoption` for any of them is answered
    // by something that said it had them.
    self.postMessage("id name Stockfish Stub");
    self.postMessage("option name Hash type spin default 16 min 1 max 33554432");
    self.postMessage("option name UCI_LimitStrength type check default false");
    self.postMessage("option name UCI_Elo type spin default 1320 min 1320 max 3190");
    self.postMessage("uciok");
    return;
  }
  if (command === "isready") {
    self.postMessage("readyok");
    return;
  }
  if (command.startsWith("position fen ")) {
    fen = command.slice("position fen ".length).trim();
    return;
  }
  if (command.startsWith("go")) {
    const url = `${MOCK_ORIGIN}/__test/engine-move?fen=${encodeURIComponent(fen)}`;
    fetch(url)
      .then((response) => response.text())
      .then((uci) => {
        // `(none)` is what a mated position answers, and the page reads it as "no move to play".
        self.postMessage(`bestmove ${uci.trim() || "(none)"}`);
      })
      .catch(() => self.postMessage("bestmove (none)"));
    return;
  }
  // `quit` and anything else: a stub has nothing to close.
};
