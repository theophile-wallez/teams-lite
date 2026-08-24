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
    let words = truncate(&teams_read::preview_for_message(message), MAX_BODY_CHARS);
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

}
