// Live probe: can this app PUBLISH a chat's pin, mute and hide to Teams, and does the
// tenant report the change back?
//
// This one WRITES. It is pinned to the designated sandbox chat and names no other
// conversation (AGENTS.md § Sending messages), so a mistake lands where a mistake is
// harmless — the same rule examples/agent_stream_probe.rs follows, enforced by
// .claude/hooks/guard-live-automation.sh.
//
// It answers what the read-only recon cannot (see examples/chat_settings_recon.rs,
// which measured WHICH property carries each setting):
//   1. does `PUT {chatService}/v1/users/ME/conversations/{id}/properties?name=<key>`
//      answer 200 for `alerts` (mute), `ispinned` (pin) and `historyHiddenTime` (hide);
//   2. does the CSA aggregator — the payload the sidebar is built from — then report
//      `isMuted` / `isSticky` / `hidden` to match.
//
// Every write is undone before it exits: the original value is captured first and put
// back at the end, so the sandbox chat is left exactly as it was found.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example chat_settings_probe
use anyhow::{Context, Result};
use serde_json::Value;

/// The ONE conversation this file may touch — the designated sandbox chat. Hard-coded
/// on purpose: an example holds a broker token, so nothing but this constant stands
/// between it and a colleague's chat.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// How long to wait for CSA to catch up with a write before reading it back.
const SETTLE_MS: u64 = 2_500;

struct Probe {
    http: reqwest::Client,
    session: teams_lite::teams::Session,
    chat_service: String,
    csa_token: String,
}

impl Probe {
    /// The sandbox chat's own property bag, straight from the chat service.
    async fn properties(&self) -> Result<Value> {
        let url = format!(
            "{}/v1/users/ME/conversations/{}",
            self.chat_service,
            urlencoding::encode(SANDBOX_THREAD)
        );
        let body = self
            .http
            .get(&url)
            .header("authentication", format!("skypetoken={}", self.session.skypetoken))
            .send()
            .await?
            .text()
            .await?;
        let v: Value = serde_json::from_str(&body).context("parse conversation")?;
        Ok(v.get("properties").cloned().unwrap_or(Value::Null))
    }

    /// What CSA says about the sandbox chat — the three flags the sidebar reads.
    async fn csa_flags(&self) -> Result<(bool, bool, bool)> {
        let url = "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";
        let body = self
            .http
            .get(url)
            .bearer_auth(&self.csa_token)
            .header("x-skypetoken", &self.session.skypetoken)
            .send()
            .await?
            .text()
            .await?;
        let v: Value = serde_json::from_str(&body)?;
        let chat = v
            .get("chats")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .find(|c| c.get("id").and_then(|x| x.as_str()) == Some(SANDBOX_THREAD))
            .cloned()
            .unwrap_or(Value::Null);
        let flag = |key: &str| chat.get(key).and_then(|x| x.as_bool()).unwrap_or(false);
        Ok((flag("isSticky"), flag("isMuted"), flag("hidden")))
    }

    /// Write one property of the sandbox chat. Returns the HTTP status, so a refusal
    /// is data rather than an error: the point of the probe is which keys are writable.
    async fn write(&self, key: &str, value: &str) -> Result<reqwest::StatusCode> {
        let url = format!(
            "{}/v1/users/ME/conversations/{}/properties?name={key}",
            self.chat_service,
            urlencoding::encode(SANDBOX_THREAD)
        );
        let resp = self
            .http
            .put(&url)
            .header("authentication", format!("skypetoken={}", self.session.skypetoken))
            .json(&serde_json::json!({ key: value }))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            println!("   body: {}", body.chars().take(240).collect::<String>());
        }
        Ok(status)
    }
}

fn property(properties: &Value, key: &str) -> String {
    properties
        .get(key)
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| "<absent>".to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint")?
        .trim_end_matches('/')
        .to_string();
    let csa_token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
    let probe = Probe { http, session, chat_service, csa_token };

    println!("== sandbox chat {SANDBOX_THREAD}");
    let before = probe.properties().await?;
    let (sticky, muted, hidden) = probe.csa_flags().await?;
    println!(
        "-- before: alerts={} ispinned={} historyHiddenTime={} | CSA isSticky={sticky} isMuted={muted} hidden={hidden}",
        property(&before, "alerts"),
        property(&before, "ispinned"),
        property(&before, "historyHiddenTime"),
    );

    // Each case: the property, the value that turns the setting ON, and the value that
    // restores the Teams default. The mute is inverted — `alerts` is notifications, so
    // "false" is muted.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .to_string();
    // The extra candidates are there because the first probe run proved `alerts` and
    // disproved `ispinned`: the property took the write and CSA's `isSticky` did not
    // move. A key that CSA does not read back is a key this app must not write.
    let cases: [(&str, &str, &str, &str); 6] = [
        ("mute", "alerts", "false", "true"),
        ("pin", "ispinned", "true", "false"),
        ("pin (candidate)", "sticky", "true", "false"),
        ("pin (candidate)", "pinned", "true", "false"),
        ("pin (candidate)", "favorite", "true", "false"),
        ("hide", "historyHiddenTime", now_ms.as_str(), "0"),
    ];

    for (label, key, on, default) in cases {
        println!("-- {label}: PUT name={key} <- {on}");
        let status = probe.write(key, on).await?;
        println!("   -> {status}");
        if !status.is_success() {
            continue;
        }
        tokio::time::sleep(std::time::Duration::from_millis(SETTLE_MS)).await;
        let after = probe.properties().await?;
        let (sticky, muted, hidden) = probe.csa_flags().await?;
        println!(
            "   property now {}={} | CSA isSticky={sticky} isMuted={muted} hidden={hidden}",
            key,
            property(&after, key)
        );

        // Put it back. The original value when there was one, the Teams default when the
        // property did not exist — either way the chat is left as it was found.
        let restore = match property(&before, key) {
            v if v == "<absent>" => default.to_string(),
            v => v,
        };
        println!("   restoring {key} <- {restore}");
        let status = probe.write(key, &restore).await?;
        println!("   -> {status}");
    }

    tokio::time::sleep(std::time::Duration::from_millis(SETTLE_MS)).await;
    let after = probe.properties().await?;
    let (sticky, muted, hidden) = probe.csa_flags().await?;
    println!(
        "-- after restore: alerts={} ispinned={} historyHiddenTime={} | CSA isSticky={sticky} isMuted={muted} hidden={hidden}",
        property(&after, "alerts"),
        property(&after, "ispinned"),
        property(&after, "historyHiddenTime"),
    );
    Ok(())
}
