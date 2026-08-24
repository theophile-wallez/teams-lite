// Manual live check for a post's TITLE: send one with `properties.subject`, read it back
// through this crate's own parser, EDIT it both ways, and remove what it posted.
//
// It pins the three facts the feature rests on, and only a live round-trip gives any of
// them:
//   1. `properties.subject` on a SEND is what the service stores as the post's title —
//      `teams_send::SUBJECT`, written by `build_body`. The read path already decodes that
//      field on every inbound message (`parse_thread` in src/teams_read.rs), so the shape
//      is proven INBOUND; what nothing here could know is whether the service accepts it
//      from a client. A wrong spelling does not fail: the message posts with no title,
//      which is exactly the differentiation this feature exists to draw.
//   2. an EDIT that does not restate the subject DELETES it. The service assigns
//      `properties` rather than merging it, so rewriting one word of a titled post loses
//      the line above the body — for everybody in the thread, silently.
//   3. an edit that DOES restate it keeps it, which is what `build_edit_body` now does
//      with the title this machine's own store holds (see the `edit` handler).
//
// It is NOT a unit test: it posts to real Teams. Two rails, both deliberate:
//   - the conversation is a CONST — the sandbox chat from AGENTS.md, the one place a send
//     is pre-authorized. Do not parameterize it (rule 1c of
//     .claude/hooks/guard-live-automation.sh refuses an example that can post anywhere).
//   - what it posts it removes: both messages are deleted on the way out, so the sandbox
//     thread is left as it was found.
//
// A CHANNEL is where a titled post really lives, and there is no sandbox channel — so what
// this measures is the service accepting the property on the messages endpoint, which is
// one endpoint for a chat and a channel alike. One titled post in a real channel stays the
// user's own click, in their own app.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example channel_subject_probe
use anyhow::{Context, Result};

use teams_lite::{teams, teams_read, teams_send};

/// The sandbox chat (AGENTS.md § Sending messages). The only pre-authorized target, and
/// the only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// The title under test. Ordinary words, so a colleague who sees the thread before the
/// probe removes the message reads something that explains itself.
const TITLE: &str = "channel subject probe — this is the title";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // 1. Two titled messages, posted through this crate's own send — so what is measured
    //    is what ships rather than a hand-built body beside it. One is edited each way.
    let bare_edit = post_titled(&http, &session, "this one is edited WITHOUT its title").await?;
    let kept_edit = post_titled(&http, &session, "this one is edited WITH its title").await?;
    for (label, id) in [("bare", &bare_edit), ("kept", &kept_edit)] {
        let stored = subject_of(&http, &session, id).await?;
        println!(
            "{label}: after the send the stored title is {:?} — {}",
            stored,
            match stored.as_deref() {
                Some(TITLE) => "ACCEPTED, byte for byte",
                Some(_) => "accepted but REWRITTEN",
                None => "IGNORED: properties.subject is not the field",
            }
        );
    }

    // 2. The hazard: an edit that restates nothing.
    edit(&http, &session, &bare_edit, None).await?;
    let after_bare = subject_of(&http, &session, &bare_edit).await?;
    println!(
        "bare: after an edit carrying no title, the stored title is {:?} — {}",
        after_bare,
        match after_bare.as_deref() {
            None => "GONE, so `properties` is ASSIGNED and an edit must carry the title",
            Some(_) => "still there: the service MERGES properties on an edit",
        }
    );

    // 3. The fix: the edit the app really makes, carrying the stored title with it.
    edit(&http, &session, &kept_edit, Some(TITLE)).await?;
    let after_kept = subject_of(&http, &session, &kept_edit).await?;
    println!(
        "kept: after an edit carrying the title, the stored title is {:?} — {}",
        after_kept,
        if after_kept.as_deref() == Some(TITLE) { "KEPT" } else { "LOST ANYWAY" }
    );

    // Leave the sandbox as it was found. A deletion is final, which is exactly why the
    // probe removes only the messages it posted itself, addressed by the ids the sends
    // answered with.
    for id in [&bare_edit, &kept_edit] {
        teams_send::delete_message(&http, &session, SANDBOX_THREAD, id)
            .await
            .context("remove the probe's own message")?;
    }
    println!("removed both of the probe's messages");
    Ok(())
}

/// Post one titled message and return its server id.
async fn post_titled(
    http: &reqwest::Client,
    session: &teams::Session,
    note: &str,
) -> Result<String> {
    let sent = teams_send::send_message(
        http,
        session,
        "",
        SANDBOX_THREAD,
        "",
        None,
        Some(&format!("<p>channel subject probe — {note}</p>")),
        &[],
        &[],
        // A probe mentions nobody: a mention notifies the person it names.
        &[],
        None,
        Some(TITLE),
        // A probe seals nothing: it posts to the sandbox chat in the clear.
        None,
    )
    .await
    .context("send a titled message")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send answered with no id to address");
    Ok(sent.id)
}

/// Rewrite one message's body, with or without restating its title.
async fn edit(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
    subject: Option<&str>,
) -> Result<()> {
    teams_send::edit_message(
        http,
        session,
        SANDBOX_THREAD,
        message_id,
        "",
        Some("<p>channel subject probe — the body was rewritten by an edit</p>"),
        &[],
        subject,
        None, // a probe posts in the clear
    )
    .await
    .context("edit a titled message")
    // The edit answers with the body it posted; this probe seals nothing, so there is
    // nothing to compare and the body is dropped.
    .map(|_posted| ())
}

/// The title the service really stored for one message, read back through the app's own
/// parser rather than out of the raw JSON: what the app will draw is what this reports.
async fn subject_of(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
) -> Result<Option<String>> {
    let page = teams_read::fetch_newest(http, session, SANDBOX_THREAD)
        .await
        .context("read the thread back")?;
    Ok(page
        .messages
        .iter()
        .find(|m| m.id == message_id)
        .map(|m| m.thread_subject.clone())
        .filter(|s| !s.is_empty()))
}
