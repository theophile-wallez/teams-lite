//! The trailing line a CHESS message signs itself with, as the BACKEND reads it.
//!
//! A game of chess is played in a conversation because Teams has no private data channel: every
//! challenge, accept, move and resignation is an ordinary message whose body carries one
//! machine-readable line — `— chess <game> <state>, via teams-lite` (the whole shape, and every
//! decision behind it, is `web/src/lib/chess-wire.ts`).
//!
//! **THIS SIDE READS THE MARKER AND NOTHING ELSE, and that is the design.** The page owns the wire:
//! what a ledger says, whose ply is whose, what the clocks read and who won are all decided in ONE
//! place, by the derivation in `web/src/lib/chess-thread.ts`. A second spelling of any of that here
//! would be a second answer to "what happened in this game", drifting from the first at the next
//! token anybody adds. So the backend answers only the question a page cannot: **WHICH of this
//! conversation's stored messages carry a game at all** — see [`crate::store::Store::chess_messages`],
//! which is what lets a head-to-head score be counted over the whole history rather than over the
//! page that happens to be loaded.
//!
//! **AND THE FINDING ITSELF IS [`crate::wire_line`]'s, because the GRAMMAR IS SHARED WITH THE PET.**
//! Both features sign `— <keyword> <6 lowercase hex> <payload>, via teams-lite`, so what is left here
//! is the keyword — which is exactly the thing that tells them apart. This module was that finder plus
//! a `without_chess_line` that nothing but its own tests called: `push_policy` had already grown its
//! own preview-shaped strip and stopped using it, so the public one drifted (it still required a WHOLE
//! line, where the live one re-validates a tail a preview cut) while its docstring named the caller
//! that no longer called it. Whoever reached for the obviously-named helper would have got the
//! pre-fix behaviour — the leak the strip exists to stop. The strip lives in one place now, and it is
//! `push_policy`'s.

/// What a chess line opens with, and the ONE spelling of it in this crate.
///
/// The store reads it to answer which messages hold a game, and `push_policy` reads it to keep a
/// wire line out of a notification — so a second spelling here would leave one of those two
/// recognising a line the other had stopped recognising. `web/src/lib/chess-wire.ts` writes it.
pub const MARKER: &str = "— chess ";

/// Where the chess line starts, when this text ends with one — the byte offset of its em dash.
pub fn chess_line_at(text: &str) -> Option<usize> {
    crate::wire_line::line_at(text, MARKER)
}

/// Whether this text carries a chess line at all — the store's own filter.
///
/// Asked THROUGH [`chess_line_at`] rather than beside it, so this module has no public function whose
/// only caller is its own test — which is the smell the deleted strip above was an instance of.
pub fn carries_chess_line(text: &str) -> bool {
    chess_line_at(text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker is read out of a message BODY, where it sits inside its own italic block — which
    /// is the shape the store filters on, and the one a preview-shaped reader would miss.
    #[test]
    fn a_chess_line_is_found_in_a_body_and_in_a_preview() {
        let body = "<p>♟ Chess — I'd like a game.</p><p><em>— chess 7f3a1c v2 w open tc.600+0, via teams-lite</em></p>";
        assert!(carries_chess_line(body));
        let preview = "♟ 1. e4\n— chess 7f3a1c 1 e4, via teams-lite";
        assert!(carries_chess_line(preview));
        assert_eq!(chess_line_at(preview), Some("♟ 1. e4\n".len()));
    }

    /// And nothing else is ever read as a game: an agent's own signature, a colleague's prose, a
    /// bare em dash, and a game id that is not six hex characters.
    #[test]
    fn nothing_else_is_read_as_a_game() {
        for text in [
            "done — claude, via teams-lite",
            "on my way",
            "— chess not-a-game 1 e4, via teams-lite",
            "— chess 7F3A1C 1 e4, via teams-lite",
            "— chess 7f3a1c 1 e4",
            "— chess 7f3a1c",
        ] {
            assert!(!carries_chess_line(text), "{text} was read as a game");
        }
    }

    /// A body holding a QUOTE of an earlier chess message still carries its own line, and the one
    /// that counts is the message's own — the last of them.
    #[test]
    fn the_last_qualifying_line_is_the_one_that_counts() {
        let text = "— chess 7f3a1c 1 e4, via teams-lite\nand then — chess bbb222 2 e5, via teams-lite";
        let at = chess_line_at(text).expect("a line");
        assert_eq!(&text[at..], "— chess bbb222 2 e5, via teams-lite");
    }

    /// **THE STRIP IS `push_policy`'s AND THERE IS NO SECOND ONE HERE.** A `without_chess_line` used
    /// to sit in this module, called by nothing but its own tests while the live strip grew the two
    /// cut rules a preview needs — a public helper with a stale rule and a docstring naming a caller
    /// that had stopped calling it. This scans the source so it cannot come back by accident.
    #[test]
    fn this_module_holds_no_strip_of_its_own() {
        let src = include_str!("chess_wire.rs");
        // The needle is ASSEMBLED, because this file is what is being scanned: written whole it is
        // itself the thing the scan looks for, and the test fails on its own assertion.
        let needle = concat!("fn ", "without_chess_line");
        assert!(
            !src.contains(needle),
            "a chess strip belongs in push_policy, which is the one that re-validates a cut tail",
        );
    }
}
