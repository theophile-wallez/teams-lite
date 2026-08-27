//! The trailing line a COMPANION's message signs itself with, as the BACKEND reads it.
//!
//! A pet lives in a conversation for the reason a game of chess does — Teams has no private data
//! channel — so its whole record is ONE ordinary message per person, edited in place, whose last block
//! carries `— pet <pet> <payload>, via teams-lite`. The shape and every decision behind it are
//! `web/src/lib/pet-wire.ts`.
//!
//! **THIS SIDE READS THE MARKER AND NOTHING ELSE**, which is [`crate::chess_wire`]'s rule and its
//! reason: whose pet is whose, what has been done to it, how hungry it is and whether it has gone home
//! are the page's ONE derivation, and a second spelling of any of it here would drift at the next token
//! anybody adds. The grammar itself is [`crate::wire_line`]'s, shared with chess, because the two lines
//! ARE one shape after their own keyword.
//!
//! **WHAT THE ONE QUESTION IS: which of a conversation's stored messages carry a pet at all** — see
//! [`crate::store::Store::pet_messages`]. For chess that read exists so a head-to-head SCORE is counted
//! over the whole history rather than over the page that happens to be loaded; here it is a
//! CORRECTNESS rail, and that difference is worth stating.
//!
//! A pet's ledger message keeps the `seq` and the `compose_time` it was FIRST posted at, because every
//! act edits it — so in a thread that has moved on it pages out of the loaded window while the creature
//! is still very much alive. The page then folded no pet of the reader's own, drew none, hid Feed, Play
//! and Nap behind "Feeding and playing take a companion of your own", and OFFERED THEM A SPAWN: a
//! second `send`, a second arrival message everybody in the thread reads, and a record every reader's
//! fold absorbs and ignores WHOLE — so the creature they had just taken vanished and nothing in the
//! feature could ever reach it again. Forty messages is a couple of days in a real chat. This read is
//! what closes it.

/// What a pet line opens with, and the ONE spelling of it in this crate.
///
/// The store reads it to answer which messages hold a pet, and `push_policy` reads it to keep a wire
/// line out of a notification — the same pair, and the same reason, as [`crate::chess_wire::MARKER`]:
/// two spellings would leave one of those readers recognising a line the other had stopped
/// recognising. `web/src/lib/pet-wire.ts` writes it.
pub const MARKER: &str = "— pet ";

/// Where the pet line starts, when this text ends with one — the byte offset of its em dash.
pub fn pet_line_at(text: &str) -> Option<usize> {
    crate::wire_line::line_at(text, MARKER)
}

/// Whether this text carries a pet line at all — the store's own filter.
///
/// Asked THROUGH [`pet_line_at`], for the reason [`crate::chess_wire::carries_chess_line`] is: neither
/// module should hold a public function whose only caller is its own test.
pub fn carries_pet_line(text: &str) -> bool {
    pet_line_at(text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker is read out of a message BODY, where it sits inside its own italic block — which is
    /// the shape the store filters on — and out of a flattened preview.
    #[test]
    fn a_pet_line_is_found_in_a_body_and_in_a_preview() {
        let body = "<p>Nori · fed 2</p><p><em>— pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c, via teams-lite</em></p>";
        assert!(carries_pet_line(body));
        let preview = "Nori is here.\n— pet 7f3a1c v1 s.cat, via teams-lite";
        assert!(carries_pet_line(preview));
        assert_eq!(pet_line_at(preview), Some("Nori is here.\n".len()));
    }

    /// And nothing else is: an agent's own signature, a colleague writing plainly ABOUT a pet, a CHESS
    /// line, an upper-case id, and a line whose trailing clause is missing.
    #[test]
    fn nothing_else_is_read_as_a_pet() {
        for text in [
            "done — claude, via teams-lite",
            "— pet food is in the second drawer",
            "— pet food is in the second drawer, via teams-lite",
            "— chess 7f3a1c v2 w open, via teams-lite",
            "— pet 7F3A1C v1 s.cat, via teams-lite",
            "— pet 7f3a1c v1 s.cat",
        ] {
            assert!(!carries_pet_line(text), "{text} was read as a pet");
        }
    }

    /// A `gone` record is still a record, and it is exactly the one the read must not miss: it is what
    /// the spawn row's "bring your companion back" is drawn from, and a reader whose gone ledger had
    /// paged out was offered a FRESH creature instead.
    #[test]
    fn a_pet_that_has_gone_home_still_carries_its_line() {
        assert!(carries_pet_line(
            "<p>Nori has gone home.</p><p><em>— pet 7f3a1c v1 s.cat gone, via teams-lite</em></p>",
        ));
    }
}
