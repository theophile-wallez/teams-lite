// Manual live check for the read state: what the unread marker and "seen by" are
// built from (src/teams_readstate.rs).
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY:
//   1. the unread chats     (the CSA `users/me` aggregator's `isRead` flag)
//   2. every member's read position for one thread
//      (GET {chatService}/v1/threads/{id}/consumptionhorizons)
//   3. the newest message we would declare as read for that thread
//
// It never WRITES a horizon. Marking a thread read is a PUT of the conversation's
// own horizon property, which clears the unread marker on every device the user owns
// and shows the sender a read receipt; it lives behind the gated `mark_read` RPC
// (src/bin/server.rs and src/teams_readstate.rs), and
// .claude/hooks/guard-live-automation.sh blocks any command that issues it directly —
// including this file, if it ever named that endpoint. The write was verified once
// against this tenant, with the user's consent: it answers 200 and CSA then reports
// the thread as read.
//
//   # list the unread chats
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example readstate_recon
//
//   # one thread's read positions
//   … cargo run --example readstate_recon -- --conv 19:<id>
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let conversation = args
        .iter()
        .position(|a| a == "--conv")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    println!("== region={} self={}", session.region, session.self_mri);

    let Some(conversation) = conversation else {
        let csa = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
        let convs = teams_lite::teams_read::fetch_conversations(&http, &session, &csa).await?;
        let mut unread: Vec<_> = convs.iter().filter(|c| !c.is_read && !c.is_empty).collect();
        unread.sort_by_key(|c| -c.last_message_time);
        println!("== {} unread of {} conversations", unread.len(), convs.len());
        for c in unread.iter().take(20) {
            println!(
                "-- {}\n   {:?} kind={} muted={} last={} preview={:?}",
                c.id,
                c.title,
                c.kind().as_str(),
                c.is_muted,
                c.last_message_time,
                c.last_message_preview.chars().take(60).collect::<String>(),
            );
        }
        return Ok(());
    };

    let horizons =
        teams_lite::teams_readstate::fetch_consumption_horizons(&http, &session, &conversation)
            .await?;
    println!("== read positions ({} members)", horizons.len());
    for h in &horizons {
        println!("   {} -> {} @ {}", h.mri, h.last_read_message_id, h.read_time_ms);
    }

    // The position `mark_read` would publish: the newest message we hold, because a
    // read position must name a message the user could actually see.
    let page = teams_lite::teams_read::fetch_newest(&http, &session, &conversation).await?;
    match page.messages.last() {
        Some(m) => println!("== newest message id={} from={:?}", m.id, m.sender),
        None => println!("== no message in the newest page"),
    }
    Ok(())
}
