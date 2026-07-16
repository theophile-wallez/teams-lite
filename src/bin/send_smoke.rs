// teams-lite — SEND SMOKE TEST (safe: note-to-self only)
//
// Proves message sending end-to-end WITHOUT risk of messaging a colleague:
//   auth -> find the self-chat (the 1:1 whose only member is us) -> send a
//   timestamped test line -> assert POST 2xx -> refetch newest -> assert the
//   message is now in the store.
//
// No raw tokens printed.

use anyhow::{Context, Result};
use serde_json::Value;
use teams_lite::store::Store;
use teams_lite::{auth, teams, teams_read, teams_send};

const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";
const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    let _ic3 = auth::get_token(IC3_SCOPE).await.context("ic3")?;
    let csa = auth::get_token(teams_read::CSA_SCOPE).await.context("csa")?;
    let sess = teams::connect(&http).await?;
    println!("[ok] region={} | self={:?} | mri={}", sess.region, sess.self_name, redact(&sess.self_mri));

    // find the self-chat: a chat whose members are all us (objectId == our guid)
    let raw = http
        .get(CSA_URL)
        .bearer_auth(&csa)
        .header("x-skypetoken", &sess.skypetoken)
        .send()
        .await?
        .text()
        .await?;
    let v: Value = serde_json::from_str(&raw).context("parse CSA")?;
    let my_guid = sess.self_mri.rsplit(':').next().unwrap_or("").to_string();
    anyhow::ensure!(!my_guid.is_empty(), "no self mri — cannot identify note-to-self safely");

    let self_chat = v
        .get("chats")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
        .find(|c| {
            let members = c.get("members").and_then(|m| m.as_array());
            match members {
                Some(ms) if !ms.is_empty() => ms.iter().all(|m| {
                    m.get("objectId").and_then(|x| x.as_str()).map(|g| g == my_guid).unwrap_or(false)
                }),
                _ => false,
            }
        })
        .and_then(|c| c.get("id").and_then(|x| x.as_str()))
        .map(String::from)
        .context("could not find a self-chat (note-to-self) — aborting to avoid messaging someone")?;

    println!("[ok] note-to-self conv = {}", &self_chat[..self_chat.len().min(28)]);

    // send a timestamped, clearly-labelled test message
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let text = format!("teams-lite send test — {ts}");
    println!("[send] \"{text}\"");
    let cmid = teams_send::send_message(&http, &sess, &self_chat, &text).await.context("send")?;
    println!("[ok] POST accepted (clientmessageid={cmid})");

    // refetch newest and confirm the message landed
    let db = std::env::temp_dir().join("teams-lite-sendsmoke.sqlite");
    let _ = std::fs::remove_file(&db);
    let store = Store::open(db.to_str().unwrap())?;
    // small delay: the message needs to be indexed server-side
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let page = teams_read::fetch_newest(&http, &sess, &self_chat).await?;
    teams_read::persist_page(&store, &self_chat, &page)?;
    let msgs = store.newest_messages(&self_chat, 50)?;

    let found = msgs.iter().any(|m| {
        // content is HTML; our text has no markup so a substring check is fine
        m.content.contains(&text)
    });
    println!("[verify] {} messages fetched; sent line present = {found}", msgs.len());
    let _ = std::fs::remove_file(&db);

    anyhow::ensure!(found, "sent message did not come back in the newest page");
    println!("\n✅ SEND PROVEN: message envoyé dans la note-to-self et relu depuis le store.");
    Ok(())
}

fn redact(mri: &str) -> String {
    match mri.rsplit_once(':') {
        Some((p, id)) if id.len() > 4 => format!("{p}:…{}", &id[id.len() - 4..]),
        _ => "<mri>".into(),
    }
}
