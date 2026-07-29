// Manual live check of the mail WIRE CONTRACT, against a running backend.
//
// The seam this closes: `src/bin/server.rs` serializes mail, and
// `web/src/lib/protocol.ts` declares what it expects. Unit tests cover each side
// separately and the mock mirrors the shape by hand, so a mismatch between the two —
// a renamed field, a missing key — would only surface at runtime in the browser.
// This connects to the real backend over its real WebSocket and asserts that every
// field the web client reads is actually present.
//
// Start a READ-ONLY backend first (it binds 19430, never competing with the user's
// own on 19420), then run this:
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     TEAMS_LITE_READ_ONLY=1 cargo run --bin server &
//   cargo run --example mail_rpc_check
//
// READS ONLY — the five methods it calls are the entire mail surface, and all five
// are reads. It prints field names and sizes, never mail content.
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

const BACKEND: &str = "ws://127.0.0.1:19430";

/// Assert an object carries every key the web client reads, and report which.
fn require_keys(what: &str, value: &Value, keys: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .with_context(|| format!("{what} is not an object: {value}"))?;
    let missing: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|key| !object.contains_key(*key))
        .collect();
    anyhow::ensure!(
        missing.is_empty(),
        "{what} is missing {missing:?} — web/src/lib/protocol.ts expects them"
    );
    println!("  {what}: all {} expected fields present", keys.len());
    Ok(())
}

struct Client {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: i64,
}

impl Client {
    async fn connect() -> Result<Self> {
        let (socket, _) = tokio_tungstenite::connect_async(BACKEND)
            .await
            .with_context(|| format!("connect {BACKEND} (is a read-only backend running?)"))?;
        Ok(Self { socket, next_id: 1 })
    }

    /// Send one request and return its result, skipping the events that arrive
    /// interleaved (`status`, `mail_list_updated`, …).
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                request.to_string().into(),
            ))
            .await?;
        while let Some(frame) = self.socket.next().await {
            let text = match frame? {
                tokio_tungstenite::tungstenite::Message::Text(t) => t,
                _ => continue,
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_i64) != Some(id) {
                continue; // a server-pushed event, not our answer
            }
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                anyhow::bail!("{method} failed: {error}");
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
        anyhow::bail!("{method}: connection closed before an answer")
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut client = Client::connect().await?;

    println!("== mail_folders ==");
    let folders = client.call("mail_folders", json!({})).await?;
    let folders = folders.as_array().context("mail_folders must be an array")?;
    anyhow::ensure!(!folders.is_empty(), "no folders returned");
    println!("  {} folders", folders.len());
    require_keys(
        "folder",
        &folders[0],
        &[
            "id",
            "display_name",
            "well_known",
            "total_count",
            "unread_count",
            "position",
        ],
    )?;

    let inbox = folders
        .iter()
        .find(|f| f["well_known"] == "Inbox")
        .context("no inbox in the folder list")?;
    let inbox_id = inbox["id"].as_str().context("inbox has no id")?.to_string();

    println!("== mail_list ==");
    let list = client
        .call("mail_list", json!({ "folder": inbox_id, "limit": 10 }))
        .await?;
    require_keys("list page", &list, &["messages", "has_more"])?;
    let messages = list["messages"].as_array().context("messages must be an array")?;
    // A cold store answers an empty page and syncs in the background; retry once so
    // the check is meaningful on a first run.
    let messages = if messages.is_empty() {
        println!("  (cold cache — waiting for the background sync)");
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let list = client
            .call("mail_list", json!({ "folder": inbox_id, "limit": 10 }))
            .await?;
        list["messages"].as_array().cloned().unwrap_or_default()
    } else {
        messages.clone()
    };
    anyhow::ensure!(!messages.is_empty(), "no mail returned for the inbox");
    println!("  {} headers", messages.len());
    require_keys(
        "header",
        &messages[0],
        &[
            "id",
            "folder_id",
            "conversation_id",
            "subject",
            "from",
            "to",
            "cc",
            "received",
            "is_read",
            "has_attachments",
            "importance",
            "preview",
        ],
    )?;
    require_keys("header.from", &messages[0]["from"], &["name", "address"])?;

    println!("== mail_backfill ==");
    let oldest = messages
        .last()
        .and_then(|m| m["received"].as_str())
        .context("no received timestamp to page from")?;
    let older = client
        .call(
            "mail_backfill",
            json!({ "folder": inbox_id, "before": oldest, "limit": 5 }),
        )
        .await?;
    require_keys("backfill page", &older, &["messages", "has_more"])?;
    for mail in older["messages"].as_array().cloned().unwrap_or_default() {
        let received = mail["received"].as_str().unwrap_or_default();
        anyhow::ensure!(
            received < oldest,
            "backfill returned a row inside the previous page"
        );
    }
    println!(
        "  {} older headers, all strictly older",
        older["messages"].as_array().map(|a| a.len()).unwrap_or(0)
    );

    println!("== mail_body ==");
    let id = messages[0]["id"].as_str().context("header has no id")?;
    let body = client.call("mail_body", json!({ "id": id })).await?;
    require_keys(
        "body",
        &body,
        &[
            "html",
            "blocked_remote_images",
            "truncated",
            "attachments",
            "header",
        ],
    )?;
    // The header the deep-link path depends on must be a full header, not a stub.
    require_keys("body.header", &body["header"], &["id", "subject", "from", "received"])?;
    let html = body["html"].as_str().unwrap_or_default();
    println!("  html={} B", html.len());
    for forbidden in ["src=\"http", "<script", "<iframe"] {
        anyhow::ensure!(
            !html.to_ascii_lowercase().contains(forbidden),
            "a body served over the wire contains `{forbidden}`"
        );
    }

    println!("== mail_attachment ==");
    match messages
        .iter()
        .find(|m| m["has_attachments"].as_bool() == Some(true))
    {
        None => println!("  (no mail with attachments in this page — skipped)"),
        Some(mail) => {
            let mail_id = mail["id"].as_str().unwrap_or_default();
            let body = client.call("mail_body", json!({ "id": mail_id })).await?;
            let attachments = body["attachments"].as_array().cloned().unwrap_or_default();
            match attachments.iter().find(|a| a["is_inline"] != json!(true)) {
                None => println!("  (only inline attachments — skipped)"),
                Some(attachment) => {
                    require_keys(
                        "attachment",
                        attachment,
                        &["id", "name", "content_type", "size", "is_inline"],
                    )?;
                    let fetched = client
                        .call(
                            "mail_attachment",
                            json!({
                                "message_id": mail_id,
                                "attachment_id": attachment["id"],
                            }),
                        )
                        .await?;
                    require_keys(
                        "attachment bytes",
                        &fetched,
                        &["content_type", "name", "data_base64"],
                    )?;
                    println!(
                        "  {} base64 chars",
                        fetched["data_base64"].as_str().unwrap_or_default().len()
                    );
                }
            }
        }
    }

    println!("OK — every field web/src/lib/protocol.ts reads is present on the wire");
    Ok(())
}
