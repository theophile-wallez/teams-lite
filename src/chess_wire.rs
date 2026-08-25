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
//! The marker is deliberately narrow — six lowercase hex characters and the exact trailing clause —
//! so an agent's own `— claude, via teams-lite` and a colleague's prose can never be read as a game.

/// Where the chess line starts, when this text ends with one — the byte offset of its em dash.
///
/// The text may be a message BODY (where the line sits inside `<p><em>…</em></p>`) or a flattened
/// preview (where it follows a newline), so a line runs to the next `<`, the next newline, or the end
/// of the text. Every occurrence is considered and the LAST qualifying one wins, which is what makes
/// this answer the same question for a body and for a preview.
pub fn chess_line_at(text: &str) -> Option<usize> {
    const MARKER: &str = "— chess ";
    let mut found = None;
    let mut from = 0;
    while let Some(offset) = text[from..].find(MARKER) {
        let at = from + offset;
        let rest = &text[at + MARKER.len()..];
        let end = rest.find(['<', '\n']).unwrap_or(rest.len());
        if is_chess_line(rest[..end].trim()) {
            found = Some(at);
        }
        from = at + MARKER.len();
    }
    found
}

/// Whether this text carries a chess line at all — the store's own filter.
pub fn carries_chess_line(text: &str) -> bool {
    chess_line_at(text).is_some()
}

/// The text with a trailing chess line taken off, or the text unchanged.
///
/// What it is FOR is a push notification: the line is machine-readable and the reader must never be
/// shown it (see [`crate::push_policy`]). The page strips it from a sidebar preview itself
/// (`chessPreviewText`), and a push has no page.
pub fn without_chess_line(text: &str) -> String {
    match chess_line_at(text) {
        Some(at) => text[..at].trim().to_string(),
        None => text.to_string(),
    }
}

/// `<6 lowercase hex> <anything>, via teams-lite`, and nothing else counts.
fn is_chess_line(line: &str) -> bool {
    let Some((game, state)) = line.split_once(' ') else {
        return false;
    };
    let is_game =
        game.len() == 6 && game.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    is_game && state.ends_with(", via teams-lite")
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
        assert_eq!(without_chess_line(preview), "♟ 1. e4");
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
            assert_eq!(without_chess_line(text), text);
        }
    }

    /// A body holding a QUOTE of an earlier chess message still carries its own line, and the one
    /// that is cut is the message's own — the last of them.
    #[test]
    fn the_last_qualifying_line_is_the_one_that_counts() {
        let text = "— chess 7f3a1c 1 e4, via teams-lite\nand then — chess bbb222 2 e5, via teams-lite";
        let at = chess_line_at(text).expect("a line");
        assert_eq!(&text[at..], "— chess bbb222 2 e5, via teams-lite");
    }
}
