//! What deserves to buzz a phone, and what it should say.
//!
//! Separate from [`crate::push`] (which knows how to encrypt and POST) because
//! this is the part with an opinion. A phone notification is expensive in a way a
//! sidebar row is not: it interrupts. So the rules here are deliberately narrower
//! than "every live message", and they mirror what Teams itself does:
//!
//! - **A chat message notifies.** One-to-one and group chats are addressed to the
//!   user; that is the whole reason the app is on their Home Screen.
//! - **A channel post follows the user's own Microsoft Teams setting for that
//!   channel** ([`crate::store::ChannelAlerts`]): silent when they muted it,
//!   otherwise an @mention only — and every post, or every post and reply, when
//!   they asked Teams for that. A channel can produce hundreds of messages a day
//!   and none of them is a summons, so the mention-only default stands.
//! - **A system line never notifies.** "Call ended", "Member added" and the like
//!   are context, not news.
//! - **The user's own message never notifies**, and neither does anything already
//!   stale — a trouter reconnect can replay frames, and a phone buzzing about this
//!   morning's message is worse than silence.
//!
//! Every rule is a pure function of one stored message, so the whole policy is unit
//! tested and the delivery path in `src/bin/server.rs` stays a plumbing detail.

use crate::push::Notification;
use crate::store::{ChannelAlerts, Message};
use crate::teams_activity;
use crate::teams_read;
use serde_json::Value;

/// How late a message may be and still notify. Past this, the frame is a replay
/// (reconnect, backfill) rather than news.
const MAX_AGE_MS: i64 = 10 * 60 * 1000;

/// How much of the preview the notification carries. Lock screens truncate around
/// here anyway, and the payload has a hard ceiling (see
/// [`crate::push::MAX_PAYLOAD_BYTES`]).
const MAX_BODY_CHARS: usize = 180;

/// Where a message landed, as the delivery path already knows it.
///
/// An enum rather than a struct with an `is_channel` flag: only a channel has a
/// notification setting, and only a channel is gated on one. A chat that carried
/// an unused [`ChannelAlerts`] would be a state that cannot be read correctly.
pub enum Placement<'a> {
    /// A one-to-one or group chat. `title` is its display name, `""` when the
    /// store has none yet.
    Chat { title: &'a str },
    /// A team channel, with the user's own Teams notification setting for it.
    /// `title` is `"Team · Channel"`, `""` when the store has none yet.
    Channel { title: &'a str, alerts: ChannelAlerts },
}

impl<'a> Placement<'a> {
    /// The chat or channel display name. Used to say *where* a message came from,
    /// and only when that adds something (see [`title_for`]).
    fn title(&self) -> &'a str {
        match *self {
            Placement::Chat { title } | Placement::Channel { title, .. } => title,
        }
    }
}

/// The notification a live message deserves, or `None` when it should stay silent.
///
/// `from_me` comes from the caller because it already resolved it (identity matching
/// needs both the display name and the MRI — see `is_self` in `src/bin/server.rs`).
///
/// `sealed_words` is the user's own setting for a SEALED chat: false — the default — means the
/// notification says a message arrived and NOT what it says. The backend holds the key, so it
/// could publish the words either way, and the payload is encrypted to the device (RFC 8291) so
/// no push service reads them; what the setting decides is whether the words of a chat the user
/// deliberately sealed appear on a locked screen. A sealed chat still notifies: silence would
/// leave them wondering, which is worse than a preview that says nothing.
/// What a notification says about a sealed message when the user has not asked for the words.
///
/// Deliberately neutral: it says a message arrived and nothing else. A phrase naming this app or
/// the fact that the chat is encrypted would put on a locked screen exactly what the sealed body
/// itself is careful not to carry.
const SEALED_BODY: &str = "New message";

/// The trailing marker a CHESS or a PET message signs itself with, cut off a preview.
///
/// ONE function for both, because the two lines are ONE SHAPE: the words, then
/// `— <keyword> <6 lowercase hex> <payload>, via teams-lite`. `web/src/lib/chess-wire.ts` and
/// `pet-wire.ts` write them and `chessPreviewText` / `stripPetLine` strip them on the page; a
/// second spelling of the same rule here would drift from the first at the next feature that signs
/// a body this way. The six lowercase hex characters are what keep an agent's own
/// `— claude, via teams-lite` and a colleague's prose out of this.
///
/// **IT RE-VALIDATES THE TAIL BEFORE CUTTING**, never just cuts at the marker: a naive
/// `split(marker)` truncates a real message that happens to contain the words.
///
/// A tail that ENDS IN AN ELLIPSIS is cut too, and that half is not a nicety. A preview is the
/// body's first 120 characters (`teams_read::preview_from_html`), and one message now holds a
/// whole record — a pet's acts, a game's plies — so the line is cut mid-wire long before its own
/// `, via teams-lite` is reached. Computed rather than guessed, over the bodies these two features
/// really write: an act token costs 23 characters WITH its separator, so a pet crosses 120 at
/// **its third act of MIXED kind** — measured through `petMessageWords` + `petLedgerLine` over all
/// three shipped skins, **140 for the cat, 142 for the duck, 150 for the blue boy**. Three FEEDS of
/// the same creature is shorter, because its words are, and it lands on BOTH sides of the ceiling:
/// 118 for the cat, exactly 120 (so uncut) for the duck, and **128 for the blue boy, which DOES
/// cross** — so the truncated path is reachable at three feeds too, and "two acts never cross" is
/// the only safe reading of the shorter shape. The ceiling is crossed by the BODY rather than by an
/// act count, and WHERE depends on the art's own label and skin name as much as on the acts. (An
/// earlier note here said 141 and 119: that is the cat's own wire token with a FOUR-character
/// label — the `Nori` fixture — rather than any skin that ships.) A clocked v2 game
/// crosses it at **the challenger's first own move** — 61 characters of words plus a space plus a
/// 77-character line is **139**, against 112 for the challenge alone — which is why every clocked
/// game leaked a truncated wire onto its chat row from move one. Those words are the TEN-MINUTE
/// challenge's own (`♟ Chess — I'd like a game. I'm white. 10 min.` plus the score sheet), so
/// another clock spelling moves the number by a few characters; what does not move is that one ply
/// crosses and the challenge alone does not. With the complete ending required,
/// this function would do nothing at all for either. (The first note here said 137, which is that
/// 139 with the `♟ ` prefix left out of the count.)
///
/// **THIS BRANCH'S PROOF IS WEAKER THAN THE WHOLE LINE'S**, and saying so is the point: the hex id
/// keeps prose out of the branch ABOVE, and here what is left structurally is the marker, a
/// six-character all-hex word and a space. English has such words (`facade`, `decade`, `deface`,
/// `beaded`), so `"…— pet facade beats…"` would be cut. And an author's own trailing ellipsis is
/// indistinguishable from the preview's cut marker, so the rule also fires on an UNTRUNCATED
/// message that simply ends in one. Both paths are nil-probability rather than impossible, and
/// neither loses a message: what one costs is a trailing clause.
/// **AND THE FOURTH SHAPE IS A CUT INSIDE THE MARKER ITSELF, which no search for the marker can
/// find.** With the 120th code point landing in `— chess ` there is no marker in the preview at all,
/// so `rfind` answers `None` and the fragment survives onto the row and into the push — the exact leak
/// the three rules below exist to stop. It is reachable by the same arithmetic that reaches the id
/// cut, one window later: the marker sits immediately after the words, so where an id cut needs words
/// of 105–110 characters, a marker cut needs 111–118. An earlier note on [`is_wire_tail`] called the
/// residual gap "one code point wide"; it was the whole length of the marker.
fn without_wire_line(preview: &str, marker: &str) -> String {
    // The two anchor at OPPOSITE ends — `rfind` finds a marker anywhere, a cut fragment is only ever
    // the last thing in the preview — so the marker-cut rule is asked even when a marker was found
    // and its tail was not a line. A body saying "— pet food is in the drawer" whose own wire line is
    // then cut mid-marker holds both.
    if let Some(at) = preview.rfind(marker)
        && let Some(rest) = preview[at..].trim().strip_prefix(marker)
        && is_wire_tail(rest)
    {
        return preview[..at].trim().to_string();
    }
    match cut_marker_at(preview, marker) {
        Some(at) => preview[..at].trim().to_string(),
        None => preview.to_string(),
    }
}

/// Where a trailing fragment of the MARKER ITSELF starts — `♟ …23. Bxf6 — ches…`.
///
/// The fragment must be a PROPER prefix of the marker: a whole one is [`without_wire_line`]'s own
/// branch and every shape [`is_wire_tail`] covers under it. Longest first, so `— pet` wins over `—`
/// and the cut takes the whole fragment rather than leaving `pet` behind as a word.
///
/// **THE SHORTEST PREFIX IS THE EM DASH ALONE, and what that costs is the point of saying it.** It
/// fires on any preview whose cut lands immediately after an em dash, with no keyword evidence at all
/// — and it is in because the em dash is genuinely where a cut can land, being the marker's own first
/// code point. What it takes is that dangling em dash and nothing else: `"Hello there —…"` becomes
/// `"Hello there"`. That is a SMALLER cost than the id-cut rule above, which can take a whole word,
/// and it is the same trade this module already accepts — a trailing clause, never a message.
fn cut_marker_at(preview: &str, marker: &str) -> Option<usize> {
    let stem = preview.strip_suffix('…')?;
    // The byte offset that ENDS each prefix, the full marker excluded — `skip(1)` drops the empty one.
    let ends: Vec<usize> = marker.char_indices().map(|(at, _)| at).skip(1).collect();
    ends.into_iter()
        .rev()
        .find_map(|end| stem.strip_suffix(&marker[..end]).map(str::len))
}

/// One id character: lowercase hex, which is the whole of what keeps prose out of the rules below.
fn is_lower_hex(c: char) -> bool {
    c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
}

/// Whether what follows the marker is a wire line — a WHOLE one, or one a preview CUT.
///
/// THREE shapes, and the third was a measured leak rather than a hypothetical. A cut landing INSIDE
/// the six-hex id leaves no `<id> <payload>` to split at all, so the rules below found nothing and
/// the marker fragment survived on the row and in the push. Measured over 48 realistic engine-game
/// ledgers (a Stockfish name, a clock and four to six shown moves): **8 leaked**, because words of
/// 104–108 characters put the 120th code point inside the id. For a PET it is structurally
/// unreachable with the shipped skins — its words top out around 41 and the window is 107–119 — so
/// this was a CHESS leak on a feature that ships, and the test for it used to assert the leak as
/// expected, which pinned the defect instead of the rule.
///
/// The id-cut rule is `<1..=6 hex><optional space>…` and nothing else: the marker, then only hex,
/// then the cut. **It widens the nil-probability prose path stated on `without_wire_line` by some
/// 60x rather than by "one notch", and the honest statement is ANY HEX-INITIAL WORD**: it fires at
/// k=1, so a word whose FIRST character is `a`–`f` or a digit is enough — roughly 30% of English
/// words by initial letter against roughly 0.5% for a full six-hex word. So
/// `"…thanks ever — pet b…"` is cut, and `cage`, `carrier`, `bed`, `dish`, `brush`, `collar`,
/// `food` and `bowl` all reach it: a colleague could plainly write "— pet food is in the second
/// drawer", and the improbable part is the CUT landing inside that 1–6 character window rather
/// than the words. The cost is unchanged and is what makes it acceptable — a trailing clause,
/// never a message.
///
/// One footnote, measured. The OPTIONAL SPACE sub-branch is unreachable from a real preview
/// in either language, because `preview_from_html` runs `truncated.trim_end()` before it appends
/// the `…` — so `— pet 7f3a1c …` is a shape the truncator cannot emit and its fixture is testing
/// the rule rather than a preview.
///
/// **THE RESIDUAL WINDOW USED TO BE THE WHOLE MARKER WIDE, not the "one code point" an earlier note
/// here claimed.** A cut landing inside `— chess ` leaves no marker for `rfind` to find, so none of
/// the three rules here was ever asked and the fragment reached the row. [`cut_marker_at`] is that
/// window, and with it the residual really is one code point: a preview cut exactly after the
/// marker's own trailing space — `— pet ` whole, zero hex, no `…`-bearing fragment left to match — is
/// a shape `preview_from_html` cannot emit, since it trims before it appends the cut marker.
fn is_wire_tail(rest: &str) -> bool {
    // THE ID ITSELF WAS CUT: only hex, then the preview's own cut marker, and no payload at all.
    if let Some(hex) = rest.strip_suffix('…') {
        let hex = hex.strip_suffix(' ').unwrap_or(hex);
        if (1..=6).contains(&hex.len()) && hex.chars().all(is_lower_hex) {
            return true;
        }
    }
    // `<6 hex> <anything>, via teams-lite` — or the same with the PAYLOAD cut short.
    let Some((id, payload)) = rest.split_once(' ') else {
        return false;
    };
    id.len() == 6
        && id.chars().all(is_lower_hex)
        && (payload.ends_with(", via teams-lite") || payload.ends_with('…'))
}

/// A game of CHESS: `— chess 7f3a1c v2 w open tc.600+0, via teams-lite`.
///
/// The marker comes from [`crate::chess_wire`] rather than being spelled again here, because the
/// STORE reads that same marker to answer WHICH messages hold a game
/// (see [`crate::store::Store::chess_messages`]): two spellings of it would leave a push carrying a
/// line the other reader had learned to recognise. What is NOT shared is the strip itself — this one
/// re-validates a tail a PREVIEW cut, which a body-shaped reader never sees.
fn without_chess_line(preview: &str) -> String {
    without_wire_line(preview, crate::chess_wire::MARKER)
}

/// A COMPANION: `— pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c, via teams-lite`.
///
/// The marker comes from [`crate::pet_wire`] for the reason the chess one comes from
/// [`crate::chess_wire`]: the STORE reads that same marker to answer which messages hold a pet
/// ([`crate::store::Store::pet_messages`]), so a literal here would be a second spelling — and one of
/// the two readers would eventually stop recognising a line the other still did.
fn without_pet_line(preview: &str) -> String {
    without_wire_line(preview, crate::pet_wire::MARKER)
}

pub fn notification_for(
    message: &Message,
    placement: &Placement<'_>,
    self_mri: &str,
    from_me: bool,
    now_ms: i64,
    sealed_words: bool,
) -> Option<Notification> {
    if from_me {
        return None;
    }
    // An activity stream is not a chat: its frames carry no body, and the mentions
    // they announce reach us as the channel message itself.
    if teams_activity::is_system_feed_thread(&message.conversation_id) {
        return None;
    }
    if !message.system_event.is_empty() || message.deleted {
        return None;
    }
    if is_stale(message.compose_time, now_ms) {
        return None;
    }
    if let Placement::Channel { alerts, .. } = *placement
        && !channel_post_notifies(message, alerts, self_mri)
    {
        return None;
    }

    // A SEALED message notifies, and what it SAYS is the user's own setting. `preview_for_message`
    // answers nothing for a sealed body by design (it is what keeps a base64 token out of the
    // sidebar), so a sealed chat would otherwise fall through the empty-body gate below and stay
    // silent — a message the reader never hears about at all.
    let sealed = message.seal != crate::store::MessageSeal::None;
    // A CHESS message and a PET message each carry a machine-readable line the reader must never
    // be shown, and a push is the one surface that gets its words from this side: the page strips
    // them out of a sidebar preview itself (`chessPreviewText`, `stripPetLine`), and there is no
    // page here. It matters more than it did: an act used to be its own short line, and a whole
    // record — a game's plies, a pet's acts — now lives in ONE message that is rewritten as it is
    // played with, so an unstripped push would be a screenful of wire with the sentence it is
    // about pushed off the end of it. Both, because a chat holds both: a message is one or the
    // other and never both, so the order the two run in decides nothing.
    let preview = teams_read::preview_for_message(message);
    let words = truncate(&without_pet_line(&without_chess_line(&preview)), MAX_BODY_CHARS);
    // Two ways a sealed message says nothing about its words, and they must land on the same
    // sentence: the user has not asked for them, or this machine cannot READ them — a message
    // sealed under a passphrase nobody here holds has no words to publish. Falling through to the
    // empty-body gate below would make that second one SILENT, and the reader would never hear
    // about a message at all.
    let body = if sealed && (!sealed_words || words.is_empty()) {
        SEALED_BODY.to_string()
    } else {
        words
    };
    if body.is_empty() {
        return None; // nothing to say; a blank notification is worse than none
    }

    Some(Notification {
        title: title_for(message, placement),
        body,
        // The web app's conversation route (see web/src/routes/_app.c.$conversationId.tsx).
        url: format!("/c/{}", urlencoding::encode(&message.conversation_id)),
        // One row per conversation on the lock screen: a burst replaces itself
        // instead of stacking.
        tag: message.conversation_id.clone(),
    })
}

/// Whether one channel post passes the user's own Microsoft Teams setting for that
/// channel.
///
/// An @mention always passes an unmuted channel: it is a summons, and Teams
/// notifies about it at every level except "off". Above the default, the setting
/// widens to every new post — and, when the user also asked for replies, to a reply
/// inside a post's thread.
fn channel_post_notifies(message: &Message, alerts: ChannelAlerts, self_mri: &str) -> bool {
    let mentioned = mentions_user(&message.mentions, self_mri);
    match alerts {
        ChannelAlerts::Muted => false,
        ChannelAlerts::MentionsOnly => mentioned,
        ChannelAlerts::AllNewPosts => mentioned || !is_reply(message),
        ChannelAlerts::AllNewPostsAndReplies => true,
    }
}

/// Whether a channel message is a reply inside a post's thread, rather than the
/// post that opened it.
///
/// A channel message carries the id of its thread's opening post
/// (`rootMessageId`, or the `;messageid=` suffix of its conversation link — see
/// `teams_read::parse_thread`). The opening post names itself, so "root is somebody
/// else" is what makes a message a reply. An absent root — a frame that carried
/// neither spelling — reads as a post, which is the safe way round: "All new posts"
/// then still notifies.
fn is_reply(message: &Message) -> bool {
    !message.thread_root_id.is_empty() && message.thread_root_id != message.id
}

/// Whether the message is too old to be news. Also catches a clock-skewed future
/// timestamp, which is just as untrustworthy.
fn is_stale(compose_time: i64, now_ms: i64) -> bool {
    if compose_time <= 0 {
        return true;
    }
    compose_time < now_ms - MAX_AGE_MS || compose_time > now_ms + MAX_AGE_MS
}

/// The notification title: who wrote, plus where — but only when "where" is not
/// the same thing as "who".
///
/// That one condition covers both shapes without a special case: in a one-to-one
/// chat the conversation is named after the sender, so the title stays "Ada
/// Lovelace"; in a group or channel it becomes "Ada Lovelace · Release train".
fn title_for(message: &Message, placement: &Placement<'_>) -> String {
    let sender = message.sender.trim();
    let sender = if sender.is_empty() { "New message" } else { sender };
    let title = placement.title().trim();
    if title.is_empty() || title.eq_ignore_ascii_case(sender) {
        return sender.to_string();
    }
    format!("{sender} · {title}")
}

/// Whether the message's @mentions point at this user.
///
/// The rendered body only carries a mention's local `itemid`
/// (`<span itemtype="http://schema.skype.com/Mention" itemid="0">Théophile</span>`),
/// so the display name in the text proves nothing — two colleagues share a first
/// name often enough. [`Message::mentions`] is the resolved list, with an MRI per
/// mention, and it is the only trustworthy answer.
pub fn mentions_user(mentions_json: &str, self_mri: &str) -> bool {
    if self_mri.is_empty() {
        return false;
    }
    let Ok(Value::Array(mentions)) = serde_json::from_str::<Value>(mentions_json) else {
        return false;
    };
    mentions.iter().any(|mention| {
        mention
            .get("mri")
            .and_then(Value::as_str)
            .is_some_and(|mri| crate::store::same_user(mri, self_mri))
    })
}

fn truncate(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect::<String>().trim_end().to_string() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;
    const SELF_MRI: &str = "8:orgid:11111111-1111-1111-1111-111111111111";
    const OTHER_MRI: &str = "8:orgid:22222222-2222-2222-2222-222222222222";

    fn chat_message() -> Message {
        Message {
            seal: Default::default(),
            id: "m1".into(),
            conversation_id: "19:chat@thread.v2".into(),
            seq: 1,
            compose_time: NOW,
            sender: "Ada Lovelace".into(),
            sender_mri: OTHER_MRI.into(),
            message_type: "RichText/Html".into(),
            content: "<p>Ready for the demo?</p>".into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            system_event: String::new(),
            thread_root_id: String::new(),
            thread_subject: String::new(),
            deleted: false,
            scheduled_time: 0,
            mentions: "[]".into(),
        }
    }

    fn chat() -> Placement<'static> {
        Placement::Chat { title: "Ada Lovelace" }
    }

    /// A channel at Teams' default: an @mention notifies, nothing else does.
    fn channel() -> Placement<'static> {
        Placement::Channel { title: "Engine · General", alerts: ChannelAlerts::MentionsOnly }
    }

    #[test]
    fn a_chat_message_notifies_with_the_senders_name_and_the_body() {
        let notification = notification_for(&chat_message(), &chat(), SELF_MRI, false, NOW, false).unwrap();
        assert_eq!(notification.title, "Ada Lovelace");
        assert_eq!(notification.body, "Ready for the demo?");
        assert_eq!(notification.tag, "19:chat@thread.v2");
        assert_eq!(notification.url, "/c/19%3Achat%40thread.v2");
    }

    #[test]
    fn a_group_chat_says_where_the_message_came_from() {
        let placement = Placement::Chat { title: "Release train" };
        let notification =
            notification_for(&chat_message(), &placement, SELF_MRI, false, NOW, false).unwrap();
        assert_eq!(notification.title, "Ada Lovelace · Release train");
    }

    #[test]
    fn our_own_message_never_notifies() {
        assert!(notification_for(&chat_message(), &chat(), SELF_MRI, true, NOW, false).is_none());
    }

    #[test]
    fn a_system_line_never_notifies() {
        let mut message = chat_message();
        message.system_event = r#"{"kind":"call","event":"ended"}"#.into();
        message.content = String::new();
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn a_deleted_message_never_notifies() {
        let mut message = chat_message();
        message.deleted = true;
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn an_activity_stream_frame_never_notifies() {
        let mut message = chat_message();
        message.conversation_id = teams_activity::MENTIONS_THREAD.into();
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn a_replayed_message_never_notifies() {
        let mut old = chat_message();
        old.compose_time = NOW - MAX_AGE_MS - 1;
        assert!(notification_for(&old, &chat(), SELF_MRI, false, NOW, false).is_none());

        let mut skewed = chat_message();
        skewed.compose_time = NOW + MAX_AGE_MS + 1;
        assert!(notification_for(&skewed, &chat(), SELF_MRI, false, NOW, false).is_none());

        let mut undated = chat_message();
        undated.compose_time = 0;
        assert!(notification_for(&undated, &chat(), SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn a_channel_post_notifies_only_when_it_mentions_us() {
        let channel = channel();
        let mut message = chat_message();
        message.conversation_id = "19:abc@thread.tacv2".into();

        assert!(notification_for(&message, &channel, SELF_MRI, false, NOW, false).is_none());

        message.mentions =
            format!(r#"[{{"itemid":0,"mri":"{SELF_MRI}","kind":"person","display_name":"Ada"}}]"#);
        let notification = notification_for(&message, &channel, SELF_MRI, false, NOW, false).unwrap();
        assert_eq!(notification.title, "Ada Lovelace · Engine · General");
    }

    #[test]
    fn a_mention_of_somebody_else_in_a_channel_stays_silent() {
        let channel = channel();
        let mut message = chat_message();
        message.mentions = format!(r#"[{{"itemid":0,"mri":"{OTHER_MRI}","kind":"person"}}]"#);
        assert!(notification_for(&message, &channel, SELF_MRI, false, NOW, false).is_none());
    }

    /// A channel post, with the thread fields a real `@thread.tacv2` message carries.
    fn channel_post(id: &str, thread_root_id: &str) -> Message {
        Message {
            id: id.into(),
            conversation_id: "19:abc@thread.tacv2".into(),
            thread_root_id: thread_root_id.into(),
            ..chat_message()
        }
    }

    #[test]
    fn a_muted_channel_stays_silent_even_for_an_mention() {
        let muted = Placement::Channel { title: "Engine · General", alerts: ChannelAlerts::Muted };
        let mut message = channel_post("m1", "m1");
        message.mentions =
            format!(r#"[{{"itemid":0,"mri":"{SELF_MRI}","kind":"person","display_name":"Ada"}}]"#);
        assert!(notification_for(&message, &muted, SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn all_new_posts_notifies_about_a_post_but_not_about_a_reply() {
        let all_posts =
            Placement::Channel { title: "Engine · General", alerts: ChannelAlerts::AllNewPosts };

        // The post that opens a thread names itself as the thread's root.
        let post = channel_post("m1", "m1");
        assert!(notification_for(&post, &all_posts, SELF_MRI, false, NOW, false).is_some());

        // A reply names the opening post instead.
        let reply = channel_post("m2", "m1");
        assert!(notification_for(&reply, &all_posts, SELF_MRI, false, NOW, false).is_none());

        // …unless it mentions us: a summons passes at every level but muted.
        let mut mentioning_reply = channel_post("m3", "m1");
        mentioning_reply.mentions = format!(r#"[{{"itemid":0,"mri":"{SELF_MRI}"}}]"#);
        assert!(notification_for(&mentioning_reply, &all_posts, SELF_MRI, false, NOW, false).is_some());

        // A frame with no thread field at all reads as a post, never as a reply.
        let rootless = channel_post("m4", "");
        assert!(notification_for(&rootless, &all_posts, SELF_MRI, false, NOW, false).is_some());
    }

    #[test]
    fn all_new_posts_and_replies_notifies_about_a_reply_too() {
        let with_replies = Placement::Channel {
            title: "Engine · General",
            alerts: ChannelAlerts::AllNewPostsAndReplies,
        };
        assert!(notification_for(&channel_post("m1", "m1"), &with_replies, SELF_MRI, false, NOW, false)
            .is_some());
        assert!(notification_for(&channel_post("m2", "m1"), &with_replies, SELF_MRI, false, NOW, false)
            .is_some());
    }

    #[test]
    fn a_channel_setting_never_overrides_the_rules_above_it() {
        // "All new posts and replies" is the widest setting Teams offers, and it
        // still cannot make our own message, a system line or a replay notify.
        let widest = Placement::Channel {
            title: "Engine · General",
            alerts: ChannelAlerts::AllNewPostsAndReplies,
        };
        assert!(notification_for(&channel_post("m1", "m1"), &widest, SELF_MRI, true, NOW, false).is_none());

        let mut system = channel_post("m2", "m2");
        system.system_event = r#"{"kind":"call","event":"ended"}"#.into();
        system.content = String::new();
        assert!(notification_for(&system, &widest, SELF_MRI, false, NOW, false).is_none());

        let mut replayed = channel_post("m3", "m3");
        replayed.compose_time = NOW - MAX_AGE_MS - 1;
        assert!(notification_for(&replayed, &widest, SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn mentions_are_matched_on_the_mri_not_the_display_name() {
        let mentions = format!(r#"[{{"itemid":0,"mri":"{SELF_MRI}","display_name":"Somebody Else"}}]"#);
        assert!(mentions_user(&mentions, SELF_MRI));
        assert!(!mentions_user("[]", SELF_MRI));
        assert!(!mentions_user("not json", SELF_MRI));
        // Without our own MRI there is nothing to match, so nothing is a mention.
        assert!(!mentions_user(&mentions, ""));
    }

    #[test]
    fn an_empty_body_stays_silent() {
        let mut message = chat_message();
        message.content = "<p> </p>".into();
        message.message_type = "RichText/Html".into();
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW, false).is_none());
    }

    #[test]
    fn a_long_body_is_truncated_for_the_lock_screen() {
        let mut message = chat_message();
        message.content = format!("<p>{}</p>", "word ".repeat(200));
        let notification = notification_for(&message, &chat(), SELF_MRI, false, NOW, false).unwrap();
        assert!(notification.body.chars().count() <= MAX_BODY_CHARS + 1, "{}", notification.body);
        assert!(notification.body.ends_with('…'));
    }
    /// A SEALED message NOTIFIES, and by default it says nothing about the words.
    ///
    /// Both halves matter. Silence would leave the reader to find the message by opening the app,
    /// which is what a notification exists to save them — and the words on a locked screen are the
    /// one place a sealed conversation would appear in the clear without them asking.
    #[test]
    fn a_sealed_message_notifies_without_publishing_the_words() {
        let mut message = chat_message();
        message.content = "<p>the merger closes on Friday</p>".to_string();
        message.seal = crate::store::MessageSeal::Opened;

        let quiet = notification_for(&message, &chat(), SELF_MRI, false, NOW, false)
            .expect("a sealed message still notifies");
        assert_eq!(quiet.body, SEALED_BODY);
        assert!(!quiet.body.contains("merger"), "the words must stay off the lock screen");
        // It still says WHERE, because that is the half the reader acts on.
        assert!(!quiet.title.is_empty());

        // And with the setting on, the words are what it carries.
        let loud = notification_for(&message, &chat(), SELF_MRI, false, NOW, true)
            .expect("a sealed message still notifies");
        assert!(loud.body.contains("merger"), "the setting asks for the words: {}", loud.body);
    }

    /// A message this machine could NOT open notifies the same way, and never with the token.
    ///
    /// `preview_for_message` answers nothing for a sealed body — which is what keeps base64 out of
    /// the sidebar — so without the sealed branch this message would fall through the empty-body
    /// gate and stay silent, and the reader would never hear about it at all.
    #[test]
    fn a_message_this_machine_cannot_open_still_notifies() {
        let mut message = chat_message();
        // What the store really holds for a locked row: an empty body, and the seal state.
        message.content = String::new();
        message.seal = crate::store::MessageSeal::Locked { key_id: "0a1b2c3d".to_string() };
        let notification = notification_for(&message, &chat(), SELF_MRI, false, NOW, false)
            .expect("a locked message still notifies");
        assert_eq!(notification.body, SEALED_BODY);
        // Even with the setting ON: there are no words on this machine to publish.
        let asked = notification_for(&message, &chat(), SELF_MRI, false, NOW, true)
            .expect("a locked message still notifies");
        assert_eq!(asked.body, SEALED_BODY);
    }


    /// A push about a game of CHESS says what happened, never the line that carries it.
    ///
    /// The page strips the marker out of a sidebar preview itself; a push has no page. A ledger's
    /// line is some hundreds of characters (one message holds a player's whole record), so left in
    /// it would push the sentence it is about off the end of the notification.
    #[test]
    fn a_push_about_a_game_of_chess_carries_no_wire() {
        assert_eq!(
            without_chess_line(
                "♟ Chess — I'd like a game. I'm white. 10 min. — chess 7f3a1c v2 w open tc.600+0, via teams-lite"
            ),
            "♟ Chess — I'd like a game. I'm white. 10 min."
        );
        // A newline is how the backend flattens the two blocks of the body.
        assert_eq!(
            without_chess_line("♟ 1. e4\n— chess 7f3a1c 1 e4, via teams-lite"),
            "♟ 1. e4"
        );
        // And nothing else is ever cut: an agent's own signature, a colleague's prose, an em dash.
        assert_eq!(
            without_chess_line("done — claude, via teams-lite"),
            "done — claude, via teams-lite"
        );
        assert_eq!(without_chess_line("on my way"), "on my way");
        assert_eq!(
            without_chess_line("— chess not-a-game 1 e4, via teams-lite"),
            "— chess not-a-game 1 e4, via teams-lite"
        );
    }

    /// A push about a COMPANION says what happened, never the line that carries it.
    ///
    /// The same rule as the game above, and it needs its own test because it is its own marker: a
    /// pet's record is one message rewritten on every act, so a colleague's spawn — which is a
    /// `send`, and notifies like any other message — arrives here with the whole wire on it.
    #[test]
    fn a_push_about_a_companion_carries_no_wire() {
        // The body `petMessageHtml` writes, flattened the way the backend flattens two blocks.
        assert_eq!(
            without_pet_line("Nori is here.\n— pet 7f3a1c v1 s.cat, via teams-lite"),
            "Nori is here."
        );
        assert_eq!(
            without_pet_line(
                "Nori · fed 3 · played 1 — pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c, via teams-lite"
            ),
            "Nori · fed 3 · played 1"
        );
        // And nothing else is ever cut: an agent's own signature, a colleague's prose about a pet,
        // a bare em dash, and an id that is not one.
        assert_eq!(
            without_pet_line("done — claude, via teams-lite"),
            "done — claude, via teams-lite"
        );
        assert_eq!(
            without_pet_line("I told him — pet the cat, not the dog"),
            "I told him — pet the cat, not the dog"
        );
        assert_eq!(without_pet_line("on my way — see you"), "on my way — see you");
        assert_eq!(
            without_pet_line("— pet not-a-pet v1 s.cat, via teams-lite"),
            "— pet not-a-pet v1 s.cat, via teams-lite"
        );

        // AND THE NOTIFICATION REALLY GOES THROUGH IT. The two `without_*` assertions above hold
        // whether or not `notification_for` calls either one, which is the one way this could pass
        // over the whole defect: this is the body a colleague's spawn arrives with, and a spawn is
        // a `send`, so it notifies like any other message.
        let mut message = chat_message();
        message.content =
            "<p>Nori is here.</p><p><em>— pet 7f3a1c v1 s.cat, via teams-lite</em></p>".to_string();
        let notification = notification_for(&message, &chat(), SELF_MRI, false, NOW, false)
            .expect("a colleague's spawn notifies");
        assert_eq!(notification.body, "Nori is here.");
    }

    /// A record too long for a preview is CUT MID-WIRE, and that cut is still no wire.
    ///
    /// `teams_read::preview_from_html` keeps the body's first 120 characters and marks the cut with
    /// an ellipsis, and three acts of MIXED kind already take a pet's body past that (141) — so
    /// requiring the line's own `, via teams-lite` would have left every push about a played-with
    /// pet carrying a wire dump, and every clocked game leaking from its first move. The ellipsis
    /// is the preview's own proof that it truncated, which is why nothing whole is touched by this:
    /// the two prose lines below end in one and are left alone, because neither carries the marker
    /// with an id behind it.
    #[test]
    fn a_push_about_a_record_too_long_to_preview_carries_no_wire() {
        assert_eq!(
            without_pet_line(
                "Nori · fed 3 — pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c 175606001…"
            ),
            "Nori · fed 3"
        );
        assert_eq!(
            without_chess_line("♟ 1. e4 2. Nf3 — chess 7f3a1c v2 w tc.600+0 at.17560600123…"),
            "♟ 1. e4 2. Nf3"
        );
        // A colleague's own sentence that was truncated keeps every word of what survived.
        assert_eq!(
            without_pet_line("I told him — pet the cat, not the d…"),
            "I told him — pet the cat, not the d…"
        );
        assert_eq!(without_pet_line("we should talk about the deploy…"), "we should talk about the deploy…");

        // A CUT LANDING INSIDE THE ID, which this used to assert as a LEAK — the test pinned the
        // defect rather than the rule. Measured over 48 engine-game ledgers, 8 of them landed here
        // (words of 104–108 put the 120th code point inside the six-hex id), so it was reachable on
        // a feature that ships rather than the 22-character curiosity it was written off as.
        assert_eq!(without_pet_line("Nori is here. — pet 7f3a…"), "Nori is here.");
        assert_eq!(without_pet_line("Nori is here. — pet 7f3a1c …"), "Nori is here.");
        // The two real ones, from the measured leak. The `…` is the preview's own cut marker.
        assert_eq!(
            without_chess_line(
                "♟ Chess — I'm playing Stockfish 3190. 3 min. moves: 20… Qxd5+ … 23. Bxf6 — chess 7f3a…"
            ),
            "♟ Chess — I'm playing Stockfish 3190. 3 min. moves: 20… Qxd5+ … 23. Bxf6"
        );
        assert_eq!(
            without_chess_line(
                "♟ Chess — I'm playing Stockfish 1320. 3 min + 2 s. moves: … 22… Nbxd7 — chess 7f3a1c…"
            ),
            "♟ Chess — I'm playing Stockfish 1320. 3 min + 2 s. moves: … 22… Nbxd7"
        );
        // And an id-shaped cut is still the ONLY thing cut on that branch: prose keeps its words,
        // even where the words after the marker are longer than an id could be.
        assert_eq!(
            without_pet_line("I told him — pet the cat, not the d…"),
            "I told him — pet the cat, not the d…"
        );
        assert_eq!(without_pet_line("we walked the — pet shop…"), "we walked the — pet shop…");

        // ONE CASE RULE, THE SAME AS THE PAGE'S: lowercase, because a real id is `toString(16)`.
        // `is_lower_hex` survived widening to any hex unpinned, and the page's own `ID_CUT`
        // survived losing its `/i` — so the two could have disagreed, which on prose is a row and
        // a push saying different things about the same words.
        assert_eq!(without_pet_line("Nori is here. — pet 7F3A…"), "Nori is here. — pet 7F3A…");
        assert_eq!(
            without_pet_line("Nori · fed 3 — pet 7F3A1C v1 s.cat 1756…"),
            "Nori · fed 3 — pet 7F3A1C v1 s.cat 1756…"
        );
    }

    /// A CUT LANDING INSIDE THE MARKER ITSELF, which no search for the marker can find.
    ///
    /// The fourth shape, and the one that was still leaking: with the 120th code point inside
    /// `— chess ` there is no marker in the preview at all, so `rfind` answered `None`, none of the
    /// three rules above was ever asked, and the fragment reached the row and the push — the exact
    /// thing this whole function exists to stop. It is the id cut's own arithmetic one window later:
    /// the marker sits immediately after the words, so where an id cut needs words of 105–110
    /// characters, this needs 111–118.
    ///
    /// The COST is asserted beside it, because the shortest prefix is the em dash alone: a preview cut
    /// immediately after one loses that dash and nothing else, which is a smaller price than the
    /// id-cut rule above already pays (it can take a whole word).
    #[test]
    fn a_cut_inside_the_marker_itself_is_no_wire_either() {
        // Every prefix of the chess marker, from the whole keyword down to the em dash.
        for (cut, want) in [
            ("♟ … 23. Bxf6 — chess…", "♟ … 23. Bxf6"),
            ("♟ … 23. Bxf6 — ches…", "♟ … 23. Bxf6"),
            ("♟ … 23. Bxf6 — ch…", "♟ … 23. Bxf6"),
            ("♟ … 23. Bxf6 — c…", "♟ … 23. Bxf6"),
            ("♟ … 23. Bxf6 —…", "♟ … 23. Bxf6"),
        ] {
            assert_eq!(without_chess_line(cut), want, "{cut}");
        }
        for (cut, want) in [
            ("Nori · fed 3 — pet…", "Nori · fed 3"),
            ("Nori · fed 3 — pe…", "Nori · fed 3"),
            ("Nori · fed 3 — p…", "Nori · fed 3"),
            ("Nori · fed 3 —…", "Nori · fed 3"),
        ] {
            assert_eq!(without_pet_line(cut), want, "{cut}");
        }

        // NOTHING WHOLE IS TOUCHED, which is the half that keeps the widening honest: a fragment is
        // only ever cut where the preview says it truncated. A colleague's own em dash mid-sentence
        // survives, and so does one at the end of a message the preview did NOT cut.
        assert_eq!(without_pet_line("on my way — see you"), "on my way — see you");
        assert_eq!(without_chess_line("we lost — again"), "we lost — again");
        assert_eq!(without_pet_line("that was the plan —"), "that was the plan —");
        // A fragment of the OTHER feature's keyword is not this one's: `— ches…` is no pet.
        assert_eq!(without_pet_line("♟ … 23. Bxf6 — ches…"), "♟ … 23. Bxf6 — ches…");
        // And a word that merely STARTS like the keyword is not a fragment of it.
        assert_eq!(without_pet_line("we walked the — pest…"), "we walked the — pest…");
        assert_eq!(without_chess_line("this — chest…"), "this — chest…");

        // AND THE NOTIFICATION REALLY GOES THROUGH IT, which is the one way the whole rule could be
        // right and unreached: the body is what a mid-marker cut of a real record looks like.
        // THE FIXTURE'S OWN LENGTH IS WHAT PUTS THE CUT INSIDE THE MARKER, so it is computed rather
        // than eyeballed. `preview_from_html` joins blocks with one newline, so the marker's six code
        // points start one after the words: for the 120th to land inside it and not past it, the words
        // have to be 114–118 long. 116 puts the cut three characters in (`— p…`).
        let words = format!("Nori has had a long afternoon and it is all in the record{}", ".".repeat(59));
        assert_eq!(words.chars().count(), 116, "the fixture's length is the whole of what it tests");
        let mut message = chat_message();
        message.content = format!(
            "<p>{words}</p><p><em>— pet 7f3a1c v1 s.cat 1756060012345.f.7f3a1c, via teams-lite</em></p>",
        );
        let preview = teams_read::preview_from_html(&message.content);
        assert!(preview.ends_with("— p…"), "the fixture's own cut has to land inside the marker: {preview}");
        let notification = notification_for(&message, &chat(), SELF_MRI, false, NOW, false)
            .expect("a colleague's act notifies");
        assert!(
            !notification.body.contains('—'),
            "no fragment of the marker may reach a lock screen: {}",
            notification.body,
        );
    }

    /// THE PAGE MIRRORS THIS PREVIEW'S OWN CEILING, and a wrong mirror is otherwise SILENT.
    ///
    /// `web/src/lib/protocol.test.ts` ports `preview_from_html` in order to build a fixture whose
    /// wire line the cut has really broken — a hand-typed fixture is an untruncated one, which is
    /// exactly what the old strip passed straight through. A second spelling of a Rust function is
    /// a thing that drifts, and measured: moving that mirror's cap from 120 to 130 failed NOTHING.
    /// 60 and 200 were caught, so the guard band was an accident of two numbers — below ~120 the
    /// marker leaves the string and above 141 the pet fixture stops being truncated, and anything
    /// between hides. And if `MAX_CHARS` moves HERE while the mirror does not, nothing fails at all.
    ///
    /// So the ceiling is MEASURED through `preview_from_html` itself and the page's own spec is
    /// scanned for the number that comes out. That is the cross-process pattern this crate already
    /// uses — `update::tests` on the workflow YAML, `agent::tests` on a unit file — and for its
    /// reason: that file is on the other side of a process boundary, so a change to either side is
    /// invisible to the other.
    #[test]
    fn the_page_mirrors_this_previews_own_ceiling() {
        let cut = teams_read::preview_from_html(&format!("<p>{}</p>", "a".repeat(400)));
        assert!(cut.ends_with('…'), "a truncated preview marks its own cut");
        let length = cut.chars().count();
        let spec = include_str!("../web/src/lib/protocol.test.ts");
        assert!(
            spec.contains(&format!("toBe({length})")),
            "web/src/lib/protocol.test.ts must pin its `backendPreview` mirror at {length} code \
             points (the ceiling plus the ellipsis); move MAX_CHARS and the mirror moves with it"
        );
    }
}
