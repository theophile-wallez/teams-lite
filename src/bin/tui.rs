// teams-lite — TUI (slice 3 + cmd+K from slice 4)
//
// Event-driven, local-first terminal client:
//   - the UI thread reads ONLY from SQLite and redraws on events
//   - a network layer syncs the conversation list + message pages INTO the store,
//     then signals the UI to re-query — the UI never calls the network directly
//   - redraw happens only on a keyboard event or a network "changed" signal
//     (zero CPU at rest)
//
// Auth is broker-only (device-code is blocked by tenant Conditional Access).
// No raw tokens are ever printed (and in the TUI we print nothing to stdout).

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::sync::mpsc;

use teams_lite::store::{Message, Store};
use teams_lite::teams::Session;
use teams_lite::ui::{Action, App};
use teams_lite::{auth, teams, teams_profiles, teams_read, teams_send, trouter};

use ratatui::crossterm::event::{Event, EventStream, KeyEventKind};

const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

/// Signals from the network layer telling the UI what changed in the store.
enum Net {
    ConversationsUpdated,
    MessagesUpdated(String), // conversation id
    /// Real-time messages just arrived from the trouter and were persisted.
    Live(Vec<Message>),
    /// Real-time connection lifecycle.
    LiveStatus(trouter::Status),
    Status(String),
}

/// Shared, cheaply-clonable networking context for spawned tasks.
#[derive(Clone)]
struct NetCtx {
    http: reqwest::Client,
    session: Arc<Session>,
    csa_token: Arc<String>,
    /// token for the profiles endpoint (mri -> display name); used to name 1:1s
    profile_token: Arc<String>,
    db_path: Arc<String>,
    tx: mpsc::UnboundedSender<Net>,
}

impl NetCtx {
    /// Open a fresh store connection for a task (WAL allows concurrent readers/writer).
    fn store(&self) -> Result<Store> {
        Store::open(&self.db_path)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // --- bootstrap networking BEFORE taking over the terminal, so any auth error
    //     is printed normally instead of into a raw-mode screen. ---
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    println!("teams-lite — authentification (broker)…");
    let ic3 = auth::get_token(IC3_SCOPE).await.context("ic3 token")?;
    let csa = auth::get_token(teams_read::CSA_SCOPE).await.context("csa token")?;
    let profile_token = auth::get_token(teams_profiles::PROFILE_SCOPE).await.context("profile token")?;
    let session = teams::connect(&http).await?;
    println!("[ok] region={} — connexion établie", session.region);

    let db_path = std::env::temp_dir().join("teams-lite.sqlite");
    let db_path = db_path.to_str().unwrap().to_string();
    // Ensure schema exists before the UI reads.
    Store::open(&db_path)?;

    let (net_tx, mut net_rx) = mpsc::unbounded_channel::<Net>();
    let ctx = NetCtx {
        http,
        session: Arc::new(session.clone()),
        csa_token: Arc::new(csa),
        profile_token: Arc::new(profile_token),
        db_path: Arc::new(db_path.clone()),
        tx: net_tx.clone(),
    };

    // Kick off the initial conversation-list sync in the background.
    spawn_sync_conversations(ctx.clone());

    // Start the real-time trouter client. It emits parsed messages + lifecycle
    // status; we persist and refresh on each batch. epid is persisted so the
    // server keeps routing to the same registration across runs.
    spawn_realtime(&session, ic3, &db_path, net_tx.clone());

    // our display name, used to derive 1:1 conversation names from message senders
    let self_name = session.self_name.clone();

    // --- take over the terminal ---
    let mut terminal = ratatui::init();
    let store = Store::open(&db_path)?;
    let mut app = App::new(store.conversations(&self_name)?);

    let mut keys = EventStream::new();
    app.draw_into(&mut terminal)?;

    loop {
        tokio::select! {
            // keyboard
            maybe = keys.next() => {
                let Some(Ok(ev)) = maybe else { continue };
                if let Event::Key(k) = ev {
                    if k.kind != KeyEventKind::Press { continue; }
                    match app.handle_key(k) {
                        Action::Quit => break,
                        Action::None => {}
                        Action::OpenConversation(id) => {
                            // render cached tail instantly, then fetch newest in the background
                            if let Ok(msgs) = store.newest_messages(&id, 200) {
                                app.set_messages(&id, msgs);
                            }
                            spawn_open(ctx.clone(), id);
                        }
                        Action::BackfillOlder(id) => spawn_backfill(ctx.clone(), id),
                        Action::SendMessage { id, text } => spawn_send(ctx.clone(), id, text),
                    }
                    app.draw_into(&mut terminal)?;
                }
            }
            // network signals
            Some(sig) = net_rx.recv() => {
                match sig {
                    Net::ConversationsUpdated => app.set_conversations(store.conversations(&self_name)?),
                    Net::MessagesUpdated(id) => {
                        if let Ok(msgs) = store.newest_messages(&id, 200) {
                            app.set_messages(&id, msgs);
                        }
                        app.set_conversations(store.conversations(&self_name)?);
                    }
                    Net::Live(messages) => {
                        // persist live messages locally (dedup by id), then refresh
                        let mut touched_open = false;
                        for m in &messages {
                            store.upsert_conversation(&m.conversation_id, "", m.compose_time).ok();
                            store.insert_message(m).ok();
                            if app.open_id.as_deref() == Some(m.conversation_id.as_str()) {
                                touched_open = true;
                            }
                        }
                        // conversation list re-sorts by last_message_time
                        app.set_conversations(store.conversations(&self_name)?);
                        // if a message landed in the open conversation, refresh its pane
                        if touched_open
                            && let Some(id) = app.open_id.clone()
                                && let Ok(msgs) = store.newest_messages(&id, 200) {
                                    app.set_messages(&id, msgs);
                                }
                    }
                    Net::LiveStatus(st) => {
                        app.status = match st {
                            trouter::Status::Connecting => "⏳ temps réel: connexion…".into(),
                            trouter::Status::Connected => {
                                // catch up on anything missed while disconnected
                                spawn_sync_conversations(ctx.clone());
                                if let Some(id) = app.open_id.clone() {
                                    spawn_open(ctx.clone(), id);
                                }
                                "🟢 temps réel: connecté".into()
                            }
                            trouter::Status::Disconnected { retry_in_secs } => {
                                format!("🔴 temps réel: reconnexion dans {retry_in_secs}s")
                            }
                        };
                    }
                    Net::Status(s) => app.status = s,
                }
                app.draw_into(&mut terminal)?;
            }
        }
    }

    ratatui::restore();
    Ok(())
}

/// Start the real-time trouter client and bridge its channels into the UI's Net
/// channel. Runs forever (with reconnection) in the background.
fn spawn_realtime(session: &Session, ic3: String, db_path: &str, ui_tx: mpsc::UnboundedSender<Net>) {
    let session = session.clone();
    // persist the endpoint id next to the db so the registration is stable
    let epid_path = std::path::Path::new(db_path).with_extension("epid");
    let epid = trouter::load_or_create_epid(&epid_path);

    let (ev_batch_tx, mut ev_batch_rx) = mpsc::unbounded_channel::<Vec<Message>>();
    let (st_tx, mut st_rx) = mpsc::unbounded_channel::<trouter::Status>();

    // bridge: trouter message batches -> UI Net::Live
    let ui_ev = ui_tx.clone();
    tokio::spawn(async move {
        while let Some(msgs) = ev_batch_rx.recv().await {
            if ui_ev.send(Net::Live(msgs)).is_err() {
                break;
            }
        }
    });
    // bridge: trouter status -> UI Net::LiveStatus
    let ui_st = ui_tx;
    tokio::spawn(async move {
        while let Some(st) = st_rx.recv().await {
            if ui_st.send(Net::LiveStatus(st)).is_err() {
                break;
            }
        }
    });

    // the trouter client itself (reconnects internally)
    tokio::spawn(async move {
        trouter::run(session, ic3, epid, ev_batch_tx, st_tx).await;
    });
}

fn spawn_sync_conversations(ctx: NetCtx) {
    tokio::spawn(async move {
        let _ = ctx.tx.send(Net::Status("Sync des conversations…".into()));
        match teams_read::fetch_conversations(&ctx.http, &ctx.session, &ctx.csa_token).await {
            Ok(convs) => {
                // ... then persist (sync, store never crosses an await)
                let n = match ctx.store() {
                    Ok(store) => teams_read::persist_conversations(&store, &convs),
                    Err(e) => {
                        let _ = ctx.tx.send(Net::Status(format!("store: {e}")));
                        return;
                    }
                };
                let _ = ctx.tx.send(Net::ConversationsUpdated);
                let _ = ctx.tx.send(Net::Status(format!("{n} conversations")));

                // Resolve 1:1 names: gather the other member's mri for non-empty 1:1
                // chats that have no title, batch-resolve to display names, and
                // upsert them as the conversation title.
                let to_resolve: Vec<(String, String)> = convs
                    .iter()
                    .filter(|c| c.is_one_on_one && !c.is_empty && c.title.is_empty() && !c.other_member_mri.is_empty())
                    .map(|c| (c.id.clone(), c.other_member_mri.clone()))
                    .collect();
                if !to_resolve.is_empty() {
                    let mris: Vec<String> = to_resolve.iter().map(|(_, mri)| mri.clone()).collect();
                    if let Ok(names) = teams_profiles::fetch_names(&ctx.http, &ctx.session, &ctx.profile_token, &mris).await
                        && let Ok(store) = ctx.store() {
                            let mut resolved = 0;
                            for (conv_id, mri) in &to_resolve {
                                if let Some(name) = names.get(mri) {
                                    // last_message_time is preserved by MAX() in upsert
                                    if store.upsert_conversation(conv_id, name, 0).is_ok() {
                                        resolved += 1;
                                    }
                                }
                            }
                            if resolved > 0 {
                                let _ = ctx.tx.send(Net::ConversationsUpdated);
                            }
                        }
                }
            }
            Err(e) => {
                let _ = ctx.tx.send(Net::Status(format!("erreur sync conv: {e}")));
            }
        }
    });
}

fn spawn_open(ctx: NetCtx, conversation_id: String) {
    tokio::spawn(async move {
        match teams_read::fetch_newest(&ctx.http, &ctx.session, &conversation_id).await {
            Ok(page) => {
                if let Ok(store) = ctx.store() {
                    let _ = teams_read::persist_page(&store, &conversation_id, &page);
                }
                let _ = ctx.tx.send(Net::MessagesUpdated(conversation_id));
            }
            Err(e) => {
                let _ = ctx.tx.send(Net::Status(format!("erreur ouverture: {e}")));
            }
        }
    });
}

/// Send a message, then refresh the conversation so the sent line appears even if
/// the real-time echo is slow (or the trouter isn't connected yet).
fn spawn_send(ctx: NetCtx, conversation_id: String, text: String) {
    tokio::spawn(async move {
        let _ = ctx.tx.send(Net::Status("Envoi…".into()));
        match teams_send::send_message(&ctx.http, &ctx.session, &conversation_id, &text).await {
            Ok(_cmid) => {
                let _ = ctx.tx.send(Net::Status("Envoyé".into()));
                // pull the newest page so the sent message shows immediately
                if let Ok(page) = teams_read::fetch_newest(&ctx.http, &ctx.session, &conversation_id).await {
                    if let Ok(store) = ctx.store() {
                        let _ = teams_read::persist_page(&store, &conversation_id, &page);
                    }
                    let _ = ctx.tx.send(Net::MessagesUpdated(conversation_id));
                }
            }
            Err(e) => {
                let _ = ctx.tx.send(Net::Status(format!("échec envoi: {e}")));
            }
        }
    });
}

fn spawn_backfill(ctx: NetCtx, conversation_id: String) {
    tokio::spawn(async move {
        let _ = ctx.tx.send(Net::Status("Chargement de l'historique…".into()));
        // read the cursor (sync), fetch older (async), persist (sync) — the store
        // is only ever held in non-async scopes.
        let before_ms = match ctx.store() {
            Ok(store) => match store.oldest_cursor(&conversation_id) {
                Ok((_, false)) => {
                    let _ = ctx.tx.send(Net::Status("Début de la conversation".into()));
                    return;
                }
                Ok((cursor, true)) => cursor.and_then(|s| s.parse::<i64>().ok()),
                Err(e) => {
                    let _ = ctx.tx.send(Net::Status(format!("store: {e}")));
                    return;
                }
            },
            Err(e) => {
                let _ = ctx.tx.send(Net::Status(format!("store: {e}")));
                return;
            }
        };
        match teams_read::fetch_messages_page(&ctx.http, &ctx.session, &conversation_id, before_ms, 30).await {
            Ok(page) => {
                let n = match ctx.store() {
                    Ok(store) => teams_read::persist_page(&store, &conversation_id, &page).unwrap_or(0),
                    Err(_) => 0,
                };
                let _ = ctx.tx.send(Net::MessagesUpdated(conversation_id));
                let _ = ctx.tx.send(Net::Status(if n > 0 {
                    format!("+{n} messages plus anciens")
                } else {
                    "Début de la conversation".into()
                }));
            }
            Err(e) => {
                let _ = ctx.tx.send(Net::Status(format!("erreur backfill: {e}")));
            }
        }
    });
}
