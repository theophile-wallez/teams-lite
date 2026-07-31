//! What deserves to buzz a phone, and what it should say.
//!
//! Separate from [`crate::push`] (which knows how to encrypt and POST) because
//! this is the part with an opinion. A phone notification is expensive in a way a
//! sidebar row is not: it interrupts. So the rules here are deliberately narrower
//! than "every live message", and they mirror what Teams itself does:
//!
//! - **A chat message notifies.** One-to-one and group chats are addressed to the
//!   user; that is the whole reason the app is on their Home Screen.
//! - **A channel post notifies only when it mentions the user.** A followed channel
//!   can produce hundreds of messages a day and none of them is a summons.
//! - **A system line never notifies.** "Call ended", "Member added" and the like
//!   are context, not news.
//! - **The user's own message never notifies**, and neither does anything already
//!   stale — a trouter reconnect can replay frames, and a phone buzzing about this
//!   morning's message is worse than silence.
//!
//! Every rule is a pure function of one stored message, so the whole policy is unit
//! tested and the delivery path in `src/bin/server.rs` stays a plumbing detail.

use crate::push::Notification;
use crate::store::Message;
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
pub struct Placement<'a> {
    /// True for a team channel (its own tab in the app), false for a chat.
    pub is_channel: bool,
    /// The chat or channel display name, `""` when the store has none yet. Used to
    /// say *where* a message came from, and only when that adds something.
    pub title: &'a str,
}

/// The notification a live message deserves, or `None` when it should stay silent.
///
/// `from_me` comes from the caller because it already resolved it (identity matching
/// needs both the display name and the MRI — see `is_self` in `src/bin/server.rs`).
pub fn notification_for(
    message: &Message,
    placement: &Placement<'_>,
    self_mri: &str,
    from_me: bool,
    now_ms: i64,
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
    if placement.is_channel && !mentions_user(&message.mentions, self_mri) {
        return None;
    }

    let body = truncate(&teams_read::preview_for_message(message), MAX_BODY_CHARS);
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
    let title = placement.title.trim();
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
            mentions: "[]".into(),
        }
    }

    fn chat() -> Placement<'static> {
        Placement { is_channel: false, title: "Ada Lovelace" }
    }

    #[test]
    fn a_chat_message_notifies_with_the_senders_name_and_the_body() {
        let notification = notification_for(&chat_message(), &chat(), SELF_MRI, false, NOW).unwrap();
        assert_eq!(notification.title, "Ada Lovelace");
        assert_eq!(notification.body, "Ready for the demo?");
        assert_eq!(notification.tag, "19:chat@thread.v2");
        assert_eq!(notification.url, "/c/19%3Achat%40thread.v2");
    }

    #[test]
    fn a_group_chat_says_where_the_message_came_from() {
        let placement = Placement { is_channel: false, title: "Release train" };
        let notification =
            notification_for(&chat_message(), &placement, SELF_MRI, false, NOW).unwrap();
        assert_eq!(notification.title, "Ada Lovelace · Release train");
    }

    #[test]
    fn our_own_message_never_notifies() {
        assert!(notification_for(&chat_message(), &chat(), SELF_MRI, true, NOW).is_none());
    }

    #[test]
    fn a_system_line_never_notifies() {
        let mut message = chat_message();
        message.system_event = r#"{"kind":"call","event":"ended"}"#.into();
        message.content = String::new();
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW).is_none());
    }

    #[test]
    fn a_deleted_message_never_notifies() {
        let mut message = chat_message();
        message.deleted = true;
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW).is_none());
    }

    #[test]
    fn an_activity_stream_frame_never_notifies() {
        let mut message = chat_message();
        message.conversation_id = teams_activity::MENTIONS_THREAD.into();
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW).is_none());
    }

    #[test]
    fn a_replayed_message_never_notifies() {
        let mut old = chat_message();
        old.compose_time = NOW - MAX_AGE_MS - 1;
        assert!(notification_for(&old, &chat(), SELF_MRI, false, NOW).is_none());

        let mut skewed = chat_message();
        skewed.compose_time = NOW + MAX_AGE_MS + 1;
        assert!(notification_for(&skewed, &chat(), SELF_MRI, false, NOW).is_none());

        let mut undated = chat_message();
        undated.compose_time = 0;
        assert!(notification_for(&undated, &chat(), SELF_MRI, false, NOW).is_none());
    }

    #[test]
    fn a_channel_post_notifies_only_when_it_mentions_us() {
        let channel = Placement { is_channel: true, title: "Engine · General" };
        let mut message = chat_message();
        message.conversation_id = "19:abc@thread.tacv2".into();

        assert!(notification_for(&message, &channel, SELF_MRI, false, NOW).is_none());

        message.mentions =
            format!(r#"[{{"itemid":0,"mri":"{SELF_MRI}","kind":"person","display_name":"Ada"}}]"#);
        let notification = notification_for(&message, &channel, SELF_MRI, false, NOW).unwrap();
        assert_eq!(notification.title, "Ada Lovelace · Engine · General");
    }

    #[test]
    fn a_mention_of_somebody_else_in_a_channel_stays_silent() {
        let channel = Placement { is_channel: true, title: "Engine · General" };
        let mut message = chat_message();
        message.mentions = format!(r#"[{{"itemid":0,"mri":"{OTHER_MRI}","kind":"person"}}]"#);
        assert!(notification_for(&message, &channel, SELF_MRI, false, NOW).is_none());
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
        assert!(notification_for(&message, &chat(), SELF_MRI, false, NOW).is_none());
    }

    #[test]
    fn a_long_body_is_truncated_for_the_lock_screen() {
        let mut message = chat_message();
        message.content = format!("<p>{}</p>", "word ".repeat(200));
        let notification = notification_for(&message, &chat(), SELF_MRI, false, NOW).unwrap();
        assert!(notification.body.chars().count() <= MAX_BODY_CHARS + 1, "{}", notification.body);
        assert!(notification.body.ends_with('…'));
    }
}
