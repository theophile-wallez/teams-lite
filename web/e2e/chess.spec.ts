import {
  test,
  expect,
  chessChallengeFromOpponent,
  openChessEngineRow,
  resetChessEngine,
  resetChessSounds,
  setChessEngine,
  setChessSounds,
  chessOpponentMoves,
  fetchCapturedEdits,
  openChessPage,
  seedChessGame,
  chessSquareHasPiece,
  closeConversationMenu,
  conversationMenuTrigger,
  dragChessPiece,
  drawChessArrow,
  fetchCapturedSends,
  rightClickChessSquare,
  gotoApp,
  openChessChallenge,
  openConversationMenu,
  openConversationNamed,
  playChessMove,
  resetChess,
  setChessOpponent,
  setSendControl,
  startChessGame,
} from "./helpers";
import type { Page } from "@playwright/test";

// A game of chess played IN a conversation.
//
// Teams has no private data channel, so every challenge, accept and move is an ordinary message
// in the thread — and the position is derived from those messages rather than stored anywhere
// (see web/src/lib/chess-thread.ts). That is what these tests are really about: the board on
// screen is a reading of the history, and the run of messages behind it collapses into ONE row.
//
// Everything happens in "Chess Club", a thread of its own. A game posts several messages and the
// board absorbs them, so played in a shared fixture it would move the rows every later spec
// counts on.
test.describe("chess in a conversation", () => {
  const board = '[data-testid="chess-game"]';
  const status = '[data-testid="chess-status"]';
  const scroller = '[data-testid="message-scroll"]';

  async function openChessThread(page: Page): Promise<void> {
    await gotoApp(page);
    await openConversationNamed(page, "Chess Club");
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Chess Club");
  }

  test.afterEach(async ({ page }) => {
    // One mock process serves the whole run: an opponent left silent or aimed at one move
    // would break every later game — and an ENGINE left present would let a later spec pass
    // without ever pressing the row that fetches one.
    await resetChess(page);
    await resetChessEngine(page);
    await setSendControl(page, { clear: true });
  });

  test("the header challenges, and the game arrives as ONE row the messages fold into", async ({
    page,
  }) => {
    await openChessThread(page);
    const before = Number(await page.locator(scroller).getAttribute("data-loaded-count"));

    await startChessGame(page, "w");

    // Two messages went out and came back — the challenge and the accept — so the history holds
    // more than it did...
    const after = Number(await page.locator(scroller).getAttribute("data-loaded-count"));
    expect(after).toBeGreaterThan(before);
    // ...and they are drawn as exactly ONE board, not as two messages plus a board.
    await expect(page.locator(board)).toHaveCount(1);
    // The words of a chess message are never drawn as an ordinary bubble.
    await expect(page.locator('[data-testid="message"]', { hasText: "via teams-lite" })).toHaveCount(
      0,
    );
  });

  test("BEING CHALLENGED offers an answer, and accepting starts the game", async ({ page }) => {
    // The other half of the feature, and the one the mock's own auto-accept used to hide: the
    // reader is challenged, so their side of the card owes an ANSWER rather than a move.
    await openChessThread(page);
    await chessChallengeFromOpponent(page, "w");
    await expect(page.locator(board)).toBeVisible();

    // It says who asked and which side they would take, and offers both answers.
    await expect(page.locator(status)).toContainText(/challenged you/i);
    await expect(page.locator(status)).toContainText("black");
    await expect(page.locator('[data-testid="chess-accept"]')).toBeVisible();
    await expect(page.locator('[data-testid="chess-decline"]')).toBeVisible();
    // The header says something is waiting for them, which is not the same as their move. It
    // is read off the TRIGGER, which is where the game's state moved when the header's three
    // controls became one menu — and that is the whole reason it is stated there: a signal
    // inside a closed menu says nothing, so a fact about a game a screen away has to be
    // readable without opening anything.
    const header = conversationMenuTrigger(page);
    await expect(header).toHaveAttribute("data-awaiting-answer", "true");
    await expect(header).not.toHaveAttribute("data-your-turn", "true");

    // Accepting starts the game — and the opponent took white, so they open.
    await page.locator('[data-testid="chess-accept"]').click();
    await expect(page.locator('[data-testid="chess-accept"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("1.");
    await expect(page.locator(status)).toContainText(/your move/i);
    // Still one row: the challenge, the accept and the first move all folded into the board.
    await expect(page.locator(board)).toHaveCount(1);
  });

  test("DECLINING a challenge ends it, and it stops asking for anything", async ({ page }) => {
    await openChessThread(page);
    await chessChallengeFromOpponent(page, "w");
    await page.locator('[data-testid="chess-decline"]').click();

    await expect(page.locator(status)).toContainText(/declined/i);
    // Nothing is waiting for the reader any more: no dot on the trigger, no chip in the strip.
    await expect(page.locator('[data-testid="chess-your-turn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-game-chip"]')).toHaveCount(0);
    // And the challenge is offered, as it always is now.
    await openChessChallenge(page);
    await closeConversationMenu(page);
  });

  test("WITHDRAWING our own unanswered challenge is not a loss", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await openChessChallenge(page);
    await page.locator('[data-testid="chess-color-w"]').click();
    await page.locator('[data-testid="chess-challenge"]').click();
    await expect(page.locator(board)).toBeVisible();
    await expect(page.locator(status)).toContainText(/waiting for somebody to accept/i);

    await page.locator('[data-testid="chess-withdraw"]').click();
    await expect(page.locator(status)).toContainText(/withdrew the challenge/i);
    // A game nobody played is not a game anybody lost.
    await expect(page.locator(status)).not.toContainText(/resigned/i);
    // And the next challenge may go out.
    await openChessChallenge(page);
    await closeConversationMenu(page);
  });

  test("the board is a reading of the messages: what leaves is the wire, not markup", async ({
    page,
  }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    const sends = await fetchCapturedSends(page);
    const challenge = sends.at(-1);
    // The challenge really carried the LEDGER line the other machine reads back: the game, the
    // version, a resolved colour — never the word "random", which would leave two clients
    // disagreeing about who moves first — and the clock the game is played with.
    expect(challenge?.content_html).toMatch(
      /<p><em>— chess [0-9a-f]{6} v2 w open tc\.600\+0, via teams-lite<\/em><\/p>$/,
    );
    // NO COLON anywhere in it: a colon is a custom emoji code span, and the backend's own
    // substitution would replace `:e4:` with an `<img>` and lose the game for both players.
    const line = /— chess [^<]*/.exec(challenge?.content_html ?? "")?.[0] ?? "";
    expect(line).not.toContain(":");
    // And the words above it, which is all a stock Teams client would show.
    expect(challenge?.content_html).toContain("I'm white");
  });

  test("a move is played by pressing the piece and then its square, and the opponent answers", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessOpponent(page, { reply: "e5" });
    await startChessGame(page, "w");
    await expect(page.locator(status)).toContainText("Your move");

    // Pressing the piece lights every legal square it can reach — the tap-tap a phone needs.
    await page.locator('[data-square="e2"]').click();
    // The highlight is this app's own overlay INSIDE the renderer's square (see
    // components/chess-board.tsx), so it is a descendant rather than the square itself.
    await expect(page.locator('[data-square="e4"] [data-target="true"]')).toBeVisible();
    await expect(page.locator('[data-square="e3"] [data-target="true"]')).toBeVisible();

    await page.locator('[data-square="e4"]').click();
    // The piece has moved, the score sheet says so, and the opponent's reply lands after it.
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("1. e4");
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("e5");
    expect(await chessSquareHasPiece(page, "e4")).toBe(true);
    expect(await chessSquareHasPiece(page, "e2")).toBe(false);
    // Still one row: the two moves folded into the board that was already there.
    await expect(page.locator(board)).toHaveCount(1);
  });

  test("an ILLEGAL press does nothing at all", async ({ page }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    await expect(page.locator(status)).toContainText("Your move");
    // A rook has nowhere to go from the opening position.
    await page.locator('[data-square="a1"]').click();
    await expect(page.locator('[data-square="a3"] [data-target="true"]')).toHaveCount(0);
    await page.locator('[data-square="a3"]').click();
    // Nothing was played and nothing was sent.
    await expect(page.locator('[data-testid="chess-moves"]')).toHaveCount(0);
    expect(await chessSquareHasPiece(page, "a1")).toBe(true);
  });

  test("a move that could not be sent is TAKEN BACK, and the board says so", async ({ page }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    // Silenced only AFTER the accept: the game needs an opponent before there is a move to
    // refuse, and an opponent silenced first would never accept at all.
    await setChessOpponent(page, { silent: true });
    await expect(page.locator(status)).toContainText("Your move");

    // The send is refused before anything is posted.
    await setSendControl(page, { error: "network unreachable" });
    await playChessMove(page, "d2", "d4");

    await expect(page.locator('[data-testid="chess-error"]')).toBeVisible();
    // The piece is back where it was: nothing left, so the board must not keep showing it.
    await expect(page.locator('[data-square="d2"] [data-piece]')).toBeVisible();
    expect(await chessSquareHasPiece(page, "d4")).toBe(false);
    await expect(page.locator('[data-testid="chess-moves"]')).toHaveCount(0);
  });

  test("resigning asks twice, and a settled game offers nothing to press", async ({ page }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    const resign = page.locator('[data-testid="chess-resign"]');

    await resign.click();
    // The armed press says what it costs before it lands.
    await expect(resign).toContainText(/nothing takes it back/i);

    await resign.click();
    await expect(page.locator(status)).toContainText(/resigned/i);
    await expect(page.locator('[data-testid="chess-resign"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-draw"]')).toHaveCount(0);
    // The board stays where it was — a finished game is still a row in the history.
    await expect(page.locator(board)).toHaveCount(1);
  });

  test("the header points at the live game and says when it is our move", async ({ page }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    // Silenced after the accept, so the turn stays ours long enough to read the dot.
    await setChessOpponent(page, { silent: true });

    // The TRIGGER, closed: which game is live and whether it wants a move are the two facts
    // the header owes a reader whose board is a screen away, so they are stated on the thing
    // that opens the menu rather than on a row inside it.
    const header = conversationMenuTrigger(page);
    await expect(header).toHaveAttribute("data-chess-game", /^[0-9a-f]{6}$/);
    // It is ours to move, and the board may be a screen away.
    await expect(page.locator('[data-testid="chess-your-turn"]')).toBeVisible();
    await expect(header).toHaveAttribute("data-your-turn", "true");

    // And the ROW inside says it in words and points at that game's own page. The CHALLENGE is
    // still offered beside it, because a conversation holds several games at once — the rule that
    // refused a second one is gone, and the row that used to replace the challenge is a list.
    const game = await header.getAttribute("data-chess-game");
    await openConversationMenu(page);
    const row = page.locator('[data-testid="chess-game-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-chess-game", game!);
    await expect(row).toContainText(/your move/i);
    await expect(page.locator('[data-testid="chess-button"]')).toContainText(/another game/i);
    await closeConversationMenu(page);

    // Once the move is out it is not our turn, and the dot goes.
    await setSendControl(page, { clear: true });
    await playChessMove(page, "e2", "e4");
    await expect(page.locator('[data-testid="chess-your-turn"]')).toHaveCount(0);
  });

  test("a resigned game leaves its board and stops wanting anything", async ({ page }) => {
    await openChessThread(page);
    await startChessGame(page, "w");
    const resign = page.locator('[data-testid="chess-resign"]');
    await resign.click();
    await resign.click();
    await expect(page.locator(status)).toContainText(/resigned/i);

    // The control offers a challenge again rather than pointing at the finished game.
    await openChessChallenge(page);
    await closeConversationMenu(page);
  });

  test("the marker a chess message carries is drawn NOWHERE", async ({ page }) => {
    // The wire rides in the body, so it is on screen unless something takes it off. The chat
    // list's own strip is a pure function with its own unit tests (`chessPreviewText`,
    // `previewLine`); what only a browser can say is that nothing anywhere renders the raw
    // line — not a bubble, not a preview, not a title.
    await openChessThread(page);
    await startChessGame(page, "w");
    await setChessOpponent(page, { silent: true });
    await playChessMove(page, "e2", "e4");
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("1. e4");

    const body = page.locator("body");
    await expect(body).not.toContainText("via teams-lite");
    await expect(body).not.toContainText("— chess");
    // And the game really is on screen, so the assertion above is not passing on an empty page.
    await expect(page.locator(board)).toHaveCount(1);
  });

  test("Notes offers no game, because there is nobody to play", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Notes");
    // OPENED, which is the whole of this assertion now: with the menu shut every row of it is
    // out of the DOM, so a bare count of zero would pass in a thread that offers the game as
    // happily as in the one that must not.
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="chess-button"]')).toHaveCount(0);
    // Absent rather than disabled — a row that cannot do the thing it names is worse than no
    // row — and the menu really is open, which is what stops the line above passing on nothing.
    await expect(page.locator('[data-testid="agent-mode-toggle"]')).toBeVisible();
    await closeConversationMenu(page);
  });

  test("the board fits a phone's column and does not widen the pane", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openChessThread(page);
    await startChessGame(page, "w");

    const card = page.locator(board);
    const pane = page.locator('[data-testid="message-pane"]');
    const cardBox = await card.boundingBox();
    const paneBox = await pane.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThanOrEqual(paneBox!.x - 1);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1);
    // A board is square, whatever width the column gave it.
    const squares = await page.locator('[data-testid="chess-board"]').boundingBox();
    expect(Math.abs(squares!.width - squares!.height)).toBeLessThanOrEqual(2);
  });

  // ---- the LEDGER: a move EDITS one message rather than posting another --------------
  test("a MOVE edits the same message, so a game of ten moves is two messages", async ({
    page,
  }) => {
    // The whole point of the ledger. Before it, a sixty-move game was sixty messages in the
    // conversation; now each player keeps ONE and rewrites it.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // A game with an opponent and no moves yet, ours to play: the ledger the reader's own
    // challenge left behind is the message the move has to rewrite.
    await seedChessGame(page, { mine: "w", moves: [] });
    await expect(page.locator(board)).toBeVisible();
    const before = Number(await page.locator(scroller).getAttribute("data-loaded-count"));

    await playChessMove(page, "e2", "e4");
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("1. e4");

    // The history did not grow: the move rewrote the challenge's own message.
    const after = Number(await page.locator(scroller).getAttribute("data-loaded-count"));
    expect(after).toBe(before);
    // And it really was an EDIT on the wire, carrying the ledger's rich body — not a send.
    const edits = await fetchCapturedEdits(page);
    const edit = edits.at(-1);
    expect(edit?.content_html).toMatch(/— chess [0-9a-f]{6} v2 w open tc\.600\+0 at\.\d+ 1\.e4/);
    expect(page.locator(board)).toHaveCount(1);
  });

  // ---- the CLOCKS -------------------------------------------------------------------
  test("both clocks are on screen, and the one that is running counts DOWN", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // A game already under way, ours to move, with a minute each: the clock is running the
    // moment the board is drawn.
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"], base: 60, clock: { w: 40_000, b: 55_000 } });
    await expect(page.locator(board)).toBeVisible();

    const ours = page.locator('[data-testid="chess-clock-w"]');
    const theirs = page.locator('[data-testid="chess-clock-b"]');
    await expect(ours).toBeVisible();
    await expect(theirs).toBeVisible();
    // OURS is the one on the clock, and it says so.
    await expect(ours).toHaveAttribute("data-running", "true");
    await expect(theirs).not.toHaveAttribute("data-running", "true");

    const first = await ours.textContent();
    const frozen = await theirs.textContent();
    await page.waitForTimeout(1_500);
    // It really moved — and the other one really did not.
    expect(await ours.textContent()).not.toBe(first);
    expect(await theirs.textContent()).toBe(frozen);
  });

  test("a clock that has RUN OUT is claimed, never taken", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // Their clock is gone and it is their move, so the win is the reader's to claim. Nothing
    // ends the game by itself: no machine's clock can be trusted over another's.
    // Three plies, so it is BLACK's move — and black has a move of their own, which is what lets
    // the wire state their clock at all: a ledger carries a clock per MOVE.
    await seedChessGame(page, {
      mine: "w",
      moves: ["e4", "e5", "Nf3"],
      base: 60,
      clock: { w: 30_000, b: 0 },
    });
    const claim = page.locator('[data-testid="chess-claim-flag"]');
    await expect(claim).toBeVisible();
    await expect(page.locator(status)).toContainText(/ran out of time/i);

    await claim.click();
    await expect(page.locator(status)).toContainText(/ran out of time/i);
    // The game is settled, so there is nothing left to press.
    await expect(page.locator('[data-testid="chess-claim-flag"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-resign"]')).toHaveCount(0);
  });

  // ---- the STRIP under the header ---------------------------------------------------
  test("the games running here float under the header, with their clocks", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    const first = await seedChessGame(page, { mine: "w", moves: ["e4", "e5"], base: 600 });
    const second = await seedChessGame(page, { mine: "b", moves: ["d4"], base: 600 });

    const chips = page.locator('[data-testid="chess-game-chip"]');
    await expect(chips).toHaveCount(2);
    // Most urgent first: the game waiting for the reader comes before the one waiting for
    // somebody else. In the second seed the reader is black with one ply played, so it is theirs.
    await expect(chips.first()).toHaveAttribute("data-chess-game", second);
    await expect(chips.first()).toHaveAttribute("data-wants-us", "true");
    await expect(chips.nth(1)).toHaveAttribute("data-chess-game", first);
    // Each chip carries BOTH clocks, which is the whole reason it is a chip rather than a dot.
    await expect(chips.first().locator('[data-testid="chess-chip-clock-ours"]')).toBeVisible();
    await expect(chips.first().locator('[data-testid="chess-chip-clock-theirs"]')).toBeVisible();

    // It FLOATS: the history keeps its own box, so nothing in the conversation moved.
    const strip = page.locator('[data-testid="chess-games-strip"]');
    const stripBox = await strip.boundingBox();
    const scrollBox = await page.locator(scroller).boundingBox();
    expect(stripBox!.y).toBeGreaterThanOrEqual(scrollBox!.y - 1);
    expect(stripBox!.y).toBeLessThan(scrollBox!.y + 40);
  });

  test("SEVERAL GAMES AT ONCE, each with its own board and its own row", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"] });
    await seedChessGame(page, { mine: "b", moves: ["d4"] });

    // Two boards in the history, one per game — the rule that refused a second game is gone.
    await expect(page.locator(board)).toHaveCount(2);
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="chess-game-row"]')).toHaveCount(2);
    // And the challenge is still there, so a third can start.
    await expect(page.locator('[data-testid="chess-button"]')).toContainText(/another game/i);
    await closeConversationMenu(page);
  });

  // ---- the PAGE ---------------------------------------------------------------------
  test("the board has a PAGE of its own: the score sheet, the chat, and one composer", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    const game = await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3", "Nc6"] });
    await openChessPage(page);

    // The URL is the surface: it survives a reload and can be sent to whoever you are playing.
    expect(page.url()).toContain(`/chess/${game}`);
    // The score sheet is a column of pairs, and every ply is a press.
    await expect(page.locator('[data-testid="chess-score-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="chess-ply-4"]')).toBeVisible();
    // The conversation is beside it, with the app's ONE composer in it.
    await expect(page.locator('[data-testid="chess-page-chat"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveCount(1);
    // The sidebar and the message pane are gone: this is a page, not a panel.
    await expect(page.locator('[data-testid="message-pane"]')).toHaveCount(0);

    // Back leaves the board for the conversation, never for the chat list.
    await page.locator('[data-testid="chess-page-back"]').click();
    await expect(page.locator('[data-testid="message-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Chess Club");
  });

  test("THE BOARD COLUMN DOES NOT SCROLL: the board gives way instead", async ({ page }) => {
    // The whole page is a screen the reader plays on, so the column holding the board must not
    // carry a scrollbar — it moves the squares under the pointer, and a board somebody has to
    // scroll to see is not a board. The board is sized to the room the seats, the four controls
    // and the sentence leave it (`useBoardFit`), so it is the board that gives way.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3", "Nc6"] });
    await openChessPage(page);

    const column = page.locator('[data-testid="chess-board-column"]');
    const overflow = async () =>
      column.evaluate((el) => el.scrollHeight - el.clientHeight);
    // It is MEASURED after the fit has settled: the first paint carries the CSS estimate and the
    // measurement corrects it, which is one frame the reader never sees.
    await expect.poll(overflow).toBeLessThanOrEqual(0);

    // And the board is still a board: square, and inside the column that holds it.
    const squares = (await page.locator('[data-testid="chess-board"]').boundingBox())!;
    const columnBox = (await column.boundingBox())!;
    expect(Math.abs(squares.width - squares.height)).toBeLessThanOrEqual(2);
    expect(squares.height).toBeLessThanOrEqual(columnBox.height + 1);
    expect(squares.width).toBeLessThanOrEqual(columnBox.width + 1);
    // The seats line up with the board's own edges rather than with the column's, which is what
    // the measured width is for: a clock floating a hand's width right of the board reads as a
    // layout nobody finished.
    const seat = (await page.locator('[data-testid="chess-clock-w"]').boundingBox())!;
    expect(seat.x + seat.width).toBeLessThanOrEqual(squares.x + squares.width + 2);

    // A window this page is really read in stays scroll-free too — including the short one that
    // leaves the board less room than the column is wide.
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1024, height: 620 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(overflow).toBeLessThanOrEqual(0);
    }
  });

  test("the board column holds the BOARD AND TWO SEATS and nothing else, and the board fills it", async ({
    page,
  }) => {
    // THE BOARD IS AS BIG AS THE COLUMN CAN HOLD, and that is what moving every other line into the
    // sidebar bought: the four move controls, the sentence, the score, the rematch and the two
    // answers a challenge takes each used to stand under the board, and the board is sized to
    // whatever they left it (`useBoardFit`). So the column's own height is the two seats plus the
    // board, and nothing between them.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, {
      mine: "w",
      moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6", "dxc6"],
      ending: "theyResigned",
    });
    await openChessPage(page);
    const column = page.locator('[data-testid="chess-board-column"]');

    // Every one of them is on the page, in the SIDEBAR's own block rather than under the board.
    const controls = page.locator('[data-testid="chess-page-controls"]');
    for (const id of ["chess-move-nav", "chess-page-status", "chess-series", "chess-rematch"]) {
      await expect(controls.locator(`[data-testid="${id}"]`)).toBeVisible();
      await expect(column.locator(`[data-testid="${id}"]`)).toHaveCount(0);
    }

    // And what is left over is the board: the column's height is the board plus the two seats,
    // within the padding it draws them in.
    const squares = (await page.locator('[data-testid="chess-board"]').boundingBox())!;
    const seats = page.locator('[data-testid="chess-board-column"] header');
    await expect(seats).toHaveCount(2);
    const heights = await seats.evaluateAll((els) =>
      els.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0),
    );
    const columnBox = (await column.boundingBox())!;
    // 24px of padding, and a hair for the gaps: anything more is a line nobody asked for.
    expect(columnBox.height - (squares.height + heights)).toBeLessThanOrEqual(32);

    // A SEAT IS ONE ROW, so the haul sits at the same vertical level as the name and the clock
    // rather than on a line of its own under them — which is where two of those lines came from.
    const haul = (await page.locator('[data-testid="chess-captured-w"]').boundingBox())!;
    const clock = (await page.locator('[data-testid="chess-clock-w"]').boundingBox())!;
    const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(centre(haul) - centre(clock))).toBeLessThanOrEqual(4);
  });

  test("the reader can WALK BACK through the game, and the board says it is not live", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3", "Nc6"] });
    await openChessPage(page);

    // Four plies in: the knight is out.
    await expect.poll(async () => chessSquareHasPiece(page, "f3")).toBe(true);
    await page.locator('[data-testid="chess-nav-prev"]').click();
    await page.locator('[data-testid="chess-nav-prev"]').click();
    // Two moves back, so the knight is home again and the page says the board is not live. The
    // reads POLL because the renderer animates a position change: a piece is still in the DOM at
    // its old square for a frame or two, which is a fact about the animation and not about the
    // board's state.
    await expect(page.locator('[data-testid="chess-page-status"]')).toContainText(/not live/i);
    await expect.poll(async () => chessSquareHasPiece(page, "f3")).toBe(false);
    await expect.poll(async () => chessSquareHasPiece(page, "g1")).toBe(true);
    // A press on a ply in the score sheet goes there…
    await page.locator('[data-testid="chess-ply-1"]').click();
    await expect(page.locator('[data-testid="chess-ply-1"]')).toHaveAttribute("data-current", "true");
    // …and the way back to the live position is one press.
    await page.locator('[data-testid="chess-nav-live"]').click();
    await expect.poll(async () => chessSquareHasPiece(page, "f3")).toBe(true);
    await expect(page.locator('[data-testid="chess-page-status"]')).not.toContainText(/not live/i);
  });

  test("a PREMOVE is queued while they think, and plays itself when they move", async ({ page }) => {
    await openChessThread(page);
    // A game where it is THEIR move, so anything the reader plays is a premove.
    await setChessOpponent(page, { silent: true });
    const game = await seedChessGame(page, { mine: "w", moves: ["e4"] });
    await openChessPage(page);
    await expect(page.locator('[data-testid="chess-page-status"]')).toContainText(/waiting/i);

    // Queue g1-f3. Nothing is posted: a premove is a private intention.
    const before = (await fetchCapturedEdits(page)).length;
    await playChessMove(page, "g1", "f3");
    await expect(page.locator('[data-square="f3"] [data-premove="true"]')).toBeVisible();
    await expect(page.locator('[data-square="g1"] [data-premove="true"]')).toBeVisible();
    expect((await fetchCapturedEdits(page)).length).toBe(before);

    // Their move lands, and the premove goes out by itself.
    await chessOpponentMoves(page, game);
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("Nf3");
    await expect(page.locator('[data-premove="true"]')).toHaveCount(0);
  });

  test("a PREMOVE is set by DRAGGING, and a right press anywhere takes it back", async ({ page }) => {
    // THE GESTURE A DESKTOP PLAYS WITH, and the one a premove was unreachable by: the board named
    // the side to MOVE as the side that may be picked up, so the renderer disabled all 32 pieces
    // on the one turn a premove is made in — a whole half of the feature, dead, with the tap-tap
    // specs passing either side of it.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4"] });
    await openChessPage(page);
    await expect(page.locator('[data-testid="chess-page-status"]')).toContainText(/waiting/i);

    const before = (await fetchCapturedEdits(page)).length;
    await dragChessPiece(page, "g1", "f3");
    // BOTH squares are tinted, in the premove's own colour: where the piece is going, and where it
    // is coming from — which is what says which piece is committed. IT IS THE WHOLE OF WHAT IS
    // DRAWN: the three sentences that used to stand under the board explained a gesture the reader
    // had just made, and they took room the board itself needs (see `useBoardFit`).
    await expect(page.locator('[data-square="f3"] [data-premove="true"]')).toBeVisible();
    await expect(page.locator('[data-square="g1"] [data-premove="true"]')).toBeVisible();
    await expect(page.locator('[data-testid="chess-page"]')).not.toContainText(/premove/i);
    // Still a private intention: nothing has left for the thread.
    expect((await fetchCapturedEdits(page)).length).toBe(before);

    // A right DRAG draws an arrow and is NOT a cancel. This is the rail that made the board keep
    // the renderer's own square handler: only it knows an arrow was being drawn.
    await drawChessArrow(page, "d2", "d4");
    await expect(page.locator('[data-square="f3"] [data-premove="true"]')).toBeVisible();

    // A right PRESS takes it back — and on a square that has nothing to do with the premove,
    // because what it cancels is not about a square.
    await rightClickChessSquare(page, "h6");
    await expect(page.locator('[data-premove="true"]')).toHaveCount(0);
  });

  test("a PREMOVE may be a move the rules refuse, and THEIR move is what makes it legal", async ({
    page,
  }) => {
    // The whole point of a premove, and the case the old rule could not express: after 1. e4 e5
    // 2. Nf3 the e4 pawn has NO legal move at all — e5 is blocked by their own pawn and both
    // diagonals are empty — so exd5, the commonest premove in chess, could not be set. It is
    // offered wherever the piece could go once they have moved (web/src/lib/chess-premove.ts).
    await openChessThread(page);
    await setChessOpponent(page, { silent: true, reply: "d5" });
    const game = await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3"] });
    await openChessPage(page);

    // The pawn's own dots say so before the press: d5 is offered while nothing stands on it.
    await page.locator('[data-square="e4"]').click();
    await expect(page.locator('[data-square="d5"] [data-target="true"]')).toBeVisible();
    await page.locator('[data-square="d5"]').click();
    await expect(page.locator('[data-square="d5"] [data-premove="true"]')).toBeVisible();

    // Their pawn arrives on d5, and the premove that was illegal a moment ago is the capture.
    await chessOpponentMoves(page, game);
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("exd5");
    await expect(page.locator('[data-premove="true"]')).toHaveCount(0);
  });

  test("a PREMOVE the arriving position makes illegal is DROPPED, never posted", async ({ page }) => {
    // The other half of being permissive, and what makes it safe: the real rules are asked about
    // the real position before anything leaves, so a premove that never became legal costs the
    // reader their tempo and can never put an illegal ply in the ledger — which would be a game
    // neither machine could replay.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true, reply: "Nc6" });
    const game = await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3"] });
    await openChessPage(page);

    await playChessMove(page, "e4", "d5");
    await expect(page.locator('[data-square="d5"] [data-premove="true"]')).toBeVisible();

    // They develop the knight instead, so nothing is on d5 and the queued capture is dropped.
    await chessOpponentMoves(page, game);
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("Nc6");
    await expect(page.locator('[data-premove="true"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-moves"]')).not.toContainText("d5");
    // And it is the reader's move, with the board waiting for them rather than stuck.
    await expect(page.locator('[data-testid="chess-page-status"]')).toContainText(/your move/i);
  });

  test("each SEAT says what it has taken, and how far up or down it leaves them", async ({
    page,
  }) => {
    // Both hauls and both numbers on one board, which is the whole feature: a player reads the
    // position and then reads these two things. 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6
    // 5. Nxe5 — white has a knight and a pawn, black has a bishop, so white is one point up.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, {
      mine: "w",
      moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6", "dxc6", "Nxe5"],
    });
    await openChessPage(page);

    const white = page.locator('[data-testid="chess-captured-w"]');
    const black = page.locator('[data-testid="chess-captured-b"]');
    // The DELTA is signed from each side's own point of view, because a player reading their own
    // seat on a phone reads one of them and never both.
    await expect(white).toHaveAttribute("data-delta", "1");
    await expect(black).toHaveAttribute("data-delta", "-1");
    // The words, because a row of glyphs says nothing to a screen reader — and they name what was
    // really taken rather than a count of pieces.
    await expect(white).toHaveAttribute("aria-label", /1 knight and 1 pawn/i);
    await expect(black).toHaveAttribute("aria-label", /1 bishop/i);

    // WALKING BACK walks the material back with it: at the start of the game nobody has taken
    // anything, so neither line is drawn at all.
    await page.locator('[data-testid="chess-nav-first"]').click();
    await expect(white).toHaveCount(0);
    await expect(black).toHaveCount(0);
    await page.locator('[data-testid="chess-nav-live"]').click();
    await expect(white).toHaveAttribute("data-delta", "1");
  });

  test("a finished game offers a REMATCH: the same clock, the colours the other way round", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // A game we played as white and lost. The rematch takes BLACK — a series played from one side
    // is not a series.
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"], base: 300, ending: "weResigned" });
    await openChessPage(page);

    const rematch = page.locator('[data-testid="chess-rematch"]');
    await expect(rematch).toHaveAttribute("data-rematch-color", "b");
    await expect(rematch).toContainText(/you take black/i);
    // The clock the last game was played with, carried: a rematch at another time control is a
    // different game, and re-picking one is what the menu is for.
    await expect(rematch).toContainText("5 min");

    // The press is an ordinary CHALLENGE — a SEND, not an edit of the game that just ended.
    const before = (await fetchCapturedSends(page)).length;
    await rematch.click();
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBe(before + 1);
    const sent = (await fetchCapturedSends(page)).at(-1);
    expect(sent?.content_html).toContain("open");
    // A NEW game, and the reader is black in it.
    expect(sent?.content_html).toMatch(/— chess [0-9a-f]{6} v2 b open tc\.300\+0/);
    // And it goes quiet once it has left, because pressing again would open a second game.
    await expect(rematch).toBeDisabled();

    // THE PAGE FOLLOWS IT. A reader who pressed "play again" on a full-screen board asked for the
    // next board, not for a trip back through the conversation to find it — so this stays a page,
    // and it is the NEW game's page: the address changes and the board is at move nought.
    const next = /— chess ([0-9a-f]{6}) v2/.exec(sent?.content_html ?? "")?.[1];
    expect(next).toBeTruthy();
    await expect(page.locator('[data-testid="chess-page"]')).toBeVisible();
    await expect.poll(() => page.url()).toContain(`/chess/${next}`);
    // The board it landed on is the fresh one: nothing taken, and no rematch of its own to offer.
    await expect(page.locator('[data-testid="chess-rematch"]')).toHaveCount(0);
  });

  test("a game still going, and one the reader watched, offer NO rematch", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // Mid-game: a rematch here is a second board nobody asked for, and the menu already offers a
    // fresh challenge.
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"] });
    await openChessPage(page);
    await expect(page.locator('[data-testid="chess-rematch"]')).toHaveCount(0);
  });

  test("the SERIES counts every game in the thread, with a draw as a half", async ({ page }) => {
    // THE SCORE IS OVER THE WHOLE STORED HISTORY rather than over the loaded page, which is what
    // the backend's own read is for (`chess_messages`). Three finished games — one each and a draw
    // — so the score has to read a half, and a fourth the page is opened on.
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"], ending: "theyResigned" });
    await seedChessGame(page, { mine: "b", moves: ["d4", "d5"], ending: "weResigned" });
    await seedChessGame(page, { mine: "w", moves: ["c4", "c5"], ending: "draw" });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5", "Nf3"], ending: "theyResigned" });
    // The NEWEST board, which is the one at the foot of the history: the pane is virtualized, so
    // the first of four games may not be in the DOM at all.
    await page.locator('[data-testid="chess-open-page"]').last().click();
    await page.locator('[data-testid="chess-page"]').waitFor();
    await page.locator('[data-testid="chess-board"]').first().waitFor();

    const series = page.locator('[data-testid="chess-series"]');
    // Two wins, one loss and a draw: 2½–1½ to the reader over four games.
    await expect(series).toHaveAttribute("data-series-played", "4");
    await expect(series).toContainText("You lead 2½–1½ after 4 games");

    // AND ON THE CARD, where a finished game is met first — the same hook, so the two surfaces
    // cannot disagree about a score.
    await page.locator('[data-testid="chess-page-back"]').click();
    await page.locator('[data-testid="message-pane"]').waitFor();
    const card = page.locator('[data-testid="chess-game"]').last();
    await expect(card.locator('[data-testid="chess-series"]')).toContainText("You lead 2½–1½");
  });

  test("a game against the COMPUTER keeps no series: a machine scores with nobody", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-engine-color-w"]').click();
    await page.locator('[data-testid="chess-engine-play"]').click();
    await page.locator('[data-testid="chess-engine-seat"]').last().waitFor();
    await openChessPage(page);
    await expect(page.locator('[data-testid="chess-series"]')).toHaveCount(0);
  });

  test("a PROMOTION asks which piece, over the board, with real pieces", async ({ page }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // A pawn one square from the eighth rank, and the reader to move it.
    await seedChessGame(page, {
      mine: "w",
      moves: ["e4", "d5", "exd5", "c6", "dxc6", "Qd6", "cxb7", "Qc6"],
    });
    await openChessPage(page);

    await playChessMove(page, "b7", "a8");
    const picker = page.locator('[data-testid="chess-promotion"]');
    await expect(picker).toBeVisible();
    // Four pieces, and each one is drawn as a piece rather than as its name.
    await expect(picker.locator("svg")).not.toHaveCount(0);
    await page.locator('[data-testid="chess-promote-n"]').click();
    await expect(page.locator('[data-testid="chess-moves"]')).toContainText("=N");
  });

  test("an ARROW is drawn by a right-drag on the page, and never in the conversation", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"] });

    // The card in the history draws none: a right-drag there would take the browser's own menu
    // away from a message thread.
    await expect(page.locator('[data-testid="chess-board"][data-scrollable="true"]')).toBeVisible();

    await openChessPage(page);
    const from = await page.locator('[data-square="d2"]').boundingBox();
    const to = await page.locator('[data-square="d4"]').boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
    await page.mouse.up({ button: "right" });
    // The renderer draws it into its own overlay; what this pins is that one exists at all.
    await expect(page.locator('[data-testid="chess-page"] svg[data-testid="arrows"], [data-testid="chess-page"] line, [data-testid="chess-page"] marker')).not.toHaveCount(0);
  });

  test("the board in the history does not eat the conversation's SCROLL", async ({ page }) => {
    // The reported bug: `react-chessboard` writes `touch-action: none` on every piece, so a
    // finger landing on any of the 32 of them could not scroll the thread — which on a phone is
    // most of the width of the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await openChessThread(page);
    await setChessOpponent(page, { silent: true });
    // TWO boards, so the history is really taller than the screen: a thread that overflows
    // nothing cannot prove anything about scrolling it.
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"] });
    await seedChessGame(page, { mine: "b", moves: ["d4"] });
    await expect(page.locator(board)).toHaveCount(2);
    await expect
      .poll(async () =>
        page.locator(scroller).evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeGreaterThan(100);

    // The board says it gives the scroll away…
    const pieces = page.locator('[data-testid="chess-board"][data-scrollable="true"] [data-piece]');
    await expect(pieces.first()).toBeVisible();
    // …and the browser really computes `pan-y` on a piece, which is what lets a touch scroll.
    const action = await pieces.first().evaluate((el) => getComputedStyle(el).touchAction);
    expect(action).toBe("manipulation");

    // And a WHEEL over the board scrolls the history rather than being swallowed. It is measured
    // DOWNWARD from the top: this history is stuck to its bottom, so wheeling up in a thread with
    // barely a screenful of overflow is a scroll the pane legitimately takes back — which would
    // fail this assertion for a reason that is nothing to do with the board.
    await page.locator(scroller).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(async () => page.locator(scroller).evaluate((el) => el.scrollTop)).toBe(0);
    const box = await page.locator('[data-testid="chess-board"]').first().boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(async () => page.locator(scroller).evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });

  // ---- playing the COMPUTER ---------------------------------------------------------
  //
  // The engine is not in this app: it is 7.3 MB the backend fetches on the reader's own press, and
  // these tests are about that chain — the row that offers it, the strength they pick, and a game
  // that really advances because the computer moved.
  test("the computer is offered only once its engine is HERE, and the row says what it costs", async ({
    page,
  }) => {
    await openChessThread(page);
    await openChessEngineRow(page);

    // ABSENT is the state a fresh machine is in, and the row states the size before the press: it is
    // the one fact the reader decides with.
    const fetchRow = page.locator('[data-testid="chess-engine-download"]');
    await expect(fetchRow).toBeVisible();
    await expect(page.locator('[data-testid="chess-engine-row"]')).toContainText("7.3 MB");
    // No strength picker and no game while there is no engine: an offer drawn on a hopeful answer
    // would start a game whose first move nothing could make.
    await expect(page.locator('[data-testid="chess-engine-play"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chess-elo-1800"]')).toHaveCount(0);

    // The press fetches it, and the row counts while it runs.
    await fetchRow.click();
    await expect(page.locator('[data-testid="chess-engine-row"]')).toContainText(/%|on this machine/);
    await expect(page.locator('[data-testid="chess-engine-play"]')).toBeVisible({ timeout: 10_000 });
    // And now the strengths are offered — the engine's own scale, whose floor is 1320.
    await expect(page.locator('[data-testid="chess-elo-1320"]')).toBeVisible();
    await expect(page.locator('[data-testid="chess-elo-3190"]')).toBeVisible();
    await closeConversationMenu(page);
  });

  test("a fetch that FAILS says so where the press was made", async ({ page }) => {
    await openChessThread(page);
    await setChessEngine(page, { error: "the release could not be reached" });
    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-engine-download"]').click();

    await expect(page.locator('[data-testid="chess-engine-error"]')).toContainText(
      /could not be reached/i,
    );
    // Nothing pretends it worked: the game is still not offered.
    await expect(page.locator('[data-testid="chess-engine-play"]')).toHaveCount(0);
    await closeConversationMenu(page);
  });

  test("a game against the computer is ONE message, and the computer really moves", async ({
    page,
  }) => {
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    await setChessOpponent(page, { silent: true });
    const before = Number(await page.locator(scroller).getAttribute("data-loaded-count"));

    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-elo-1320"]').click();
    // WHITE, said out loud: the picker opens on Random, so a test that took the default would be a
    // test that asserts "your move" half the time.
    await page.locator('[data-testid="chess-engine-color-w"]').click();
    await page.locator('[data-testid="chess-engine-play"]').click();

    // The board arrives, playable at once: there is nobody to accept a game against a machine.
    const engineBoard = page.locator('[data-testid="chess-game"]').last();
    await expect(engineBoard).toBeVisible();
    await expect(engineBoard.locator('[data-testid="chess-engine-seat"]')).toBeVisible();
    // ONE message in the thread — the reader's own ledger, carrying both sides.
    const after = Number(await page.locator(scroller).getAttribute("data-loaded-count"));
    expect(after).toBe(before + 1);

    // The reader moves, and the computer answers — by editing that same message.
    await expect(engineBoard.locator(status)).toContainText(/your move/i);
    await playChessMove(page, "e2", "e4");
    await expect(engineBoard.locator('[data-testid="chess-moves"]')).toContainText("1. e4");
    // The engine's own move lands in the SAME message: the history does not grow.
    await expect
      .poll(async () => (await engineBoard.locator('[data-testid="chess-moves"]').textContent()) ?? "")
      .toMatch(/1\. e4 \S+/);
    expect(Number(await page.locator(scroller).getAttribute("data-loaded-count"))).toBe(before + 1);
    await expect(engineBoard.locator(status)).toContainText(/your move/i);

    // The wire says who the opponent is, and it never says it with a colon. NO `tc.` token, because
    // an engine game carries NO CLOCK unless the reader asked for one: a time control is an
    // agreement between two people about how long each may think, and an engine's own clock is
    // stated rather than counted down — so a countdown inherited from the human default was one the
    // reader could only ever lose on.
    const sends = await fetchCapturedSends(page);
    const opened = sends.at(-1);
    expect(opened?.content_html).toMatch(/— chess [0-9a-f]{6} v2 [wb] open sf\.1320,/);
    expect(opened?.content_html).not.toContain("tc.");
    expect(opened?.content_html).toContain("I'm playing Stockfish 1320");
    // And no clock is drawn on either seat, rather than a dash nobody can act on.
    await expect(engineBoard.locator('[data-testid="chess-clock-w"]')).toHaveCount(0);
    await expect(engineBoard.locator('[data-testid="chess-clock-b"]')).toHaveCount(0);
  });

  test("a clock against the computer is OFFERED, and the pick is its own", async ({ page }) => {
    // The refusal above is a DEFAULT rather than a limit: a reader who wants to practise blitz
    // against a machine is asking for exactly the clock it declines to assume. The engine's row has
    // a picker of its own, so choosing one there can never move the human challenge's own.
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    await setChessOpponent(page, { silent: true });

    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-engine-color-w"]').click();
    await page.locator('[data-testid="chess-engine-time-300-0"]').click();
    await page.locator('[data-testid="chess-engine-play"]').click();

    const engineBoard = page.locator('[data-testid="chess-game"]').last();
    await expect(engineBoard.locator('[data-testid="chess-clock-w"]')).toBeVisible();
    const sends = await fetchCapturedSends(page);
    expect(sends.at(-1)?.content_html).toContain("tc.300+0");
  });

  test("the computer OPENS the game when it has white, with nobody having moved", async ({
    page,
  }) => {
    // The other half of every engine game, and the half no assertion covered: with the reader as
    // BLACK the first ply is the machine's, so the board has to play it with nothing pressed. It is
    // also the case a fixed pause hid in a capture — the first move costs a worker boot, a UCI
    // handshake and a search before the message is edited.
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    await setChessOpponent(page, { silent: true });

    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-engine-color-b"]').click();
    // A clock is asked for here, because the clocks are what this test is about — an engine game
    // carries none by default.
    await page.locator('[data-testid="chess-engine-time-600-0"]').click();
    await page.locator('[data-testid="chess-engine-play"]').click();
    const engineBoard = page.locator('[data-testid="chess-game"]').last();
    await expect(engineBoard.locator('[data-testid="chess-engine-seat"]')).toBeVisible();

    // Nothing was pressed on the board, and the game is one ply in.
    await expect(engineBoard.locator('[data-testid="chess-moves"]')).toContainText(/1\. \S+/);
    await expect(engineBoard.locator(status)).toContainText(/your move/i);
    // The reader's own clock is the one running now — and the engine's is barely touched, because
    // its move costs what the SEARCH cost rather than the seconds the reader sat there.
    await expect(engineBoard.locator('[data-testid="chess-clock-b"]')).toHaveAttribute(
      "data-running",
      "true",
    );
    await expect(engineBoard.locator('[data-testid="chess-clock-w"]')).not.toHaveAttribute(
      "data-running",
      "true",
    );
  });

  test("on a PHONE the press that starts the game is on screen, not below the fold", async ({
    page,
  }) => {
    // The engine's disclosure is FIVE rows tall — a sentence, seven strengths, three sides, nine
    // clocks and the press — and this menu lists every running game above it, so on a 390px screen
    // the one row the reader came for opens off the bottom. It brings itself into view — the rule
    // the merge-request page holds for its own actions.
    await page.setViewportSize({ width: 390, height: 844 });
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    // Two games running, which is what pushes the block down — and the state a real thread is in.
    await seedChessGame(page, { mine: "w", moves: ["e4", "e5"] });
    await seedChessGame(page, { mine: "b", moves: ["d4"] });

    const play = page.locator('[data-testid="chess-engine-play"]');
    const onScreen = async () => {
      await expect(play).toBeVisible();
      const box = await play.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    };

    await openChessEngineRow(page);
    await onScreen();
    await closeConversationMenu(page);

    // AND AGAIN ON THE NEXT OPEN. The disclosure is FOLDED when the menu closes, exactly as the
    // human challenge's own form is: left standing it re-opened scrolled to the top with the press
    // off the bottom, because nothing about it had changed for the scroll to react to.
    await expect(play).toHaveCount(0);
    await openChessEngineRow(page);
    await onScreen();
    await closeConversationMenu(page);
  });

  test("a machine is asked for no DRAW and claims no FLAG", async ({ page }) => {
    await openChessThread(page);
    await setChessEngine(page, { present: true });
    await setChessOpponent(page, { silent: true });
    await openChessEngineRow(page);
    await page.locator('[data-testid="chess-engine-color-w"]').click();
    await page.locator('[data-testid="chess-engine-play"]').click();
    const engineBoard = page.locator('[data-testid="chess-game"]').last();
    await expect(engineBoard).toBeVisible();

    // There is nobody to offer a draw to, and an engine's clock is never drained by the wall — so
    // neither control is drawn. Resigning is still the reader's own act.
    await expect(engineBoard.locator('[data-testid="chess-draw"]')).toHaveCount(0);
    await expect(engineBoard.locator('[data-testid="chess-claim-flag"]')).toHaveCount(0);
    await expect(engineBoard.locator('[data-testid="chess-resign"]')).toBeVisible();
  });

  test("NOTES offers the computer, and only the computer", async ({ page }) => {
    // The one place a human game is refused because there is nobody to play — and the computer is
    // somebody, so the chat with oneself is exactly where a solo game belongs.
    await gotoApp(page);
    await setChessEngine(page, { present: true });
    await openConversationNamed(page, "Notes");
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="chess-engine-row"]')).toBeVisible();
    await expect(page.locator('[data-testid="chess-button"]')).toHaveCount(0);
    await closeConversationMenu(page);
  });

  test("the board's sounds NEVER come from chess.com, and a machine without them still plays", async ({
    page,
  }) => {
    // THE RULE THIS FEATURE RESTS ON. The recordings are chess.com's, and they reach the page from
    // THIS app's own origin because the backend fetched them (see src/chess_sound.rs): a page that
    // asked chess.com itself would tell their CDN the reader's address every time it drew a board —
    // the read receipt § Mail strips out of every message body, in another costume.
    const offMachine: string[] = [];
    const ours: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/chesscomfiles\.com|chess\.com/.test(url)) offMachine.push(url);
      if (url.includes("/__chess-sound/")) ours.push(url);
    });

    // `present: true` is the state in which the page really tries to load them — the one that could
    // reach off this machine if the address were built from the wrong end.
    await setChessSounds(page, { present: true });
    await openChessThread(page);
    await startChessGame(page);
    await playChessMove(page, "e2", "e4");
    await expect(page.locator(board)).toBeVisible();
    await chessOpponentMoves(page);

    expect(offMachine, "the page must never request chess.com").toEqual([]);
    // And what it DID ask for is this app's own route, under the version the backend named.
    for (const url of ours) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
      expect(url).toContain("/__chess-sound/chesscom-default-");
    }

    // The suite's sound directory is empty on purpose, so every one of those 404s and the board
    // falls back to its synthesized palette. The game must be entirely unaffected: this assertion
    // is the whole reason the fallback exists.
    await expect(page.locator(status)).toBeVisible();
    await playChessMove(page, "d2", "d4");
    await expect(page.locator(board)).toBeVisible();

    await resetChessSounds(page);
  });

  test("Settings says what the engine costs, and takes it back", async ({ page }) => {
    await gotoApp(page);
    await setChessEngine(page, { present: true });
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
    const section = page.locator('[data-testid="chess-engine-settings"]');
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('[data-testid="chess-engine-state"]')).toContainText(
      /on this machine/i,
    );
    await expect(section).toContainText("7.3 MB");

    await section.locator('[data-testid="chess-engine-remove"]').click();
    await expect(section.locator('[data-testid="chess-engine-state"]')).toContainText(/fetch/i);
    // And nothing is left to remove.
    await expect(section.locator('[data-testid="chess-engine-remove"]')).toHaveCount(0);
  });
});
