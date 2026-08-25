/**
 * THE HEAD TO HEAD: how the reader stands against one colleague over every game they have played
 * in a conversation, with a draw counting a half — chess's own scoring.
 *
 * A rematch is the press this exists for. "Play again" means nothing without it; with it, the two
 * of them are keeping score, which is what makes a game in a chat a series rather than an
 * afternoon.
 *
 * **IT IS DERIVED, LIKE EVERYTHING ELSE ABOUT A GAME.** There is no store for a game and no store
 * for the score: the games replay out of the thread's own messages (see lib/chess-thread.ts), so
 * this is arithmetic over them. Nothing is written down, so there is nothing to reconcile and
 * nothing to migrate — and a colleague's own app answers the same numbers off the same messages.
 *
 * **AND IT IS OVER THE WHOLE STORED HISTORY, not over the loaded page.** That is the one thing the
 * derivation alone cannot do: the history loads a page at a time, so a score taken off `messages`
 * would count the games that happen to be on screen and quietly grow as the reader scrolled back.
 * The backend answers the chess-carrying messages of the conversation from its own store
 * (`chess_messages`, an ordinary open read), the store derives games from them with THIS app's one
 * derivation, and {@link chessSeriesGames} merges that snapshot with what the thread holds live.
 * So there is still exactly one spelling of the wire, and the backend never needs the rules.
 *
 * Pure, no dependency, unit-tested — the rule every `lib/chess-*.ts` holds.
 */

import { chessIsEngineGame, chessResultFor, type ChessGame } from "./chess-thread";

/** How the reader stands against one person. */
export type ChessSeries = {
  /** Games that reached a RESULT. A game in progress is not in it, and neither is a challenge
   *  nobody took up: the score says what has been settled. */
  played: number;
  wins: number;
  losses: number;
  draws: number;
  /** Points, a draw counting a half — so the two always add up to {@link played}. */
  us: number;
  them: number;
};

const NO_SERIES: ChessSeries = { played: 0, wins: 0, losses: 0, draws: 0, us: 0, them: 0 };

/**
 * Who the reader is playing in this game — the other person, by MRI.
 *
 * Named by MRI and never by display name, which is the rule this whole feature holds: two
 * colleagues may share one (§ WHO said it), and a series counted by name would pool two people's
 * games under one score. Null for a game the reader is only watching, a game nobody has accepted,
 * and a game against the ENGINE — a machine keeps no score with anybody.
 */
export function chessOpponentMri(game: ChessGame): string | null {
  if (!game.ourColor || chessIsEngineGame(game)) return null;
  const them = game.challenger.isSelf ? game.opponent : game.challenger;
  return them && them.mri ? them.mri : null;
}

/**
 * The score between the reader and one person, over every game given.
 *
 * The games are counted whatever order they arrive in and however they ended — a resignation, a
 * flag, an agreed draw, a mate the wire states — because `chessResultFor` is the one answer to
 * "how did this end for me" and it needs no board.
 */
export function chessSeriesBetween(games: ChessGame[], opponentMri: string): ChessSeries {
  if (!opponentMri) return NO_SERIES;
  const series: ChessSeries = { ...NO_SERIES };
  for (const game of games) {
    if (chessOpponentMri(game) !== opponentMri) continue;
    const result = chessResultFor(game);
    if (!result) continue;
    series.played += 1;
    if (result === "win") {
      series.wins += 1;
      series.us += 1;
    } else if (result === "lose") {
      series.losses += 1;
      series.them += 1;
    } else {
      series.draws += 1;
      series.us += 0.5;
      series.them += 0.5;
    }
  }
  return series;
}

/**
 * The games a series is counted over: the backend's snapshot of the whole stored history, with
 * whatever the thread holds LIVE winning per game id.
 *
 * The live half has to win rather than merely be added: the snapshot is read once and a game that
 * finished a moment ago is settled in the thread and still running in the snapshot. Merged the
 * other way round, resigning would leave the score unchanged until the page was reloaded.
 */
export function chessSeriesGames(archive: ChessGame[], live: ChessGame[]): ChessGame[] {
  const byId = new Map<string, ChessGame>();
  for (const game of archive) byId.set(game.id, game);
  for (const game of live) byId.set(game.id, game);
  return [...byId.values()];
}

/** A points total as chess writes one: `2`, `2½`. */
export function formatChessPoints(points: number): string {
  const whole = Math.floor(points);
  const half = points - whole >= 0.5;
  if (!half) return String(whole);
  return whole === 0 ? "½" : `${whole}½`;
}

/**
 * The score in one line, or null when there is nothing to say.
 *
 * The LEADER is named first, because that is how a score is read out loud, and a level series says
 * so rather than naming somebody. A series of ONE game still earns the line: "you lead 1–0 after 1
 * game" is exactly what the reader who just won wants to see, and it is what tells them the score
 * exists at all.
 */
export function chessSeriesWords(series: ChessSeries, themName: string): string | null {
  if (series.played === 0) return null;
  const games = `${series.played} ${series.played === 1 ? "game" : "games"}`;
  const us = formatChessPoints(series.us);
  const them = formatChessPoints(series.them);
  if (series.us === series.them) return `Level ${us}–${them} after ${games}`;
  if (series.us > series.them) return `You lead ${us}–${them} after ${games}`;
  return `${themName} leads ${them}–${us} after ${games}`;
}
