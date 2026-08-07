// Manual live check: fetch a REAL slackmojis emoji, validate it through the app's own
// rails, write it into the pack, post one message that uses it, and read the message
// back to verify the inline emoji survived.
//
// The emoji is fetched through `sender_icon::fetch_raster` (the same rails a sender
// icon uses), then validated against the same checks the RPC applies, so this exercises
// the whole chain: network fetch -> validation -> pack write -> substitution -> upload
// -> inline markup, with a real emoji from a real slackmojis URL.
//
// It is NOT a unit test: it posts to real Teams. The conversation is therefore a
// CONST, not an argument — the sandbox channel from CLAUDE.md, the one place a send is
// pre-authorized. Do not parameterize it: an example that can post anywhere is a send
// waiting for a typo, and `.claude/hooks/guard-live-automation.sh` (rule 1c) refuses
// to run one.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example custom_emoji_slackmoji
//
use anyhow::{Context, Result};
use serde_json::Value;

use teams_lite::{custom_emoji, sender_icon, teams, teams_send};

/// The sandbox channel (CLAUDE.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// IC3 token scope for AMS uploads — the same string the backend's own `IC3_SCOPE` holds
/// (src/bin/server.rs). It is spelled again because that const is private to the binary.
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";

/// The slackmojis emoji fetched for this test: alert.gif. A real URL, from the live
/// site, to exercise the whole network fetch path.
const EMOJI_URL: &str = "https://slackmojis.com/emojis/2453-alert/download";

/// The database path, resolved the same way the server does.
fn data_db_path() -> Result<String> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| std::path::PathBuf::from(h).join(".local/share"))
        })
        .context("cannot resolve a data directory: neither XDG_DATA_HOME nor HOME is set")?;
    let dir = base.join("teams-lite");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create data dir {}", dir.display()))?;
    dir.join("teams-lite.sqlite")
        .into_os_string()
        .into_string()
        .map_err(|p| anyhow::anyhow!("data path is not valid UTF-8: {p:?}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // Get IC3 token for AMS uploads.
    let ic3 = teams_lite::auth::get_token(IC3_SCOPE)
        .await
        .context("acquire IC3 token")?;

    // 1. Fetch the emoji through the app's own network rails.
    println!("fetching emoji from slackmojis...");
    let media = sender_icon::fetch_raster(EMOJI_URL, custom_emoji::MAX_CUSTOM_EMOJI_BYTES)
        .await
        .context("fetch emoji from slackmojis")?
        .context("no image returned from slackmojis")?;
    println!(
        "fetched: {} bytes, content type: {}",
        media.bytes.len(),
        media.content_type
    );

    // 2. Measure the art the way the RPC does — one call, because a validation sequence
    // written out again here is one that can disagree with the one that ships.
    let (content_type, width, height) = custom_emoji::measure_art(&media.bytes)?;
    println!("measured: {content_type}, {width}x{height} px");

    // 3. Write the emoji into the pack.
    let db_path = data_db_path().context("resolve database path")?;
    let store = teams_lite::store::Store::open(&db_path)
        .context("open store")?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .set_custom_emoji(
            "alert",
            Some((content_type, &media.bytes, width, height)),
            None,
            "slackmojis.com/emojis/2453-alert",
            now_ms,
        )
        .context("write emoji to pack")?;
    println!("wrote emoji to pack as :alert:");

    // 4. Post one message that uses the emoji, going through the REAL substitution
    // path.
    let text = "heads up :alert:";
    let emoji_art = vec![teams_send::EmojiArt {
        name: "alert".to_string(),
        content_type: content_type.to_string(),
        bytes: media.bytes.clone(),
    }];
    let (content, emoji_ids) = teams_send::resolve_custom_emoji(
        &http,
        &session,
        &ic3,
        SANDBOX,
        text,
        &emoji_art,
    )
    .await
    .context("resolve custom emoji")?;

    println!("substituted body has {} AMS ids", emoji_ids.len());

    let sent = send_with_emoji(&http, &session, &content, &emoji_ids)
        .await
        .context("send message with custom emoji")?;
    println!("posted message, id = {}", sent.id);

    // 5. Read the message back and verify the inline emoji survived.
    let stored = read_message(&http, &session, &sent.id).await?;
    println!("\n=== Stored body (raw) ===");
    let body = stored.get("content").and_then(Value::as_str).unwrap_or("");
    println!("{}", body);
    println!("=== End raw body ===\n");

    let has_inline_emoji = body.contains("itemtype=\"http://schema.skype.com/Emoji\"")
        && body.contains("itemid=\"alert\"")
        && body.contains("src=")
        && body.contains("width=")
        && body.contains("height=");

    println!(
        "inline emoji survived: {}",
        if has_inline_emoji { "yes" } else { "no" }
    );

    // 6. The last link, and the one nothing else proves: fetch the art a READER would
    // fetch and confirm it still animates. The message names `views/imgo`, which AMS
    // answers with a single still frame; `custom_emoji::original_art_url` is what turns
    // that into the original bytes, so this asserts the whole chain rather than the
    // upload alone — GIF in, GIF out, through the real tenant.
    let src = body
        .split("src=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .context("the stored body carried no src to read the art back from")?;
    let art_url = teams_lite::custom_emoji::original_art_url(src);
    println!("\nreader fetches: {art_url}");
    let art = teams_lite::teams_media::fetch_media(&http, &session, &art_url).await?;
    let animated = art.bytes.starts_with(b"GIF89a") || art.bytes.starts_with(b"GIF87a");
    println!(
        "art read back: {} | {} bytes | animated GIF: {}",
        art.content_type,
        art.bytes.len(),
        if animated { "yes" } else { "NO" }
    );
    anyhow::ensure!(
        animated,
        "the art a reader fetches is not a GIF — the animation is lost somewhere in the chain"
    );

    println!("\nOK — slackmojis custom emoji probe complete");
    // What this run LEAVES BEHIND, said plainly. The pack is the user's own store, not a
    // fixture: this wrote a row into it and nothing here takes it back, so a reader who
    // did not want `:alert:` has to be told where it now lives and how to drop it.
    println!(
        "the pack on this machine now holds :alert: permanently — remove it in \
         Settings > Custom emoji if you did not want it"
    );
    Ok(())
}

/// Send a message with explicit HTML content and amsreferences array.
async fn send_with_emoji(
    http: &reqwest::Client,
    session: &teams::Session,
    content: &str,
    emoji_ids: &[String],
) -> Result<teams_send::Sent> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages",
        urlencoding::encode(SANDBOX)
    );
    let cmid = teams_send::new_client_message_id();

    let mut body = serde_json::json!({
        "clientmessageid": cmid,
        "content": content,
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": session.self_name,
    });
    if !emoji_ids.is_empty() {
        body["amsreferences"] = serde_json::json!(emoji_ids);
    }

    let resp = http
        .post(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("send message request")?;
    let status = resp.status();
    let resp_body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!(
            "send -> {status}: {}",
            resp_body.chars().take(500).collect::<String>()
        );
    }

    Ok(teams_send::Sent {
        id: sent_message_id(&resp_body),
        client_message_id: cmid,
    })
}

/// The server message id in a send response, or `""` when it carries none.
fn sent_message_id(body: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    parsed
        .get("id")
        .or_else(|| parsed.get("OriginalArrivalTime"))
        .and_then(|v| {
            v.as_str()
                .map(String::from)
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
}

/// One message resource in the sandbox channel, as Teams currently holds it.
async fn read_message(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
) -> Result<Value> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(SANDBOX),
        urlencoding::encode(message_id)
    );
    let resp = http
        .get(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .send()
        .await
        .context("read the message back")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    anyhow::ensure!(
        status.is_success(),
        "read -> {status}: {}",
        body.chars().take(500).collect::<String>()
    );
    serde_json::from_str(&body).context("the message body is not JSON")
}
