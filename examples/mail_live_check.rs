// Manual live check for the READ-ONLY mail surface, through the production code path.
//
// Exercises `teams_lite::mail` end to end against the real mailbox — folder
// resolution, the newest page, keyset paging, and the sanitizer on real bodies — and
// reports what it found. This is the mail sibling of `broker_token.rs`: not a unit
// test, a hands-on verification that the implementation works against the tenant.
//
//   DBUS_SESSION_BUS_ADDRESS="unix:path=/proc/$(pgrep -f \
//     identity-broker/bin/microsoft-identity-broker|head -1)/root/run/user/0/bus" \
//     cargo run --example mail_live_check
//
// READS ONLY, and it prints STRUCTURE, never content: subjects, senders, addresses
// and bodies stay out of the output. What it shows is counts, sizes and shapes —
// enough to verify the pipeline, nothing that spills a mailbox into a terminal
// scrollback or a transcript.
use anyhow::Result;

/// How many of the newest mails to render, to exercise the sanitizer on real input.
const BODIES_TO_RENDER: usize = 5;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let token = teams_lite::auth::get_token(teams_lite::mail::MAIL_SCOPE).await?;

    println!("== folders ==");
    let folders = teams_lite::mail::fetch_folders(&http, &token).await?;
    for folder in &folders {
        println!(
            "  pos={:<2} well_known={:<8} total={:<6} unread={:<6} name_len={}",
            folder.position,
            if folder.well_known.is_empty() {
                "-"
            } else {
                &folder.well_known
            },
            folder.total_count,
            folder.unread_count,
            // The display name is localized and identifies nothing useful here.
            folder.display_name.chars().count(),
        );
    }

    let inbox = folders
        .iter()
        .find(|f| f.well_known == "Inbox")
        .ok_or_else(|| anyhow::anyhow!("no inbox resolved"))?;

    println!("== newest page ==");
    let page = teams_lite::mail::fetch_newest(
        &http,
        &token,
        &inbox.id,
        teams_lite::mail::DEFAULT_PAGE_SIZE,
    )
    .await?;
    println!("  {} headers", page.len());
    let unread = page.iter().filter(|m| !m.is_read).count();
    let with_attachments = page.iter().filter(|m| m.has_attachments).count();
    println!("  unread={unread} with_attachments={with_attachments}");
    if let (Some(first), Some(last)) = (page.first(), page.last()) {
        // The ordering invariant the store and the UI both rely on.
        println!("  newest={} oldest={}", first.received, last.received);
        assert!(first.received >= last.received, "page must be newest-first");
    }

    println!("== keyset paging ==");
    if let Some(oldest) = page.last() {
        let older = teams_lite::mail::fetch_older(
            &http,
            &token,
            &inbox.id,
            &oldest.received,
            teams_lite::mail::DEFAULT_PAGE_SIZE,
        )
        .await?;
        println!("  {} older headers", older.len());
        // Paging must not repeat or skip: every row is strictly older.
        for mail in &older {
            assert!(
                mail.received < oldest.received,
                "keyset paging returned a row inside the previous page"
            );
        }
    }

    println!("== bodies (sanitized) ==");
    for mail in page.iter().take(BODIES_TO_RENDER) {
        let fetched = teams_lite::mail::fetch_body(&http, &token, &mail.id).await?;
        let files = fetched.attachments.iter().filter(|a| !a.is_inline).count();
        println!(
            "  html={:>7} B  blocked_remote={:<3} inline_embedded={:<3} truncated={:<5} files={files} header={}",
            fetched.body.html.len(),
            fetched.body.blocked_remote_images,
            fetched.body.inline_images,
            fetched.body.truncated,
            fetched.header.is_some(),
        );
        // The guarantee the whole feature rests on: a rendered body reaches out to
        // nothing. Assert it on real mail, not just in unit tests.
        let html = fetched.body.html.to_ascii_lowercase();
        for forbidden in ["src=\"http", "src='http", "<script", "<iframe", "url("] {
            assert!(
                !html.contains(forbidden),
                "a sanitized body still contains `{forbidden}` — it could reach the network"
            );
        }
    }

    println!("OK — folders resolved, paging consistent, bodies inert");
    Ok(())
}
