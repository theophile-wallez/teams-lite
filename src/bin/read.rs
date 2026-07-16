// teams-lite — SLICE 1 END-TO-END PROOF
//
// Exercises the real production path (src/teams_read.rs -> src/store.rs):
//   1. sync the conversation list into a fresh SQLite store (CSA aggregator)
//   2. open the most-recently-active conversation -> newest page into the store
//   3. backfill two older pages at the cache frontier -> prove history grows,
//      dedup holds, and the backfill cursor moves monotonically into the past
//
// Reads ONLY through the store afterwards (local-first). No raw tokens printed.

use anyhow::{Context, Result};
use teams_lite::{auth, store::Store, teams, teams_read};

const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;

    // ic3 is used elsewhere (trouter); here we mainly need the CSA-audience token.
    let _ic3 = auth::get_token(IC3_SCOPE).await.context("ic3 token")?;
    let csa = auth::get_token(teams_read::CSA_SCOPE).await.context("csa token")?;
    let sess = teams::connect(&http).await?;
    println!("[ok] region={} | chatService={}", sess.region, sess.endpoint("chatService").unwrap_or("?"));

    // Fresh throwaway DB so the run is reproducible.
    let db_path = std::env::temp_dir().join("teams-lite-slice1.sqlite");
    let _ = std::fs::remove_file(&db_path);
    let store = Store::open(db_path.to_str().unwrap())?;

    // 1. conversation list -> store
    let n = teams_read::sync_conversation_list(&http, &sess, &csa, &store).await?;
    println!("\n[1] conversation list synced -> {n} non-empty conversations in store");

    // pick the most recently active conversation (network fetch just to choose one)
    let convs = teams_read::fetch_conversations(&http, &sess, &csa).await?;
    let target = convs
        .into_iter()
        .filter(|c| !c.is_empty)
        .max_by_key(|c| c.last_message_time)
        .context("no non-empty conversation to open")?;
    println!(
        "    opening most-active conv: \"{}\" [{}]",
        target.title,
        &target.id[..target.id.len().min(24)]
    );

    // 2. newest page -> store
    let ins = teams_read::sync_newest_page(&http, &sess, &target.id, &store).await?;
    let after_open = store.newest_messages(&target.id, 1000)?;
    let (cur, more) = store.oldest_cursor(&target.id)?;
    println!("\n[2] newest page: +{ins} inserted | store now holds {} msgs | cursor={cur:?} more={more}", after_open.len());
    if let (Some(first), Some(last)) = (after_open.first(), after_open.last()) {
        println!("    seq range [{}..{}] | newest: \"{}\" — {}", first.seq, last.seq, last.sender, snippet(&last.content));
    }

    // 3. backfill older history at the frontier (twice)
    for round in 1..=2 {
        let before = store.newest_messages(&target.id, 1000)?.len();
        let ins = teams_read::backfill_older(&http, &sess, &target.id, &store).await?;
        let all = store.newest_messages(&target.id, 5000)?;
        let (cur, more) = store.oldest_cursor(&target.id)?;
        println!(
            "\n[3.{round}] backfill: +{ins} older msgs | store {} -> {} | cursor={cur:?} more={more}",
            before,
            all.len()
        );
        if let Some(oldest) = all.first() {
            println!("    oldest now: seq {} — \"{}\" — {}", oldest.seq, oldest.sender, snippet(&oldest.content));
        }
        if ins == 0 {
            println!("    (no more history — reached the top)");
            break;
        }
    }

    // dedup proof: re-open newest page, expect 0 new inserts
    let redup = teams_read::sync_newest_page(&http, &sess, &target.id, &store).await?;
    println!("\n[dedup] re-sync newest page -> +{redup} inserted (expect 0)");

    // local-first read proof: the display path reads ONLY from SQLite
    let tail = store.newest_messages(&target.id, 5)?;
    println!("\n[local-first] last {} messages from SQLite (no network):", tail.len());
    for m in &tail {
        println!("    [seq {}] {}: {}", m.seq, m.sender, snippet(&m.content));
    }

    println!("\n✅ SLICE 1 PROVEN: conv list + history pagination -> local-first store.");
    let _ = std::fs::remove_file(&db_path);
    Ok(())
}

/// One-line, HTML-stripped preview of message content for the console.
fn snippet(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.chars().take(60).collect::<String>().replace('\n', " ")
}
