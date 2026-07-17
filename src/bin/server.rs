// teams-lite — SERVER (Rust backend, opencode model)
//
// The proven Rust core (auth broker, trouter real-time, local-first SQLite store,
// send, name resolution) exposed over a local WebSocket so the OpenTUI/Solid UI
// can drive it. The UI never touches the network or the store directly — it speaks
// this JSON protocol:
//
//   request  (client -> server):  { "id": <n>, "method": "<m>", "params": {...} }
//   response (server -> client):  { "id": <n>, "result": <v> }  |  { "id": <n>, "error": "<msg>" }
//   event    (server -> client):  { "event": "<name>", "data": {...} }   (no id)
//
// Methods: conversations | open | backfill | send
// Events:  status | message | conversations_changed
//
// No raw tokens are ever logged or sent.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use teams_lite::store::{Message, Store};
use teams_lite::teams::Session;
use teams_lite::{auth, retry, teams, teams_profiles, teams_read, teams_send, trouter};

const ADDR: &str = "127.0.0.1:8420";
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

/// Shared backend context; cloned into each connection + the trouter task.
#[derive(Clone)]
struct Ctx {
    http: reqwest::Client,
    /// broker token cache (auto-refreshes per scope before expiry)
    tokens: auth::TokenCache,
    /// the Teams session (skypetoken + endpoints); refreshed when stale
    session: Arc<tokio::sync::Mutex<SessionCell>>,
    db_path: Arc<String>,
    /// broadcast of server->client events (fan-out to every connected UI)
    events: broadcast::Sender<Value>,
}

/// The session plus when it was minted, so we can rebuild it before the
/// skypetoken expires (~1 day, but we refresh conservatively).
struct SessionCell {
    session: Session,
    minted: std::time::Instant,
}

const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(50 * 60);

impl Ctx {
    fn store(&self) -> Result<Store> {
        Store::open(&self.db_path)
    }
    fn emit(&self, event: &str, data: Value) {
        // ignore send errors (no subscribers yet is fine)
        let _ = self.events.send(json!({ "event": event, "data": data }));
    }
    /// A valid CSA-audience token (auto-refreshed).
    async fn csa(&self) -> Result<String> {
        self.tokens.get(teams_read::CSA_SCOPE).await
    }
    /// A valid profiles-audience token (auto-refreshed).
    async fn profile(&self) -> Result<String> {
        self.tokens.get(teams_profiles::PROFILE_SCOPE).await
    }
    /// A fresh clone of the Teams session, rebuilt if the cached one is stale.
    async fn session(&self) -> Result<Session> {
        {
            let cell = self.session.lock().await;
            if cell.minted.elapsed() < SESSION_TTL {
                return Ok(cell.session.clone());
            }
        }
        // stale: rebuild (skypetoken from a fresh skype token via the broker)
        let fresh = teams::connect(&self.http).await?;
        let mut cell = self.session.lock().await;
        cell.session = fresh.clone();
        cell.minted = std::time::Instant::now();
        Ok(fresh)
    }

    /// Force-refresh every credential the read/send paths depend on: the CSA and
    /// profile broker tokens, and the Teams session (skypetoken). Called after an
    /// unexpected 401, whose cause may be either the bearer token or the
    /// skypetoken, so we refresh both rather than guess.
    async fn force_refresh_auth(&self) -> Result<Session> {
        let _ = self.tokens.refresh(teams_read::CSA_SCOPE).await;
        let _ = self.tokens.refresh(teams_profiles::PROFILE_SCOPE).await;
        let fresh = teams::connect(&self.http).await?;
        let mut cell = self.session.lock().await;
        cell.session = fresh.clone();
        cell.minted = std::time::Instant::now();
        Ok(fresh)
    }

    /// Run a network operation under the shared retry policy (see `retry`).
    ///
    /// `op` receives a fresh session + csa token on each attempt (re-read from
    /// the cache, so a refresh between attempts is picked up). The policy:
    ///   - 401  -> force-refresh every credential, then retry (once);
    ///   - 429/5xx/timeout/dropped connection -> back off and retry;
    ///   - 400/403/404/parse/etc. -> fail fast (retrying can't help).
    /// This is the single reactive safety net over the time-based token cache.
    async fn retry_on_auth<T, F, Fut>(&self, op: F) -> Result<T>
    where
        F: Fn(Session, String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let attempt = || async {
            let session = self.session().await?;
            let csa = self.csa().await?;
            op(session, csa).await
        };
        let on_auth = || async {
            eprintln!("[auth] 401 — refreshing credentials before retry");
            self.force_refresh_auth().await.map(|_| ())
        };
        retry::with_retry(retry::RetryPolicy::default(), Some(on_auth), attempt).await
    }
}

/// The trouter's credential source: hands it a freshly-valid session (rebuilt if
/// stale) and ic3 token (auto-refreshed via the cache) before every reconnection,
/// so the real-time feed keeps working past the ~1h broker-token lifetime.
impl trouter::CredentialProvider for Ctx {
    async fn credentials(&self) -> Result<trouter::Credentials> {
        let session = self.session().await?;
        let ic3 = self.tokens.get(IC3_SCOPE).await?;
        Ok(trouter::Credentials { session, ic3 })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("teams-lite server — authenticating (broker)…");
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    let tokens = auth::TokenCache::new();
    // warm the caches used at boot (also validates the broker is reachable)
    tokens.get(IC3_SCOPE).await.context("ic3 token")?;
    tokens.get(teams_read::CSA_SCOPE).await.context("csa token")?;
    tokens.get(teams_profiles::PROFILE_SCOPE).await.context("profile token")?;
    let session = teams::connect(&http).await?;
    eprintln!("[ok] region={} self={:?}", session.region, session.self_name);

    let db_path = std::env::temp_dir().join("teams-lite.sqlite");
    let db_path = db_path.to_str().unwrap().to_string();
    Store::open(&db_path)?; // ensure schema

    let (events_tx, _) = broadcast::channel::<Value>(256);
    let ctx = Ctx {
        http,
        tokens,
        session: Arc::new(tokio::sync::Mutex::new(SessionCell {
            session: session.clone(),
            minted: std::time::Instant::now(),
        })),
        db_path: Arc::new(db_path.clone()),
        events: events_tx,
    };

    // real-time: run the trouter, persist each live message, broadcast an event.
    spawn_realtime(ctx.clone(), session, db_path);

    let listener = TcpListener::bind(ADDR).await.with_context(|| format!("bind {ADDR}"))?;
    eprintln!("[ok] server ws://{ADDR} — ready");

    loop {
        // A transient accept() error (e.g. fd pressure) must not take down the
        // whole server — log it and keep serving. Propagating it here would
        // exit the process and leave every connected UI reconnecting to nothing.
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[accept] transient error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_conn(ctx, stream).await {
                eprintln!("[conn] fin: {e}");
            }
        });
    }
}

/// Handle one UI connection: answer requests + forward broadcast events.
async fn serve_conn(ctx: Ctx, stream: tokio::net::TcpStream) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut write, mut read) = ws.split();
    let mut events_rx = ctx.events.subscribe();

    // greet with current status
    let hello = json!({ "event": "status", "data": "connected" });
    write.send(WsMessage::Text(hello.to_string().into())).await?;

    loop {
        tokio::select! {
            // incoming requests from the UI
            maybe = read.next() => {
                let Some(msg) = maybe else { break };
                match msg? {
                    WsMessage::Text(t) => {
                        let req: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                        let id = req.get("id").cloned().unwrap_or(json!(0));
                        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        let params = req.get("params").cloned().unwrap_or(Value::Null);
                        let reply = match dispatch(&ctx, &method, &params).await {
                            Ok(result) => json!({ "id": id, "result": result }),
                            Err(e) => json!({ "id": id, "error": e.to_string() }),
                        };
                        write.send(WsMessage::Text(reply.to_string().into())).await?;
                    }
                    WsMessage::Ping(p) => { write.send(WsMessage::Pong(p)).await.ok(); }
                    WsMessage::Close(_) => break,
                    _ => {}
                }
            }
            // events pushed from the backend (trouter, sync) -> this UI
            ev = events_rx.recv() => {
                match ev {
                    Ok(v) => { write.send(WsMessage::Text(v.to_string().into())).await?; }
                    Err(broadcast::error::RecvError::Lagged(_)) => {} // dropped some events, keep going
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}

/// Route a request method to backend logic and return its JSON result.
async fn dispatch(ctx: &Ctx, method: &str, params: &Value) -> Result<Value> {
    match method {
        "ping" => Ok(json!("pong")),

        // full conversation list — LOCAL-FIRST: answer instantly from the SQLite
        // cache (0 network round-trips), then sync from the network in the
        // background and emit `conversations_changed` if anything new arrived.
        "conversations" => {
            let self_name = {
                let session = ctx.session().await?;
                session.self_name.to_string()
            };
            let rows = {
                let store = ctx.store()?;
                store.conversations(&self_name)?
            };
            // background sync (does not block the response = instant startup)
            sync_conversations_bg(ctx.clone());
            Ok(conversations_json(&rows))
        }

        // open a conversation — LOCAL-FIRST: answer instantly from the SQLite
        // cache (0 network round-trips), then refresh from the network in the
        // background and emit `messages_updated` if anything new arrived.
        "open" => {
            let conv = param_str(params, "conversation")?;
            // self identity comes from the cached session (a lock + clone, no
            // network in the common case) so we can tag each cached message with
            // is_self. The MRI is the reliable signal; the name is the fallback.
            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };
            let cached = {
                let store = ctx.store()?;
                store.newest_messages(&conv, 200)?
            };
            // background refresh (does not block the response = instant switch)
            let ctx_bg = ctx.clone();
            let conv_bg = conv.clone();
            let self_name_bg = self_name.clone();
            let self_mri_bg = self_mri.clone();
            let had = cached.len();
            tokio::spawn(async move {
                let http = ctx_bg.http.clone();
                let conv_op = conv_bg.clone();
                let page = ctx_bg
                    .retry_on_auth(move |session, _csa| {
                        let http = http.clone();
                        let conv = conv_op.clone();
                        async move { teams_read::fetch_newest(&http, &session, &conv).await }
                    })
                    .await;
                if let Ok(page) = page {
                    let after = {
                        if let Ok(store) = ctx_bg.store() {
                            let inserted = teams_read::persist_page(&store, &conv_bg, &page).unwrap_or(0);
                            if inserted > 0 { store.newest_messages(&conv_bg, 200).ok() } else { None }
                        } else {
                            None
                        }
                    };
                    if let Some(msgs) = after {
                        // something changed vs the cache we already returned
                        let _ = had;
                        ctx_bg.emit("messages_updated", json!({ "conversation": conv_bg, "messages": messages_value(&msgs, &self_name_bg, &self_mri_bg) }));
                    }
                } else if let Err(e) = page {
                    // The background network refresh failed (e.g. auth couldn't be
                    // recovered). Tell the UI so it can show a real error instead
                    // of the misleading "No messages yet." empty state.
                    ctx_bg.emit(
                        "messages_error",
                        json!({ "conversation": conv_bg, "error": e.to_string() }),
                    );
                }
            });
            Ok(messages_json(&cached, &self_name, &self_mri))
        }

        // older page for scroll-up
        "backfill" => {
            let conv = param_str(params, "conversation")?;
            let before_ms = {
                let store = ctx.store()?;
                match store.oldest_cursor(&conv)? {
                    (_, false) => return Ok(json!({ "messages": [], "has_more": false })),
                    (cursor, true) => cursor.and_then(|s| s.parse::<i64>().ok()),
                }
            };
            let session = ctx.session().await?;
            let self_name = session.self_name.to_string();
            let self_mri = session.self_mri.to_string();
            let http = ctx.http.clone();
            let conv_op = conv.clone();
            let page = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = conv_op.clone();
                    async move {
                        teams_read::fetch_messages_page(&http, &session, &conv, before_ms, 30).await
                    }
                })
                .await?;
            let msgs = {
                let store = ctx.store()?;
                teams_read::persist_page(&store, &conv, &page)?;
                store.newest_messages(&conv, 500)?
            };
            Ok(messages_json(&msgs, &self_name, &self_mri))
        }

        // send a message
        "send" => {
            let conv = param_str(params, "conversation")?;
            let text = param_str(params, "text")?;
            let http = ctx.http.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = conv.clone();
                let text = text.clone();
                async move { teams_send::send_message(&http, &session, &conv, &text).await }
            })
            .await?;
            Ok(json!({ "sent": true }))
        }

        other => anyhow::bail!("unknown method: {other}"),
    }
}

fn param_str(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .with_context(|| format!("missing param: {key}"))
}

fn conversations_json(rows: &[teams_lite::store::ConversationRow]) -> Value {
    json!(rows
        .iter()
        .map(|c| json!({
            "id": c.id,
            "name": c.display_name,
            "last_message_time": c.last_message_time,
            "kind": c.kind.as_str()
        }))
        .collect::<Vec<_>>())
}

/// Decide whether a message is ours. We match on the sender's MRI (reliable —
/// it's a stable per-user identifier) whenever both sides have one. We fall back
/// to comparing display names only for legacy rows stored before we captured the
/// MRI, where `sender_mri` is empty.
fn is_self(m: &Message, self_name: &str, self_mri: &str) -> bool {
    if !self_mri.is_empty() && !m.sender_mri.is_empty() {
        return m.sender_mri == self_mri;
    }
    !self_name.is_empty() && m.sender == self_name
}

fn messages_value(msgs: &[Message], self_name: &str, self_mri: &str) -> Value {
    json!(msgs
        .iter()
        .map(|m| json!({
            "id": m.id, "conversation_id": m.conversation_id, "seq": m.seq,
            "compose_time": m.compose_time, "sender": m.sender, "content": m.content,
            "is_self": is_self(m, self_name, self_mri)
        }))
        .collect::<Vec<_>>())
}

fn messages_json(msgs: &[Message], self_name: &str, self_mri: &str) -> Value {
    json!({ "messages": messages_value(msgs, self_name, self_mri) })
}

fn message_json(m: &Message, self_name: &str, self_mri: &str) -> Value {
    json!({
        "id": m.id, "conversation_id": m.conversation_id, "seq": m.seq,
        "compose_time": m.compose_time, "sender": m.sender, "content": m.content,
        "is_self": is_self(m, self_name, self_mri)
    })
}

/// Sync the conversation list from the network in the background: fetch, persist,
/// resolve 1:1 names, and emit `conversations_changed` if anything changed. This
/// keeps the `conversations` request off the network path (local-first startup).
fn sync_conversations_bg(ctx: Ctx) {
    tokio::spawn(async move {
        let http = ctx.http.clone();
        let convs = match ctx
            .retry_on_auth(|session, csa| {
                let http = http.clone();
                async move { teams_read::fetch_conversations(&http, &session, &csa).await }
            })
            .await
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let inserted = {
            if let Ok(store) = ctx.store() {
                teams_read::persist_conversations(&store, &convs)
            } else {
                return;
            }
        };
        if inserted > 0 {
            ctx.emit("conversations_changed", json!({}));
        }
        // resolve 1:1 names in the background (emits conversations_changed itself)
        resolve_names_bg(ctx, convs);
    });
}

/// Resolve 1:1 display names in the background and emit conversations_changed.
fn resolve_names_bg(ctx: Ctx, convs: Vec<teams_read::Conversation>) {
    tokio::spawn(async move {
        let to_resolve: Vec<(String, String)> = convs
            .iter()
            .filter(|c| c.is_one_on_one && !c.is_empty && c.title.is_empty() && !c.other_member_mri.is_empty())
            .map(|c| (c.id.clone(), c.other_member_mri.clone()))
            .collect();
        if to_resolve.is_empty() {
            return;
        }
        let mris: Vec<String> = to_resolve.iter().map(|(_, m)| m.clone()).collect();
        let session = match ctx.session().await { Ok(s) => s, Err(_) => return };
        let profile = match ctx.profile().await { Ok(t) => t, Err(_) => return };
        if let Ok(names) = teams_profiles::fetch_names(&ctx.http, &session, &profile, &mris).await {
            if let Ok(store) = ctx.store() {
                let mut changed = false;
                for (conv_id, mri) in &to_resolve {
                    if let Some(name) = names.get(mri) {
                        if store.upsert_conversation(conv_id, name, 0).is_ok() {
                            changed = true;
                        }
                    }
                }
                if changed {
                    ctx.emit("conversations_changed", json!({}));
                }
            }
        }
    });
}

/// Start the trouter; persist each live message and broadcast it as an event.
///
/// The trouter re-acquires fresh credentials before every (re)connection via the
/// `Ctx` credential provider, so the real-time feed survives token expiry.
fn spawn_realtime(ctx: Ctx, session: Session, db_path: String) {
    let epid_path = std::path::Path::new(&db_path).with_extension("epid");
    let epid = trouter::load_or_create_epid(&epid_path);

    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<Message>>();
    let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<trouter::Status>();

    // consume trouter messages: persist + broadcast. self identity is stable
    // across token refreshes, so capturing it once at boot is fine.
    let ctx_msgs = ctx.clone();
    let self_name = session.self_name.to_string();
    let self_mri = session.self_mri.to_string();
    tokio::spawn(async move {
        while let Some(msgs) = ev_rx.recv().await {
            if let Ok(store) = ctx_msgs.store() {
                for m in &msgs {
                    store.upsert_conversation(&m.conversation_id, "", m.compose_time).ok();
                    if store.insert_message(m).unwrap_or(false) {
                        ctx_msgs.emit("message", message_json(m, &self_name, &self_mri));
                    }
                }
            }
        }
    });
    // trouter status -> event
    let ctx_st = ctx.clone();
    tokio::spawn(async move {
        while let Some(st) = st_rx.recv().await {
            let label = match st {
                trouter::Status::Connecting => "connecting",
                trouter::Status::Connected => "connected",
                trouter::Status::Disconnected { .. } => "disconnected",
            };
            ctx_st.emit("realtime_status", json!(label));
        }
    });

    tokio::spawn(async move {
        trouter::run(ctx, epid, ev_tx, st_tx).await;
    });
}
