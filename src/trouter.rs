// Real-time trouter client as a library module (slice 6).
//
// Promoted from the proven src/bin/trouter.rs spike. Instead of printing, it emits
// parsed chat `Message`s and lifecycle `Status` over channels, and reconnects with
// backoff. The backend spawns `run` and persists each emitted message into the
// store, then tells every client — that's live delivery, end to end.
//
// Flow (reverse-engineered from EionRobb/purple-teams teams_trouter.c):
//   1. POST go.trouter.teams.microsoft.com/v4/a?epid={epid}  (x-skypetoken)
//        -> { socketio, surl, connectparams, ccid? }
//   2. GET  {socketio}socket.io/1/?v=v4&{connectparams}&...   -> sessionId
//   3. WS   wss://{socketio}socket.io/1/websocket/{sessionId}?...  (+X-Skypetoken)
//   4. on "1::" -> user.authenticate (Bearer ic3) + user.activity + registrar POST
//   5. messages arrive as "3:::{...}"; ack every request, then decode
//
// TWO connections, not one, because that is what the real web client runs: the
// messaging worker (chat, typing, read receipts) and — only when the user turned
// calling on — the CALLING worker, which is a connection of its own to its own
// regional host, registered under its own template (see [`Endpoint::calling`] and
// NATIVE-CALLING.md § 2.1). A `Role` says which of the two a connection is, so the
// handshake, the acking and the reconnect backoff are written once.
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
/// The registrar every endpoint registers with. Public because the calling plane
/// falls back to it when the directory does not name `calling_registrarUrl`.
pub const REGISTRAR: &str = "https://teams.microsoft.com/registrar/prod/V2/registrations";
const TCCV: &str = "2024.23.01.2";
const CLIENT_VERSION: &str = "1415/26061118216";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

/// The messaging worker's registration — the one this app has always used.
const MESSAGING_APP_ID: &str = "TeamsCDLWebWorker";
const MESSAGING_TEMPLATE: &str = "TeamsCDLWebWorker_2.1";
/// A day: a messaging endpoint is long-lived and re-registered on every reconnect.
const MESSAGING_TTL: u64 = 86400;

/// The CALLING worker's registration, taken from the real web client's own
/// configuration rather than from the desktop client's: `pnhTemplate` is
/// `SkypeSpacesWeb_2.6` and `webRegistrarTtlInSeconds` is 3600
/// (config-prod-<hash>.js — see NATIVE-CALLING.md § 2.1).
///
/// The desktop client's `NGCallManagerWin` / `DesktopNgc_2.3` pair is deliberately
/// NOT used: its path suffix belongs to a Windows endpoint, and Teams routes a call
/// to the endpoints it believes are running.
const CALLING_APP_ID: &str = "SkypeSpacesWeb";
const CALLING_TEMPLATE: &str = "SkypeSpacesWeb_2.6";
const CALLING_TTL: u64 = 3600;

/// Which trouter this connection talks to, and how it registers there.
///
/// Two instances exist: [`Endpoint::messaging`], hard-coded to the global allocate
/// host this app has always used, and [`Endpoint::calling`], built from the calling
/// URLs in the authz directory so the connection lands on the user's own region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The allocate URL (`…/v4/a`), which the connection POSTs to first.
    pub allocate: String,
    /// The registrar the registration is POSTed to.
    pub registrar: String,
    pub app_id: &'static str,
    pub template_key: &'static str,
    pub ttl_secs: u64,
}

impl Endpoint {
    /// The messaging worker: chat, typing and read receipts.
    pub fn messaging() -> Self {
        Self {
            allocate: TROUTER_BEGIN.to_string(),
            registrar: REGISTRAR.to_string(),
            app_id: MESSAGING_APP_ID,
            template_key: MESSAGING_TEMPLATE,
            ttl_secs: MESSAGING_TTL,
        }
    }

    /// The calling worker, addressed from the directory's own `calling_trouterUrl`
    /// and `calling_registrarUrl`.
    pub fn calling(trouter_url: &str, registrar: &str) -> Self {
        Self {
            allocate: allocate_url_for(trouter_url),
            registrar: registrar.to_string(),
            app_id: CALLING_APP_ID,
            template_key: CALLING_TEMPLATE,
            ttl_secs: CALLING_TTL,
        }
    }
}

/// Map a trouter URL from the directory onto the allocate endpoint this client
/// speaks.
///
/// The directory states the CONNECT form (`https://go-eu.trouter.teams.microsoft.com/v3/c`)
/// while this client speaks the allocate-then-socket.io flow (`…/v4/a`) that the
/// messaging connection has used all along. The real client converts between the
/// two forms the same way — it rewrites `/v4/c` to `/v4/a` and back — so only the
/// host matters, and keeping the directory's host is what puts the connection in the
/// user's own region. A URL that already names an allocate path is left alone.
pub fn allocate_url_for(trouter_url: &str) -> String {
    let trimmed = trouter_url.trim_end_matches('/');
    if trimmed.ends_with("/v4/a") {
        return trimmed.to_string();
    }
    // Keep scheme + host, drop whatever version path the directory stated.
    let without_scheme = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("wss://"));
    match without_scheme {
        Some(rest) => {
            let host = rest.split('/').next().unwrap_or(rest);
            format!("https://{host}/v4/a")
        }
        // Not a URL we recognise: fall back to the host that is known to work rather
        // than to something malformed.
        None => TROUTER_BEGIN.to_string(),
    }
}

/// The live calling connection's own address, published upward the moment it is
/// registered.
///
/// The signaling layer needs it: every callback link a call publishes is built on
/// this surl (`{surl}callAgent/{sessionId}/{causeId}{path}`), so a call cannot be
/// placed or answered before this arrives — and a reconnect that changes the surl
/// invalidates the links of any call still up, which is why it is a channel rather
/// than a one-shot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallingChannel {
    /// The trouter surl this connection was allocated.
    pub surl: String,
    /// The registration id (endpoint id) it registered under.
    pub endpoint_id: String,
}

/// What a connection does with the pushes it receives.
///
/// One enum rather than two `run` functions with different parameter lists: the
/// handshake, the ack and the backoff are identical, and the only real difference is
/// where a decoded push goes.
pub enum Role {
    /// The messaging worker. `calls` still exists here to catch a calling push that
    /// arrives on this socket anyway (the service has routed one before), so a frame
    /// is never silently dropped.
    Messaging {
        events: mpsc::UnboundedSender<Vec<Message>>,
        typing: mpsc::UnboundedSender<crate::trouter_events::TypingEvent>,
        receipts: mpsc::UnboundedSender<crate::trouter_events::ReadReceiptEvent>,
        calls: mpsc::UnboundedSender<crate::trouter_events::CallFrame>,
    },
    /// The calling worker. Every push here is calling traffic — the invite, the
    /// media answer, the roster, the ending — so nothing is filtered by URL.
    Calling {
        frames: mpsc::UnboundedSender<crate::trouter_events::CallFrame>,
        channel: mpsc::UnboundedSender<CallingChannel>,
    },
}

impl Role {
    /// Decode one push and fan it out. Returns false when the consumer is gone, so
    /// the connection can stop instead of decoding for nobody.
    fn deliver(&self, request: &Value) -> bool {
        match self {
            Role::Messaging { events, typing, receipts, calls } => {
                let Ok(rt) = crate::trouter_events::realtime_from_request(request) else {
                    return true; // a frame we cannot decode is not a reason to hang up
                };
                if !rt.messages.is_empty() && events.send(rt.messages).is_err() {
                    return false; // consumer gone
                }
                // Typing, receipts and calls are best-effort: a dropped receiver must
                // never take down the chat stream.
                rt.typing.into_iter().for_each(|t| {
                    let _ = typing.send(t);
                });
                rt.read_receipts.into_iter().for_each(|r| {
                    let _ = receipts.send(r);
                });
                rt.calls.into_iter().for_each(|c| {
                    let _ = calls.send(c);
                });
                true
            }
            Role::Calling { frames, .. } => {
                match crate::trouter_events::call_frame_from_request(request) {
                    Ok(Some(frame)) => frames.send(frame).is_ok(),
                    // An empty or undecodable body is nothing to act on; the ack has
                    // already gone out, which is what keeps the socket alive.
                    _ => true,
                }
            }
        }
    }

    /// Whether the consumer of this role has gone away.
    fn is_closed(&self) -> bool {
        match self {
            Role::Messaging { events, .. } => events.is_closed(),
            Role::Calling { frames, .. } => frames.is_closed(),
        }
    }

    /// Announce the connection's own address, for the roles that need it.
    fn on_registered(&self, surl: &str, endpoint_id: &str) {
        if let Role::Calling { channel, .. } = self {
            let _ = channel.send(CallingChannel {
                surl: surl.to_string(),
                endpoint_id: endpoint_id.to_string(),
            });
        }
    }
}

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

/// Run one real-time connection forever, reconnecting with capped exponential
/// backoff.
///
/// - `creds` supplies fresh credentials before every connection attempt (so a
///   reconnection past the ~1h token lifetime re-mints the skypetoken + ic3).
/// - `endpoint` says which trouter this is and how to register there
///   ([`Endpoint::messaging`] or [`Endpoint::calling`]).
/// - `role` receives whatever the pushes decode into.
/// - `status` receives lifecycle transitions (Connecting/Connected/Disconnected).
/// - `epid` is the stable endpoint id; persist it across runs so the server keeps
///   routing to the same registration. The two connections use DIFFERENT ids: one
///   registration per worker, or the second would replace the first.
///
/// Returns only if the channels close (i.e. the UI is gone).
pub async fn run(
    creds: impl CredentialProvider,
    epid: String,
    endpoint: Endpoint,
    role: Role,
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
        //
        // Say WHY when it fails. This loop retries forever and the error used to be
        // dropped on the floor, so a broker that stopped minting tokens left the live
        // feed dead with an empty journal — while mail and the calendar both logged
        // their failures. A backend that runs for weeks is diagnosed from that
        // journal, so the one line that names the cause has to be in it.
        match creds.credentials().await {
            Ok(Credentials { session, ic3 }) => {
                let _ =
                    connect_once(&http, &session, &ic3, &epid, &endpoint, &role, &status).await;
            }
            Err(e) => eprintln!(
                "[realtime] no credentials, retrying in {backoff}s — is the identity broker up? ({e:#})"
            ),
        }
        // If the consumer is gone, stop.
        if role.is_closed() || status.is_closed() {
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
    endpoint: &Endpoint,
    role: &Role,
    status: &mpsc::UnboundedSender<Status>,
) -> Result<()> {
    // 1. trouter connect
    let begin_url = format!("{}?epid={}", endpoint.allocate, urlencoding::encode(epid));
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

                        register(http, &sess.skypetoken, ic3, &surl, epid, endpoint).await?;
                        // The surl is only ours once the registration took, so this
                        // is where a call may start building links on it.
                        role.on_registered(&surl, epid);
                        let _ = status.send(Status::Connected);
                    }
                    b'3' => {
                        if let Some(payload) = after_third_colon(&text)
                            && let Ok(reqv) = serde_json::from_str::<Value>(payload) {
                                // ack EVERY request (the server drops us otherwise)
                                let id = reqv.get("id").cloned().unwrap_or(json!(0));
                                let ack = json!({"id": id, "status": 200, "body": ""});
                                write.send(WsMessage::Text(format!("3:::{ack}"))).await?;

                                if !role.deliver(&reqv) {
                                    return Ok(()); // consumer gone
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

async fn register(
    http: &reqwest::Client,
    skypetoken: &str,
    ic3: &str,
    surl: &str,
    epid: &str,
    endpoint: &Endpoint,
) -> Result<()> {
    let body = registration_body(surl, epid, endpoint);
    http.post(&endpoint.registrar)
        .header("content-type", "application/json")
        .header("X-Skypetoken", skypetoken)
        .header("authorization", format!("Bearer {ic3}"))
        .body(body.to_string())
        .send()
        .await?;
    Ok(())
}

/// Remove a registration: `DELETE {registrar}/{registrationId}`, the same call the
/// web client makes when it stops.
///
/// It matters most for the CALLING worker. A registration Teams still believes in
/// keeps routing the user's calls to a client that is no longer listening, and a call
/// offered to a device that never rings is a call they miss.
pub async fn unregister(
    http: &reqwest::Client,
    skypetoken: &str,
    ic3: &str,
    registrar: &str,
    registration_id: &str,
) -> Result<()> {
    let url = format!(
        "{}/{}",
        registrar.trim_end_matches('/'),
        urlencoding::encode(registration_id)
    );
    let response = http
        .delete(&url)
        .header("X-Skypetoken", skypetoken)
        .header("authorization", format!("Bearer {ic3}"))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("unregister -> {}", response.status()));
    }
    Ok(())
}

/// The registration body, pure so both workers' shapes can be pinned by a test.
///
/// `path` is the BARE surl for either worker: the real web client appends no suffix
/// to it (`transports:{TROUTER:[{context, path: allocateResult.surl, ttl}]}`), and a
/// suffix here is what made this app look like a Windows endpoint.
fn registration_body(surl: &str, epid: &str, endpoint: &Endpoint) -> Value {
    json!({
        "clientDescription": {
            "appId": endpoint.app_id,
            "aesKey": "",
            "languageId": "en-US",
            "platform": "edge",
            "templateKey": endpoint.template_key,
            "platformUIVersion": CLIENT_VERSION
        },
        "registrationId": epid,
        "nodeId": "",
        "transports": { "TROUTER": [{ "context": "", "path": surl, "ttl": endpoint.ttl_secs }] }
    })
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

    /// The registration is what tells Teams which client is running, and the
    /// calling one decides whether a call is routed here at all. Both shapes are
    /// pinned: the bare surl as the path, the web client's own template, and its
    /// own TTL.
    #[test]
    fn each_worker_registers_the_way_the_web_client_registers_it() {
        let messaging = registration_body("https://tr/v4/f/abc/", "epid-1", &Endpoint::messaging());
        assert_eq!(messaging["clientDescription"]["appId"], "TeamsCDLWebWorker");
        assert_eq!(messaging["clientDescription"]["templateKey"], "TeamsCDLWebWorker_2.1");
        assert_eq!(messaging["registrationId"], "epid-1");
        assert_eq!(messaging["transports"]["TROUTER"][0]["path"], "https://tr/v4/f/abc/");
        assert_eq!(messaging["transports"]["TROUTER"][0]["ttl"], 86400);

        let calling = Endpoint::calling("https://go-eu.trouter.teams.microsoft.com/v3/c", REGISTRAR);
        let body = registration_body("https://tr/v4/f/xyz/", "epid-2", &calling);
        assert_eq!(body["clientDescription"]["appId"], "SkypeSpacesWeb");
        assert_eq!(body["clientDescription"]["templateKey"], "SkypeSpacesWeb_2.6");
        assert_eq!(body["transports"]["TROUTER"][0]["ttl"], 3600);
        // The BARE surl: the desktop client's worker suffix is what made a call
        // routed to a Windows endpoint that does not exist here.
        let path = body["transports"]["TROUTER"][0]["path"].as_str().unwrap();
        assert_eq!(path, "https://tr/v4/f/xyz/");
        assert!(!path.contains("NGCallManager"), "the web client appends no worker suffix");
    }

    /// The desktop client's templates must not come back: Teams routes a call to
    /// the endpoints it believes are running, and claiming to be a Windows client
    /// sends the user's calls to a client that is not there.
    #[test]
    fn no_worker_ever_claims_to_be_the_desktop_client() {
        // Built rather than written, because this test's own source is part of what
        // it scans: a literal here would make the assertion find itself.
        let desktop = [
            format!("NGCallManager{}", "Win"),
            format!("NGCallManager{}", "Osx"),
            format!("Desktop{}", "Ngc"),
        ];
        let source = include_str!("trouter.rs");
        for spelling in desktop {
            assert!(
                !source.contains(&format!("\"{spelling}\"")),
                "{spelling} must never be a value this app sends"
            );
        }
        // And the values that ARE sent are the web client's own.
        assert_eq!(Endpoint::calling("https://t/v3/c", REGISTRAR).app_id, "SkypeSpacesWeb");
        assert_eq!(
            Endpoint::calling("https://t/v3/c", REGISTRAR).template_key,
            "SkypeSpacesWeb_2.6"
        );
    }

    #[test]
    fn a_directory_trouter_url_becomes_this_clients_allocate_url() {
        // The directory states the connect form; we speak allocate, same host.
        assert_eq!(
            allocate_url_for("https://go-eu.trouter.teams.microsoft.com/v3/c"),
            "https://go-eu.trouter.teams.microsoft.com/v4/a"
        );
        assert_eq!(
            allocate_url_for("wss://go-eu.trouter.teams.microsoft.com/v4/c"),
            "https://go-eu.trouter.teams.microsoft.com/v4/a"
        );
        // Already an allocate URL: left alone (trailing slash trimmed).
        assert_eq!(
            allocate_url_for("https://go.trouter.teams.microsoft.com/v4/a/"),
            "https://go.trouter.teams.microsoft.com/v4/a"
        );
        // Nonsense falls back to the host that is known to work rather than to a
        // malformed URL: a calling connection that cannot allocate is a feature
        // that silently does nothing.
        assert_eq!(allocate_url_for("not a url"), TROUTER_BEGIN);
    }

    /// A call cannot publish a link before it knows its own surl, so the calling
    /// role must announce it — and the messaging role must not (it has no links).
    #[tokio::test(flavor = "current_thread")]
    async fn the_calling_role_publishes_its_surl_once_registered() {
        let (frames_tx, _frames_rx) = mpsc::unbounded_channel();
        let (chan_tx, mut chan_rx) = mpsc::unbounded_channel();
        let calling = Role::Calling { frames: frames_tx, channel: chan_tx };
        calling.on_registered("https://tr/v4/f/abc/", "epid-2");
        let published = chan_rx.recv().await.expect("the surl");
        assert_eq!(published.surl, "https://tr/v4/f/abc/");
        assert_eq!(published.endpoint_id, "epid-2");

        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        let (ty_tx, _ty_rx) = mpsc::unbounded_channel();
        let (rr_tx, _rr_rx) = mpsc::unbounded_channel();
        let (call_tx, _call_rx) = mpsc::unbounded_channel();
        Role::Messaging { events: ev_tx, typing: ty_tx, receipts: rr_tx, calls: call_tx }
            .on_registered("https://tr/v4/f/abc/", "epid-1");
        // Nothing to assert but the absence of a panic: the messaging role has no
        // channel to publish on.
    }

    /// Everything on the calling socket is calling traffic, whatever URL it names —
    /// filtering it by URL is what dropped the web client's own frame shape.
    #[tokio::test(flavor = "current_thread")]
    async fn the_calling_role_forwards_every_push_it_gets() {
        let (frames_tx, mut frames_rx) = mpsc::unbounded_channel();
        let (chan_tx, _chan_rx) = mpsc::unbounded_channel();
        let role = Role::Calling { frames: frames_tx, channel: chan_tx };
        let request = json!({
            "url": "https://tr/v4/f/abc/callAgent/s/c/call/mediaAnswer/",
            "body": "{\"mediaAnswer\":{}}"
        });
        assert!(role.deliver(&request));
        let frame = frames_rx.recv().await.expect("a frame");
        assert!(frame.url.contains("callAgent"));
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
        let (rr_tx, _rr_rx) = mpsc::unbounded_channel::<crate::trouter_events::ReadReceiptEvent>();
        let (call_tx, _call_rx) = mpsc::unbounded_channel::<crate::trouter_events::CallFrame>();
        let (st_tx, mut st_rx) = mpsc::unbounded_channel::<Status>();
        let role = Role::Messaging {
            events: ev_tx,
            typing: ty_tx,
            receipts: rr_tx,
            calls: call_tx,
        };

        let handle = tokio::spawn(async move {
            run(provider, "epid-test".to_string(), Endpoint::messaging(), role, st_tx).await;
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
