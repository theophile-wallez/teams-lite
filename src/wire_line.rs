//! WHERE a feature's own signed line sits in a text, as the BACKEND reads one — for every feature
//! that signs a message body this way, in ONE spelling.
//!
//! A game of chess and a companion are each carried by ordinary Teams messages because Teams has no
//! private data channel: every challenge, move, spawn and feed is a message whose body carries one
//! machine-readable line — `— <keyword> <6 lowercase hex> <payload>, via teams-lite`. The whole shape
//! and every decision behind it live on the page ([`crate::chess_wire`] and `web/src/lib/pet-wire.ts`
//! say why); what this side answers is the ONE question a page cannot answer for a history it has not
//! loaded: **which of a conversation's stored messages carry a record at all.**
//!
//! **IT IS PARAMETERISED BY THE MARKER AND BY NOTHING ELSE, because the GRAMMAR is shared and the
//! keyword is not.** Both features spell the same `<6 lowercase hex> <anything>, via teams-lite` after
//! their own `— chess ` / `— pet `, so a second copy of that grammar per feature is a second chance to
//! narrow one of them and not the other — which is exactly how the third copy of the strip rules drifted
//! before `web/src/lib/wire-line.ts` was written (it is that module's twin, for a body rather than for a
//! preview).
//!
//! The grammar is deliberately narrow — six LOWERCASE hex characters and the exact trailing clause — so
//! an agent's own `— claude, via teams-lite` and a colleague's prose can never be read as a record. Case
//! matters: a real id is `toString(16)`, so it can only ever be lowercase, and admitting upper case
//! would only ever widen the prose paths.
//!
//! **WHAT IS NOT HERE: the STRIP.** Taking a line off a PREVIEW is `crate::push_policy`'s own, because a
//! preview is the body's first 120 characters and a record is one message rewritten on every act — so
//! that reader has to re-validate a tail the cut broke, in three shapes this one never sees. A body-shaped
//! reader and a preview-shaped reader are two questions, and merging them would give the wrong answer to
//! both.

/// Where the signed line starts, when this text ends with one — the byte offset of its em dash.
///
/// The text may be a message BODY (where the line sits inside `<p><em>…</em></p>`) or a flattened
/// preview (where it follows a newline), so a line runs to the next `<`, the next newline, or the end
/// of the text. Every occurrence is considered and the LAST qualifying one wins, which is what makes
/// this answer the same question for a body and for a preview — and what makes a body holding a QUOTE
/// of an earlier record resolve to the message's own line rather than to the one it quotes.
pub fn line_at(text: &str, marker: &str) -> Option<usize> {
    let mut found = None;
    let mut from = 0;
    while let Some(offset) = text[from..].find(marker) {
        let at = from + offset;
        let rest = &text[at + marker.len()..];
        let end = rest.find(['<', '\n']).unwrap_or(rest.len());
        if is_signed_line(rest[..end].trim()) {
            found = Some(at);
        }
        from = at + marker.len();
    }
    found
}

/// `<6 lowercase hex> <anything>, via teams-lite`, and nothing else counts.
fn is_signed_line(line: &str) -> bool {
    let Some((id, payload)) = line.split_once(' ') else {
        return false;
    };
    let is_id = id.len() == 6 && id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    is_id && payload.ends_with(", via teams-lite")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHESS: &str = crate::chess_wire::MARKER;
    const PET: &str = crate::pet_wire::MARKER;

    /// The "is there one at all" reading, spelled HERE rather than exported.
    ///
    /// Each feature already publishes its own (`carries_chess_line`, `carries_pet_line`) because that
    /// is what a store filter asks for by name; a third, marker-taking copy in this module would be a
    /// public function whose only caller is this test — the smell that had `chess_wire` carrying a
    /// diverged strip nothing called.
    fn carries(text: &str, marker: &str) -> bool {
        line_at(text, marker).is_some()
    }

    /// The line is read out of a message BODY, where it sits inside its own italic block — which is
    /// the shape a store filters on, and the one a preview-shaped reader would miss — and out of a
    /// flattened PREVIEW, where it follows a newline.
    #[test]
    fn a_line_is_found_in_a_body_and_in_a_preview() {
        let body = "<p>♟ Chess — I'd like a game.</p><p><em>— chess 7f3a1c v2 w open tc.600+0, via teams-lite</em></p>";
        assert!(carries(body, CHESS));
        assert!(carries("♟ 1. e4\n— chess 7f3a1c 1 e4, via teams-lite", CHESS));

        let pet = "<p>Nori is here.</p><p><em>— pet 7f3a1c v1 s.cat, via teams-lite</em></p>";
        assert!(carries(pet, PET));
        assert!(carries("Nori · fed 1\n— pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c, via teams-lite", PET));
    }

    /// EACH MARKER ANSWERS FOR ITS OWN FEATURE AND NOT FOR THE OTHER, which is the whole reason the
    /// keyword is the parameter: one store read must never count the other feature's messages.
    #[test]
    fn a_marker_answers_only_for_its_own_feature() {
        let chess = "— chess 7f3a1c v2 w open, via teams-lite";
        let pet = "— pet 7f3a1c v1 s.cat, via teams-lite";
        assert!(carries(chess, CHESS) && !carries(chess, PET));
        assert!(carries(pet, PET) && !carries(pet, CHESS));
    }

    /// And nothing else is ever read as a record: an agent's own signature, a colleague's prose, a
    /// bare em dash, an id that is not six hex characters, an UPPER-CASE one, and a line with the
    /// trailing clause missing.
    #[test]
    fn nothing_else_is_read_as_a_record() {
        for text in [
            "done — claude, via teams-lite",
            "on my way",
            "— chess not-a-game 1 e4, via teams-lite",
            "— chess 7F3A1C 1 e4, via teams-lite",
            "— chess 7f3a1c 1 e4",
            "— chess 7f3a1c",
        ] {
            assert!(!carries(text, CHESS), "{text} was read as a record");
        }
        for text in [
            "— pet food is in the second drawer, via teams-lite",
            "— pet 7F3A1C v1 s.cat, via teams-lite",
            "— pet 7f3a1c v1 s.cat",
        ] {
            assert!(!carries(text, PET), "{text} was read as a record");
        }
    }

    /// A body holding a QUOTE of an earlier record still carries its own line, and the one that
    /// counts is the message's own — the last of them.
    #[test]
    fn the_last_qualifying_line_is_the_one_that_counts() {
        let text = "— chess 7f3a1c 1 e4, via teams-lite\nand then — chess bbb222 2 e5, via teams-lite";
        let at = line_at(text, CHESS).expect("a line");
        assert_eq!(&text[at..], "— chess bbb222 2 e5, via teams-lite");
    }
}
