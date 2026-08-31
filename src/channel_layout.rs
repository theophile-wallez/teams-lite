// How a CHANNEL is laid out: as a wall of titled POSTS, or as a running CONVERSATION with
// its replies behind a threads panel. Teams has both and the choice is the channel's own —
// made where the channel was created and read here, never guessed.
//
// It is one field on the channel's own THREAD, and the request that carries it is the one
// `teams_members::fetch_thread` already makes:
//
//   GET {chatService}/v1/threads/{channel}?view=msnp24Equivalent
//     -> { "properties": { "chatModalityType": "Conversational" | "PostReply", … }, … }
//
// MEASURED against the real tenant on 2026-08-31, over all 70 channels this account holds
// (`examples/channel_layout_recon.rs`, READ-ONLY):
//
//   - `Conversational`  6 channels
//   - `PostReply`      10 channels
//   - (absent)         54 channels
//
// And the fact that makes the field trustworthy rather than plausible: the two channels the
// user can name in their own client came back exactly as their own client draws them —
// `[Run] 👨‍💻 Devs` conversational, `[Run] Engine merge requests` posts.
//
// CSA's own `channelType` (0 / 1) is NOT this: it is private-vs-shared, and reading it as a
// layout is the mistake § The channel sidebar mirrors Teams records twice already
// (`isFavorite` is Show/Hide, `hidden` is not Teams' Hide).
//
// This module issues no request of its own — it delegates — so there is one spelling of that
// endpoint and one place the GET-only scan has to hold.

use anyhow::Result;
use serde_json::Value;

/// The service's own word for a channel drawn as a running conversation.
pub const CONVERSATIONAL: &str = "Conversational";
/// The service's own word for a channel drawn as titled posts with threaded replies.
pub const POST_REPLY: &str = "PostReply";

/// How this app draws a channel's history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChannelLayout {
    /// Titled announcements, each with its replies under it in a card of its own. What
    /// every channel in this app was drawn as before the layout was read, and what an
    /// ABSENT or unrecognised modality means (see [`from_thread`]).
    #[default]
    Posts,
    /// A running conversation of chat bubbles, whose replies live in a threads panel.
    Conversation,
}

impl ChannelLayout {
    /// The one spelling that travels to a page, and the one a page sends back.
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelLayout::Posts => "posts",
            ChannelLayout::Conversation => "conversation",
        }
    }
}

/// Read the layout off a channel's own thread payload.
///
/// **Anything but `Conversational` is POSTS**, and that is the whole of the rule rather than
/// an omission. An ABSENT modality is 54 of this tenant's 70 channels — every classic one —
/// and posts is what this app has always drawn there; a modality this build has not heard of
/// takes the same answer, because drawing a surface built for one shape on the strength of a
/// word nobody measured is exactly what `mergeVerdict` refuses for an unknown merge status.
/// So the narrow, already-shipped answer is the fallback, and only the service's own
/// [`CONVERSATIONAL`] opts a channel into the other one.
pub fn from_thread(payload: &Value) -> ChannelLayout {
    match payload.get("properties").and_then(|p| p.get("chatModalityType")).and_then(Value::as_str)
    {
        Some(CONVERSATIONAL) => ChannelLayout::Conversation,
        _ => ChannelLayout::Posts,
    }
}

/// Fetch one channel's layout.
///
/// The request is `teams_members::fetch_thread`'s — see this module's own header for why it
/// is not repeated here.
pub async fn fetch(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    channel_id: &str,
) -> Result<ChannelLayout> {
    Ok(from_thread(&crate::teams_members::fetch_thread(http, session, channel_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape the tenant really answers with, captured by
    /// `examples/channel_layout_recon.rs` — the modality sits inside `properties`, beside
    /// the roster fields, and never at the top level.
    #[test]
    fn the_modality_is_read_out_of_properties() {
        let conversational = json!({
            "id": "19:devs@thread.tacv2",
            "type": "Thread",
            "properties": { "chatModalityType": CONVERSATIONAL, "topic": "Devs" },
            "members": [],
        });
        assert_eq!(from_thread(&conversational), ChannelLayout::Conversation);

        let posts = json!({
            "id": "19:mrs@thread.tacv2",
            "properties": { "chatModalityType": POST_REPLY },
        });
        assert_eq!(from_thread(&posts), ChannelLayout::Posts);
    }

    /// 54 of this tenant's 70 channels carry NO modality at all, and posts is what this app
    /// has always drawn for every one of them. A word nobody measured takes the same
    /// answer: the narrow, already-shipped surface is never something an unknown value
    /// opts a channel out of.
    #[test]
    fn anything_but_conversational_is_posts() {
        for payload in [
            json!({ "id": "19:x@thread.tacv2" }),
            json!({ "properties": {} }),
            json!({ "properties": { "chatModalityType": Value::Null } }),
            json!({ "properties": { "chatModalityType": "" } }),
            json!({ "properties": { "chatModalityType": "conversational" } }),
            json!({ "properties": { "chatModalityType": "SomethingNewIn2027" } }),
            json!({ "properties": "not an object" }),
        ] {
            assert_eq!(
                from_thread(&payload),
                ChannelLayout::Posts,
                "only the service's own `{CONVERSATIONAL}` may opt a channel into the \
                 conversation layout: {payload}"
            );
        }
    }

    /// The default is what a store, a payload and a page too old to name a layout all read
    /// as — and it has to be the surface that already shipped.
    #[test]
    fn the_default_is_posts() {
        assert_eq!(ChannelLayout::default(), ChannelLayout::Posts);
        assert_eq!(ChannelLayout::Posts.as_str(), "posts");
        assert_eq!(ChannelLayout::Conversation.as_str(), "conversation");
    }

    /// The endpoint is spelled ONCE, in `teams_members`, where the GET-only scan holds. A
    /// copy here would be a second thing to keep in step with the service and one that scan
    /// could not see — so what is scanned for is the REQUEST rather than a verb name:
    /// `payload.get("properties")` is this module's own reading of an answer, and a `.get(`
    /// ban would fire on it while a hand-rolled POST spelled another way went past.
    #[test]
    fn this_module_makes_no_request_of_its_own() {
        let source = include_str!("channel_layout.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let code: String = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("fetch_thread(http, session"), "scanned the wrong text");
        for spelling in ["v1/threads", ".send(", "skypetoken=", "chatService"] {
            assert!(
                !code.contains(spelling),
                "src/channel_layout.rs must delegate its read to \
                 `teams_members::fetch_thread`, found `{spelling}`"
            );
        }
    }
}
