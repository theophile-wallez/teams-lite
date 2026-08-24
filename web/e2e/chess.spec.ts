import {
  test,
  expect,
  chessChallengeFromOpponent,
  chessSquareHasPiece,
  closeConversationMenu,
  conversationMenuTrigger,
  fetchCapturedSends,
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
    // would break every later game.
    await resetChess(page);
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

  test("DECLINING a challenge frees the conversation for the next one", async ({ page }) => {
    await openChessThread(page);
    await chessChallengeFromOpponent(page, "w");
    await page.locator('[data-testid="chess-decline"]').click();

    await expect(page.locator(status)).toContainText(/declined/i);
    // Nothing is waiting for the reader any more…
    await expect(page.locator('[data-testid="chess-your-turn"]')).toHaveCount(0);
    // …and the header offers a challenge again rather than pointing at a dead game.
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
    // The challenge really carried the line the other machine reads back, and a resolved
    // colour — never the word "random", which would leave two clients disagreeing about who
    // moves first.
    expect(challenge?.content_html).toMatch(
      /<p><em>— chess [0-9a-f]{6} open w, via teams-lite<\/em><\/p>$/,
    );
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

    // And the ROW inside says it in words, and points at the board rather than at a challenge:
    // one game in flight per conversation, so there is nothing else for it to offer.
    const game = await header.getAttribute("data-chess-game");
    await openConversationMenu(page);
    const row = page.locator('[data-testid="chess-button"]');
    await expect(row).toHaveAttribute("data-chess-game", game!);
    await expect(row).toContainText(/your move/i);
    await expect(page.locator('[data-testid="chess-challenge"]')).toHaveCount(0);
    await closeConversationMenu(page);

    // Once the move is out it is not our turn, and the dot goes.
    await setSendControl(page, { clear: true });
    await playChessMove(page, "e2", "e4");
    await expect(page.locator('[data-testid="chess-your-turn"]')).toHaveCount(0);
  });

  test("a resigned game lets the next challenge go out", async ({ page }) => {
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
});
