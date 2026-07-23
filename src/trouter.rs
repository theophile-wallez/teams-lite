// Real-time trouter client as a library module (slice 6).
//
// Promoted from the proven src/bin/trouter.rs spike. Instead of printing, it emits
// parsed chat `Message`s and lifecycle `Status` over channels, and reconnects with
// backoff. The TUI spawns `run` and persists each emitted message into the store,
// then refreshes the view — that's live delivery, end to end.
//
// Flow (reverse-engineered from EionRobb/purple-teams teams_trouter.c):
//   1. POST go.trouter.teams.microsoft.com/v4/a?epid={epid}  (x-skypetoken)
//        -> { socketio, surl, connectparams, ccid? }
//   2. GET  {socketio}socket.io/1/?v=v4&{connectparams}&...   -> sessionId
//   3. WS   wss://{socketio}socket.io/1/websocket/{sessionId}?...  (+X-Skypetoken)
//   4. on "1::" -> user.authenticate (Bearer ic3) + user.activity + registrar POST
//   5. messages arrive as "3:::{...}"; ack every request, decode /messaging pushes
//
// No raw tokens are ever logged (Status carries only human-readable state).

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::store::Message;
use crate::teams::Session;

const TROUTER_BEGIN: &str = "https://go.trouter.teams.microsoft.com/v4/a";
const REGISTRAR: &str = "https://teams.microsoft.com/registrar/prod/V2/registrations";
const TCCV: &str = "2024.23.01.2";
const CLIENT_VERSION: &str = "1415/26061118216";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

/// Lifecycle signals from the real-time client (for a status line / catch-up hook).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Connecting,
    /// Socket authenticated + endpoint registered — live and receiving.
    Connected,
    /// Connection dropped; will retry after `retry_in`.
    Disconnected { retry_in_secs: u64 },
}

/// A fresh set of credentials for one trouter connection attempt.
pub struct Credentials {
    /// The Teams session (carries the skypetoken + region endpoints).
    pub session: Session,
    /// A Bearer token for the ic3 audience (socket authenticate + registrar).
    pub ic3: String,
}

/// Supplies fresh credentials on demand. The trouter calls this before EVERY
/// connection attempt, so a reconnection after a long-lived socket dropped gets
/// a freshly-minted skypetoken and ic3 token instead of the boot-time ones —
/// which is what keeps the real-time feed alive past the ~1h token lifetime.
///
/// This is a dependency-inversion boundary: the trouter states what it needs
/// (fresh credentials) without knowing HOW they are obtained (broker, cache,
/// TTL, session rebuild — all owned by the caller).
pub trait CredentialProvider: Send + Sync {
    /// Return freshly-valid credentials, refreshing through whatever backing
    /// mechanism the implementor owns. Errors abort this attempt; the caller
    /// backs off and asks again.
    fn credentials(&self)
        -> impl std::future::Future<Output = Result<Credentials>> + Send;
}

/// Run the real-time client forever, reconnecting with capped exponential backoff.
///
/// - `creds` supplies fresh credentials before every connection attempt (so a
///   reconnection past the ~1h token lifetime re-mints the skypetoken + ic3).
/// - `events` receives batches of parsed chat messages as they arrive.
/// - `status` receives lifecycle transitions (Connecting/Connected/Disconnected).
/// - `epid` is the stable endpoint id; persist it across runs so the server keeps
///   routing to the same registration.
///
/// Returns only if the channels close (i.e. the UI is gone).
pub async fn run(
    creds: impl CredentialProvider,
    epid: String,
    events: mpsc::UnboundedSender<Vec<Message>>,
    typing: mpsc::UnboundedSender<crate::trouter_events::TypingEvent>,
    status: mpsc::UnboundedSender<Status>,
) {
    let http = match reqwest::Client::builder().user_agent(UA).http1_only().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut backoff = 1u64;
    loop {
        let _ = status.send(Status::Connecting);
        // Fresh credentials for THIS attempt. If minting fails (broker down,
        // etc.) treat it like a disconnect and back off. connect_once only
        // returns on disconnect/error, so we ignore its result either way.
        if let Ok(Credentials { session, ic3 }) = creds.credentials().await {
            let _ = connect_once(&http, &session, &ic3, &epid, &events, &typing, &status).await;
        }
        // If the consumer is gone, stop.
        if events.is_closed() || status.is_closed() {
            return;
        }
        let _ = status.send(Status::Disconnected { retry_in_secs: backoff });
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30); // cap at 30s
    }
}

/// One full connect → listen cycle. Returns when the socket closes or errors.
async fn connect_once(
    http: &reqwest::Client,
    sess: &Session,
    ic3: &str,
    epid: &str,
    events: &mpsc::UnboundedSender<Vec<Message>>,
    typing: &mpsc::UnboundedSender<crate::trouter_events::TypingEvent>,
    status: &mpsc::UnboundedSender<Status>,
) -> Result<()> {
    // 1. trouter connect
    let begin_url = format!("{TROUTER_BEGIN}?epid={}", urlencoding::encode(epid));
    let r = http
        .post(&begin_url)
        .header("x-skypetoken", &sess.skypetoken)
        .header("content-length", "0")
        .send()
        .await?;
    let body = r.text().await?;
    let info: Value = serde_json::from_str(&body).context("trouter begin body")?;
    let socketio = info.get("socketio").and_then(|v| v.as_str()).context("no socketio")?;
    let surl = info.get("surl").and_then(|v| v.as_str()).context("no surl")?.to_string();
    let connectparams = info.get("connectparams").cloned().unwrap_or(Value::Null);
    let ccid = info.get("ccid").and_then(|v| v.as_str());

    // 2. socket.io v1 handshake
    let q = socketio_query(&connectparams, epid, ccid);
    let hs = http
        .get(format!("{socketio}socket.io/1/?{q}"))
        .header("X-Skypetoken", &sess.skypetoken)
        .send()
        .await?;
    if !hs.status().is_success() {
        return Err(anyhow!("socket.io handshake -> {}", hs.status()));
    }
    let hs_body = hs.text().await?;
    let session_id = hs_body.split(':').next().unwrap_or("").to_string();
    if session_id.is_empty() {
        return Err(anyhow!("empty socket.io session id"));
    }

    // 3. websocket connect
    let ws_url = format!("{socketio}socket.io/1/websocket/{session_id}?{q}")
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let mut req = ws_url.as_str().into_client_request().context("build ws request")?;
    req.headers_mut().insert("X-Skypetoken", sess.skypetoken.parse()?);
    req.headers_mut().insert("User-Agent", UA.parse()?);
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await.context("ws connect")?;
    let (mut write, mut read) = ws.split();

    let mut count = 1u32;
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            maybe = read.next() => {
                let Some(msg) = maybe else { return Ok(()); }; // stream ended -> reconnect
                let text = match msg.context("ws read")? {
                    WsMessage::Text(t) => t.to_string(),
                    WsMessage::Ping(p) => { write.send(WsMessage::Pong(p)).await.ok(); continue; }
                    WsMessage::Close(_) => return Ok(()),
                    _ => continue,
                };
                if text.is_empty() { continue; }

                match text.as_bytes()[0] {
                    b'1' => {
                        // authenticate + activity + register
                        let auth_msg = json!({
                            "name": "user.authenticate",
                            "args": [{
                                "headers": {
                                    "X-Ms-Test-User": "False",
                                    "Authorization": format!("Bearer {ic3}"),
                                    "X-MS-Migration": "True"
                                },
                                "connectparams": connectparams.clone()
                            }]
                        });
                        write.send(WsMessage::Text(format!("5:::{auth_msg}"))).await?;

                        let act = json!({"name":"user.activity","args":[{"state":"active","cv":"teamslite000000000000.0.1"}]});
                        write.send(WsMessage::Text(format!("5:{count}+::{act}"))).await?;
                        count += 1;

                        register(http, &sess.skypetoken, ic3, &surl, epid).await?;
                        let _ = status.send(Status::Connected);
                    }
                    b'3' => {
                        if let Some(payload) = after_third_colon(&text)
                            && let Ok(reqv) = serde_json::from_str::<Value>(payload) {
                                // ack EVERY request (the server drops us otherwise)
                                let id = reqv.get("id").cloned().unwrap_or(json!(0));
                                let ack = json!({"id": id, "status": 200, "body": ""});
                                write.send(WsMessage::Text(format!("3:::{ack}"))).await?;

                                // decode once, fan out chat messages + typing signals
                                // (non-message pushes decode to empty and cost nothing).
                                if let Ok(rt) = crate::trouter_events::realtime_from_request(&reqv) {
                                    if !rt.messages.is_empty() && events.send(rt.messages).is_err() {
                                        return Ok(()); // consumer gone
                                    }
                                    for t in rt.typing {
                                        // A dropped typing receiver is non-fatal: presence is
                                        // best-effort, so keep the chat stream alive.
                                        let _ = typing.send(t);
                                    }
                                }
                            }
                    }
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if write.send(WsMessage::Text(format!("5:{count}+::{{\"name\":\"ping\"}}"))).await.is_err() {
                    return Ok(()); // write failed -> reconnect
                }
                count += 1;
            }
        }
    }
}

fn socketio_query(connectparams: &Value, epid: &str, ccid: Option<&str>) -> String {
    let mut q = String::from("v=v4&");
    if let Some(obj) = connectparams.as_object() {
        for (k, v) in obj {
            if let Some(val) = v.as_str() {
                q.push_str(&format!("{k}={}&", urlencoding::encode(val)));
            }
        }
    }
    let tc = format!("{{\"cv\":\"{TCCV}\",\"ua\":\"TeamsCDL\",\"hr\":\"\",\"v\":\"{CLIENT_VERSION}\"}}");
    q.push_str(&format!("tc={}&", urlencoding::encode(&tc)));
    q.push_str("con_num=1234567890123_1&");
    q.push_str(&format!("epid={}&", urlencoding::encode(epid)));
    if let Some(c) = ccid {
        q.push_str(&format!("ccid={}&", urlencoding::encode(c)));
    }
    q.push_str("auth=true&timeout=40&");
    q
}

fn after_third_colon(s: &str) -> Option<&str> {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if c == ':' {
            n += 1;
            if n == 3 {
                return Some(&s[i + 1..]);
            }
        }
    }
    None
}

async fn register(http: &reqwest::Client, skypetoken: &str, ic3: &str, surl: &str, epid: &str) -> Result<()> {
    let body = json!({
        "clientDescription": {
            "appId": "TeamsCDLWebWorker",
            "aesKey": "",
            "languageId": "en-US",
            "platform": "edge",
            "templateKey": "TeamsCDLWebWorker_2.1",
            "platformUIVersion": CLIENT_VERSION
        },
        "registrationId": epid,
        "nodeId": "",
        "transports": { "TROUTER": [{ "context": "", "path": surl, "ttl": 86400 }] }
    });
    http.post(REGISTRAR)
        .header("content-type", "application/json")
        .header("X-Skypetoken", skypetoken)
        .header("authorization", format!("Bearer {ic3}"))
        .body(body.to_string())
        .send()
        .await?;
    Ok(())
}

/// Load a persisted endpoint id from `path`, or generate + save a fresh one.
/// A stable epid lets the trouter keep routing to the same registration across runs.
pub fn load_or_create_epid(path: &std::path::Path) -> String {
    if let Ok(s) = std::fs::read_to_string(path) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let epid = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(path, &epid);
    epid
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn after_third_colon_extracts_payload() {
        assert_eq!(after_third_colon("3:::{\"id\":1}"), Some("{\"id\":1}"));
        assert_eq!(after_third_colon("3:42+:/ep:{\"a\":1}"), Some("{\"a\":1}"));
        // "1::" has only two colons -> no third-colon payload
        assert_eq!(after_third_colon("1::"), None);
        // but "1:::" (the connect frame form) yields an empty payload
        assert_eq!(after_third_colon("1:::"), Some(""));
        assert_eq!(after_third_colon("no-colons"), None);
    }

    #[test]
    fn socketio_query_encodes_and_includes_epid() {
        let cp = json!({ "tenant": "af1b bf3d", "sr": "x/y" });
        let q = socketio_query(&cp, "epid-123", Some("cc id"));
        assert!(q.starts_with("v=v4&"));
        assert!(q.contains("tenant=af1b%20bf3d"));
        assert!(q.contains("sr=x%2Fy"));
        assert!(q.contains("epid=epid-123"));
        assert!(q.contains("ccid=cc%20id"));
        assert!(q.contains("auth=true"));
    }

    #[test]
    fn epid_persists_across_calls() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("teams-lite-epid-test-{}.txt", uuid::Uuid::new_v4()));
        let a = load_or_create_epid(&path);
        let b = load_or_create_epid(&path);
        assert_eq!(a, b, "epid must be stable once written");
        assert!(!a.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    /// The core of the token-refresh fix: `run` must ask the provider for fresh
    /// credentials on EVERY connection attempt, not once at startup. We make the
    /// provider fail every time (so no real network happens) and count its calls;
    /// after it has been asked twice — i.e. it was re-asked on the reconnect — we
    /// close the channels to end the loop and assert the re-invocation happened.
    #[tokio::test(flavor = "current_thread")]
    async fn run_asks_provider_for_fresh_credentials_each_attempt() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        struct CountingProvider {
            calls: Arc<AtomicUsize>,
        }
        impl CredentialProvider for CountingProvider {
            async fn credentials(&self) -> Result<Credentials> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                // Never hand back real creds: fail so `run` treats it as a failed
                // attempt and loops into its backoff → reconnect path.
                Err(anyhow!("test: no credentials"))
            }
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let provider = CountingProvider { calls: calls.clone() };
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<Vec<Message>>();
        let (ty_tx, _ty_rx) = mpsc::unbounded_channel::<crate::trouter_events::TypingEvent>();
        let (st_tx, mut st_rx) = mpsc::unbounded_channel::<Status>();

        let handle = tokio::spawn(async move {
            run(provider, "epid-test".to_string(), ev_tx, ty_tx, st_tx).await;
        });

        // Wait until the provider has been asked at least twice (proves it was
        // re-invoked on the reconnect, not reused from a first attempt). The
        // backoff after the first failure is 1s, so allow a little headroom.
        let mut saw_reconnect = false;
        for _ in 0..40 {
            if calls.load(Ordering::SeqCst) >= 2 {
                saw_reconnect = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(saw_reconnect, "provider must be asked again on reconnect");

        // Close the consumer side so `run` observes it and returns.
        drop(ev_rx);
        st_rx.close();
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }
}
