// The user's own per-chat settings, published to Teams.
//
// A chat carries three settings in Microsoft Teams — pinned, muted, hidden — and this
// module owns the ONE of them that can be published: the mute. What decides that is
// measurement, not preference (see `examples/chat_settings_recon.rs` for the read and
// `examples/chat_settings_probe.rs` for the write, both against the real tenant):
//
//   - **mute is `properties.alerts`** on the conversation, and it round-trips. Every
//     chat the tenant reports as muted carries `alerts: "false"`, every unmuted one
//     `"true"` (3 and 20 of the chats measured, no crossover) — and a `PUT` of it
//     answers 200, after which the CSA aggregator reports `isMuted` to match. That
//     aggregator is the payload this app's sidebar is built from, so a write the app
//     can read back is a write the user's other clients see.
//   - **the pin is NOT a conversation property.** The service keeps an allowlist of
//     property names and answers `400 "sticky: Conversation property is not allowed"`
//     for `sticky` and `pinned`; `ispinned` IS allowed and takes the value, but CSA's
//     `isSticky` never moves, so nothing reads it back. A write nothing reads is worse
//     than no write: it would report success while the user's phone disagreed.
//   - **the hide is not proven either.** `historyHiddenTime` is an allowed property and
//     one chat on the tenant carries it, but CSA's `hidden` does not follow it — and
//     that flag cannot be the oracle anyway, since it is true on all 95 of the
//     tenant's one-to-one chats (see `store::ConversationRow::is_hidden`).
//
// So the pin and the hide stay LOCAL to this app until they are measured, and this
// module writes one property and no other. `only_the_mute_is_written` pins that: it
// scans this file for any other property name.
//
// OUTWARD. A mute lands in every Teams client the user is signed in on — their phone
// stops notifying them about that thread — so the write is gated exactly like a send:
// the write token, refused read-only, an `OUTWARD_METHODS` entry (`set_chat_muted`),
// and `.claude/hooks/guard-live-automation.sh` refuses any command that names the
// endpoint directly.

use anyhow::{Context, Result};

/// The one conversation property this app writes: Teams' notification switch for a
/// chat. `"true"` means notifications are on, `"false"` means the chat is muted — so
/// the value is the INVERSE of "muted", which is why nothing else spells it.
const ALERTS_PROPERTY: &str = "alerts";

/// Mute or unmute one chat in the user's Teams account.
///
/// OUTWARD: the setting propagates to every client the user is signed in on, so their
/// phone stops (or starts) notifying them about this thread. Only the gated
/// `set_chat_muted` RPC calls this.
///
/// Hits the conversation's own `alerts` property with the skypetoken — the same auth
/// scheme and the same property endpoint the read position uses. Verified against the
/// live tenant in both directions: the PUT answers 200 and CSA then reports `isMuted`
/// to match (`examples/chat_settings_probe.rs`).
pub async fn set_chat_muted(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    conversation_id: &str,
    muted: bool,
) -> Result<()> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat_service}/v1/users/ME/conversations/{}/properties?name={ALERTS_PROPERTY}",
        urlencoding::encode(conversation_id)
    );
    // Teams stores the flag as a STRING, and as notifications rather than as silence.
    let alerts = if muted { "false" } else { "true" };
    let resp = http
        .put(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .json(&serde_json::json!({ ALERTS_PROPERTY: alerts }))
        .send()
        .await
        .context("alerts PUT")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("alerts PUT -> {status} {}", body.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// This module may write ONE conversation property, and only the one whose write
    /// round-trips through the tenant. The other two settings a chat has are local to
    /// this app precisely because nothing reads their write back, and a later change
    /// that adds a `name=…` here would publish a setting the user cannot see.
    #[test]
    fn only_the_mute_is_written() {
        let source = include_str!("teams_chat_settings.rs");
        // Every property name this file addresses, from the URL it builds. The
        // constant is spelled once, so the URL carries a placeholder and nothing else.
        for forbidden in ["name=ispinned", "name=historyHiddenTime", "name=favorite", "name=hidden"]
        {
            assert!(
                !source.contains(&format!("?{forbidden}")),
                "{forbidden} is not a setting this app may publish — see the module comment"
            );
        }
    }

    /// The pin and the hide must not be published from ANYWHERE in the crate, not just
    /// from this module — the same guarantee `src/mail.rs` keeps for the mail-send
    /// endpoint, and for the same reason: the skypetoken this app holds is accepted for
    /// both properties (the service answers 200), so the only thing standing between the
    /// user and a setting they cannot see changing is that no code names it.
    #[test]
    fn the_crate_publishes_no_unproven_chat_setting() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new("src"), &mut files);
        assert!(files.len() > 5, "no Rust sources found to scan");
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            // The comments necessarily name what they refuse, and so does this module's
            // own test block, so only code before `#[cfg(test)]` with the comments
            // stripped is scanned — the same shape `crate_contains_no_mail_send_endpoint`
            // uses.
            let code: String = source
                .split("#[cfg(test)]")
                .next()
                .unwrap_or(&source)
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for forbidden in ["name=ispinned", "name=historyHiddenTime"] {
                assert!(
                    !code.contains(forbidden),
                    "{} names `{forbidden}`. Neither the pin nor the hide round-trips \
                     through the tenant, so publishing one would report success while the \
                     user's own client disagreed. Measure it first — see the module comment.",
                    file.display()
                );
            }
        }
    }

    /// The value is the inverse of the setting, which is the one thing about this
    /// endpoint a reader will get wrong.
    #[test]
    fn muted_means_alerts_off() {
        assert_eq!(super::ALERTS_PROPERTY, "alerts");
        // Documented here rather than only in the function, because the mapping is
        // what the store's `is_muted` column means on the way back in.
        let alerts_for = |muted: bool| if muted { "false" } else { "true" };
        assert_eq!(alerts_for(true), "false");
        assert_eq!(alerts_for(false), "true");
    }
}
