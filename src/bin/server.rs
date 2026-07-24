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
// Methods: conversations | open | backfill | set_draft | send | edit | react | notifications
//          | fetch_media | get_settings | set_settings | enrich_link
// Events:  status | message | conversations_changed | notifications_changed | typing | update_available
//
// No raw tokens are ever logged or sent.

use anyhow::{Context, Result};
use base64::Engine as _;
use futures_util::{stream::FuturesUnordered, FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use teams_lite::store::{Message, Store};
use teams_lite::teams::Session;
use teams_lite::{
    auth, retry, teams, teams_activity, teams_media, teams_profiles, teams_read, teams_send, trouter,
    trouter_events,
};
use teams_lite::gitlab;

const ADDR: &str = "127.0.0.1:8420";
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";
/// Give the UI ample time to connect after the server becomes ready. Authentication
/// happens before the listener binds, so this only covers local startup delays.
const INITIAL_CLIENT_GRACE: Duration = Duration::from_secs(30);
/// Once at least one UI has connected, an empty server is an orphan. Keep a short
/// grace window for UI restarts/reconnects, then terminate the backend ourselves.
const DISCONNECTED_CLIENT_GRACE: Duration = Duration::from_secs(10);

/// Settings keys (see `store::Store::{get,set}_setting`). The GitLab host and a
/// personal access token drive rich link previews (see `gitlab`).
const SETTING_GITLAB_HOST: &str = "gitlab_host";
const SETTING_GITLAB_TOKEN: &str = "gitlab_token";

/// Tracks established WebSocket clients. Raw TCP readiness probes do not count:
/// the lease is acquired only after the WebSocket handshake succeeds.
#[derive(Clone)]
struct ClientTracker {
    state: Arc<Mutex<ClientState>>,
}

struct ClientState {
    active: usize,
    ever_connected: bool,
    last_change: Instant,
}

impl ClientTracker {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ClientState {
                active: 0,
                ever_connected: false,
                last_change: Instant::now(),
            })),
        }
    }

    fn connect(&self) -> ClientLease {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active += 1;
        state.ever_connected = true;
        state.last_change = Instant::now();
        ClientLease {
            tracker: self.clone(),
        }
    }

    fn snapshot(&self) -> (usize, bool, Duration) {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (
            state.active,
            state.ever_connected,
            state.last_change.elapsed(),
        )
    }
}

/// RAII keeps the active count correct through normal closes and every error path.
struct ClientLease {
    tracker: ClientTracker,
}

impl Drop for ClientLease {
    fn drop(&mut self) {
        let mut state = self.tracker.state.lock().unwrap_or_else(|e| e.into_inner());
        debug_assert!(state.active > 0, "client tracker underflow");
        state.active = state.active.saturating_sub(1);
        state.last_change = Instant::now();
    }
}

fn should_shutdown(active: usize, ever_connected: bool, idle_for: Duration) -> bool {
    if active > 0 {
        return false;
    }
    let grace = if ever_connected {
        DISCONNECTED_CLIENT_GRACE
    } else {
        INITIAL_CLIENT_GRACE
    };
    idle_for >= grace
}

/// Env escape hatch to keep the backend alive across frontend disconnects (dev /
/// standalone use): with `TEAMS_NO_IDLE_EXIT` set, the process only stops on a
/// signal (Ctrl+C), never because the last client went away. Any value counts as
/// "on" except an explicit falsey token, so both `=1` and `=true` work.
///
/// Pure helper (takes the raw value) so the parsing is unit-tested without
/// touching the process environment.
fn env_flag_enabled(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
    }
}

/// Resolve whether idle auto-shutdown is disabled, from the process environment.
fn idle_exit_disabled() -> bool {
    env_flag_enabled(std::env::var("TEAMS_NO_IDLE_EXIT").ok().as_deref())
}

async fn wait_for_idle_shutdown(clients: ClientTracker, disabled: bool) {
    // Dev/standalone: never resolve, so the caller's shutdown branch can't fire.
    // Only a signal (Ctrl+C / SIGTERM) will stop the process.
    if disabled {
        std::future::pending::<()>().await;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (active, ever_connected, idle_for) = clients.snapshot();
        if should_shutdown(active, ever_connected, idle_for) {
            return;
        }
    }
}

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
    /// `update_available` event payload once the startup check has found a newer
    /// release, else `None`. Cached so a UI that connects AFTER the one-shot
    /// broadcast fired still learns about the update on its greeting.
    update: Arc<std::sync::Mutex<Option<Value>>>,
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

    let db_path = data_db_path()?;
    eprintln!("[ok] store {db_path}");
    Store::open(&db_path)?; // ensure schema

    // The activity feed (`48:notifications`) is a system thread, not a chat.
    // Older builds mis-persisted it as a conversation full of empty-content
    // bubbles under a raw MRI-URL title; purge that junk once so it stops
    // showing in the sidebar. Going forward it is routed to the notifications
    // surface and never re-persisted as a chat (see `spawn_realtime`).
    if let Ok(store) = Store::open(&db_path) {
        if let Err(e) = store.delete_conversation(teams_activity::NOTIFICATIONS_THREAD) {
            eprintln!("[cleanup] could not purge {}: {e}", teams_activity::NOTIFICATIONS_THREAD);
        }
        // Older builds also stored control/system frames (typing/presence pushes
        // and ThreadActivity member/topic changes) as chat bubbles — the bare
        // `notifications.skype.net` URLs and raw `<partlist>`/`<addmember>` XML.
        // Ingestion now drops them (see `teams_read::parse_message`); clear the
        // ones already persisted so existing chats read clean.
        match store.purge_control_frames() {
            Ok(n) if n > 0 => eprintln!("[cleanup] removed {n} legacy control-frame message(s)"),
            Ok(_) => {}
            Err(e) => eprintln!("[cleanup] could not purge control frames: {e}"),
        }
        // Call/meeting events that older builds stored as raw XML are upgraded in
        // place into structured `system_event` rows, so they render as a centered
        // "Call ended" line instead of a wall of machine XML.
        match store.convert_legacy_call_events() {
            Ok(n) if n > 0 => eprintln!("[cleanup] upgraded {n} legacy call-event message(s)"),
            Ok(_) => {}
            Err(e) => eprintln!("[cleanup] could not convert call events: {e}"),
        }
    }

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
        update: Arc::new(std::sync::Mutex::new(None)),
    };

    // real-time: run the trouter, persist each live message, broadcast an event.
    spawn_realtime(ctx.clone(), session, db_path);

    // one-shot, best-effort: is a newer rolling `latest` build available?
    spawn_update_check(ctx.clone());

    let listener = TcpListener::bind(ADDR).await.with_context(|| format!("bind {ADDR}"))?;
    eprintln!("[ok] server ws://{ADDR} — ready");
    let clients = ClientTracker::new();
    let no_idle_exit = idle_exit_disabled();
    if no_idle_exit {
        eprintln!("[lifecycle] TEAMS_NO_IDLE_EXIT set — staying alive until terminated (Ctrl+C)");
    }
    let idle_shutdown = wait_for_idle_shutdown(clients.clone(), no_idle_exit);
    tokio::pin!(idle_shutdown);

    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = &mut idle_shutdown => {
                eprintln!("[lifecycle] no UI clients remain — shutting down");
                return Ok(());
            }
        };
        // A transient accept() error (e.g. fd pressure) must not take down the
        // whole server — log it and keep serving. Propagating it here would
        // exit the process and leave every connected UI reconnecting to nothing.
        let (stream, _peer) = match accepted {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[accept] transient error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let ctx = ctx.clone();
        let clients = clients.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_conn(ctx, stream, clients).await {
                eprintln!("[conn] fin: {e}");
            }
        });
    }
}

/// Handle one UI connection: answer requests + forward broadcast events.
async fn serve_conn(ctx: Ctx, stream: tokio::net::TcpStream, clients: ClientTracker) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let _client_lease = clients.connect();
    let (mut write, mut read) = ws.split();
    let mut events_rx = ctx.events.subscribe();
    let mut requests = FuturesUnordered::new();

    // greet with current status
    let hello = json!({ "event": "status", "data": "connected" });
    write.send(WsMessage::Text(hello.to_string().into())).await?;

    // If the startup update check already found a newer release, tell this UI
    // right away — it may have connected after the one-shot broadcast fired, so
    // it would otherwise never hear about it.
    let pending_update = ctx.update.lock().ok().and_then(|slot| slot.clone());
    if let Some(data) = pending_update {
        let ev = json!({ "event": "update_available", "data": data });
        write.send(WsMessage::Text(ev.to_string().into())).await?;
    }

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
                        let request_ctx = ctx.clone();
                        requests.push(async move {
                            let reply = match dispatch(&request_ctx, &method, &params).await {
                                Ok(result) => json!({ "id": id, "result": result }),
                                Err(e) => json!({ "id": id, "error": e.to_string() }),
                            };
                            WsMessage::Text(reply.to_string().into())
                        }.boxed());
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
            Some(reply) = requests.next(), if !requests.is_empty() => {
                write.send(reply).await?;
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
            sync_csa_bg(ctx.clone());
            Ok(conversations_json(&rows))
        }

        // team/channel tree — LOCAL-FIRST, exactly like `conversations`: answer
        // instantly from the SQLite cache, then sync from the network in the
        // background and emit `channels_changed` if the tree changed. One CSA
        // fetch backs both lists, so this triggers the same shared sync.
        "channels" => {
            let rows = {
                let store = ctx.store()?;
                store.channels()?
            };
            sync_csa_bg(ctx.clone());
            Ok(channels_json(&rows))
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
            let (cached, has_more) = {
                let store = ctx.store()?;
                newest_history_page(&store, &conv)?
            };
            // background refresh (does not block the response = instant switch)
            let ctx_bg = ctx.clone();
            let conv_bg = conv.clone();
            let self_name_bg = self_name.clone();
            let self_mri_bg = self_mri.clone();
            let had_more = has_more;
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
                            newest_history_page(&store, &conv_bg)
                                .ok()
                                .filter(|(_, has_more)| inserted > 0 || *has_more != had_more)
                        } else {
                            None
                        }
                    };
                    if let Some((msgs, has_more)) = after {
                        // something changed vs the cache we already returned
                        ctx_bg.emit("messages_updated", json!({
                            "conversation": conv_bg,
                            "messages": messages_value(&msgs, &self_name_bg, &self_mri_bg),
                            "has_more": has_more
                        }));
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
            Ok(messages_json(&cached, &self_name, &self_mri, has_more))
        }

        // older page for scroll-up
        "backfill" => {
            let conv = param_str(params, "conversation")?;
            let before_seq = params
                .get("before_seq")
                .and_then(Value::as_i64)
                .context("missing param: before_seq")?;
            let (cached, cached_has_more) = {
                let store = ctx.store()?;
                cached_history_page(&store, &conv, before_seq)?
            };

            let session = ctx.session().await?;
            let self_name = session.self_name.to_string();
            let self_mri = session.self_mri.to_string();
            if !cached.is_empty() {
                return Ok(messages_json(
                    &cached,
                    &self_name,
                    &self_mri,
                    cached_has_more,
                ));
            }
            if !cached_has_more {
                return Ok(messages_json(&[], &self_name, &self_mri, false));
            }

            let before_ms = {
                let store = ctx.store()?;
                store
                    .oldest_cursor(&conv)?
                    .0
                    .and_then(|cursor| cursor.parse::<i64>().ok())
            };
            let http = ctx.http.clone();
            let conv_op = conv.clone();
            let page = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = conv_op.clone();
                    async move {
                        teams_read::fetch_messages_page(
                            &http,
                            &session,
                            &conv,
                            before_ms,
                            teams_read::DEFAULT_PAGE_SIZE,
                        )
                        .await
                    }
                })
                .await?;
            let has_more = {
                let store = ctx.store()?;
                teams_read::persist_backfill_page(&store, &conv, &page)?;
                store.oldest_cursor(&conv)?.1
            };
            Ok(messages_json(&page.messages, &self_name, &self_mri, has_more))
        }

        // Persist unsent composer text locally. This never touches the network.
        // Proxy one hosted-content media object (inline chat image or a shared
        // file) with the session credentials, streaming the bytes back to the UI
        // base64-encoded. The browser cannot fetch these URLs itself — they need
        // the skypetoken — and the UI never touches the network directly, so this
        // keeps images/attachments flowing through the same WebSocket protocol as
        // everything else. The URL is host-checked (see `teams_media`) before the
        // token is ever attached, so an untrusted URL can never exfiltrate it.
        "fetch_media" => {
            let url = param_str(params, "url")?;
            anyhow::ensure!(
                teams_media::is_allowed_media_url(&url),
                "media host not allowed"
            );
            let http = ctx.http.clone();
            let media = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let url = url.clone();
                    async move { teams_media::fetch_media(&http, &session, &url).await }
                })
                .await?;
            let data = base64::engine::general_purpose::STANDARD.encode(&media.bytes);
            Ok(json!({ "content_type": media.content_type, "data_base64": data }))
        }

        "set_draft" => {
            let conv = param_str(params, "conversation")?;
            let text = param_str(params, "text")?;
            let store = ctx.store()?;
            store.set_draft(&conv, &text)?;
            Ok(json!({ "saved": true }))
        }

        // send a message
        "send" => {
            let conv = param_str(params, "conversation")?;
            let text = param_str(params, "text")?;
            let reply_to = params.get("reply_to").map(parse_reply_to).transpose()?;
            let content_html = params
                .get("content_html")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let http = ctx.http.clone();
            let send_conv = conv.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = send_conv.clone();
                let text = text.clone();
                let reply_to = reply_to.clone();
                let content_html = content_html.clone();
                async move {
                    teams_send::send_message(
                        &http,
                        &session,
                        &conv,
                        &text,
                        reply_to.as_ref(),
                        content_html.as_deref(),
                    )
                    .await
                }
            })
            .await?;
            // The network accepted the message, so the persisted draft is no
            // longer needed. Never turn a successful send into an apparent
            // failure if this best-effort cleanup hits a transient SQLite error;
            // the UI also retries the same idempotent clear after the response.
            if let Err(e) = ctx.store().and_then(|store| store.set_draft(&conv, "")) {
                eprintln!("[draft] could not clear sent draft for {conv}: {e}");
            }
            Ok(json!({ "sent": true }))
        }

        // edit one of our own messages in place. The network PUT replaces the
        // message resource; we then update the local row and broadcast the new
        // content so open UIs reflect the edit immediately (both clients merge
        // live messages by id), without waiting for the trouter echo.
        "edit" => {
            let conv = param_str(params, "conversation")?;
            let message_id = param_str(params, "message_id")?;
            let text = param_str(params, "text")?;
            let http = ctx.http.clone();
            let edit_conv = conv.clone();
            let edit_id = message_id.clone();
            let edit_text = text.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = edit_conv.clone();
                let message_id = edit_id.clone();
                let text = edit_text.clone();
                async move {
                    teams_send::edit_message(&http, &session, &conv, &message_id, &text).await
                }
            })
            .await?;

            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };
            let new_content = teams_send::escape_html(&text);
            if let Ok(store) = ctx.store() {
                if let Some(updated) =
                    store.update_message_content(&conv, &message_id, &new_content)?
                {
                    ctx.emit("message", message_json(&updated, &self_name, &self_mri));
                }
            }
            Ok(json!({ "edited": true }))
        }

        // react to a message with an emoji (Teams "emotion"), or toggle ours off.
        // `key` is the emotion the user picked (e.g. "like", "heart"). Teams keeps
        // one reaction per user per message, so we toggle: clicking our current
        // reaction removes it; any other key replaces it. After the network PUT we
        // optimistically update the local row and broadcast it (both clients merge
        // by id), so the reaction shows immediately without waiting for the echo.
        "react" => {
            let conv = param_str(params, "conversation")?;
            let message_id = param_str(params, "message_id")?;
            let key = param_str(params, "key")?;

            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };

            // Decide the toggle from what we currently hold: same key -> off.
            let current_key = ctx
                .store()
                .ok()
                .and_then(|store| store.get_message(&conv, &message_id).ok().flatten())
                .and_then(|m| teams_lite::store::my_reaction_key(&m.reactions, &self_mri));
            let on = current_key.as_deref() != Some(key.as_str());

            let http = ctx.http.clone();
            let react_conv = conv.clone();
            let react_id = message_id.clone();
            let react_key = key.clone();
            ctx.retry_on_auth(move |session, _csa| {
                let http = http.clone();
                let conv = react_conv.clone();
                let message_id = react_id.clone();
                let key = react_key.clone();
                async move {
                    teams_send::set_reaction(&http, &session, &conv, &message_id, &key, on).await
                }
            })
            .await?;

            // Optimistic local update: reflect our own reaction now.
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if let Ok(store) = ctx.store() {
                let key_arg = if on { Some(key.as_str()) } else { None };
                if let Some(updated) =
                    store.set_my_reaction(&conv, &message_id, &self_mri, key_arg, now_ms)?
                {
                    ctx.emit("message", message_json(&updated, &self_name, &self_mri));
                }
            }
            Ok(json!({ "reacted": on }))
        }

        // activity feed (`48:notifications`) — reactions / mentions / replies
        // directed at us. Not a chat: fetched fresh from Teams (which holds the
        // server-side read state), decoded into structured notifications, and
        // surfaced in the UI's notifications panel. No local cache — the feed is
        // small and the panel refreshes on `notifications_changed`.
        "notifications" => {
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 100) as u32)
                .unwrap_or(teams_activity::DEFAULT_NOTIFICATIONS_LIMIT);
            let http = ctx.http.clone();
            let items = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    async move { teams_activity::fetch_notifications(&http, &session, limit).await }
                })
                .await?;
            Ok(notifications_json(&items))
        }

        // Read the non-secret view of the app settings: the configured GitLab
        // host and whether a token is stored. The raw token is NEVER returned —
        // it is write-only from the UI's perspective, matching the "no raw tokens
        // are ever sent" rule.
        "get_settings" => {
            let store = ctx.store()?;
            gitlab_settings_json(&store)
        }

        // Persist app settings (partial update). Only keys present in `params`
        // are written, so the UI can save the host without resending the token.
        // `gitlab_token: ""` explicitly clears the token. Returns the same
        // non-secret view as `get_settings` so the UI updates in one round-trip.
        "set_settings" => {
            let store = ctx.store()?;
            if let Some(host) = params.get("gitlab_host").and_then(Value::as_str) {
                store.set_setting(SETTING_GITLAB_HOST, host.trim())?;
            }
            if let Some(token) = params.get("gitlab_token").and_then(Value::as_str) {
                store.set_setting(SETTING_GITLAB_TOKEN, token.trim())?;
            }
            gitlab_settings_json(&store)
        }

        // Enrich a GitLab link with metadata (title, state, author, …) so the UI
        // can render a rich preview card instead of a bare URL. The configured
        // token is read from the store and sent only to the configured host (see
        // `gitlab`). Best-effort: a non-GitLab/private link yields `metadata:
        // null` (the UI shows the plain link); only a transient failure errors.
        "enrich_link" => {
            let url = param_str(params, "url")?;
            let (host, token) = {
                let store = ctx.store()?;
                (
                    store.get_setting(SETTING_GITLAB_HOST)?,
                    store.get_setting(SETTING_GITLAB_TOKEN)?,
                )
            };
            let host = host
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| gitlab::DEFAULT_HOST.to_string());
            let token = token.filter(|t| !t.is_empty());
            let metadata =
                gitlab::fetch_metadata(&ctx.http, &host, token.as_deref(), &url).await?;
            Ok(json!({ "metadata": metadata }))
        }

        other => anyhow::bail!("unknown method: {other}"),
    }
}

fn parse_reply_to(value: &Value) -> Result<teams_send::ReplyTo> {
    Ok(teams_send::ReplyTo {
        compose_time: value
            .get("compose_time")
            .and_then(Value::as_i64)
            .context("missing param: reply_to.compose_time")?,
        sender: param_str(value, "sender")?,
        sender_mri: value
            .get("sender_mri")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        preview: param_str(value, "preview")?,
        before: param_str(value, "before")?,
        after: param_str(value, "after")?,
    })
}

fn param_str(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .with_context(|| format!("missing param: {key}"))
}

/// Build the non-secret view of the app settings for the UI: the configured
/// GitLab host (falling back to the default) and whether a token is stored. The
/// raw token is deliberately never included — the UI only needs to know it is
/// set, never its value.
fn gitlab_settings_json(store: &Store) -> Result<Value> {
    let host = store
        .get_setting(SETTING_GITLAB_HOST)?
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| gitlab::DEFAULT_HOST.to_string());
    let token_set = store
        .get_setting(SETTING_GITLAB_TOKEN)?
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    Ok(json!({ "gitlab_host": host, "gitlab_token_set": token_set }))
}

/// Resolve the persistent SQLite path, following the XDG Base Directory spec:
/// `$XDG_DATA_HOME/teams-lite/teams-lite.sqlite`, falling back to
/// `~/.local/share/teams-lite/teams-lite.sqlite`.
///
/// This MUST be a durable location. The store is the local-first cache — its
/// entire value (instant open, offline history) depends on surviving restarts
/// and reboots. The temp dir is often a tmpfs that's wiped on reboot, which
/// silently defeats local-first (every conversation reloads from the network
/// after a reboot), so we never put it there. The parent dir is created if
/// missing.
fn data_db_path() -> Result<String> {
    // XDG spec: a relative $XDG_DATA_HOME is invalid and must be ignored.
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
        .context("cannot resolve a data directory: neither XDG_DATA_HOME nor HOME is set")?;
    let dir = base.join("teams-lite");
    std::fs::create_dir_all(&dir).with_context(|| format!("create data dir {}", dir.display()))?;
    dir.join("teams-lite.sqlite")
        .into_os_string()
        .into_string()
        .map_err(|p| anyhow::anyhow!("data path is not valid UTF-8: {p:?}"))
}

/// Serialize the activity feed for the UI: the decoded notifications plus the
/// unread count (derived from Teams' own read-state) so the bell can badge it.
fn notifications_json(items: &[teams_activity::Notification]) -> Value {
    let unread = items.iter().filter(|n| !n.is_read).count();
    json!({
        "unread": unread,
        "items": items
            .iter()
            .map(|n| json!({
                "id": n.id,
                "activity_type": n.activity_type,
                "activity_subtype": n.activity_subtype,
                "actor_name": n.actor_name,
                "actor_mri": n.actor_mri,
                "source_thread_id": n.source_thread_id,
                "source_message_id": n.source_message_id,
                "preview": n.preview,
                "timestamp": n.timestamp_ms,
                "count": n.count,
                "is_read": n.is_read
            }))
            .collect::<Vec<_>>()
    })
}

fn conversations_json(rows: &[teams_lite::store::ConversationRow]) -> Value {
    json!(rows
        .iter()
        .map(|c| json!({
            "id": c.id,
            "name": c.display_name,
            "last_message_time": c.last_message_time,
            "kind": c.kind.as_str(),
            "last_message_preview": c.last_message_preview,
            "last_message_sender": c.last_message_sender,
            "last_message_from_me": c.last_message_from_me,
            "is_read": c.is_read,
            "is_muted": c.is_muted,
            "is_pinned": c.is_pinned,
            "is_hidden": c.is_hidden,
            "thread_type": c.thread_type,
            "draft": c.draft
        }))
        .collect::<Vec<_>>())
}

/// Serialize the channel tree for the UI. A flat list, pre-sorted by the store
/// (team, General-first, then name); the web client groups it into team → channel
/// sections. `team_id`/`team_name` are denormalized onto each row so the grouping
/// needs no second lookup.
fn channels_json(rows: &[teams_lite::store::ChannelRow]) -> Value {
    json!(rows
        .iter()
        .map(|c| json!({
            "id": c.id,
            "team_id": c.team_id,
            "team_name": c.team_name,
            "name": c.display_name,
            "is_general": c.is_general,
            "is_favorite": c.is_favorite,
            "last_message_time": c.last_message_time,
            "last_message_preview": c.last_message_preview,
            "last_message_sender": c.last_message_sender,
            "last_message_from_me": c.last_message_from_me,
            "is_read": c.is_read,
            "draft": c.draft
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
            "compose_time": m.compose_time, "sender": m.sender, "sender_mri": m.sender_mri,
            "content": m.content,
            "attachments": attachments_value(m),
            "reactions": reactions_value(m, self_mri),
            "system_event": system_event_value(m),
            "is_self": is_self(m, self_name, self_mri)
        }))
        .collect::<Vec<_>>())
}

/// Decode a message's stored attachments (a JSON array string) back into a JSON
/// value for the wire. A legacy/blank/malformed value degrades to an empty array
/// so a single bad row can never break a whole page's serialization.
fn attachments_value(m: &Message) -> Value {
    serde_json::from_str(&m.attachments).unwrap_or_else(|_| json!([]))
}

/// Decode a message's structured system event (a JSON object string) for the wire,
/// or `null` when the message is a normal chat message (empty `system_event`) or
/// the stored value is malformed. The UI renders a centered system line when this
/// is present (see `web/src/components/call-event-line.tsx`).
fn system_event_value(m: &Message) -> Value {
    if m.system_event.is_empty() {
        return Value::Null;
    }
    serde_json::from_str(&m.system_event).unwrap_or(Value::Null)
}

/// Decode a message's stored reactions into the wire shape the UIs render: one
/// `{ "key", "count", "mine" }` per emotion that has at least one user, with
/// `mine` true when our own MRI is among them. The full user list stays server-
/// side; the UI only needs the aggregate plus whether we reacted. A legacy /
/// blank / malformed value degrades to an empty array so one bad row can never
/// break serialization.
fn reactions_value(m: &Message, self_mri: &str) -> Value {
    let parsed: Value = serde_json::from_str(&m.reactions).unwrap_or_else(|_| json!([]));
    let Some(list) = parsed.as_array() else {
        return json!([]);
    };
    let out: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            let key = e.get("key").and_then(Value::as_str)?;
            let users = e.get("users").and_then(Value::as_array)?;
            if users.is_empty() {
                return None;
            }
            let mine = !self_mri.is_empty()
                && users
                    .iter()
                    .filter_map(|u| u.get("mri").and_then(Value::as_str))
                    .any(|m| teams_lite::store::same_user(m, self_mri));
            Some(json!({ "key": key, "count": users.len(), "mine": mine }))
        })
        .collect();
    json!(out)
}

fn messages_json(msgs: &[Message], self_name: &str, self_mri: &str, has_more: bool) -> Value {
    json!({
        "messages": messages_value(msgs, self_name, self_mri),
        "has_more": has_more
    })
}

fn newest_history_page(store: &Store, conversation_id: &str) -> Result<(Vec<Message>, bool)> {
    let mut messages = store.newest_messages(
        conversation_id,
        i64::from(teams_read::DEFAULT_PAGE_SIZE) + 1,
    )?;
    let has_cached_more = messages.len() > teams_read::DEFAULT_PAGE_SIZE as usize;
    if has_cached_more {
        let extra = messages.len() - teams_read::DEFAULT_PAGE_SIZE as usize;
        messages.drain(..extra);
    }
    let network_has_more = store.oldest_cursor(conversation_id)?.1;
    Ok((messages, has_cached_more || network_has_more))
}

/// Return one older page from SQLite before using the network frontier. Reading
/// one extra row lets us report `has_more` exactly when all known history is
/// local; the persisted frontier covers history that still needs a network fetch.
fn cached_history_page(
    store: &Store,
    conversation_id: &str,
    before_seq: i64,
) -> Result<(Vec<Message>, bool)> {
    let mut messages = store.messages_before(
        conversation_id,
        before_seq,
        i64::from(teams_read::DEFAULT_PAGE_SIZE) + 1,
    )?;
    let has_cached_more = messages.len() > teams_read::DEFAULT_PAGE_SIZE as usize;
    if has_cached_more {
        let extra = messages.len() - teams_read::DEFAULT_PAGE_SIZE as usize;
        messages.drain(..extra);
    }
    let network_has_more = store.oldest_cursor(conversation_id)?.1;
    Ok((messages, has_cached_more || network_has_more))
}

fn message_json(m: &Message, self_name: &str, self_mri: &str) -> Value {
    json!({
        "id": m.id, "conversation_id": m.conversation_id, "seq": m.seq,
        "compose_time": m.compose_time, "sender": m.sender, "sender_mri": m.sender_mri,
        "content": m.content,
        "attachments": attachments_value(m),
        "reactions": reactions_value(m, self_mri),
        "system_event": system_event_value(m),
        "is_self": is_self(m, self_name, self_mri)
    })
}

/// Sync the chat list AND the channel tree from the network in the background:
/// one CSA fetch feeds both. Persist each, emit `conversations_changed` and/or
/// `channels_changed` only when something actually changed, then resolve 1:1
/// names. This keeps the `conversations`/`channels` requests off the network path
/// (local-first startup).
///
/// Persisting channels also HEALS any channel row that leaked into the chat list:
/// a channel post arriving live (before the first CSA sync) upserts a conversation
/// row by id, and `persist_channels` deletes it. When healing happens we must emit
/// `conversations_changed` too so the sidebar drops the stray chat entry.
fn sync_csa_bg(ctx: Ctx) {
    tokio::spawn(async move {
        let http = ctx.http.clone();
        let (convs, teams) = match ctx
            .retry_on_auth(|session, csa| {
                let http = http.clone();
                async move { teams_read::fetch_csa(&http, &session, &csa).await }
            })
            .await
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let (chats_changed, channels_changed) = {
            if let Ok(store) = ctx.store() {
                let inserted = teams_read::persist_conversations(&store, &convs);
                let (changed, healed) = teams_read::persist_channels(&store, &teams);
                // A healed leak removes a row from the chat list, so it is also a
                // conversations change.
                (inserted > 0 || healed > 0, changed > 0)
            } else {
                return;
            }
        };
        if chats_changed {
            ctx.emit("conversations_changed", json!({}));
        }
        if channels_changed {
            ctx.emit("channels_changed", json!({}));
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
                        // Only a real name change counts: re-resolving to the
                        // same name must not emit `conversations_changed`, or the
                        // UI's refresh loop would run forever (a 1:1's network
                        // title stays blank, so it is "resolvable" on every sync).
                        if store.upsert_conversation(conv_id, name, 0).unwrap_or(false) {
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

/// Check GitHub once, in the background, for a newer rolling `latest` release
/// than the commit this binary was built from, and tell the UI if there is one.
///
/// Best-effort by design: a dev build (no embedded commit), no network, or a
/// rate-limited API all end the check quietly — it must never affect startup or
/// the running app. On a hit we cache the payload (so UIs that connect later
/// still learn about it, see `serve_conn`) and broadcast it to any UI already
/// connected.
fn spawn_update_check(ctx: Ctx) {
    let Some(current) = teams_lite::update::build_rev() else {
        // Built from source: nothing meaningful to compare against, so we never
        // nag developers running a local build.
        return;
    };
    tokio::spawn(async move {
        match teams_lite::update::check(&ctx.http, current).await {
            Ok(Some(info)) => {
                let data = json!({
                    "current": info.current,
                    "latest": info.latest,
                    "url": info.url,
                });
                if let Ok(mut slot) = ctx.update.lock() {
                    *slot = Some(data.clone());
                }
                ctx.emit("update_available", data);
                eprintln!(
                    "[update] a newer build is available ({} -> {})",
                    info.current, info.latest
                );
            }
            // Up to date, or the remote commit couldn't be identified: say nothing.
            Ok(None) => {}
            // Reached-but-failed or offline: log once, never surface to the user.
            Err(e) => eprintln!("[update] check skipped: {e}"),
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
    let (ty_tx, mut ty_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::TypingEvent>();
    let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<trouter::Status>();

    // consume trouter messages: persist + broadcast. self identity is stable
    // across token refreshes, so capturing it once at boot is fine.
    let ctx_msgs = ctx.clone();
    let self_name = session.self_name.to_string();
    let self_mri = session.self_mri.to_string();
    tokio::spawn(async move {
        while let Some(msgs) = ev_rx.recv().await {
            if let Ok(store) = ctx_msgs.store() {
                let mut activity_changed = false;
                let mut channels_changed = false;
                for m in &msgs {
                    // The activity feed is not a chat: never persist it as a
                    // conversation. Signal the UI to refresh notifications
                    // instead — the full payload is re-fetched via the
                    // `notifications` method (the live frame's chat `content` is
                    // always empty; the payload lives in properties.activity).
                    if teams_activity::is_notifications_thread(&m.conversation_id) {
                        activity_changed = true;
                        continue;
                    }
                    // A channel post must NOT create a chat-list row. Bump the
                    // channel's last-message metadata instead (kept in the
                    // channels table, surfaced under the Channels tab). The
                    // message body still lands in the shared `messages` table
                    // below, so an open channel view updates live. We match on the
                    // thread-id shape (reliable, covers channels not yet synced)
                    // and, defensively, on any channel we already know.
                    let is_channel = teams_read::is_channel_thread_id(&m.conversation_id)
                        || store.is_channel(&m.conversation_id).unwrap_or(false);
                    if is_channel {
                        let from_me = is_self(m, &self_name, &self_mri);
                        if store
                            .touch_channel(&m.conversation_id, m.compose_time, from_me)
                            .unwrap_or(false)
                        {
                            channels_changed = true;
                        }
                    } else {
                        store.upsert_conversation(&m.conversation_id, "", m.compose_time).ok();
                    }
                    let inserted = store.insert_message(m).unwrap_or(false);
                    // Reconcile reactions when this live frame carried an
                    // emotions snapshot. An empty sentinel means the frame said
                    // nothing about reactions (e.g. a plain edit), so we never
                    // clobber an existing set. On a real change we get back the
                    // refreshed row to broadcast.
                    let reacted = if m.reactions.is_empty() {
                        None
                    } else {
                        store
                            .update_message_reactions(&m.conversation_id, &m.id, &m.reactions)
                            .unwrap_or(None)
                    };
                    if inserted || reacted.is_some() {
                        // Emit the authoritative stored row: on a reaction change
                        // it is `reacted`; on a fresh insert / content edit re-read
                        // so the broadcast still carries reactions preserved across
                        // the change (the parsed `m` may hold the sentinel, not the
                        // stored set).
                        let row = reacted
                            .or_else(|| store.get_message(&m.conversation_id, &m.id).ok().flatten())
                            .unwrap_or_else(|| m.clone());
                        ctx_msgs.emit("message", message_json(&row, &self_name, &self_mri));
                    }
                }
                if activity_changed {
                    ctx_msgs.emit("notifications_changed", json!({}));
                }
                if channels_changed {
                    ctx_msgs.emit("channels_changed", json!({}));
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

    // trouter typing signals -> `typing` event. Ephemeral presence: resolve the
    // sender MRI to a display name from what the store already holds (no network),
    // drop our own echo, and never touch the activity-feed thread.
    let ctx_ty = ctx.clone();
    let self_mri_ty = session.self_mri.to_string();
    tokio::spawn(async move {
        while let Some(t) = ty_rx.recv().await {
            if t.sender_mri == self_mri_ty {
                continue; // don't show ourselves typing
            }
            if teams_activity::is_notifications_thread(&t.conversation_id) {
                continue; // the activity feed is not a chat
            }
            let sender = ctx_ty
                .store()
                .ok()
                .and_then(|s| s.display_name_for_mri(&t.sender_mri).ok().flatten())
                .unwrap_or_default();
            ctx_ty.emit(
                "typing",
                json!({
                    "conversation_id": t.conversation_id,
                    "sender_mri": t.sender_mri,
                    "sender": sender,
                    "is_typing": t.is_typing,
                }),
            );
        }
    });

    tokio::spawn(async move {
        trouter::run(ctx, epid, ev_tx, ty_tx, st_tx).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(seq: i64) -> Message {
        Message {
            id: format!("m{seq}"),
            conversation_id: "c1".into(),
            seq,
            compose_time: seq,
            sender: "Alice".into(),
            sender_mri: String::new(),
            content: format!("message {seq}"),
            attachments: "[]".into(),
            reactions: "[]".into(),
            system_event: String::new(),
        }
    }

    #[test]
    fn reactions_value_aggregates_count_and_mine() {
        let mut m = message(1);
        m.reactions = r#"[
            {"key":"like","users":[{"mri":"8:me","time":1},{"mri":"8:other","time":2}]},
            {"key":"heart","users":[]}
        ]"#
        .into();

        let v = reactions_value(&m, "8:me");
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1, "the empty-user 'heart' emotion is dropped");
        assert_eq!(arr[0]["key"], "like");
        assert_eq!(arr[0]["count"], 2);
        assert_eq!(arr[0]["mine"], true);

        // `mine` is false when our MRI is not among the reactors
        let v = reactions_value(&m, "8:someone_else");
        assert_eq!(v.as_array().unwrap()[0]["mine"], false);
    }

    #[test]
    fn system_event_rides_the_wire_only_for_events() {
        // A normal chat message carries a null system_event on the wire.
        let chat = message(1);
        assert!(message_json(&chat, "Alice", "8:me")["system_event"].is_null());

        // A call event serializes its structured payload for the UI to render.
        let mut call = message(2);
        call.content = String::new();
        call.system_event =
            r#"{"kind":"call","event":"ended","duration_seconds":600,"participant_count":5,"participants":["A"]}"#
                .into();
        let v = message_json(&call, "Alice", "8:me");
        assert_eq!(v["system_event"]["kind"], "call");
        assert_eq!(v["system_event"]["event"], "ended");
        assert_eq!(v["system_event"]["duration_seconds"], 600);
        assert_eq!(v["content"], "");
    }

    #[test]
    fn channels_json_carries_team_grouping_and_read_state() {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_channel_full(&teams_lite::store::ChannelUpdate {
                id: "19:general@thread.tacv2",
                team_id: "19:team@thread.tacv2",
                team_name: "Engineering",
                display_name: "General",
                is_general: true,
                is_favorite: false,
                last_message_time: 1_700_000_000_000,
                last_message_preview: "Ship it",
                last_message_sender: "Alice",
                last_message_from_me: false,
                is_read: false,
            })
            .unwrap();

        let v = channels_json(&store.channels().unwrap());
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let c = &arr[0];
        assert_eq!(c["id"], "19:general@thread.tacv2");
        assert_eq!(c["team_id"], "19:team@thread.tacv2");
        assert_eq!(c["team_name"], "Engineering");
        assert_eq!(c["name"], "General");
        assert_eq!(c["is_general"], true);
        assert_eq!(c["last_message_preview"], "Ship it");
        assert_eq!(c["last_message_sender"], "Alice");
        assert_eq!(c["is_read"], false);
    }

    #[test]
    fn cached_history_is_served_in_exact_pages_before_network() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 100).unwrap();
        for seq in 1..=100 {
            store.insert_message(&message(seq)).unwrap();
        }
        store.set_oldest_cursor("c1", Some("1"), false).unwrap();

        let (initial, has_more) = newest_history_page(&store, "c1").unwrap();
        assert_eq!(initial.len(), 40);
        assert_eq!(initial.first().unwrap().seq, 61);
        assert_eq!(initial.last().unwrap().seq, 100);
        assert!(has_more);

        let (page, has_more) = cached_history_page(&store, "c1", 101).unwrap();
        assert_eq!(page.len(), 40);
        assert_eq!(page.first().unwrap().seq, 61);
        assert_eq!(page.last().unwrap().seq, 100);
        assert!(has_more);

        let (last_page, has_more) = cached_history_page(&store, "c1", 21).unwrap();
        assert_eq!(last_page.len(), 20);
        assert_eq!(last_page.first().unwrap().seq, 1);
        assert!(!has_more);
    }

    #[test]
    fn parses_reply_metadata_from_send_params() {
        let reply = parse_reply_to(&json!({
            "compose_time": 1_784_279_090_040_i64,
            "sender": "Alice",
            "sender_mri": "8:orgid:abc-123",
            "preview": "Original message",
            "before": "Draft before",
            "after": "Draft after"
        }))
        .unwrap();

        assert_eq!(reply.compose_time, 1_784_279_090_040);
        assert_eq!(reply.sender, "Alice");
        assert_eq!(reply.sender_mri, "8:orgid:abc-123");
        assert_eq!(reply.preview, "Original message");
        assert_eq!(reply.before, "Draft before");
        assert_eq!(reply.after, "Draft after");
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn active_clients_always_keep_server_alive() {
        assert!(!should_shutdown(1, true, Duration::from_secs(60)));
        assert!(!should_shutdown(2, false, Duration::from_secs(60)));
    }

    #[test]
    fn server_waits_longer_for_its_first_client() {
        assert!(!should_shutdown(
            0,
            false,
            INITIAL_CLIENT_GRACE - Duration::from_millis(1)
        ));
        assert!(should_shutdown(0, false, INITIAL_CLIENT_GRACE));
    }

    #[test]
    fn disconnected_server_exits_after_short_grace() {
        assert!(!should_shutdown(
            0,
            true,
            DISCONNECTED_CLIENT_GRACE - Duration::from_millis(1),
        ));
        assert!(should_shutdown(0, true, DISCONNECTED_CLIENT_GRACE));
    }

    #[test]
    fn no_idle_exit_flag_parsing() {
        // Present + truthy (any non-falsey value) disables idle shutdown.
        for on in ["1", "true", "TRUE", "yes", "on", " 1 ", "anything"] {
            assert!(env_flag_enabled(Some(on)), "{on:?} should enable");
        }
        // Absent or an explicit falsey token keeps the orphan safety net.
        for off in ["", "0", "false", "FALSE", "no", "off", "  "] {
            assert!(!env_flag_enabled(Some(off)), "{off:?} should stay off");
        }
        assert!(!env_flag_enabled(None));
    }

    #[tokio::test]
    async fn disabled_idle_watcher_never_shuts_down() {
        // With idle-exit disabled (TEAMS_NO_IDLE_EXIT), the watcher must never
        // resolve, even with no clients ever connected — only a signal stops the
        // process. A short timeout is enough: the future pends immediately.
        let clients = ClientTracker::new();
        let res = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for_idle_shutdown(clients, true),
        )
        .await;
        assert!(res.is_err(), "keep-alive watcher must stay pending forever");
    }

    #[test]
    fn client_lease_tracks_connection_lifetime() {
        let tracker = ClientTracker::new();
        assert_eq!(tracker.snapshot().0, 0);
        assert!(!tracker.snapshot().1);

        {
            let _lease = tracker.connect();
            assert_eq!(tracker.snapshot().0, 1);
            assert!(tracker.snapshot().1);
        }

        assert_eq!(tracker.snapshot().0, 0);
    }
}
