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
//          | fetch_media | fetch_avatar | profile | presence | get_settings
//          | set_settings | enrich_link
//          | mail_folders | mail_list | mail_backfill | mail_body | mail_attachment
//          | calendars | calendar_view
//          | agent_status | agent_set_mode | agent_set_tools
// Events:  status | message | conversations_changed | notifications_changed | typing
//          | read_receipt | call | call_signal | update_available
//          | mail_folders_changed | mail_list_updated | mail_list_error
//          | calendars_changed | calendar_view_updated | calendar_view_error
//
// The `mail_*` methods are the READ-ONLY Outlook surface (see `mail`): the same
// broker identity carries the mailbox, and the app lists folders, reads messages and
// renders bodies. It cannot send, reply, delete, move or mark as read — no such path
// exists in the crate, and `mail::tests` enforce that on the source. Mail bodies are
// sanitized server-side and stripped of every remote reference, so displaying one
// makes no network request of its own.
//
// The `calendar_*` methods are the READ-ONLY Teams/Outlook calendar (see `calendar`),
// on the same identity and the same local-first pipeline. It cannot create, move,
// cancel, accept, decline or forward anything — again absent from the crate rather
// than merely ungated, and `calendar::tests` enforce it on the source. That matters
// as much as it does for mail: creating an event mails an invitation to every
// attendee, and answering one mails the organizer.
//
// The `agent_*` methods arm the LOCAL AGENT (see `agent`, `agent_policy`): the user
// writes `@claude <prompt>` in a thread from any Teams client, this backend runs that
// CLI on this machine, posts one message and edits it as the answer arrives — so the
// whole thread watches the reply being written. It answers only a message the USER
// wrote, only in a conversation the user opted in (the sandbox channel out of the
// box), with a read-only tool allowlist, and never from a read-only backend. See
// AGENTS.md § The local agent for the four rules and why each one is load-bearing.
//
// The `call` event is incoming-call AWARENESS only (ring/dismiss a banner) — it
// rides on the after-the-fact `Event/Call` chat system message.
//
// `call_signal` is EXPERIMENTAL native-calling plumbing (opt-in via
// TEAMS_LITE_CALLING=1): the raw, still-being-reverse-engineered call setup/state
// frames from the calling trouter workers, forwarded verbatim for a live capture.
// No media is placed/answered without an explicit user action.
//
// `TEAMS_LITE_READ_ONLY=1` refuses every outward-facing method (send | edit |
// react) at the dispatch choke point — the backend's own safety catch for any
// session where the UI is driven by tooling rather than by a human. See
// `read_only`, and the "Automation safety" section of AGENTS.md.
//
// `enrich_link` turns a tracker link in a message into a rich preview card, through
// whichever integration recognizes its host (see `link_preview`): `gitlab` for merge
// requests, issues and projects, `linear` for issues, projects and documents. Both
// are READ-ONLY like mail and the calendar — a Linear API key can create and edit
// issues as the user, so `linear` sends GraphQL queries only and `linear::tests`
// enforce that on the source.
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
    agent, agent_policy, auth, calendar, mail, push, push_policy, retry, teams, teams_activity,
    teams_avatars, teams_media, teams_presence, teams_profiles, teams_read, teams_readstate,
    teams_send, trouter, trouter_events,
};
use teams_lite::{gitlab, link_preview};

/// The port the user's own backend owns: what `teams`, `teams-web` and the TUI
/// dial by default.
///
/// Every teams-lite port sits in one 194xx block, chosen because nothing registers
/// it and it stays below the ephemeral range (`net.ipv4.ip_local_port_range` starts
/// at 32768), so an outbound connection can never borrow it first. The full map
/// lives in AGENTS.md § Ports; keep the two in step.
const DEFAULT_PORT: u16 = 19420;
/// Where a READ-ONLY backend listens instead, unless `TEAMS_LITE_PORT` says
/// otherwise. A separate port by default so a read-only instance — the one tooling
/// is allowed to start — can never take the port the real one wants, and the two
/// can run side by side: the user keeps their live app on 19420 while an agent
/// inspects real data on 19430. They share the SQLite store safely (WAL +
/// busy_timeout, see `store::Store::open`).
const READ_ONLY_PORT: u16 = 19430;
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";
/// Give the UI ample time to connect after the server becomes ready. Authentication
/// happens before the listener binds, so this only covers local startup delays.
const INITIAL_CLIENT_GRACE: Duration = Duration::from_secs(30);
/// Once at least one UI has connected, an empty server is an orphan. Keep a short
/// grace window for UI restarts/reconnects, then terminate the backend ourselves.
const DISCONNECTED_CLIENT_GRACE: Duration = Duration::from_secs(10);

/// Settings keys (see `store::Store::{get,set}_setting`). The GitLab host plus one
/// access token per integration drive rich link previews (see `link_preview`).
const SETTING_GITLAB_HOST: &str = "gitlab_host";
const SETTING_GITLAB_TOKEN: &str = "gitlab_token";
/// A Linear personal API key. Linear is SaaS-only, so unlike GitLab it has no host
/// to configure — only whether we hold a key (see `linear`).
const SETTING_LINEAR_TOKEN: &str = "linear_token";
/// This machine's VAPID private key (base64url), generated on first use. It must
/// stay stable: every device's subscription embeds the matching public half, so a
/// new key silently stops every phone that already opted in (see
/// [`teams_lite::push::VapidKey`]).
const SETTING_PUSH_VAPID_PRIVATE: &str = "push_vapid_private";

/// How long a claim on a live message is kept before [`Store::prune_claims`] drops
/// it. Only there to stop two backends acting twice on the same LIVE message — a
/// double push, or one `@claude` trigger answered twice — and every policy already
/// refuses anything older than a few minutes.
const CLAIM_RETENTION: Duration = Duration::from_secs(24 * 3600);

/// The RPC methods that act OUTWARD — they change what other people see in the
/// user's real Teams account (a message posted, edited, or reacted to). Every
/// other method only reads, or writes to the local store.
const OUTWARD_METHODS: [&str; 3] = ["send", "edit", "react"];

/// The RPC methods that act on THIS MACHINE, outside the store and the network.
///
/// A second reason to need the write token, and deliberately not folded into
/// {@link OUTWARD_METHODS}: that list means "posts as the user", three tests iterate
/// it, and AGENTS.md tells every later reader that a new entry there is a Teams,
/// mail or calendar write gaining a consent gate. `repair_broker` posts nothing — it
/// restarts the Intune container — so it is gated for the other reason, and says so
/// in its own refusal text.
///
/// The `push_*` methods are here for the same reason and one of their own: a
/// subscription is a URL a client supplies, and every incoming message preview is
/// then POSTed to it. Even with [`teams_lite::push::is_supported_endpoint`] confining
/// that to the browser vendors' push services, deciding which devices a machine
/// notifies is not something a client that merely found this socket gets to do.
///
/// `set_settings` stores the integration credentials (see `link_preview`), and one
/// of them is host-pinned rather than fixed: a client that could write
/// `gitlab_host` would repoint the pin at a host it controls, and the next
/// `enrich_link` for a link on that host would hand it the user's stored GitLab
/// token. Reading the settings back stays open — it never returns a token, only
/// whether one is set.
///
/// The `agent_*` methods are the sharpest case of that reasoning. Neither one posts,
/// so neither belongs above — but `agent_set_mode` decides which conversations this
/// machine will later answer in the user's name, and `agent_set_tools` decides what a
/// chat message may make a local agent do. A client that merely found this socket
/// gets to do neither.
const MACHINE_METHODS: [&str; 7] = [
    "repair_broker",
    "push_subscribe",
    "push_unsubscribe",
    "push_test",
    "set_settings",
    "agent_set_mode",
    "agent_set_tools",
];

/// What a {@link MACHINE_METHODS} entry actually does to the machine, for its
/// refusal text. Per method, not per class: "restarts the Intune container" would be
/// a lie about a push subscription, and a refusal nobody believes is a refusal
/// nobody reads.
fn machine_effect(method: &str) -> &'static str {
    match method {
        "repair_broker" => "restarts the Intune container on this machine",
        "push_subscribe" | "push_unsubscribe" | "push_test" => {
            "changes which devices this machine sends push notifications to"
        }
        "set_settings" => "stores the integration credentials kept on this machine",
        "agent_set_mode" => {
            "decides which conversations this machine answers in the user's name, with a local \
             agent"
        }
        "agent_set_tools" => "decides what a local agent this machine runs may do",
        // Unreachable while the two lists agree; the test below pins that they do.
        _ => "changes this machine",
    }
}

/// Why a method needs the write token, or `None` when it only reads or writes the
/// local store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteClass {
    /// Posts to real people as the user. See {@link OUTWARD_METHODS}.
    Outward,
    /// Changes this machine. See {@link MACHINE_METHODS}.
    Machine,
}

fn write_class(method: &str) -> Option<WriteClass> {
    if OUTWARD_METHODS.contains(&method) {
        return Some(WriteClass::Outward);
    }
    if MACHINE_METHODS.contains(&method) {
        return Some(WriteClass::Machine);
    }
    None
}

/// The systemd unit that repairs the broker by restarting the Intune container.
/// Never run `intune-container` from here: one unit keeps the rate limit in one
/// place, counted across the health timer, this backend and the in-app button.
const BROKER_REPAIR_UNIT: &str = "teams-lite-broker-repair.service";

/// The floor between two repairs this process asks for. Shorter than the unit's own
/// limit (three an hour) so the backend refuses first and the journal names it.
const REPAIR_MIN_INTERVAL: Duration = Duration::from_secs(20 * 60);

/// Read-only mode (`TEAMS_LITE_READ_ONLY=1`): refuse every {@link OUTWARD_METHODS}
/// call before it can reach the network.
///
/// This exists because the backend is the LAST line of defense against an
/// accidental outward action: automated tooling (screenshot scripts, E2E-style
/// drivers, an agent debugging the UI) is meant to talk to `web/mock/server.ts`,
/// but a single missing `VITE_TEAMS_WS_URL` is enough to point it at this server
/// instead — and then a scripted keypress posts to a real colleague's chat. It
/// has happened. Anything that drives the UI without a human reading each
/// keystroke should run the backend with this flag set, so the worst outcome of a
/// misconfiguration is a refused request instead of a real message.
///
/// Read once: the mode is a property of the process, and re-reading the
/// environment per request would let it drift mid-session.
fn read_only() -> bool {
    static READ_ONLY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *READ_ONLY.get_or_init(|| std::env::var("TEAMS_LITE_READ_ONLY").as_deref() == Ok("1"))
}

/// Resolve the port to listen on: an explicit `TEAMS_LITE_PORT` wins, else
/// read-only mode moves aside to {@link READ_ONLY_PORT} and a normal backend takes
/// {@link DEFAULT_PORT}.
///
/// Pure (both inputs injected) so the precedence is unit-tested.
fn resolve_port(configured: Option<&str>, read_only: bool) -> u16 {
    if let Some(port) = configured.and_then(|v| v.trim().parse::<u16>().ok()).filter(|p| *p > 0) {
        return port;
    }
    if read_only {
        READ_ONLY_PORT
    } else {
        DEFAULT_PORT
    }
}

/// The address this process binds, from the environment.
fn bind_addr() -> String {
    let configured = std::env::var("TEAMS_LITE_PORT").ok();
    format!("127.0.0.1:{}", resolve_port(configured.as_deref(), read_only()))
}

/// Environment variable a launcher can use to pin the write token itself (rather
/// than letting the backend generate one), so a parent process can hand the same
/// value to the backend and to the frontend it spawns.
const WRITE_TOKEN_ENV: &str = "TEAMS_LITE_WRITE_TOKEN";

/// THE WRITE LOCK.
///
/// Reading this backend is open: any local client may list conversations and read
/// history, which is what makes it useful to work against. WRITING is not — a
/// `send`/`edit`/`react` posts to real people as the user, and an automated client
/// that reached this backend by accident must not be able to do it. (It happened:
/// a screenshot script drove the real app and posted three messages to two
/// colleagues' chats.)
///
/// So every outward-facing call must present a capability token that only the
/// user's own frontends are given: the backend mints one per process and
/// publishes it to a 0600 file in the runtime directory (see
/// `write_token_path`), where `web/server.ts`, the Vite dev server and the TUI
/// read it. A client that was not handed the token — an ad-hoc script, a stray
/// browser tab, an agent's driver — gets a refusal, not a message on the wire.
///
/// `None` means writes are refused outright: read-only mode.
///
/// Threat model, stated honestly: this stops ACCIDENTS, not a determined local
/// process. Anything running as the user can read the token file, exactly as it
/// can read the SQLite store. What it buys is that no client writes *without
/// having deliberately gone to fetch a secret it was never given* — and every
/// path that would do so is forbidden by AGENTS.md and blocked by
/// `.claude/hooks/guard-live-automation.sh`.
fn write_token() -> Option<&'static str> {
    static TOKEN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    TOKEN
        .get_or_init(|| {
            if read_only() {
                return None;
            }
            let token = std::env::var(WRITE_TOKEN_ENV)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(mint_write_token);
            if let Err(e) = publish_write_token(&token) {
                // Enforce anyway. A lock that quietly opens itself when it can't
                // publish is the failure we are fixing; a frontend that cannot
                // send until this is resolved is loud, and recoverable.
                eprintln!(
                    "[write-lock] could not publish the write token ({e}) — writes will be \
                     refused until a frontend can read it. Set {WRITE_TOKEN_ENV} in both the \
                     backend and the frontend to work around a read-only runtime directory."
                );
            }
            Some(token)
        })
        .as_deref()
}

/// A fresh 256-bit token, hex, from the OS CSPRNG (`uuid` v4 twice over).
fn mint_write_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Every directory the token is published to, most volatile first: the runtime
/// directory (tmpfs, wiped on logout) and the data directory.
///
/// BOTH, deliberately. A frontend does not necessarily see the same environment as
/// the backend — a service unit may have `XDG_RUNTIME_DIR` while a shell-launched
/// dev server does not — and a token only one side can find would leave the user's
/// own app unable to send. The frontends (`web/write-token.ts`, `ui/src/client.ts`)
/// search the same list in the same order.
fn write_token_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let candidates = [
        std::env::var_os("XDG_RUNTIME_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share").into()),
    ];
    for candidate in candidates.into_iter().flatten() {
        let path = std::path::PathBuf::from(candidate);
        if path.is_absolute() && !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs.into_iter().map(|base| base.join("teams-lite")).collect()
}

/// The first place a frontend will look for the token (used for the startup log).
fn write_token_path() -> Result<std::path::PathBuf> {
    write_token_dirs()
        .into_iter()
        .next()
        .map(|dir| dir.join("write-token"))
        .context("cannot resolve a runtime or data directory for the write token")
}

/// Write the token where our frontends can read it, owner-only (0600), replacing
/// any token left behind by a previous process. Succeeds if at least one location
/// took it; reports the last error when none did.
fn publish_write_token(token: &str) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut last_error: Option<anyhow::Error> = None;
    let mut published = 0usize;
    for dir in write_token_dirs() {
        let write_one = || -> Result<()> {
            std::fs::create_dir_all(&dir).with_context(|| format!("create dir {}", dir.display()))?;
            let path = dir.join("write-token");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .with_context(|| format!("open {}", path.display()))?;
            // An existing file keeps its old mode, so set it explicitly too.
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            file.write_all(token.as_bytes())?;
            Ok(())
        };
        match write_one() {
            Ok(()) => published += 1,
            Err(e) => last_error = Some(e),
        }
    }
    if published > 0 {
        return Ok(());
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no writable location for the write token")))
}

/// Gate one request against the write lock. Reads always pass; an outward-facing
/// method must carry a `write_token` matching this process's own.
///
/// Pure (token injected) so the policy is unit-testable without a live backend.
fn check_write_allowed(method: &str, params: &Value, token: Option<&str>) -> Result<(), String> {
    let Some(class) = write_class(method) else {
        return Ok(());
    };
    let Some(token) = token else {
        return Err(match class {
            WriteClass::Outward => format!(
                "refused: `{method}` acts on the real Teams account and this server runs read-only \
                 (TEAMS_LITE_READ_ONLY=1). Restart it without that variable to allow writes, or \
                 point the client at web/mock/server.ts to exercise the flow."
            ),
            WriteClass::Machine => format!(
                "refused: `{method}` {}, and this server runs read-only \
                 (TEAMS_LITE_READ_ONLY=1). Tooling never changes the user's own machine — their \
                 own backend does.",
                machine_effect(method)
            ),
        });
    };
    match params.get("write_token").and_then(Value::as_str) {
        Some(presented) if presented == token => Ok(()),
        _ => Err(match class {
            WriteClass::Outward => format!(
                "refused: `{method}` needs the write token this backend published for the user's \
                 own frontends. A client that was not given it (an ad-hoc script, an automated \
                 driver) may read everything here, but must not post as the user. If you are a \
                 frontend, read the token from {WRITE_TOKEN_ENV} or from the file the backend \
                 logged at startup; if you are automation, drive web/mock/server.ts instead."
            ),
            WriteClass::Machine => format!(
                "refused: `{method}` needs the write token this backend published for the user's \
                 own frontends. It {} — not something a client that merely found this socket gets \
                 to do. If you are a frontend, read the token from {WRITE_TOKEN_ENV} or from the \
                 file the backend logged at startup.",
                machine_effect(method)
            ),
        }),
    }
}

/// The `broker_status` event payload: what the backend thinks of the identity
/// broker, and whether it can do anything about it.
///
/// Emitted on a CHANGE of state and in every client's greeting — a phone that opens
/// the tab mid-outage has to learn about it too, and a page that reconnects after a
/// repair has to learn that the trouble is over. One shape for both.
fn broker_status_payload(repairing: bool) -> Value {
    let state = auth::broker_state().unwrap_or_default();
    // Only the one signature whose known cause a container restart fixes, and never
    // from a read-only backend. Not checked here: whether this host HAS an Intune
    // container. It does not need to be — a locked keyring is a containerized-Intune
    // failure, and a classic host produces `Unreachable` or `Refused` instead, both of
    // which already answer false. The repair unit re-checks anyway
    // (ConditionFileIsExecutable + its ExecCondition), so a wrong yes costs nothing.
    let can_repair = state
        .failure
        .map(|f| f.is_repairable() && !read_only())
        .unwrap_or(false);
    json!({
        "ok": state.is_ok(),
        "signature": state.failure.map(|f| f.tag()).unwrap_or(""),
        "message": state.failure.map(|f| f.message()).unwrap_or(""),
        // The full cause chain. Useful in a bug report, and never a secret: the
        // broker's error codes carry no token (see `broker_failure` in src/auth.rs).
        "detail": state.detail,
        "consecutive_failures": state.consecutive_failures,
        "can_repair": can_repair,
        "repairing": repairing,
    })
}

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
    /// Mail folders the live poll watches (see `spawn_mail_sync`). Seeded with the
    /// inbox and extended whenever a UI opens a folder, so the poll costs one
    /// request per folder the user actually looks at rather than one per folder the
    /// mailbox happens to have.
    mail_watch: Arc<Mutex<std::collections::BTreeSet<String>>>,
    /// The calendar window the live poll re-reads (see `spawn_calendar_sync`), or
    /// `None` until a UI opens the calendar. Only the LATEST window is watched: a
    /// calendar UI shows exactly one range at a time, and re-reading the month the
    /// user navigated away from would be work nobody is looking at.
    calendar_watch: Arc<Mutex<Option<CalendarWatch>>>,
    /// When this process last asked systemd for a broker repair, so it cannot loop.
    /// See {@link REPAIR_MIN_INTERVAL} and `start_broker_repair`.
    last_repair: Arc<Mutex<Option<std::time::Instant>>>,
}

/// The calendar window a UI currently has on screen, and over which calendars.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CalendarWatch {
    /// Canonical UTC timestamps, month-aligned (the span of
    /// [`calendar::months_covering`]) rather than the exact grid the UI drew, so the
    /// poll refreshes whole cache units.
    start: String,
    end: String,
    calendars: Vec<String>,
}

/// The session plus when it was minted, so we can rebuild it before the
/// skypetoken expires (~1 day, but we refresh conservatively).
struct SessionCell {
    session: Session,
    minted: std::time::Instant,
}

const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(50 * 60);

/// One store connection owned by a long-lived task (the trouter loops), opened on
/// first use and then kept.
///
/// Opening per event was never free: attaching a connection costs ~0.5 ms (SQLite
/// parses the schema on the first statement), and it starts with an empty
/// prepared-statement cache, so every frame re-parsed its SQL. Resolving a typing
/// frame's sender went from 6.5 ms to 0.02 ms once the connection — and its cache,
/// and the `sender_mri` index — stopped being thrown away between frames.
struct TaskStore {
    db_path: Arc<String>,
    store: Option<Store>,
}

impl TaskStore {
    /// The task's connection, opened on first use. `None` when the store cannot be
    /// opened; the next event tries again rather than leaving the task permanently
    /// storeless.
    fn get(&mut self) -> Option<&Store> {
        if self.store.is_none() {
            match Store::open(&self.db_path) {
                Ok(store) => self.store = Some(store),
                Err(e) => {
                    eprintln!("[store] could not open the store: {e}");
                    return None;
                }
            }
        }
        self.store.as_ref()
    }
}

impl Ctx {
    fn store(&self) -> Result<Store> {
        Store::open(&self.db_path)
    }

    /// A connection for a long-lived task to hold onto (see [`TaskStore`]).
    /// Request handlers keep using [`Ctx::store`]: they are short-lived, and a
    /// connection per in-flight request keeps writers from serializing.
    fn task_store(&self) -> TaskStore {
        TaskStore {
            db_path: self.db_path.clone(),
            store: None,
        }
    }
    fn emit(&self, event: &str, data: Value) {
        // ignore send errors (no subscribers yet is fine)
        let _ = self.events.send(json!({ "event": event, "data": data }));
    }

    /// Ask systemd to run the broker repair unit, unless this process asked for one
    /// too recently.
    ///
    /// Refuses in read-only mode HERE, not only at the dispatch choke point: the
    /// automatic trigger never passes through `check_write_allowed`, so without this
    /// guard a read-only backend started by tooling could restart the user's
    /// container on its own.
    ///
    /// Starting a unit through `systemctl` is a child process, and that is safe:
    /// `systemctl` is only a D-Bus client, so the unit's own processes are forked by
    /// the user manager into the UNIT's cgroup, a sibling of ours. The repair
    /// therefore survives the backend restart that `teams-lite-broker-bus.path`
    /// fires seconds later when the container rewrites rootless.json — which a
    /// direct child would not, because KillMode=control-group kills our whole group.
    async fn start_broker_repair(&self, automatic: bool) -> Result<Value> {
        anyhow::ensure!(
            !read_only(),
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never restarts the user's \
             Intune container"
        );

        if automatic {
            let mut last = self
                .last_repair
                .lock()
                .map_err(|_| anyhow::anyhow!("repair timestamp lock poisoned"))?;
            if let Some(at) = *last {
                let waited = at.elapsed();
                if waited < REPAIR_MIN_INTERVAL {
                    let left = (REPAIR_MIN_INTERVAL - waited).as_secs() / 60;
                    eprintln!(
                        "[broker] repair already tried {}m ago — not asking again for {left}m",
                        waited.as_secs() / 60
                    );
                    return Ok(json!({ "started": false, "reason": "rate_limited" }));
                }
            }
            *last = Some(std::time::Instant::now());
        }

        eprintln!("[broker] asking systemd to run {BROKER_REPAIR_UNIT}");
        let status = tokio::process::Command::new("systemctl")
            .args(["--user", "start", "--no-block", BROKER_REPAIR_UNIT])
            // Explicit: dropping this future must never kill the client mid-enqueue.
            .kill_on_drop(false)
            .status()
            .await
            .with_context(|| format!("run systemctl to start {BROKER_REPAIR_UNIT}"))?;

        // A non-zero exit is almost always the unit's own rate limit. `--no-block`
        // only enqueues, so success says nothing about the repair itself — the
        // outcome arrives as the broker recovering, or not.
        anyhow::ensure!(
            status.success(),
            "{BROKER_REPAIR_UNIT} refused to start ({status}). Most likely its rate limit of \
             three repairs an hour; check `systemctl --user status {BROKER_REPAIR_UNIT}`."
        );
        self.emit("broker_status", broker_status_payload(true));
        Ok(json!({ "started": true }))
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

    /// Force-refresh every credential the read/send paths depend on: the IC3, CSA,
    /// profile, and Graph (SharePoint file downloads) broker tokens, and the Teams
    /// session (skypetoken). Called after an unexpected 401, whose cause may be any
    /// of these, so we refresh them all rather than guess.
    async fn force_refresh_auth(&self) -> Result<Session> {
        let _ = self.tokens.refresh(IC3_SCOPE).await;
        let _ = self.tokens.refresh(teams_read::CSA_SCOPE).await;
        let _ = self.tokens.refresh(teams_profiles::PROFILE_SCOPE).await;
        let _ = self.tokens.refresh(teams_media::GRAPH_SCOPE).await;
        let fresh = teams::connect(&self.http).await?;
        let mut cell = self.session.lock().await;
        cell.session = fresh.clone();
        cell.minted = std::time::Instant::now();
        Ok(fresh)
    }

    /// A valid Microsoft Graph token, for the read-only mail and calendar surfaces
    /// (they share one scope, and therefore one cache entry and one refresh).
    async fn graph(&self) -> Result<String> {
        self.tokens.get(mail::MAIL_SCOPE).await
    }

    /// Mark a mail folder as one the live poll should watch.
    fn watch_mail_folder(&self, folder_id: &str) {
        if folder_id.is_empty() {
            return;
        }
        if let Ok(mut watch) = self.mail_watch.lock() {
            watch.insert(folder_id.to_string());
        }
    }

    /// Mark the calendar window the live poll should re-read, replacing whatever it
    /// watched before.
    fn watch_calendar(&self, watch: CalendarWatch) {
        if let Ok(mut slot) = self.calendar_watch.lock() {
            *slot = Some(watch);
        }
    }

    /// Run a Graph (mail or calendar) operation under the shared retry policy.
    ///
    /// The Graph sibling of [`Ctx::retry_on_auth`]: `op` gets a freshly-read Graph
    /// token per attempt, and a 401 refreshes THAT token only — the Teams session
    /// and its skypetoken are unrelated to the mailbox, so refreshing them here
    /// would be noise (and would rebuild a session for nothing).
    async fn retry_graph<T, F, Fut>(&self, op: F) -> Result<T>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let attempt = || async {
            let token = self.graph().await?;
            op(token).await
        };
        let on_auth = || async {
            eprintln!("[auth] 401 from Graph — refreshing the Graph token before retry");
            self.tokens.refresh(mail::MAIL_SCOPE).await.map(|_| ())
        };
        retry::with_retry(retry::RetryPolicy::default(), Some(on_auth), attempt).await
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

/// Open the store once at boot to create/upgrade its schema, refresh the query
/// planner's statistics, and run the one-shot legacy cleanups.
///
/// Only a failure to open the store is fatal (nothing works without it); a
/// cleanup that fails is logged and skipped, since it only affects how legacy
/// history renders.
///
/// `allow_writes` is false in read-only mode, and then NOTHING here runs beyond
/// opening the store: no cleanups (they rewrite and delete message rows) and no
/// statistics refresh (`PRAGMA optimize` writes too). A read-only backend is the one
/// tooling is allowed to start against the user's REAL store — while the user's own
/// backend is live on it — so silently migrating their history from under them is
/// exactly the class of surprise `TEAMS_LITE_READ_ONLY=1` exists to prevent. The flag
/// therefore covers the LOCAL store, not just outward sends.
///
/// The schema migration inside [`Store::open`] is deliberately NOT gated: it is
/// additive, and without it the file cannot be read at all.
fn prepare_store(db_path: &str, allow_writes: bool) -> Result<()> {
    let store = Store::open(db_path)?;
    if !allow_writes {
        eprintln!(
            "[store] read-only mode (TEAMS_LITE_READ_ONLY=1): skipping the statistics refresh \
             and the one-shot cleanups — the user's rows are never rewritten"
        );
        return Ok(());
    }
    if let Err(e) = store.optimize() {
        eprintln!("[store] could not refresh statistics: {e}");
    }
    match store.cleanups_pending() {
        Ok(true) => run_legacy_cleanups(&store),
        Ok(false) => {}
        Err(e) => eprintln!("[cleanup] could not read the cleanup revision: {e}"),
    }
    // A claim only stops two backends acting twice on the same live message, so a
    // day-old one is dead weight. Cheap and unconditional (a keyed range delete),
    // unlike the one-shot cleanups above.
    let claims_before = now_ms() - CLAIM_RETENTION.as_millis() as i64;
    if let Err(e) = store.prune_claims(claims_before) {
        eprintln!("[store] could not prune old live-message claims: {e}");
    }
    Ok(())
}

/// Heal history that older builds persisted in a shape the UI can no longer make
/// sense of. Every pass rewrites rows IN PLACE and is idempotent, so it only has
/// to run once per store — and it must, because each one scans every message body.
/// [`Store::cleanups_pending`] gates them on `CLEANUP_REVISION`, recorded here
/// once the pass completes, so later boots skip the scans entirely.
fn run_legacy_cleanups(store: &Store) {
    // The Teams activity streams (`48:notifications`, `48:mentions`,
    // `48:threads`) are system feeds, not chats. Older builds mis-persisted them
    // as conversations full of empty-content bubbles under a raw MRI-URL title;
    // purge that junk so it stops showing in the sidebar. Going forward they are
    // routed to the notifications surface and never re-persisted as chats (see
    // `spawn_realtime` and `persist_conversations`).
    for feed in [
        teams_activity::NOTIFICATIONS_THREAD,
        teams_activity::MENTIONS_THREAD,
        teams_activity::THREADS_THREAD,
    ] {
        if let Err(e) = store.delete_conversation(feed) {
            eprintln!("[cleanup] could not purge {feed}: {e}");
        }
    }
    // Channel posts that an older live feed filed under a `;messageid=` deep-link id
    // are moved back into their channel, and the pseudo-conversations those ids
    // created are removed from the chat list.
    match store.reparent_thread_link_messages() {
        Ok((moved, dropped, rows)) if moved > 0 || dropped > 0 || rows > 0 => eprintln!(
            "[cleanup] channel threads: re-filed {moved} post(s), dropped {dropped} duplicate(s), \
             removed {rows} phantom conversation(s)"
        ),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not re-file channel thread posts: {e}"),
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
    // Meeting-recording notices that older builds stored as raw `<URIObject>`
    // bubbles are upgraded in place into a media video card (final recording)
    // or removed (the in-progress notices Teams also posts).
    match store.convert_legacy_call_recordings() {
        Ok((up, del)) if up > 0 || del > 0 => {
            eprintln!("[cleanup] recordings: upgraded {up}, removed {del} in-progress notice(s)")
        }
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert call recordings: {e}"),
    }
    // `ThreadActivity` frames (a member added, a message pinned) that older builds
    // stored as a bubble of raw JSON become a centered system line; the ones we
    // cannot label are removed.
    match store.convert_legacy_thread_activities() {
        Ok((up, del)) if up > 0 || del > 0 => {
            eprintln!("[cleanup] thread activities: upgraded {up}, removed {del}")
        }
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert thread activities: {e}"),
    }
    // Adaptive/connector cards stored as the raw `SWIFT.1` URIObject — which reads
    // as "Card - access it on … cards.unsupported" in the bubble and in the sidebar
    // — are upgraded into a structured card attachment.
    match store.convert_legacy_cards() {
        Ok(n) if n > 0 => eprintln!("[cleanup] upgraded {n} legacy card message(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not convert cards: {e}"),
    }
    // Rows whose author is a raw contacts URL or MRI (an older fallback for frames
    // with no `imdisplayname`) get a blank sender, so the UI resolves a real name
    // from `sender_mri` instead of printing a URL.
    match store.blank_identity_senders() {
        Ok(n) if n > 0 => eprintln!("[cleanup] blanked {n} identity-URL sender(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not blank identity senders: {e}"),
    }
    // Typing/presence frames stored with an empty body render as a blank bubble with
    // no author. Removed LAST, so every pass above has had its chance to turn a row
    // that only LOOKS payload-less (a recording, a card, a thread activity) into
    // something renderable first.
    match store.purge_payloadless_control_frames() {
        Ok(n) if n > 0 => eprintln!("[cleanup] removed {n} payload-less control frame(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("[cleanup] could not purge payload-less control frames: {e}"),
    }
    // Only claim the revision once the passes above have had their turn: a store
    // whose cleanup errored out retries on the next boot rather than staying
    // half-healed forever.
    if let Err(e) = store.mark_cleanups_done() {
        eprintln!("[cleanup] could not record the cleanup revision: {e}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // CLAIM THE PORT FIRST, before anything with a side effect.
    //
    // The listener used to be bound at the very end, after authentication, the store
    // migrations and the trouter registration. A second backend started by hand
    // therefore did all of that — including rewriting rows in the shared store, and
    // registering the SAME endpoint id with the real-time service, which silently
    // stole the live feed from the instance already running — and only then died on
    // "address already in use".
    //
    // Binding here turns that into an immediate, obvious failure. Nothing is served
    // yet: `accept()` runs at the end of this function, so a client that connects
    // during authentication simply waits in the listen backlog, which is strictly
    // better than being refused.
    let addr = bind_addr();
    let listener = TcpListener::bind(&addr).await.with_context(|| {
        format!(
            "bind {addr} — another teams-lite backend already owns this port. \
             Stop it first (systemctl --user stop teams-lite-backend), or give this \
             one a port of its own with TEAMS_LITE_PORT."
        )
    })?;

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
    // Creates the schema, applies pending migrations and indexes, refreshes stale
    // planner statistics, and heals legacy rows — all once per boot. A read-only
    // backend skips the healing: it must not rewrite the user's rows.
    prepare_store(&db_path, !read_only())?;

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
        mail_watch: Arc::new(Mutex::new(std::collections::BTreeSet::new())),
        calendar_watch: Arc::new(Mutex::new(None)),
        last_repair: Arc::new(Mutex::new(None)),
    };

    // Watch the broker, and react once per CHANGE of state (see `observe_broker`).
    //
    // This is what turns "no chats, and nothing says why" into a banner the user can
    // act on. Two reactions: tell every connected client, and — for the one signature
    // whose known cause is a locked container keyring — ask for a repair, at most
    // once every REPAIR_MIN_INTERVAL.
    let watcher = ctx.clone();
    auth::observe_broker(move |state| {
        match state.failure {
            None => eprintln!("[broker] sign-in works again"),
            Some(failure) => eprintln!(
                "[broker] {} ({} in a row) — {}",
                failure.message(),
                state.consecutive_failures,
                state.detail
            ),
        }
        watcher.emit("broker_status", broker_status_payload(false));

        if state.failure.is_some_and(|f| f.is_repairable()) && !read_only() {
            // Spawned, not awaited: the observer runs inside whatever token call just
            // failed, and that caller must not wait on a container restart.
            let repairer = watcher.clone();
            tokio::spawn(async move {
                if let Err(e) = repairer.start_broker_repair(true).await {
                    eprintln!("[broker] could not start the repair: {e:#}");
                }
            });
        }
    });

    // real-time: run the trouter, persist each live message, broadcast an event.
    spawn_realtime(ctx.clone(), session, db_path);

    // mail: poll whichever folders a client opens (read-only, and idle until one
    // does — see `spawn_mail_sync`).
    spawn_mail_sync(ctx.clone());

    // calendar: poll whichever window a client is looking at (read-only, and idle
    // until one opens the calendar — see `spawn_calendar_sync`).
    spawn_calendar_sync(ctx.clone());

    // one-shot, best-effort: is a newer rolling `latest` build available?
    spawn_update_check(ctx.clone());

    eprintln!("[ok] server ws://{addr} — ready");
    // Say which write policy is in force, and where a frontend can pick up the
    // token — never the token itself (it must not land in a log or a scrollback).
    match write_token() {
        None => eprintln!("[write-lock] read-only: {OUTWARD_METHODS:?} are refused"),
        Some(_) => match write_token_path() {
            Ok(path) => eprintln!(
                "[write-lock] armed: {OUTWARD_METHODS:?} require the token at {}",
                path.display()
            ),
            Err(e) => eprintln!("[write-lock] armed: token published nowhere ({e})"),
        },
    }
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

    // Say how sign-in is doing, on every fresh connection. The state event is
    // otherwise emitted only on a CHANGE, so a phone that opens the tab in the middle
    // of an outage would see an empty app and no reason for it — and a page that
    // reconnects after a repair would keep showing a banner for trouble that is over.
    // Only when there is something to say: a backend that has never failed stays
    // quiet, so this cannot raise a banner by accident.
    if auth::broker_state().is_some_and(|s| !s.is_ok()) {
        let ev = json!({ "event": "broker_status", "data": broker_status_payload(false) });
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
    // The write lock, at the single choke point every request passes through —
    // rather than trusting each handler, or each client, to check. Reads are
    // unaffected. See `write_token` / `check_write_allowed`.
    if let Err(refusal) = check_write_allowed(method, params, write_token()) {
        anyhow::bail!(refusal);
    }
    match method {
        "ping" => Ok(json!("pong")),
        // Restart the Intune container, through its own systemd unit, because the
        // container's login keyring re-locks and the broker then answers every token
        // call with NoReply. The only RPC with an effect outside the store and the
        // network: token-gated as a MACHINE method, refused read-only, and refused
        // again inside the primitive so the automatic caller inherits both.
        "repair_broker" => ctx.start_broker_repair(false).await,

        // ---- push notifications (see src/push.rs) ------------------------------
        // What an installed web app needs to receive a notification while it is
        // closed. Only `push_status` reads; the other three are MACHINE methods,
        // because they decide which devices this machine notifies.

        // The subscription key the page needs and what this backend already knows.
        // Read-only, and the one arm that generates the VAPID key pair — a page that
        // asks the question is a page about to subscribe.
        "push_status" => {
            let store = ctx.store()?;
            push_status_json(&store)
        }

        // Remember this device. Idempotent: the page re-registers on every launch,
        // which is how a rotated subscription heals itself.
        "push_subscribe" => {
            let subscription = push::Subscription {
                endpoint: param_str(params, "endpoint")?,
                p256dh: param_str(params, "p256dh")?,
                auth: param_str(params, "auth")?,
            };
            // Validate BEFORE storing: a subscription that cannot be encrypted to,
            // or that points somewhere other than a browser vendor's push service,
            // must fail here rather than in a delivery task at 3 a.m.
            subscription.validate()?;
            let label = params
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .chars()
                .take(80)
                .collect::<String>();
            let store = ctx.store()?;
            store.put_push_subscription(
                &subscription.endpoint,
                &subscription.p256dh,
                &subscription.auth,
                &label,
                now_ms(),
            )?;
            eprintln!("[push] a device subscribed ({} total)", store.push_subscriptions()?.len());
            push_status_json(&store)
        }

        // Forget this device — the user turning notifications off on it.
        "push_unsubscribe" => {
            let endpoint = param_str(params, "endpoint")?;
            let store = ctx.store()?;
            let removed = store.delete_push_subscription(&endpoint)?;
            let mut status = push_status_json(&store)?;
            status["removed"] = json!(removed);
            Ok(status)
        }

        // Push one notification to every subscribed device, so the user can prove
        // the chain works without waiting for a colleague to write to them.
        "push_test" => {
            let notification = push::Notification {
                title: "teams-lite".to_string(),
                body: "Notifications are working on this device.".to_string(),
                url: "/".to_string(),
                tag: "teams-lite-test".to_string(),
            };
            let report = deliver_push(ctx, &notification, 60).await?;
            Ok(json!({ "delivered": report.delivered, "failed": report.failed, "errors": report.errors }))
        }

        // ---- the local agent (see src/agent.rs and src/agent_policy.rs) --------
        // What answers an `@claude` / `@opencode` message the USER writes, by running
        // that CLI on this machine and streaming its answer into the thread. Only
        // `agent_status` reads; the other two are MACHINE methods, because one decides
        // where this machine answers as the user and the other what it may run.

        // Which backends exist here, which conversations are opted in, what an agent
        // may do, and where it runs.
        "agent_status" => {
            let store = ctx.store()?;
            agent_status_json(&store)
        }

        // Opt one conversation in or out. The sandbox channel starts opted in because
        // AGENTS.md pre-authorizes a send there; every other conversation is off until
        // it is named here, and that is the consent gate for this whole feature.
        "agent_set_mode" => {
            let conversation = param_str(params, "conversation")?;
            let mode = agent_policy::Mode::parse(&param_str(params, "mode")?);
            let store = ctx.store()?;
            let modes = store.get_setting(agent_policy::SETTING_MODES)?;
            store.set_setting(
                agent_policy::SETTING_MODES,
                &agent_policy::with_mode(modes.as_deref(), &conversation, mode),
            )?;
            eprintln!("[agent] {conversation} is now `{}`", mode.as_str());
            agent_status_json(&store)
        }

        // Replace the tool allowlist. Deliberately a WHOLE list rather than an
        // add/remove pair: what an agent may do should be readable in one place, and
        // a client that widens it has to say what the full answer is.
        "agent_set_tools" => {
            let tools: Vec<String> = params
                .get("tools")
                .and_then(Value::as_array)
                .context("missing param: tools (an array of tool names)")?
                .iter()
                .filter_map(|tool| tool.as_str())
                .map(|tool| tool.trim().to_string())
                .filter(|tool| !tool.is_empty())
                .collect();
            let store = ctx.store()?;
            store.set_setting(agent::SETTING_TOOLS, &serde_json::to_string(&tools)?)?;
            eprintln!("[agent] the tool allowlist is now {tools:?}");
            agent_status_json(&store)
        }

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
            let http = ctx.http.clone();
            // Two hosting schemes: legacy AMS / chatService objects carry the
            // skypetoken; modern OneDrive/SharePoint chat files need a Graph bearer
            // token instead. Route by host, and reject a URL on neither allowlist
            // before any token is attached, so an untrusted URL can never leak one.
            let media = if teams_media::is_allowed_media_url(&url) {
                ctx.retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let url = url.clone();
                    async move { teams_media::fetch_media(&http, &session, &url).await }
                })
                .await?
            } else if teams_media::is_sharepoint_url(&url) {
                let tokens = ctx.tokens.clone();
                ctx.retry_on_auth(move |_session, _csa| {
                    let http = http.clone();
                    let url = url.clone();
                    let tokens = tokens.clone();
                    async move {
                        let graph = tokens.get(teams_media::GRAPH_SCOPE).await?;
                        teams_media::fetch_sharepoint_media(&http, &graph, &url).await
                    }
                })
                .await?
            } else {
                anyhow::bail!("media host not allowed");
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&media.bytes);
            Ok(json!({ "content_type": media.content_type, "data_base64": data }))
        }

        // Proxy a real profile photo (a person, or a Teams "team" group) back to
        // the UI, which can't hold the credentials. The id is charset-validated in
        // `teams_avatars` before it is put on the URL, and the request only ever
        // targets a fixed Microsoft host. A subject with no photo answers `found:
        // false` so the UI falls back to tinted initials (and can negative-cache).
        "fetch_avatar" => {
            let kind_str = param_str(params, "kind")?;
            let kind = teams_avatars::AvatarKind::from_wire(&kind_str)
                .with_context(|| format!("unknown avatar kind: {kind_str}"))?;
            let id = param_str(params, "id")?;
            anyhow::ensure!(
                teams_avatars::is_valid_avatar_id(&id),
                "malformed avatar id"
            );
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let media = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let id = id.clone();
                    async move {
                        // The photo endpoints take the profile-audience token, not
                        // the CSA one `retry_on_auth` supplies. Read it fresh each
                        // attempt so a 401 refresh in between is picked up.
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_avatars::fetch_avatar(&http, &session, &profile, kind, &id).await
                    }
                })
                .await?;
            match media {
                Some(media) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&media.bytes);
                    Ok(json!({
                        "found": true,
                        "content_type": media.content_type,
                        "data_base64": data,
                    }))
                }
                None => Ok(json!({ "found": false })),
            }
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
            let image = params.get("image").map(teams_send::parse_image).transpose()?;
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let send_conv = conv.clone();
            let sent = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let conv = send_conv.clone();
                    let text = text.clone();
                    let reply_to = reply_to.clone();
                    let content_html = content_html.clone();
                    let image = image.clone();
                    async move {
                        let ic3 = tokens.get(IC3_SCOPE).await?;
                        teams_send::send_message(
                            &http,
                            &session,
                            &ic3,
                            &conv,
                            &text,
                            reply_to.as_ref(),
                            content_html.as_deref(),
                            image.as_ref(),
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
            Ok(json!({ "sent": true, "message_id": sent.id }))
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
                    teams_send::edit_message(&http, &session, &conv, &message_id, &text, None).await
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

        // Notifications panel — the three Teams activity streams, one per tab:
        // `48:notifications` (Activity: reactions / mentions / replies),
        // `48:mentions` (@Mentions), and `48:threads` (Following). None is a
        // chat: each is fetched fresh from Teams (which holds the server-side
        // read state), decoded into structured notifications, and returned keyed
        // by tab. No local cache — the feeds are small and refresh on
        // `notifications_changed`. The three fetches run concurrently.
        "notifications" => {
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 100) as u32)
                .unwrap_or(teams_activity::DEFAULT_NOTIFICATIONS_LIMIT);
            let http = ctx.http.clone();
            let (activity, mentions, following) = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    async move {
                        let fetch = |stream| teams_activity::fetch_activity_stream(&http, &session, stream, limit);
                        tokio::try_join!(
                            fetch(teams_activity::NOTIFICATIONS_THREAD),
                            fetch(teams_activity::MENTIONS_THREAD),
                            fetch(teams_activity::THREADS_THREAD),
                        )
                    }
                })
                .await?;
            Ok(json!({
                "activity": feed_json(&activity),
                "mentions": feed_json(&mentions),
                "following": feed_json(&following),
            }))
        }

        // Read receipts ("seen by") for a conversation: every OTHER member's read
        // position, fetched from the dedicated `consumptionhorizons` thread
        // sub-resource. READ-ONLY — we only ever GET horizons, never write our
        // own. Best-effort: a thread with receipts disabled (tenant policy), too
        // many members (Teams stops tracking past ~20), or a transient failure
        // yields an empty list rather than an error, so the UI simply shows no
        // "seen by" avatars. Channels are skipped (they are large multi-party
        // threads that don't carry per-member receipts). The horizons refresh
        // live via the `read_receipt` event (see `spawn_realtime`).
        "read_receipts" => {
            let conv = param_str(params, "conversation")?;
            let (self_name, self_mri) = {
                let session = ctx.session().await?;
                (session.self_name.to_string(), session.self_mri.to_string())
            };
            let is_channel = {
                let store = ctx.store()?;
                teams_read::is_channel_thread_id(&conv) || store.is_channel(&conv).unwrap_or(false)
            };
            if is_channel {
                return Ok(json!({ "receipts": [] }));
            }
            let http = ctx.http.clone();
            let conv_op = conv.clone();
            let horizons = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let conv = conv_op.clone();
                    async move {
                        teams_readstate::fetch_consumption_horizons(&http, &session, &conv).await
                    }
                })
                .await
                .unwrap_or_default();
            let store = ctx.store()?;
            Ok(read_receipts_json(&store, &conv, &horizons, &self_name, &self_mri))
        }

        // Read the non-secret view of the app settings: the configured GitLab
        // host and whether each integration's token is stored. A raw token is
        // NEVER returned — it is write-only from the UI's perspective, matching
        // the "no raw tokens are ever sent" rule.
        "get_settings" => {
            let store = ctx.store()?;
            settings_json(&store)
        }

        // Persist app settings (partial update). Only keys present in `params`
        // are written, so the UI can save the host without resending a token, and
        // save one integration's token without touching the other's. An explicit
        // `""` clears that token. Returns the same non-secret view as
        // `get_settings` so the UI updates in one round-trip.
        "set_settings" => {
            let store = ctx.store()?;
            if let Some(host) = params.get("gitlab_host").and_then(Value::as_str) {
                store.set_setting(SETTING_GITLAB_HOST, host.trim())?;
            }
            for (param, key) in [
                ("gitlab_token", SETTING_GITLAB_TOKEN),
                ("linear_token", SETTING_LINEAR_TOKEN),
            ] {
                if let Some(token) = params.get(param).and_then(Value::as_str) {
                    store.set_setting(key, token.trim())?;
                }
            }
            settings_json(&store)
        }

        // Enrich a tracker link with metadata (title, state, assignee, …) so the
        // UI can render a rich preview card instead of a bare URL. Each
        // integration answers for its own host, with its configured token read
        // from the store (see `link_preview`). Best-effort: an unrecognized or
        // private link yields `metadata: null` (the UI shows the plain link);
        // only a transient failure errors.
        "enrich_link" => {
            let url = param_str(params, "url")?;
            let settings = {
                let store = ctx.store()?;
                link_preview_settings(&store)?
            };
            let metadata = link_preview::enrich(&ctx.http, &settings, &url).await?;
            Ok(json!({ "metadata": metadata }))
        }

        // One person's directory card — name, job title, department, email, work
        // location — for the card the UI shows on hovering a sender or an @mention.
        // `found` is false when the directory has nothing for this identity (a
        // service account, a removed guest), so the UI can fall back to the name it
        // already has. Only PERSON mris are accepted; a channel/team mri is refused
        // rather than sent upstream.
        "profile" => {
            let mri = param_str(params, "mri")?;
            anyhow::ensure!(teams_profiles::is_person_mri(&mri), "not a person mri");
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let profiles = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let mris = vec![mri.clone()];
                    async move {
                        // The short-profile endpoint takes the profile-audience
                        // token, not the CSA one `retry_on_auth` supplies.
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_profiles::fetch_profiles(&http, &session, &profile, &mris).await
                    }
                })
                .await?;
            Ok(match profiles.into_iter().next() {
                Some(p) => profile_json(&p),
                None => json!({ "found": false }),
            })
        }

        // Live presence ("Available", "Busy", "In a meeting", "Offline", …) for one
        // or more people, read the same way the Teams client reads it. Volatile by
        // nature, so it is never cached server-side: every call hits the presence
        // service and the UI decides how long to trust the answer. A person the
        // service has no answer for is simply absent from the result.
        "presence" => {
            let mris = presence_mris(params)?;
            let http = ctx.http.clone();
            let tokens = ctx.tokens.clone();
            let presences = ctx
                .retry_on_auth(move |session, _csa| {
                    let http = http.clone();
                    let tokens = tokens.clone();
                    let mris = mris.clone();
                    async move {
                        let profile = tokens.get(teams_profiles::PROFILE_SCOPE).await?;
                        teams_presence::fetch_presence(&http, &session, &profile, &mris).await
                    }
                })
                .await?;
            Ok(json!({
                "presences": presences.iter().map(presence_json).collect::<Vec<Value>>(),
            }))
        }

        // ---- mail (READ-ONLY Outlook surface, see `mail`) --------------------
        //
        // Every method below only reads. None of them is in `OUTWARD_METHODS`
        // because none can act on the mailbox: there is no send/reply/delete/move/
        // mark-as-read anywhere in the crate (`mail::tests` enforce it). What the
        // write lock protects is Teams; what protects the mailbox is that the
        // capability does not exist.

        // The mail folder list — LOCAL-FIRST like `conversations`: answer instantly
        // from SQLite, then sync from Graph in the background and emit
        // `mail_folders_changed` if any folder's name or counts moved.
        //
        // Except on a COLD store, where "local-first" would mean handing back an
        // empty mailbox: there is nothing to be instant about, so the first call
        // waits for the network. Without this, the very first time Mail is opened the
        // sidebar would come up empty and only fill in on a second visit.
        "mail_folders" => {
            let rows = {
                let store = ctx.store()?;
                store.mail_folders()?
            };
            if !rows.is_empty() {
                sync_mail_folders_bg(ctx.clone());
                return Ok(json!(rows.iter().map(mail_folder_json).collect::<Vec<Value>>()));
            }

            let http = ctx.http.clone();
            let folders = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    async move { mail::fetch_folders(&http, &token).await }
                })
                .await?;
            let store = ctx.store()?;
            mail::persist_folders(&store, &folders)?;
            // The inbox is what the unread badge counts, so it joins the live poll
            // as soon as the mailbox is known.
            if let Some(inbox) = folders.iter().find(|f| f.well_known == "Inbox") {
                ctx.watch_mail_folder(&inbox.id);
            }
            let rows = store.mail_folders()?;
            Ok(json!(rows.iter().map(mail_folder_json).collect::<Vec<Value>>()))
        }

        // A folder's newest page — LOCAL-FIRST: the cached page answers immediately
        // (0 network round-trips on a re-open), then a background fetch reconciles
        // it against the server and emits `mail_list_updated` when anything moved.
        // Opening a folder also puts it under the live poll.
        "mail_list" => {
            let folder = param_str(params, "folder")?;
            let limit = page_limit(params, mail::DEFAULT_PAGE_SIZE);
            ctx.watch_mail_folder(&folder);

            let (cached, has_more, never_synced) = {
                let store = ctx.store()?;
                let page = store.mail_page(&folder, None, limit as i64)?;
                let has_more = mail_has_more_older(&store, &folder, &page)?;
                // An empty page with no recorded frontier means this folder has never
                // been fetched — as opposed to a folder we know to be empty.
                let never_synced = page.is_empty() && store.mail_frontier(&folder)?.0.is_empty();
                (page, has_more, never_synced)
            };

            // Cold folder: wait for the network rather than answering "no mail", which
            // a client cannot tell apart from an empty folder (see `mail_folders`).
            if never_synced {
                refresh_mail_folder(ctx, &folder, limit).await?;
                let store = ctx.store()?;
                let page = store.mail_page(&folder, None, limit as i64)?;
                let has_more = mail_has_more_older(&store, &folder, &page)?;
                return Ok(mail_list_json(&page, has_more));
            }

            // Background refresh: never blocks the response, so switching folders is
            // instant once the folder has been seen at least once.
            let ctx_bg = ctx.clone();
            let folder_bg = folder.clone();
            tokio::spawn(async move {
                match refresh_mail_folder(&ctx_bg, &folder_bg, limit).await {
                    Ok(true) => emit_mail_list(&ctx_bg, &folder_bg),
                    Ok(false) => {}
                    Err(e) => ctx_bg.emit(
                        "mail_list_error",
                        json!({ "folder": folder_bg, "error": e.to_string() }),
                    ),
                }
            });
            Ok(mail_list_json(&cached, has_more))
        }

        // Older mail for scroll-up. Answers from the cache when it already holds the
        // page, else fetches it — the same shape as the chat `backfill`.
        "mail_backfill" => {
            let folder = param_str(params, "folder")?;
            let before = param_str(params, "before")?;
            let limit = page_limit(params, mail::DEFAULT_PAGE_SIZE);

            let (cached, frontier) = {
                let store = ctx.store()?;
                (
                    store.mail_page(&folder, Some(&before), limit as i64)?,
                    store.mail_frontier(&folder)?,
                )
            };
            if !cached.is_empty() {
                let has_more = mail_has_more_older(&ctx.store()?, &folder, &cached)?;
                return Ok(mail_list_json(&cached, has_more));
            }
            // Nothing cached older than `before`: if the server has nothing either,
            // say so instead of asking it again.
            if !frontier.1 {
                return Ok(mail_list_json(&[], false));
            }

            let http = ctx.http.clone();
            let folder_op = folder.clone();
            let before_op = before.clone();
            let page = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let folder = folder_op.clone();
                    let before = before_op.clone();
                    async move { mail::fetch_older(&http, &token, &folder, &before, limit).await }
                })
                .await?;
            let store = ctx.store()?;
            mail::persist_headers(&store, &page)?;
            mail::persist_frontier(&store, &folder, &page, limit)?;
            let rows = store.mail_page(&folder, Some(&before), limit as i64)?;
            let has_more = mail_has_more_older(&store, &folder, &rows)?;
            Ok(mail_list_json(&rows, has_more))
        }

        // One mail's rendered body. Cached after the first read, so re-opening a
        // mail — or reading it offline — costs nothing.
        //
        // The HTML handed back is inert and self-contained: scripts, styles, frames
        // and forms removed, remote images dropped and counted, inline images
        // embedded as data URIs (see `mail_html`). The UI still renders it inside a
        // sandboxed iframe under a `default-src 'none'` CSP.
        "mail_body" => {
            let id = param_str(params, "id")?;
            if let Some(row) = ctx.store()?.mail_message(&id)? {
                if row.body_loaded {
                    return Ok(mail_body_json(&row));
                }
            }

            let http = ctx.http.clone();
            let id_op = id.clone();
            let fetched = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let id = id_op.clone();
                    async move { mail::fetch_body(&http, &token, &id).await }
                })
                .await?;
            let store = ctx.store()?;
            // The fetch carried the header too, so a mail reached by a DEEP LINK —
            // one that was never in a list — becomes a proper row here instead of a
            // body with no sender or subject. Its folder is watched from now on, so
            // the poll keeps it current like any other.
            if let Some(header) = &fetched.header {
                mail::persist_headers(&store, std::slice::from_ref(header))?;
                ctx.watch_mail_folder(&header.folder_id);
            }
            mail::persist_body(&store, &id, &fetched)?;
            match store.mail_message(&id)? {
                Some(row) if row.body_loaded => Ok(mail_body_json(&row)),
                // No row: the mail exists on the server but Graph gave us nothing we
                // could key it by. Return the body alone rather than failing the open.
                _ => Ok(json!({
                    "html": fetched.body.html,
                    "blocked_remote_images": fetched.body.blocked_remote_images,
                    "truncated": fetched.body.truncated,
                    "attachments": serde_json::from_str::<Value>(
                        &mail::attachments_json(&fetched.attachments)
                    ).unwrap_or_else(|_| json!([])),
                    "header": Value::Null,
                })),
            }
        }

        // One attachment's bytes, base64 over the same WebSocket as every other
        // proxied media object. The browser cannot fetch these itself (they need the
        // Graph token), and the UI never touches the network directly.
        "mail_attachment" => {
            let message_id = param_str(params, "message_id")?;
            let attachment_id = param_str(params, "attachment_id")?;
            let http = ctx.http.clone();
            let attachment = ctx
                .retry_graph(move |token| {
                    let http = http.clone();
                    let message_id = message_id.clone();
                    let attachment_id = attachment_id.clone();
                    async move {
                        mail::fetch_attachment(&http, &token, &message_id, &attachment_id).await
                    }
                })
                .await?;
            let data = base64::engine::general_purpose::STANDARD.encode(&attachment.bytes);
            Ok(json!({
                "content_type": attachment.content_type,
                "name": attachment.name,
                "data_base64": data,
            }))
        }

        // ---- calendar (READ-ONLY Teams/Outlook surface, see `calendar`) -------
        //
        // Both methods below only read, and neither is in `OUTWARD_METHODS` because
        // neither can act on a calendar: there is no create/update/delete/accept/
        // decline/cancel/forward path anywhere in the crate (`calendar::tests`
        // enforce it). What the write lock protects is Teams; what protects the
        // calendar is that the capability does not exist.

        // The calendar list — LOCAL-FIRST like `mail_folders`, and cold-start-aware
        // for the same reason: answering an empty list on the first call would leave
        // the UI with nothing to show and no way to tell that apart from a mailbox
        // with no calendars.
        "calendars" => {
            let rows = ctx.store()?.calendars()?;
            if !rows.is_empty() {
                sync_calendars_bg(ctx.clone());
                return Ok(json!(rows.iter().map(calendar_json).collect::<Vec<Value>>()));
            }
            let calendars = fetch_calendars(ctx).await?;
            let store = ctx.store()?;
            calendar::persist_calendars(&store, &calendars)?;
            let rows = store.calendars()?;
            Ok(json!(rows.iter().map(calendar_json).collect::<Vec<Value>>()))
        }

        // Every event in a window — LOCAL-FIRST: a month already synced answers from
        // SQLite with no network at all (0 round-trips when navigating back to it),
        // then a background refresh reconciles it and emits `calendar_view_updated`
        // if anything moved. A window whose months have never been read waits for the
        // network instead, because "no events" and "not fetched yet" look identical
        // on a calendar grid — and the second one would render as a free week.
        //
        // Opening a window also makes it the one the live poll watches.
        "calendar_view" => {
            let start = param_str(params, "start")?;
            let end = param_str(params, "end")?;
            // Months, not the requested window: the sync unit is a calendar month, so
            // a week straddling two of them is still a cache hit. See the
            // `calendar` module doc.
            let months = calendar::months_covering(&start, &end);
            let (Some(first), Some(last)) = (months.first(), months.last()) else {
                anyhow::bail!("calendar_view needs a start before its end, both ISO 8601 UTC");
            };
            let (span_start, span_end) = (first.start(), last.end());

            // Which calendars: whatever the client asked for, else every one we know
            // (resolving them from the network if this is a cold store, so the first
            // calendar_view of a session does not come back empty).
            let calendars = match param_str_list(params, "calendars") {
                ids if !ids.is_empty() => ids,
                _ => {
                    let known = ctx.store()?.calendars()?;
                    if known.is_empty() {
                        let fetched = fetch_calendars(ctx).await?;
                        calendar::persist_calendars(&ctx.store()?, &fetched)?;
                        fetched.into_iter().map(|c| c.id).collect()
                    } else {
                        known.into_iter().map(|c| c.id).collect()
                    }
                }
            };

            ctx.watch_calendar(CalendarWatch {
                start: span_start.clone(),
                end: span_end.clone(),
                calendars: calendars.clone(),
            });

            let fully_synced = {
                let store = ctx.store()?;
                let mut synced = true;
                for calendar_id in &calendars {
                    for month in &months {
                        if !store.calendar_month_synced(calendar_id, &month.key())? {
                            synced = false;
                            break;
                        }
                    }
                    if !synced {
                        break;
                    }
                }
                synced
            };

            if !fully_synced {
                refresh_calendar_span(ctx, &calendars, &months).await?;
            } else {
                let ctx_bg = ctx.clone();
                let calendars_bg = calendars.clone();
                let months_bg = months.clone();
                tokio::spawn(async move {
                    match refresh_calendar_span(&ctx_bg, &calendars_bg, &months_bg).await {
                        Ok(true) => emit_calendar_view(&ctx_bg),
                        Ok(false) => {}
                        Err(e) => ctx_bg.emit(
                            "calendar_view_error",
                            json!({ "error": e.to_string() }),
                        ),
                    }
                });
            }

            let events = ctx.store()?.calendar_events(&start, &end, &calendars)?;
            Ok(calendar_view_json(&events, &start, &end))
        }

        other => anyhow::bail!("unknown method: {other}"),
    }
}

/// A bounded page size from `params.limit`, defaulting to `default`. Clamped so a
/// client cannot ask Graph for an unbounded page.
fn page_limit(params: &Value, default: u32) -> u32 {
    params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 100) as u32)
        .unwrap_or(default)
}

/// Whether a folder has mail older than the page just read.
///
/// True when the server is known to hold more (`has_more_older`) OR the page stops
/// short of the oldest row we hold locally — the latter is what makes scrolling a
/// long cached folder work without a network round-trip per page.
fn mail_has_more_older(
    store: &Store,
    folder_id: &str,
    page: &[teams_lite::store::MailMessageRow],
) -> Result<bool> {
    let (oldest_held, server_has_more) = store.mail_frontier(folder_id)?;
    match page.last() {
        // An empty page: only the server can still have something.
        None => Ok(server_has_more),
        Some(last) => Ok(server_has_more || last.received > oldest_held),
    }
}

/// Refresh a folder's newest window from Graph and reconcile it into the store.
///
/// Returns whether anything changed (so the caller only emits an event when it
/// did). The window is re-read in full rather than asked for incrementally, which is
/// what lets [`Store::prune_mail_window`] notice mail deleted or moved in real
/// Outlook — see [`mail::POLL_WINDOW`].
async fn refresh_mail_folder(ctx: &Ctx, folder_id: &str, limit: u32) -> Result<bool> {
    let http = ctx.http.clone();
    let folder = folder_id.to_string();
    let window = limit.max(mail::POLL_WINDOW);
    let page = ctx
        .retry_graph(move |token| {
            let http = http.clone();
            let folder = folder.clone();
            async move { mail::fetch_newest(&http, &token, &folder, window).await }
        })
        .await?;

    let store = ctx.store()?;
    let changed = mail::persist_headers(&store, &page)? > 0;
    mail::persist_frontier(&store, folder_id, &page, window)?;
    let pruned = match (page.last(), page.iter().map(|h| h.id.clone()).collect::<Vec<_>>()) {
        (Some(oldest), ids) => store.prune_mail_window(folder_id, &oldest.received, &ids)?,
        (None, _) => 0,
    };
    Ok(changed || pruned > 0)
}

/// Broadcast a folder's current newest page to every connected UI.
fn emit_mail_list(ctx: &Ctx, folder_id: &str) {
    let Ok(store) = ctx.store() else { return };
    let Ok(page) = store.mail_page(folder_id, None, mail::DEFAULT_PAGE_SIZE as i64) else {
        return;
    };
    let has_more = mail_has_more_older(&store, folder_id, &page).unwrap_or(false);
    let mut payload = mail_list_json(&page, has_more);
    payload["folder"] = json!(folder_id);
    ctx.emit("mail_list_updated", payload);
}

/// Sync the mail folder list from Graph in the background, emitting
/// `mail_folders_changed` when any folder's metadata moved. Best-effort: mail is a
/// secondary surface, so a failure is logged and the cached list stands.
///
/// Also the point at which the inbox joins the live poll: whatever folder the user
/// browses, the inbox is the one whose unread count the UI badges.
fn sync_mail_folders_bg(ctx: Ctx) {
    tokio::spawn(async move {
        let http = ctx.http.clone();
        let folders = ctx
            .retry_graph(move |token| {
                let http = http.clone();
                async move { mail::fetch_folders(&http, &token).await }
            })
            .await;
        match folders {
            Ok(folders) => {
                // Whatever the user reads first, the inbox is always worth watching:
                // it is where new mail lands and what the badge counts.
                if let Some(inbox) = folders.iter().find(|f| f.well_known == "Inbox") {
                    ctx.watch_mail_folder(&inbox.id);
                }
                let changed = ctx
                    .store()
                    .and_then(|store| mail::persist_folders(&store, &folders));
                match changed {
                    Ok(true) => ctx.emit("mail_folders_changed", json!({})),
                    Ok(false) => {}
                    Err(e) => eprintln!("[mail] could not persist folders: {e}"),
                }
            }
            Err(e) => eprintln!("[mail] folder sync failed: {e:#}"),
        }
    });
}

/// How often the watched mail folders are re-read. Mail is not chat: a minute of
/// latency on a new mail is unremarkable, and this is one request per watched
/// folder.
const MAIL_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// The mail live loop: re-read each watched folder's newest window on a timer and
/// broadcast what changed.
///
/// This is a poll, not a push. Trouter is registered against the Teams registrar and
/// carries no mailbox traffic, and Graph's change notifications need a public
/// webhook — neither is available to a local-first app, so the honest mechanism is a
/// cheap periodic read (see the `mail` module doc).
///
/// LAZY BY DESIGN: the watch set starts empty, so this loop makes NO requests until
/// a client actually opens the mail surface (`mail_folders` triggers the folder sync,
/// `mail_list` registers the folder it opened). A user who only ever uses chat — or
/// the terminal UI, which has no mail surface — pays nothing for mail at all. Once
/// Mail has been opened, the poll keeps its folders and the unread badge current for
/// the rest of the session.
fn spawn_mail_sync(ctx: Ctx) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MAIL_POLL_INTERVAL).await;
            let folders: Vec<String> = match ctx.mail_watch.lock() {
                Ok(watch) => watch.iter().cloned().collect(),
                Err(_) => continue,
            };
            for folder in folders {
                match refresh_mail_folder(&ctx, &folder, mail::POLL_WINDOW).await {
                    Ok(true) => {
                        emit_mail_list(&ctx, &folder);
                        // Counts moved with the mail, so refresh the folder list too.
                        sync_mail_folders_bg(ctx.clone());
                    }
                    Ok(false) => {}
                    // A transient failure is not worth telling the UI about: the
                    // cached list is still valid and the next tick retries.
                    Err(e) => eprintln!("[mail] poll of a watched folder failed: {e:#}"),
                }
            }
        }
    });
}

/// Serialize a mail folder for the sidebar.
fn mail_folder_json(folder: &teams_lite::store::MailFolderRow) -> Value {
    json!({
        "id": folder.id,
        // The UI shows `well_known` when set (stable English) and falls back to the
        // mailbox's own, localized name for a user folder.
        "display_name": folder.display_name,
        "well_known": folder.well_known,
        "total_count": folder.total_count,
        "unread_count": folder.unread_count,
        "position": folder.position,
    })
}

/// Serialize one mail's list fields. The body is never included here — see
/// `mail_body`.
fn mail_header_json(mail: &teams_lite::store::MailMessageRow) -> Value {
    let addresses = |raw: &str| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!([]));
    json!({
        "id": mail.id,
        "folder_id": mail.folder_id,
        "conversation_id": mail.conversation_id,
        "subject": mail.subject,
        "from": { "name": mail.from_name, "address": mail.from_address },
        "to": addresses(&mail.to_addresses),
        "cc": addresses(&mail.cc_addresses),
        "received": mail.received,
        "is_read": mail.is_read,
        "has_attachments": mail.has_attachments,
        "importance": mail.importance,
        "preview": mail.preview,
    })
}

fn mail_list_json(page: &[teams_lite::store::MailMessageRow], has_more: bool) -> Value {
    json!({
        "messages": page.iter().map(mail_header_json).collect::<Vec<Value>>(),
        "has_more": has_more,
    })
}

/// Serialize a cached body, including what the sanitizer had to remove so the UI can
/// explain a mail that is not rendered in full.
///
/// The mail's `header` rides along so opening `/m/<id>` cold — a deep link, a
/// reload, a restored tab — renders the subject, sender and recipients without a
/// second round-trip. A client that already has the header from its list simply
/// ignores it.
fn mail_body_json(mail: &teams_lite::store::MailMessageRow) -> Value {
    json!({
        "html": mail.body_html,
        "blocked_remote_images": mail.blocked_remote_images,
        "truncated": mail.body_truncated,
        "attachments": serde_json::from_str::<Value>(&mail.attachments)
            .unwrap_or_else(|_| json!([])),
        "header": mail_header_json(mail),
    })
}

// ---- calendar (READ-ONLY, see `calendar`) ----------------------------------

/// Read the mailbox's calendars from Graph under the shared retry policy.
async fn fetch_calendars(ctx: &Ctx) -> Result<Vec<calendar::Calendar>> {
    let http = ctx.http.clone();
    ctx.retry_graph(move |token| {
        let http = http.clone();
        async move { calendar::fetch_calendars(&http, &token).await }
    })
    .await
}

/// Sync the calendar list from Graph in the background, emitting
/// `calendars_changed` when any calendar's name, colour or order moved. Best-effort:
/// the calendar is a secondary surface, so a failure is logged and the cached list
/// stands.
fn sync_calendars_bg(ctx: Ctx) {
    tokio::spawn(async move {
        match fetch_calendars(&ctx).await {
            Ok(calendars) => {
                let changed = ctx
                    .store()
                    .and_then(|store| calendar::persist_calendars(&store, &calendars));
                match changed {
                    Ok(true) => ctx.emit("calendars_changed", json!({})),
                    Ok(false) => {}
                    Err(e) => eprintln!("[calendar] could not persist calendars: {e}"),
                }
            }
            Err(e) => eprintln!("[calendar] calendar sync failed: {e:#}"),
        }
    });
}

/// Re-read a contiguous span of calendar-months from Graph and reconcile it into the
/// store, for every calendar in `calendars`. Returns whether anything changed, so the
/// caller only emits an event when it did.
///
/// ONE request per calendar covering the whole span, rather than one per
/// (calendar, month): a month grid reaches into three calendar months, and three
/// sequential round-trips per calendar would be plainly visible on the first paint.
/// The results are then split back into months, because a month is the unit the
/// store records as synced and the unit it reconciles.
///
/// Reconciling means pruning: an event held locally that the fresh read does not
/// list has been deleted, moved out of the window, or had its whole series removed in
/// real Outlook, and must disappear here too (see `Store::prune_calendar_window`).
async fn refresh_calendar_span(
    ctx: &Ctx,
    calendars: &[String],
    months: &[calendar::Month],
) -> Result<bool> {
    let (Some(first), Some(last)) = (months.first(), months.last()) else {
        return Ok(false);
    };
    let (span_start, span_end) = (first.start(), last.end());

    let mut changed = false;
    for calendar_id in calendars {
        let http = ctx.http.clone();
        let id = calendar_id.clone();
        let (from, to) = (span_start.clone(), span_end.clone());
        let view = ctx
            .retry_graph(move |token| {
                let http = http.clone();
                let (id, from, to) = (id.clone(), from.clone(), to.clone());
                async move { calendar::fetch_view(&http, &token, &id, &from, &to).await }
            })
            .await?;
        if view.truncated {
            // Never a silent truncation: a short month reads as a quiet one.
            eprintln!(
                "[calendar] {calendar_id} {span_start}..{span_end} has more events than one \
                 sync reads; the view is incomplete"
            );
        }

        let store = ctx.store()?;
        changed |= calendar::persist_events(&store, &view.events)? > 0;
        for month in months {
            let (month_start, month_end) = (month.start(), month.end());
            // The ids this month is allowed to keep, decided by the SAME overlap rule
            // the store's range query uses — see `calendar::overlaps`.
            let keep: Vec<String> = view
                .events
                .iter()
                .filter(|e| calendar::overlaps(e, &month_start, &month_end))
                .map(|e| e.id.clone())
                .collect();
            // A truncated read is not authoritative about what is absent, so it must
            // not prune: it would delete events it simply did not get to.
            if !view.truncated {
                changed |= store
                    .prune_calendar_window(calendar_id, &month_start, &month_end, &keep)?
                    > 0;
                store.mark_calendar_month_synced(calendar_id, &month.key())?;
            }
        }
    }
    Ok(changed)
}

/// Broadcast the currently watched calendar window to every connected UI.
fn emit_calendar_view(ctx: &Ctx) {
    let Some(watch) = ctx.calendar_watch.lock().ok().and_then(|w| w.clone()) else {
        return;
    };
    let Ok(store) = ctx.store() else { return };
    let Ok(events) = store.calendar_events(&watch.start, &watch.end, &watch.calendars) else {
        return;
    };
    ctx.emit(
        "calendar_view_updated",
        calendar_view_json(&events, &watch.start, &watch.end),
    );
}

/// How often the watched calendar window is re-read. Slower than mail: a meeting
/// moved five minutes ago is worth knowing about, a meeting moved five seconds ago is
/// not worth a request every few seconds — and this is one request per visible
/// calendar.
const CALENDAR_POLL_INTERVAL: Duration = Duration::from_secs(120);

/// The calendar live loop: re-read the window a UI is looking at on a timer and
/// broadcast it when it changed.
///
/// A poll, not a push, for the same reason mail polls: trouter carries no calendar
/// traffic, and Graph's change notifications need a public webhook.
///
/// LAZY BY DESIGN: the watch starts empty, so this loop makes NO requests until a
/// client opens the calendar. A user who only ever chats — or the terminal UI, which
/// has no calendar surface — pays nothing for it.
fn spawn_calendar_sync(ctx: Ctx) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CALENDAR_POLL_INTERVAL).await;
            let Some(watch) = ctx.calendar_watch.lock().ok().and_then(|w| w.clone()) else {
                continue;
            };
            let months = calendar::months_covering(&watch.start, &watch.end);
            match refresh_calendar_span(&ctx, &watch.calendars, &months).await {
                Ok(true) => emit_calendar_view(&ctx),
                Ok(false) => {}
                // A transient failure is not worth telling the UI about: the cached
                // window is still valid and the next tick retries.
                Err(e) => eprintln!("[calendar] poll of the watched window failed: {e:#}"),
            }
        }
    });
}

/// Serialize one calendar for the sidebar.
fn calendar_json(calendar: &teams_lite::store::CalendarRow) -> Value {
    json!({
        "id": calendar.id,
        "name": calendar.name,
        "hex_color": calendar.hex_color,
        "is_default": calendar.is_default,
        "can_edit": calendar.can_edit,
        "position": calendar.position,
    })
}

/// Serialize one event. `attendees` and `categories` are stored as JSON and pass
/// straight through — nothing in the backend looks inside them.
fn calendar_event_json(event: &teams_lite::store::CalendarEventRow) -> Value {
    let array = |raw: &str| serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!([]));
    json!({
        "id": event.id,
        "calendar_id": event.calendar_id,
        "subject": event.subject,
        "preview": event.preview,
        "start": event.start_utc,
        "end": event.end_utc,
        "is_all_day": event.is_all_day,
        "is_cancelled": event.is_cancelled,
        "is_organizer": event.is_organizer,
        "organizer": { "name": event.organizer_name, "address": event.organizer_address },
        "location": event.location,
        "join_url": event.join_url,
        "web_link": event.web_link,
        "show_as": event.show_as,
        "response": event.response,
        "series": event.series,
        "recurrence": event.recurrence,
        "importance": event.importance,
        "sensitivity": event.sensitivity,
        "categories": array(&event.categories),
        "attendees": array(&event.attendees),
        "attendee_count": event.attendee_count,
        "has_attachments": event.has_attachments,
        "reminder_minutes": event.reminder_minutes,
    })
}

/// A window of events plus the window itself, so a client can tell a late-arriving
/// `calendar_view_updated` for a month it has navigated away from apart from one for
/// the month it is showing.
fn calendar_view_json(
    events: &[teams_lite::store::CalendarEventRow],
    start: &str,
    end: &str,
) -> Value {
    json!({
        "start": start,
        "end": end,
        "events": events.iter().map(calendar_event_json).collect::<Vec<Value>>(),
    })
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

/// The people a `presence` request asks about: either a single `mri` or an `mris`
/// array. Every entry must be a person mri, and the batch is capped, so nothing
/// unbounded or unexpected is ever forwarded to the presence service.
fn presence_mris(params: &Value) -> Result<Vec<String>> {
    let mris: Vec<String> = match params.get("mris") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => vec![param_str(params, "mri")?],
    };
    anyhow::ensure!(!mris.is_empty(), "missing param: mri");
    anyhow::ensure!(
        mris.len() <= teams_presence::MAX_BATCH,
        "too many mris in one presence request"
    );
    anyhow::ensure!(
        mris.iter().all(|m| teams_profiles::is_person_mri(m)),
        "not a person mri"
    );
    Ok(mris)
}

/// Wire shape of a person's directory card (see the `profile` method).
fn profile_json(p: &teams_profiles::Profile) -> Value {
    json!({
        "found": true,
        "mri": p.mri,
        "object_id": p.object_id,
        "display_name": p.display_name,
        "given_name": p.given_name,
        "surname": p.surname,
        "email": p.email,
        "user_principal_name": p.user_principal_name,
        "job_title": p.job_title,
        "department": p.department,
        "company_name": p.company_name,
        "office_location": p.office_location,
        "tenant_name": p.tenant_name,
        "user_type": p.user_type,
    })
}

/// Wire shape of one person's presence (see the `presence` method).
fn presence_json(p: &teams_presence::Presence) -> Value {
    json!({
        "mri": p.mri,
        "availability": p.availability,
        "activity": p.activity,
        "last_active_ms": p.last_active_ms,
        "out_of_office": p.out_of_office,
        "out_of_office_note": p.out_of_office_note,
        "note": p.note,
    })
}

fn param_str(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .with_context(|| format!("missing param: {key}"))
}

/// An optional array-of-strings parameter, empty when absent, not an array, or made
/// only of blanks. Callers treat "empty" as "no filter", so a malformed value
/// degrades to the unfiltered result rather than to an error.
fn param_str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Build the non-secret view of the app settings for the UI: the configured
/// GitLab host (falling back to the default) and whether each integration's token
/// is stored. A raw token is deliberately never included — the UI only needs to
/// know it is set, never its value.
fn settings_json(store: &Store) -> Result<Value> {
    let settings = link_preview_settings(store)?;
    Ok(json!({
        "gitlab_host": settings.gitlab_host,
        "gitlab_token_set": settings.gitlab_token.is_some(),
        "linear_token_set": settings.linear_token.is_some(),
    }))
}

/// Read what the link-preview integrations need from the store: the GitLab host
/// (falling back to the default) and one token per provider. A stored empty
/// string means "no token", which is how the UI clears one.
fn link_preview_settings(store: &Store) -> Result<link_preview::Settings> {
    let token = |key: &str| -> Result<Option<String>> {
        Ok(store.get_setting(key)?.filter(|t| !t.is_empty()))
    };
    Ok(link_preview::Settings {
        gitlab_host: store
            .get_setting(SETTING_GITLAB_HOST)?
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| gitlab::DEFAULT_HOST.to_string()),
        gitlab_token: token(SETTING_GITLAB_TOKEN)?,
        linear_token: token(SETTING_LINEAR_TOKEN)?,
    })
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

/// Serialize one activity stream for the UI: the decoded notifications plus the
/// unread count (derived from Teams' own read-state) so the panel can badge it.
fn feed_json(items: &[teams_activity::Notification]) -> Value {
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
                "source_thread_topic": n.source_thread_topic,
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
            "draft": c.draft,
            "avatar_mri": c.avatar_mri,
            "picture_url": c.picture_url
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
            "team_group_id": c.team_group_id,
            "name": c.display_name,
            "is_general": c.is_general,
            "is_favorite": c.is_favorite,
            "last_message_time": c.last_message_time,
            "last_message_preview": c.last_message_preview,
            "last_message_sender": c.last_message_sender,
            "last_message_from_me": c.last_message_from_me,
            "is_read": c.is_read,
            "alerts": c.alerts.as_str(),
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
        .map(|m| message_json(m, self_name, self_mri))
        .collect::<Vec<_>>())
}

/// Decode a message's stored attachments (a JSON array string) back into a JSON
/// value for the wire. A legacy/blank/malformed value degrades to an empty array
/// so a single bad row can never break a whole page's serialization.
fn attachments_value(m: &Message) -> Value {
    serde_json::from_str(&m.attachments).unwrap_or_else(|_| json!([]))
}

/// Decode a message's stored @mentions (a JSON array string) for the wire, so the
/// UI can map each mention span's `itemid` back to the person it names — and show
/// their card on hover. A legacy/blank/malformed value degrades to an empty array
/// so one bad row can never break serialization.
fn mentions_value(m: &Message) -> Value {
    serde_json::from_str(&m.mentions).unwrap_or_else(|_| json!([]))
}

/// Decode a message's structured system event (a JSON object string) for the wire,
/// or `null` when the message is a normal chat message (empty `system_event`) or
/// the stored value is malformed. The UI renders a centered system line when this
/// is present (see `web/src/components/call-event-line.tsx`).
///
/// Two `kind`s ride this field:
///   - `call` — `{event:"ended|missed|started", duration_seconds, participant_count,
///     participants[], participant_mris[], meeting?}`;
///   - `thread_activity` — `{event:"member_added|pinned|unpinned", time_ms,
///     actor_mri, members[], member_mris[]}`, where `members` holds display names
///     index-aligned with `member_mris` (a name may be empty: resolve it from the MRI).
/// A UI that does not know a `kind` should render nothing for it rather than the
/// raw payload; new kinds are added here, never inferred from `content`.
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

/// Serialize a conversation's read receipts for the wire: one entry per OTHER
/// member (our own horizon is dropped — we never show our own read state), each
/// carrying the reader's MRI, a resolved display name, and the id of the last
/// message they have read. The UI anchors a small avatar to that message.
///
/// Names are resolved locally from stored messages (network-free), exactly like
/// the typing indicator. For a 1:1 where the other party has read but never
/// posted, that lookup misses, so we fall back to the conversation's other-party
/// name when there is a single unresolved member. An MRI that still resolves to
/// nothing is passed through with an empty name; the UI shows a neutral avatar.
fn read_receipts_json(
    store: &Store,
    conversation_id: &str,
    horizons: &[teams_readstate::ConsumptionHorizon],
    self_name: &str,
    self_mri: &str,
) -> Value {
    let others: Vec<&teams_readstate::ConsumptionHorizon> = horizons
        .iter()
        .filter(|h| !teams_lite::store::same_user(&h.mri, self_mri))
        .collect();
    let single_other = others.len() == 1;
    let receipts: Vec<Value> = others
        .iter()
        .map(|h| {
            let mut name = store
                .display_name_for_mri(&h.mri)
                .ok()
                .flatten()
                .unwrap_or_default();
            if name.is_empty() && single_other {
                name = store
                    .other_party_name(conversation_id, self_name)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
            }
            json!({
                "member_mri": h.mri,
                "member": name,
                "last_read_message_id": h.last_read_message_id,
                "read_time_ms": h.read_time_ms,
            })
        })
        .collect();
    json!({ "receipts": receipts })
}

/// Serialize one message for the wire.
///
/// `message_type` is the Teams `messagetype` verbatim (`Text`, `RichText/Html`,
/// `RichText/Media_Card`, …), snake_cased like the other wire keys. A front-end
/// needs it to know that a `Text` body is PLAIN text and must be escaped rather
/// than parsed as HTML (otherwise `Vec<String>` renders as `Vec`). Empty for legacy
/// rows stored before the column existed — treat empty as "unknown", i.e. keep the
/// previous HTML behaviour.
fn message_json(m: &Message, self_name: &str, self_mri: &str) -> Value {
    json!({
        "id": m.id, "conversation_id": m.conversation_id, "seq": m.seq,
        "compose_time": m.compose_time, "sender": m.sender, "sender_mri": m.sender_mri,
        "message_type": m.message_type,
        "content": m.content,
        "attachments": attachments_value(m),
        "mentions": mentions_value(m),
        "reactions": reactions_value(m, self_mri),
        "system_event": system_event_value(m),
        "is_self": is_self(m, self_name, self_mri),
        "thread_root_id": m.thread_root_id,
        "thread_subject": m.thread_subject,
        "deleted": m.deleted
    })
}

/// Build the `call` real-time event for a live message that is a call system
/// event, or `None` when the message is not one (or is our own outgoing call,
/// which we never ring for).
///
/// This is incoming-call *awareness*, not a call itself: Teams posts an
/// `Event/Call` message to a conversation when a call starts/ends there, and the
/// backend already turns that into a structured `system_event` (see
/// [`teams_read::parse_call_event`]). We ride entirely on that already-parsed,
/// already-tested payload — no new wire parsing — and surface it as an ephemeral
/// signal (like `typing`) so a UI can raise/dismiss an incoming-call banner. The
/// system line is still stored and broadcast as a normal `message` alongside it.
///
/// - `started` rings (unless we started the call ourselves);
/// - `ended`/`missed` dismiss any banner the UI is showing for that conversation
///   (emitted even for our own call, since dismissal is keyed by conversation).
///
/// It does NOT place, answer, or carry media — the client has no media stack, and
/// answering would be a real action performed as the user.
fn call_event_json(m: &Message, self_name: &str, self_mri: &str) -> Option<Value> {
    let event: Value = serde_json::from_str(&m.system_event).ok()?;
    if event.get("kind").and_then(Value::as_str) != Some("call") {
        return None;
    }
    // A meeting-thread call marker (`parse_call_event`'s JSON shape) is surfaced as
    // a "Call started" line, but it is awareness noise rather than a personal
    // incoming call — no caller identity, and it can arrive in backfill — so it
    // must never raise OR clear the incoming-call banner.
    if event.get("meeting").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let kind = event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("ended");
    // Never ring for a call we started ourselves (the `started` frame carries us
    // as the sender). We still surface `ended`/`missed` so the banner clears.
    if kind == "started" && is_self(m, self_name, self_mri) {
        return None;
    }
    Some(json!({
        "conversation_id": m.conversation_id,
        "event": kind,
        "caller": m.sender,
        "caller_mri": m.sender_mri,
        "participants": event.get("participants").cloned().unwrap_or_else(|| json!([])),
        "participant_mris": event.get("participant_mris").cloned().unwrap_or_else(|| json!([])),
        "participant_count": event.get("participant_count").cloned().unwrap_or_else(|| json!(0)),
    }))
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
            // Say so. This is the sync that fills the chat list and the channel tree,
            // so a silent return is a sidebar that stays empty with nothing in the
            // journal to explain it — which is exactly how a locked keyring read as
            // "the app is broken" for a whole morning.
            Err(e) => {
                eprintln!("[sync] conversation list refresh failed: {e:#}");
                return;
            }
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

// ---- push notifications --------------------------------------------------------
// The delivery side of src/push.rs: the machine's VAPID identity, the status the
// Settings pane shows, and the two paths that actually push — the `push_test` RPC
// and every live message the policy accepts.

/// Wall-clock milliseconds, the store's timestamp unit.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// This machine's VAPID identity, generated on first use and then loaded.
///
/// Generate-once-then-load, never per process: a device's subscription embeds the
/// public half, so a fresh key pair would silently stop every phone that already
/// opted in. A stored key that no longer parses is replaced — it cannot be used for
/// anything, and refusing to push forever is worse than asking the devices to
/// subscribe again.
fn vapid_key(store: &Store) -> Result<push::VapidKey> {
    if let Some(stored) = store.get_setting(SETTING_PUSH_VAPID_PRIVATE)? {
        match push::VapidKey::from_private_base64url(&stored) {
            Ok(key) => return Ok(key),
            Err(e) => eprintln!("[push] the stored VAPID key is unusable ({e}) — generating a new one"),
        }
    }
    let key = push::VapidKey::generate();
    store.set_setting(SETTING_PUSH_VAPID_PRIVATE, &key.private_base64url())?;
    eprintln!("[push] generated this machine's VAPID key pair");
    Ok(key)
}

/// What the Settings pane needs to show the notification state, and what a page
/// needs to subscribe.
///
/// `supported: false` in read-only mode: that backend never pushes (see
/// [`deliver_push`]), so a page must not offer a switch that would do nothing.
fn push_status_json(store: &Store) -> Result<Value> {
    if read_only() {
        return Ok(json!({
            "supported": false,
            "reason": "this backend runs read-only (TEAMS_LITE_READ_ONLY=1) and never pushes",
            "public_key": "",
            "devices": [],
        }));
    }
    let key = vapid_key(store)?;
    let devices: Vec<Value> = store
        .push_subscriptions()?
        .into_iter()
        .map(|row| {
            json!({
                // The endpoint is the client's own handle on its subscription — how a
                // page recognizes ITS device in the list. It is not a secret the page
                // does not already hold.
                "endpoint": row.endpoint,
                "label": row.label,
                "created_ms": row.created_ms,
                "last_ok_ms": row.last_ok_ms,
                "last_error": row.last_error,
            })
        })
        .collect();
    Ok(json!({
        "supported": true,
        "public_key": key.public_base64url(),
        "devices": devices,
    }))
}

/// The outcome of pushing one notification to every subscribed device.
#[derive(Debug, Default)]
struct PushReport {
    delivered: usize,
    failed: usize,
    /// One line per failure, for the caller that asked (the in-app test button).
    errors: Vec<String>,
}

/// Encrypt one notification to every subscribed device and POST it.
///
/// Refuses outright in read-only mode. That mode exists so tooling can drive the
/// real store without acting on the user, and buzzing their phone from a screenshot
/// script is exactly the kind of action it forbids — the check is here, not only at
/// the dispatch gate, because live delivery never passes through the gate.
///
/// A subscription the push service reports as gone is deleted: the app was
/// uninstalled or the browser rotated it, and retrying it costs a request per
/// message forever.
async fn deliver_push(
    ctx: &Ctx,
    notification: &push::Notification,
    ttl_secs: u32,
) -> Result<PushReport> {
    if read_only() {
        anyhow::bail!(
            "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never notifies the user's \
             devices"
        );
    }
    let store = ctx.store()?;
    let key = vapid_key(&store)?;
    let payload = serde_json::to_vec(notification)?;
    let mut report = PushReport::default();

    for row in store.push_subscriptions()? {
        let subscription = push::Subscription {
            endpoint: row.endpoint.clone(),
            p256dh: row.p256dh,
            auth: row.auth,
        };
        let outcome = push::deliver(&ctx.http, &key, &subscription, &payload, ttl_secs).await;
        match outcome {
            Ok(push::Outcome::Delivered) => {
                report.delivered += 1;
                store.mark_push_delivery(&row.endpoint, now_ms(), "")?;
            }
            Ok(push::Outcome::Gone) => {
                report.failed += 1;
                report.errors.push("a device's subscription expired and was removed".to_string());
                eprintln!("[push] a subscription is gone — forgetting the device");
                store.delete_push_subscription(&row.endpoint)?;
            }
            Ok(push::Outcome::Failed(reason)) => {
                report.failed += 1;
                eprintln!("[push] delivery failed: {reason}");
                store.mark_push_delivery(&row.endpoint, now_ms(), &reason)?;
                report.errors.push(reason);
            }
            Err(e) => {
                // A transport error (no network, TLS, a malformed stored key). Same
                // treatment: record it and move to the next device.
                let reason = e.to_string();
                report.failed += 1;
                eprintln!("[push] delivery failed: {reason}");
                store.mark_push_delivery(&row.endpoint, now_ms(), &reason)?;
                report.errors.push(reason);
            }
        }
    }
    Ok(report)
}

/// Notify the user's devices about one live message, if the policy says it deserves
/// it (see [`push_policy::notification_for`]).
///
/// Fire-and-forget: the trouter loop must never wait on the network, so the whole
/// delivery runs in its own task. Claiming the message in the store first is what
/// keeps the two send-capable backends that share this store from both pushing it.
fn push_live_message(
    ctx: &Ctx,
    store: &Store,
    message: &Message,
    is_channel: bool,
    from_me: bool,
    self_mri: &str,
) {
    if read_only() || !push_subscriptions_exist(store) {
        return;
    }
    let context = store.conversation_context(&message.conversation_id).unwrap_or_default();
    // A channel is gated on the user's own Teams notification setting for it, so the
    // placement carries that setting. An unreadable store answers with Teams'
    // default rather than with silence.
    let placement = if is_channel {
        let alerts = store
            .channel_alerts(&message.conversation_id)
            .unwrap_or(teams_lite::store::ChannelAlerts::MentionsOnly);
        push_policy::Placement::Channel { title: &context, alerts }
    } else {
        push_policy::Placement::Chat { title: &context }
    };
    let Some(notification) =
        push_policy::notification_for(message, &placement, self_mri, from_me, now_ms())
    else {
        return;
    };
    let dedupe_key = format!("{}/{}", message.conversation_id, message.id);
    match store.claim_once(&dedupe_key, now_ms()) {
        Ok(true) => {}
        // Another backend on this store already pushed it.
        Ok(false) => return,
        Err(e) => {
            eprintln!("[push] could not claim {dedupe_key}: {e}");
            return;
        }
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        match deliver_push(&ctx, &notification, push::MESSAGE_TTL_SECS).await {
            Ok(report) if report.failed > 0 => {
                eprintln!("[push] {} delivered, {} failed", report.delivered, report.failed);
            }
            Ok(_) => {}
            Err(e) => eprintln!("[push] delivery skipped: {e}"),
        }
    });
}

/// Whether any device is subscribed — checked before doing any policy work, so a
/// user who never turned notifications on pays one count per message.
fn push_subscriptions_exist(store: &Store) -> bool {
    store.count_push_subscriptions().map(|count| count > 0).unwrap_or(false)
}

// ---- the local agent (see src/agent.rs and src/agent_policy.rs) ---------------

/// How often the streamed reply is edited in place, at most. Slow enough that a long
/// answer costs tens of requests rather than thousands, fast enough that the thread
/// visibly fills in.
const AGENT_EDIT_INTERVAL: Duration = Duration::from_millis(1_200);

/// How many progress edits one reply may make. Past this the answer only lands once,
/// at the end: a pathological answer must not turn into a thousand PUTs.
const AGENT_MAX_EDITS: usize = 100;

/// Answer one live message with a local agent, if the policy says it asked for one.
///
/// Fire-and-forget, like [`push_live_message`]: the trouter loop must never wait on a
/// child process or the network, so the whole run happens in its own task.
///
/// Refuses in read-only mode before anything else. That mode exists so tooling can
/// drive the user's real store, and an agent that answers a message in their name is
/// the loudest possible thing for a screenshot script to do — the check is here, not
/// only at the dispatch gate, because this path never passes through the gate.
fn agent_live_message(ctx: &Ctx, store: &Store, message: &Message, from_me: bool) {
    if read_only() {
        return;
    }
    // The cheap test first: only OUR message can be a trigger, and the great majority
    // of live messages are not ours (see the module docs for why this is the rule that
    // keeps the feature from being remote code execution).
    if !from_me {
        return;
    }
    let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap_or_default();
    let mode = agent_policy::mode_for(&message.conversation_id, modes.as_deref());
    let Some(command) = agent_policy::command_for(message, from_me, mode, now_ms()) else {
        return;
    };
    if !agent::is_available(command.backend) {
        eprintln!(
            "[agent] `{}` is not installed on this machine — ignoring the trigger",
            command.backend.program
        );
        return;
    }
    // Claim the trigger in the store, so the two send-capable backends that share it
    // (the always-on service on 19420 and the user's dev one on 19421) cannot both
    // answer the same message. The same primitive the push path uses, with its own key
    // space.
    let claim = format!("agent/{}/{}", command.conversation_id, command.message_id);
    match store.claim_once(&claim, now_ms()) {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            eprintln!("[agent] could not claim {claim}: {e}");
            return;
        }
    }
    let request = match agent_request(store, &command) {
        Ok(request) => request,
        Err(e) => {
            eprintln!("[agent] could not prepare the run: {e}");
            return;
        }
    };
    let ctx = ctx.clone();
    tokio::spawn(async move {
        if let Err(e) = agent_reply(&ctx, &command, request).await {
            eprintln!("[agent] {} failed in {}: {e}", command.backend.name, command.conversation_id);
        }
    });
}

/// Assemble everything a run needs from the store: the thread as context, the tool
/// allowlist, the workspace, and the agent session this thread already has.
fn agent_request(store: &Store, command: &agent_policy::Command) -> Result<agent::Request> {
    let history = store
        .messages_before(&command.conversation_id, i64::MAX, 60)
        .unwrap_or_default();
    let transcript = agent_policy::transcript(&history, &command.message_id);
    let title = store.conversation_context(&command.conversation_id).unwrap_or_default();
    let workspace = store
        .get_setting(agent::SETTING_WORKSPACE)?
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(agent::default_workspace);
    Ok(agent::Request {
        backend: command.backend,
        prompt: agent_policy::prompt_with_context(&command.prompt, &transcript),
        system_prompt: agent_policy::system_prompt(command.backend, &title),
        resume_session: store
            .get_setting(&agent_session_key(&command.conversation_id, command.backend.name))?
            .filter(|session| !session.trim().is_empty()),
        workspace,
        tools: agent::tools_from_setting(store.get_setting(agent::SETTING_TOOLS)?.as_deref()),
    })
}

/// The setting key holding one thread's agent session, per backend — asking claude a
/// follow-up must not resume an opencode session.
fn agent_session_key(conversation_id: &str, backend: &str) -> String {
    format!("{}{backend}:{conversation_id}", agent::SETTING_SESSION_PREFIX)
}

/// Post the answer, then keep editing that one message as the answer grows.
///
/// The streamed edit is the whole point: everybody in the thread watches the reply
/// being written, rather than staring at nothing for two minutes. It is also the
/// reason the placeholder goes out FIRST — the message must exist before it can be
/// edited, and its id is what the send hands back (see [`teams_send::Sent`]).
async fn agent_reply(
    ctx: &Ctx,
    command: &agent_policy::Command,
    request: agent::Request,
) -> Result<()> {
    let backend = command.backend;
    let placeholder = agent_policy::thinking_html(backend);
    let sent = agent_send(ctx, command, &placeholder).await?;
    if sent.id.is_empty() {
        anyhow::bail!("the reply was posted but Teams returned no message id to edit");
    }
    // The reply is our own message, so it comes back on the trouter as a live message
    // from us — and if an answer ever opened with a prefix, it would summon the agent
    // again, forever. Claiming its id here means the trigger check finds it already
    // taken. One line, and the loop cannot happen.
    if let Ok(store) = ctx.store() {
        let claim = format!("agent/{}/{}", command.conversation_id, sent.id);
        if let Err(e) = store.claim_once(&claim, now_ms()) {
            eprintln!("[agent] could not claim our own reply {claim}: {e}");
        }
    }

    let (progress, mut watch_progress) = tokio::sync::watch::channel(String::new());
    // The sender is dropped the moment the run ends, which is what stops the edit
    // loop below. Without that explicit drop the two futures would wait on each
    // other: `tokio::join!` keeps both alive until both finish.
    let run = async move {
        let outcome = agent::run(&request, &progress).await;
        drop(progress);
        outcome
    };
    let stream = agent_stream_edits(ctx, command, &sent.id, &mut watch_progress);
    // Both at once: the child's output drives the watch channel, the edits drain it.
    let (outcome, edits) = tokio::join!(run, stream);
    if let Err(e) = edits {
        eprintln!("[agent] a progress edit failed (the answer still lands): {e}");
    }

    let (final_html, session_id, cost) = match &outcome {
        Ok(outcome) => (
            agent_policy::reply_html(backend, &outcome.text, true),
            outcome.session_id.clone(),
            outcome.cost_usd,
        ),
        Err(e) => (agent_policy::failure_html(backend, &e.to_string()), None, None),
    };
    agent_edit(ctx, command, &sent.id, &final_html).await?;

    // Remember the session so a follow-up in this thread continues the conversation.
    if let (Some(session), Ok(store)) = (session_id, ctx.store()) {
        let key = agent_session_key(&command.conversation_id, backend.name);
        if let Err(e) = store.set_setting(&key, &session) {
            eprintln!("[agent] could not remember the session for {key}: {e}");
        }
    }
    match &outcome {
        Ok(outcome) => eprintln!(
            "[agent] {} answered in {} ({} chars{})",
            backend.name,
            command.conversation_id,
            outcome.text.chars().count(),
            cost.map(|c| format!(", ${c:.2}")).unwrap_or_default()
        ),
        Err(e) => eprintln!("[agent] {} could not answer: {e}", backend.name),
    }
    outcome.map(|_| ())
}

/// Edit the reply in place whenever the answer changed, at most every
/// [`AGENT_EDIT_INTERVAL`] and at most [`AGENT_MAX_EDITS`] times.
///
/// Returns when the runner drops its end of the channel, i.e. when the run is over.
/// The final text is NOT posted here — [`agent_reply`] does that once, from the
/// authoritative outcome — so a missed last tick costs nothing.
async fn agent_stream_edits(
    ctx: &Ctx,
    command: &agent_policy::Command,
    message_id: &str,
    progress: &mut tokio::sync::watch::Receiver<String>,
) -> Result<()> {
    let mut edits = 0;
    let mut posted = String::new();
    while progress.changed().await.is_ok() {
        if edits >= AGENT_MAX_EDITS {
            return Ok(());
        }
        let text = progress.borrow_and_update().clone();
        if text.trim().is_empty() || text == posted {
            continue;
        }
        let html = agent_policy::reply_html(command.backend, &text, false);
        agent_edit(ctx, command, message_id, &html).await?;
        posted = text;
        edits += 1;
        // Rate limit AFTER the edit, so the first piece of the answer appears as soon
        // as it exists and the interval spaces out what follows.
        tokio::time::sleep(AGENT_EDIT_INTERVAL).await;
    }
    Ok(())
}

/// Post the agent's message as a native Teams reply to the message that summoned it.
///
/// In a CHANNEL that quote is all the link there is: the send path does not carry a
/// `rootMessageId` yet, so the answer opens its own thread rather than landing inside
/// the user's. Nothing here needs to change when it does — the reply markup is already
/// what a chat uses, and a channel would simply gain the parent id alongside it.
async fn agent_send(
    ctx: &Ctx,
    command: &agent_policy::Command,
    html: &str,
) -> Result<teams_send::Sent> {
    let reply_to = teams_send::ReplyTo {
        sender: command.sender.clone(),
        sender_mri: command.sender_mri.clone(),
        compose_time: command.compose_time,
        preview: agent_policy::preview_of(&command.prompt),
        before: String::new(),
        after: String::new(),
    };
    let http = ctx.http.clone();
    let tokens = ctx.tokens.clone();
    let conversation = command.conversation_id.clone();
    let html = html.to_string();
    ctx.retry_on_auth(move |session, _csa| {
        let http = http.clone();
        let tokens = tokens.clone();
        let conversation = conversation.clone();
        let html = html.clone();
        let reply_to = reply_to.clone();
        async move {
            let ic3 = tokens.get(IC3_SCOPE).await?;
            teams_send::send_message(
                &http,
                &session,
                &ic3,
                &conversation,
                "",
                Some(&reply_to),
                Some(&html),
                None,
            )
            .await
        }
    })
    .await
}

/// Replace the reply's content with the answer as it stands.
async fn agent_edit(
    ctx: &Ctx,
    command: &agent_policy::Command,
    message_id: &str,
    html: &str,
) -> Result<()> {
    let http = ctx.http.clone();
    let conversation = command.conversation_id.clone();
    let message_id = message_id.to_string();
    let html = html.to_string();
    ctx.retry_on_auth(move |session, _csa| {
        let http = http.clone();
        let conversation = conversation.clone();
        let message_id = message_id.clone();
        let html = html.clone();
        async move {
            teams_send::edit_message(&http, &session, &conversation, &message_id, "", Some(&html))
                .await
        }
    })
    .await
}

/// What `agent_status` reports: which backends this machine can run, which
/// conversations are opted in, and what an agent is allowed to do.
fn agent_status_json(store: &Store) -> Result<Value> {
    let modes = store.get_setting(agent_policy::SETTING_MODES)?;
    let backends: Vec<Value> = agent_policy::BACKENDS
        .iter()
        .map(|backend| {
            json!({
                "name": backend.name,
                "prefix": backend.prefix,
                "available": agent::is_available(backend),
            })
        })
        .collect();
    let conversations: Vec<Value> = agent_policy::configured_modes(modes.as_deref())
        .into_iter()
        .map(|(id, mode)| json!({ "conversation": id, "mode": mode.as_str() }))
        .collect();
    let workspace = store
        .get_setting(agent::SETTING_WORKSPACE)?
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| agent::default_workspace().display().to_string());
    Ok(json!({
        "backends": backends,
        "conversations": conversations,
        "tools": agent::tools_from_setting(store.get_setting(agent::SETTING_TOOLS)?.as_deref()),
        "workspace": workspace,
        // A read-only backend never answers, so a UI can say so rather than offering a
        // switch that would do nothing.
        "enabled": !read_only(),
        "sandbox_conversation": agent_policy::SANDBOX_THREAD,
    }))
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
    let (rr_tx, mut rr_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::ReadReceiptEvent>();
    let (call_tx, mut call_rx) =
        tokio::sync::mpsc::unbounded_channel::<trouter_events::CallFrame>();
    let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<trouter::Status>();

    // consume trouter messages: persist + broadcast. self identity is stable
    // across token refreshes, so capturing it once at boot is fine.
    let ctx_msgs = ctx.clone();
    let self_name = session.self_name.to_string();
    let self_mri = session.self_mri.to_string();
    let mut msgs_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(msgs) = ev_rx.recv().await {
            if let Some(store) = msgs_store.get() {
                let mut activity_changed = false;
                let mut channels_changed = false;
                for m in &msgs {
                    // Incoming-call awareness: a live `Event/Call` frame in a real
                    // conversation rings (or dismisses) an incoming-call banner.
                    // Ephemeral, like `typing` — the frame is still persisted +
                    // broadcast as a `message` below. Never fires for an activity
                    // stream (not a chat).
                    if !teams_activity::is_system_feed_thread(&m.conversation_id) {
                        if let Some(call) = call_event_json(m, &self_name, &self_mri) {
                            ctx_msgs.emit("call", call);
                        }
                    }
                    // An activity stream (Activity / Mentions / Following) is not
                    // a chat: never persist it as a conversation. Signal the UI to
                    // refresh the notifications panel instead — the full payload is
                    // re-fetched via the `notifications` method (the live frame's
                    // chat `content` is always empty; the payload lives in
                    // properties.activity).
                    if teams_activity::is_system_feed_thread(&m.conversation_id) {
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
                    let from_me = is_self(m, &self_name, &self_mri);
                    if is_channel {
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
                        // Reach the devices no socket reaches: a phone whose Home
                        // Screen app is closed learns about this message only through
                        // Web Push. Only on a FRESH insert — a reaction arriving on an
                        // old message is not news worth a lock screen.
                        if inserted {
                            push_live_message(
                                &ctx_msgs, store, &row, is_channel, from_me, &self_mri,
                            );
                            // …and answer it, when the user summoned a local agent
                            // with it. Same place for the same reason: a fresh insert
                            // is the one event that means "this message is new".
                            agent_live_message(&ctx_msgs, store, &row, from_me);
                        }
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
    let mut typing_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(t) = ty_rx.recv().await {
            if t.sender_mri == self_mri_ty {
                continue; // don't show ourselves typing
            }
            if teams_activity::is_system_feed_thread(&t.conversation_id) {
                continue; // an activity stream is not a chat
            }
            let sender = typing_store
                .get()
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

    // trouter read-receipt updates -> `read_receipt` event. Ephemeral, like
    // typing: resolve the reader MRI to a display name from what the store
    // already holds (no network), drop our own echo (we never show our own read
    // state), and never touch the activity-feed thread. The UI merges each update
    // into the open conversation's "seen by" avatars.
    let ctx_rr = ctx.clone();
    let self_mri_rr = session.self_mri.to_string();
    let mut receipts_store = ctx.task_store();
    tokio::spawn(async move {
        while let Some(r) = rr_rx.recv().await {
            if teams_lite::store::same_user(&r.member_mri, &self_mri_rr) {
                continue; // never surface our own read position
            }
            if teams_activity::is_system_feed_thread(&r.conversation_id) {
                continue; // an activity stream is not a chat
            }
            let member = receipts_store
                .get()
                .and_then(|s| s.display_name_for_mri(&r.member_mri).ok().flatten())
                .unwrap_or_default();
            ctx_rr.emit(
                "read_receipt",
                json!({
                    "conversation_id": r.conversation_id,
                    "member_mri": r.member_mri,
                    "member": member,
                    "last_read_message_id": r.last_read_message_id,
                    "read_time_ms": r.read_time_ms,
                }),
            );
        }
    });

    // trouter native-calling frames -> `call_signal` event (experimental, opt-in
    // via TEAMS_LITE_CALLING=1). The native call wire schema is only partially
    // reverse-engineered, so we forward the whole decoded envelope to the UI and —
    // behind TEAMS_LITE_CALL_DEBUG=1 — log it, so a live call to a consenting
    // party pins down the exact shape. Distinct from the `call` awareness event,
    // which rides on the after-the-fact `Event/Call` chat system message.
    let ctx_call = ctx.clone();
    tokio::spawn(async move {
        let debug = std::env::var("TEAMS_LITE_CALL_DEBUG").as_deref() == Ok("1");
        // Durable capture: when TEAMS_LITE_CALL_CAPTURE names a file, append every
        // decoded call frame as one JSON line (JSONL). Opened once in append mode so
        // frames from several calls accumulate and survive a terminal scrollback wipe
        // — a single real test call is then never lost. The records carry live tokens,
        // identities, and SDP, so this must point inside the gitignored captures/ dir
        // and must never be committed.
        let mut capture_file = std::env::var("TEAMS_LITE_CALL_CAPTURE")
            .ok()
            .filter(|p| !p.is_empty())
            .and_then(|path| {
                match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                    Ok(f) => {
                        eprintln!("[call_signal] capturing decoded frames to {path}");
                        Some(f)
                    }
                    Err(e) => {
                        eprintln!("[call_signal] cannot open capture file {path}: {e}");
                        None
                    }
                }
            });
        while let Some(c) = call_rx.recv().await {
            if debug {
                eprintln!(
                    "[call_signal] {} id={}\n{}",
                    c.url,
                    c.call_id,
                    serde_json::to_string_pretty(&c.body).unwrap_or_default()
                );
            }
            if let Some(f) = capture_file.as_mut() {
                use std::io::Write;
                let ts_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if let Err(e) = f.write_all(call_capture_line(ts_ms, &c.url, &c.call_id, &c.body).as_bytes()) {
                    eprintln!("[call_signal] capture write failed: {e}");
                }
            }
            ctx_call.emit(
                "call_signal",
                json!({ "url": c.url, "call_id": c.call_id, "body": c.body }),
            );
        }
    });

    tokio::spawn(async move {
        trouter::run(ctx, epid, ev_tx, ty_tx, rr_tx, call_tx, st_tx).await;
    });
}

/// Format one decoded call frame as a single JSON-lines (JSONL) capture record:
/// `{ts_ms, url, call_id, body}` followed by a newline. Pure (no I/O) so it can be
/// unit-tested; the actual append lives in the call_signal task above, guarded by
/// TEAMS_LITE_CALL_CAPTURE. One self-describing object per line keeps a multi-call
/// capture easy to replay while we reverse-engineer the native call schema.
fn call_capture_line(ts_ms: u64, url: &str, call_id: &str, body: &Value) -> String {
    let mut line = serde_json::to_string(
        &json!({ "ts_ms": ts_ms, "url": url, "call_id": call_id, "body": body }),
    )
    .unwrap_or_default();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the write lock ----------------------------------------------------
    // Reads stay open (the point: tooling may inspect real data); writes need the
    // capability token, so a client that merely found the socket cannot post.

    #[test]
    fn reads_never_need_the_write_token() {
        for method in [
            "conversations",
            "open",
            "backfill",
            "read_receipts",
            "set_draft",
            // The read-only Graph surfaces: the write lock gates Teams, and neither
            // of these can act on the mailbox or the calendar at all.
            "mail_folders",
            "mail_list",
            "calendars",
            "calendar_view",
        ] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok(), "{method}");
            assert!(check_write_allowed(method, &json!({}), None).is_ok(), "{method}");
        }
    }

    #[test]
    fn outward_methods_are_refused_without_the_token() {
        for method in OUTWARD_METHODS {
            let err = check_write_allowed(method, &json!({ "conversation": "c1" }), Some("tok"))
                .expect_err("must refuse a tokenless write");
            assert!(err.contains("write token"), "{err}");
        }
    }

    #[test]
    fn outward_methods_are_refused_with_a_wrong_token() {
        let params = json!({ "conversation": "c1", "write_token": "not-the-token" });
        assert!(check_write_allowed("send", &params, Some("tok")).is_err());
    }

    #[test]
    fn outward_methods_pass_with_the_published_token() {
        let params = json!({ "conversation": "c1", "write_token": "tok" });
        for method in OUTWARD_METHODS {
            assert!(check_write_allowed(method, &params, Some("tok")).is_ok(), "{method}");
        }
    }

    // ---- the machine methods -----------------------------------------------
    // `repair_broker` restarts the user's Intune container. It posts nothing to
    // Teams, so it is not outward — but a client that merely found this socket must
    // not be able to take the identity broker down either.

    #[test]
    fn repair_broker_is_gated_but_is_not_outward_facing() {
        // The distinction is load-bearing: OUTWARD_METHODS means "posts as the user",
        // and AGENTS.md tells every later reader that a new entry there is a Teams,
        // mail or calendar write gaining a consent gate.
        assert!(!OUTWARD_METHODS.contains(&"repair_broker"));
        assert_eq!(write_class("repair_broker"), Some(WriteClass::Machine));
        assert_eq!(write_class("send"), Some(WriteClass::Outward));
        assert_eq!(write_class("conversations"), None);
    }

    #[test]
    fn repair_broker_is_refused_without_the_token() {
        let err = check_write_allowed("repair_broker", &json!({}), Some("tok"))
            .expect_err("must refuse a tokenless repair");
        assert!(err.contains("write token"), "{err}");
        // The refusal has to say what it is about; the outward text would be wrong.
        assert!(err.contains("Intune container"), "{err}");
    }

    #[test]
    fn repair_broker_is_refused_with_a_wrong_token() {
        let params = json!({ "write_token": "not-the-token" });
        assert!(check_write_allowed("repair_broker", &params, Some("tok")).is_err());
    }

    #[test]
    fn the_push_methods_are_gated_but_are_not_outward_facing() {
        // Subscribing decides which devices this machine notifies. It posts nothing
        // to Teams, so it is not outward — but a client that merely found this
        // socket must not be able to aim the user's message previews anywhere.
        for method in ["push_subscribe", "push_unsubscribe", "push_test"] {
            assert!(!OUTWARD_METHODS.contains(&method), "{method}");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("must refuse a tokenless push change");
            assert!(err.contains("write token"), "{err}");
            // The refusal has to say what it is about; the container text would be
            // wrong, and a refusal nobody believes is a refusal nobody reads.
            assert!(err.contains("push notifications"), "{err}");
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok());
        }
        // Reading the status is open, like every other read.
        assert_eq!(write_class("push_status"), None);
    }

    #[test]
    fn storing_the_integration_credentials_is_gated_but_is_not_outward_facing() {
        // Writing the settings can move the GitLab host the stored token is pinned
        // to, which would send that token somewhere the user never configured. It
        // posts nothing to Teams, so it is gated as a machine change, not as an
        // outward action.
        assert!(!OUTWARD_METHODS.contains(&"set_settings"));
        assert_eq!(write_class("set_settings"), Some(WriteClass::Machine));
        let err = check_write_allowed("set_settings", &json!({}), Some("tok"))
            .expect_err("must refuse a tokenless settings write");
        assert!(err.contains("write token"), "{err}");
        assert!(err.contains("integration credentials"), "{err}");
        assert!(
            check_write_allowed("set_settings", &json!({ "write_token": "tok" }), Some("tok"))
                .is_ok()
        );
        // Reading them back stays open: the view carries no token, only whether one
        // is set, and the UI needs it before the user has done anything.
        assert_eq!(write_class("get_settings"), None);
        // Enriching a link is a read as well — it is how every preview card loads.
        assert_eq!(write_class("enrich_link"), None);
    }

    #[test]
    fn the_settings_view_reports_each_token_without_revealing_it() {
        let store = Store::open_in_memory().unwrap();

        // Untouched: the GitLab default host, and neither integration configured.
        let fresh = settings_json(&store).unwrap();
        assert_eq!(fresh["gitlab_host"], gitlab::DEFAULT_HOST);
        assert_eq!(fresh["gitlab_token_set"], false);
        assert_eq!(fresh["linear_token_set"], false);

        store.set_setting(SETTING_LINEAR_TOKEN, "lin_api_secret").unwrap();
        store.set_setting(SETTING_GITLAB_HOST, "gitlab.example.com").unwrap();
        let configured = settings_json(&store).unwrap();
        assert_eq!(configured["gitlab_host"], "gitlab.example.com");
        assert_eq!(configured["linear_token_set"], true);
        // One integration's token says nothing about the other's.
        assert_eq!(configured["gitlab_token_set"], false);
        // THE point of the non-secret view: no raw token is anywhere in it.
        assert!(
            !configured.to_string().contains("lin_api_secret"),
            "the settings view must never carry a raw token: {configured}"
        );
    }

    #[test]
    fn an_emptied_token_reads_back_as_unset() {
        // How the UI clears a token: it sends "", which must not count as a stored
        // one — otherwise the pane would keep offering "Remove token" forever.
        let store = Store::open_in_memory().unwrap();
        store.set_setting(SETTING_LINEAR_TOKEN, "lin_api_secret").unwrap();
        store.set_setting(SETTING_LINEAR_TOKEN, "").unwrap();
        assert_eq!(settings_json(&store).unwrap()["linear_token_set"], false);
        assert_eq!(link_preview_settings(&store).unwrap().linear_token, None);
    }

    #[test]
    fn the_agent_methods_are_gated_but_are_not_outward_facing() {
        // Neither one posts, so neither is outward — but `agent_set_mode` decides
        // which conversations this machine will later answer in the user's name, and
        // `agent_set_tools` decides what a chat message may make a local agent do.
        for (method, phrase) in
            [("agent_set_mode", "in the user's name"), ("agent_set_tools", "local agent")]
        {
            assert!(!OUTWARD_METHODS.contains(&method), "{method}");
            assert_eq!(write_class(method), Some(WriteClass::Machine), "{method}");
            let err = check_write_allowed(method, &json!({}), Some("tok"))
                .expect_err("must refuse a tokenless agent change");
            assert!(err.contains("write token"), "{err}");
            assert!(err.contains(phrase), "{method}: {err}");
            assert!(check_write_allowed(method, &json!({ "write_token": "tok" }), Some("tok")).is_ok());
        }
        // Reading the status is open, like every other read.
        assert_eq!(write_class("agent_status"), None);
    }

    #[test]
    fn a_read_only_backend_refuses_to_arm_the_agent() {
        // The reply path checks `read_only()` on its own (an agent answering in the
        // user's name is the loudest thing a screenshot script could do), and the
        // gate refuses the switch that would arm it in the first place.
        for method in ["agent_set_mode", "agent_set_tools"] {
            let err = check_write_allowed(method, &json!({ "write_token": "tok" }), None)
                .expect_err("read-only must refuse");
            assert!(err.contains("read-only"), "{err}");
        }
    }

    #[test]
    fn the_child_never_inherits_the_write_token() {
        // `src/agent.rs` removes this variable from the agent's environment: an agent
        // holding it could post to any chat directly, around every consent gate here.
        // It cannot import the constant (this is a binary, not a library), so the two
        // spellings are pinned to each other.
        assert_eq!(WRITE_TOKEN_ENV, "TEAMS_LITE_WRITE_TOKEN");
        let source = include_str!("../agent.rs");
        assert!(
            source.contains(&format!("const WRITE_TOKEN_ENV: &str = \"{WRITE_TOKEN_ENV}\"")),
            "src/agent.rs must remove {WRITE_TOKEN_ENV} from the child's environment"
        );
        assert!(source.contains("env_remove(WRITE_TOKEN_ENV)"));
    }

    #[test]
    fn the_agent_status_lists_the_backends_and_only_the_sandbox_is_armed() {
        let store = Store::open_in_memory().unwrap();
        let status = agent_status_json(&store).unwrap();
        let names: Vec<&str> =
            status["backends"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["claude", "opencode"]);
        // Out of the box: one conversation, the pre-authorized one.
        let conversations = status["conversations"].as_array().unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0]["conversation"], agent_policy::SANDBOX_THREAD);
        assert_eq!(conversations[0]["mode"], "reply");
        // And a read-only default for what an agent may do.
        assert_eq!(status["tools"], json!(["Read", "Glob", "Grep"]));
    }

    #[test]
    fn arming_a_conversation_keeps_the_others() {
        let store = Store::open_in_memory().unwrap();
        for (conversation, mode) in
            [("19:team@thread.v2", agent_policy::Mode::Reply), (agent_policy::SANDBOX_THREAD, agent_policy::Mode::Off)]
        {
            let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap();
            store
                .set_setting(
                    agent_policy::SETTING_MODES,
                    &agent_policy::with_mode(modes.as_deref(), conversation, mode),
                )
                .unwrap();
        }
        let modes = store.get_setting(agent_policy::SETTING_MODES).unwrap();
        assert_eq!(agent_policy::mode_for("19:team@thread.v2", modes.as_deref()), agent_policy::Mode::Reply);
        // Turning the sandbox off is the user's call too, and it sticks.
        assert_eq!(agent_policy::mode_for(agent_policy::SANDBOX_THREAD, modes.as_deref()), agent_policy::Mode::Off);
    }

    #[test]
    fn one_agent_session_is_kept_per_thread_and_per_backend() {
        // Asking claude a follow-up must not resume an opencode session.
        let claude = agent_session_key("19:team@thread.v2", "claude");
        let opencode = agent_session_key("19:team@thread.v2", "opencode");
        assert_ne!(claude, opencode);
        assert!(claude.starts_with(agent::SETTING_SESSION_PREFIX));
    }

    #[test]
    fn push_status_generates_one_stable_key_and_lists_the_devices() {
        let store = Store::open_in_memory().unwrap();

        let first = push_status_json(&store).unwrap();
        assert_eq!(first["supported"], true);
        let key = first["public_key"].as_str().unwrap().to_string();
        // The browser only accepts the 65-byte uncompressed P-256 point.
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&key).unwrap().len(),
            65
        );
        assert_eq!(first["devices"].as_array().unwrap().len(), 0);

        // Stable across calls, and across a reopen of the same store: a device's
        // subscription embeds this key, so a second answer with a different one
        // would silently retire every phone that opted in.
        assert_eq!(push_status_json(&store).unwrap()["public_key"], key);
        assert_eq!(
            store.get_setting(SETTING_PUSH_VAPID_PRIVATE).unwrap().is_some(),
            true,
            "the private half must be persisted, not regenerated per process"
        );

        store
            .put_push_subscription("https://web.push.apple.com/abc", "k", "a", "iPhone", 42)
            .unwrap();
        let listed = push_status_json(&store).unwrap();
        assert_eq!(listed["public_key"], key);
        let devices = listed["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["label"], "iPhone");
        // The keys a push is encrypted to are the DEVICE's secrets; the status is
        // read by any local client, so they must not be in it.
        assert!(devices[0].get("p256dh").is_none(), "{:?}", devices[0]);
        assert!(devices[0].get("auth").is_none(), "{:?}", devices[0]);
    }

    #[test]
    fn every_machine_method_says_what_it_does_to_the_machine() {
        // The refusal text is per method (see `machine_effect`), so a new entry in
        // MACHINE_METHODS that forgets its own phrase is caught here rather than by
        // a user reading a refusal about the wrong subject.
        for method in MACHINE_METHODS {
            assert_ne!(machine_effect(method), "changes this machine", "{method} has no phrase");
        }
    }

    #[test]
    fn repair_broker_passes_with_the_published_token() {
        let params = json!({ "write_token": "tok" });
        assert!(check_write_allowed("repair_broker", &params, Some("tok")).is_ok());
    }

    #[test]
    fn read_only_mode_refuses_repair_broker_even_with_a_correct_token() {
        // Tooling never repairs the user's sign-in: restarting their container drops
        // the broker, and every session that depends on it, for about a minute.
        let params = json!({ "write_token": "tok" });
        let err = check_write_allowed("repair_broker", &params, None)
            .expect_err("read-only must refuse a repair");
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn read_only_mode_refuses_even_a_correct_token() {
        let params = json!({ "conversation": "c1", "write_token": "tok" });
        let err = check_write_allowed("send", &params, None).expect_err("read-only must refuse");
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn read_only_listens_on_its_own_port_so_it_never_takes_the_real_one() {
        assert_eq!(resolve_port(None, false), DEFAULT_PORT);
        assert_eq!(resolve_port(None, true), READ_ONLY_PORT);
        assert_ne!(READ_ONLY_PORT, DEFAULT_PORT);
    }

    #[test]
    fn an_explicit_port_wins_over_both_defaults() {
        assert_eq!(resolve_port(Some("8500"), true), 8500);
        assert_eq!(resolve_port(Some(" 8500 "), false), 8500);
        // Junk falls back to the mode's default rather than panicking.
        assert_eq!(resolve_port(Some("nope"), false), DEFAULT_PORT);
        assert_eq!(resolve_port(Some("0"), true), READ_ONLY_PORT);
    }

    #[test]
    fn minted_tokens_are_long_and_unique() {
        let (a, b) = (mint_write_token(), mint_write_token());
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The write lock covers the LOCAL store too: a read-only backend is the one
    /// tooling may start against the user's real database, while the user's own
    /// backend is live on it, so it must not run the row-rewriting cleanups.
    #[test]
    fn read_only_prepare_store_never_rewrites_message_rows() {
        let mut path = std::env::temp_dir();
        path.push(format!("teams-lite-prepare-{}.sqlite", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = path.to_str().unwrap();

        // A stored control frame: exactly what the cleanups delete.
        {
            let store = Store::open(db).unwrap();
            store.upsert_conversation("c1", "Chat", 1).unwrap();
            let mut junk = message(1);
            junk.content = "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:x".into();
            store.insert_message(&junk).unwrap();
        }

        prepare_store(db, false).unwrap();
        {
            let store = Store::open(db).unwrap();
            assert_eq!(
                store.newest_messages("c1", 10).unwrap().len(),
                1,
                "read-only mode must leave the user's rows exactly as they are"
            );
            assert!(
                store.cleanups_pending().unwrap(),
                "...and must not claim the cleanup revision, so the user's own backend still heals"
            );
        }

        // The user's own (write-capable) backend does run them.
        prepare_store(db, true).unwrap();
        {
            let store = Store::open(db).unwrap();
            assert!(store.newest_messages("c1", 10).unwrap().is_empty());
            assert!(!store.cleanups_pending().unwrap());
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

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
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }
    }

    #[test]
    fn call_capture_line_is_one_self_describing_json_object_per_line() {
        let body = json!({ "evt": "callInvite", "callId": "abc", "from": { "displayName": "Riley" } });
        let line = call_capture_line(1234, "https://x.trouter/NGCallManagerWin", "abc", &body);

        // Exactly one line, newline-terminated (so several frames append cleanly).
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);

        // Round-trips to the {ts_ms, url, call_id, body} envelope with body intact.
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["ts_ms"], 1234);
        assert_eq!(parsed["url"], "https://x.trouter/NGCallManagerWin");
        assert_eq!(parsed["call_id"], "abc");
        assert_eq!(parsed["body"]["from"]["displayName"], "Riley");
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
    fn mentions_ride_the_wire_as_a_decoded_list() {
        let mut m = message(1);
        m.mentions =
            r#"[{"itemid":0,"mri":"8:orgid:leonor","kind":"person","display_name":"Leonor"}]"#.into();
        let v = message_json(&m, "Alice", "8:me");
        assert_eq!(v["mentions"][0]["itemid"], 0);
        assert_eq!(v["mentions"][0]["mri"], "8:orgid:leonor");
        assert_eq!(v["mentions"][0]["kind"], "person");

        // A message with none, and a row whose value is unusable, both serialize
        // as an empty list — never as a string, and never as an error.
        assert_eq!(message_json(&message(2), "Alice", "8:me")["mentions"], json!([]));
        let mut broken = message(3);
        broken.mentions = "{not json".into();
        assert_eq!(message_json(&broken, "Alice", "8:me")["mentions"], json!([]));
    }

    #[test]
    fn the_message_type_rides_the_wire() {
        // The front-end needs the Teams type verbatim to know a `Text` body is plain
        // text and must be escaped, not parsed as HTML.
        let mut m = message(1);
        m.message_type = "Text".into();
        m.content = "pour moi c'est <yyyy>-<id>".into();
        let v = message_json(&m, "Alice", "8:me");
        assert_eq!(v["message_type"], "Text");
        assert_eq!(v["content"], "pour moi c'est <yyyy>-<id>", "the body is not rewritten");

        // A legacy row carries an empty type — "unknown", not a guess.
        assert_eq!(message_json(&message(2), "Alice", "8:me")["message_type"], "");
    }

    #[test]
    fn presence_params_accept_one_or_many_and_refuse_the_rest() {
        // A single mri, or a batch.
        assert_eq!(
            presence_mris(&json!({ "mri": "8:orgid:aaa" })).unwrap(),
            vec!["8:orgid:aaa".to_string()]
        );
        assert_eq!(
            presence_mris(&json!({ "mris": ["8:orgid:aaa", "8:orgid:bbb"] })).unwrap().len(),
            2
        );
        // A thread/channel mri is not a person: refused before it reaches the
        // presence service, as is an empty or over-large batch.
        assert!(presence_mris(&json!({ "mri": "19:abc@thread.tacv2" })).is_err());
        assert!(presence_mris(&json!({ "mris": [] })).is_err());
        assert!(presence_mris(&json!({})).is_err());
        let too_many: Vec<String> = (0..teams_presence::MAX_BATCH + 1)
            .map(|i| format!("8:orgid:{i}"))
            .collect();
        assert!(presence_mris(&json!({ "mris": too_many })).is_err());
    }

    #[test]
    fn profile_and_presence_serialize_every_card_field() {
        let p = teams_profiles::Profile {
            mri: "8:orgid:aaa".into(),
            display_name: "Ada LOVELACE".into(),
            job_title: "Analyst".into(),
            email: "ada@example.com".into(),
            office_location: "London".into(),
            ..Default::default()
        };
        let v = profile_json(&p);
        assert_eq!(v["found"], true);
        assert_eq!(v["display_name"], "Ada LOVELACE");
        assert_eq!(v["job_title"], "Analyst");
        assert_eq!(v["email"], "ada@example.com");
        assert_eq!(v["office_location"], "London");
        // Unreported fields are present but empty, so the UI can just skip them.
        assert_eq!(v["department"], "");

        let pres = teams_presence::Presence {
            mri: "8:orgid:aaa".into(),
            availability: "Busy".into(),
            activity: "InAMeeting".into(),
            last_active_ms: 1_700_000_000_000,
            out_of_office: true,
            out_of_office_note: "Back Monday".into(),
            note: "Heads down".into(),
        };
        let v = presence_json(&pres);
        assert_eq!(v["availability"], "Busy");
        assert_eq!(v["activity"], "InAMeeting");
        assert_eq!(v["last_active_ms"], 1_700_000_000_000i64);
        assert_eq!(v["out_of_office"], true);
        assert_eq!(v["out_of_office_note"], "Back Monday");
        assert_eq!(v["note"], "Heads down");
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

    fn call_message(event: &str) -> Message {
        let mut m = message(2);
        m.sender = "Bob".into();
        m.sender_mri = "8:orgid:bob".into();
        m.content = String::new();
        m.system_event = format!(
            r#"{{"kind":"call","event":"{event}","duration_seconds":0,"participant_count":2,"participants":["Bob","Alice"]}}"#
        );
        m
    }

    #[test]
    fn call_started_from_other_rings() {
        let m = call_message("started");
        let v = call_event_json(&m, "Alice", "8:orgid:me").expect("a started call rings");
        assert_eq!(v["event"], "started");
        assert_eq!(v["conversation_id"], "c1");
        assert_eq!(v["caller"], "Bob");
        assert_eq!(v["caller_mri"], "8:orgid:bob");
        assert_eq!(v["participant_count"], 2);
        assert_eq!(v["participants"][0], "Bob");
    }

    #[test]
    fn call_started_from_self_is_not_rung() {
        // We started the call, so the `started` frame carries us as the sender:
        // teams-lite must not ring us for our own outgoing call.
        let mut m = call_message("started");
        m.sender_mri = "8:orgid:me".into();
        assert!(call_event_json(&m, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn meeting_call_marker_does_not_ring() {
        // A meeting-thread call marker is surfaced as a "Call started" line, but it
        // must never raise the incoming-call banner: it has no caller identity and
        // can arrive in backfill. Even from another member it is silent.
        let mut m = call_message("started");
        m.system_event =
            r#"{"kind":"call","event":"started","duration_seconds":0,"participant_count":0,"participants":[],"meeting":true}"#
                .into();
        assert!(call_event_json(&m, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn call_ended_dismisses_even_from_self() {
        // Dismissal is keyed by conversation, so an `ended`/`missed` frame is
        // surfaced regardless of who ended it (it only clears a banner).
        let mut m = call_message("ended");
        m.sender_mri = "8:orgid:me".into();
        let v = call_event_json(&m, "Alice", "8:orgid:me").expect("ended clears the banner");
        assert_eq!(v["event"], "ended");

        let missed = call_message("missed");
        assert_eq!(
            call_event_json(&missed, "Alice", "8:orgid:me").unwrap()["event"],
            "missed"
        );
    }

    #[test]
    fn non_call_messages_yield_no_call_event() {
        // A plain chat message (empty system_event) is not a call.
        assert!(call_event_json(&message(1), "Alice", "8:orgid:me").is_none());

        // A non-call system event (e.g. a member change) is not a call either.
        let mut other = message(3);
        other.system_event = r#"{"kind":"member_added","members":["X"]}"#.into();
        assert!(call_event_json(&other, "Alice", "8:orgid:me").is_none());
    }

    #[test]
    fn channels_json_carries_team_grouping_and_read_state() {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_channel_full(&teams_lite::store::ChannelUpdate {
                id: "19:general@thread.tacv2",
                team_id: "19:team@thread.tacv2",
                team_name: "Engineering",
                team_group_id: "00000000-1111-2222-3333-444444444444",
                display_name: "General",
                is_general: true,
                is_favorite: false,
                last_message_time: 1_700_000_000_000,
                last_message_preview: "Ship it",
                last_message_sender: "Alice",
                last_message_from_me: false,
                is_read: false,
                alerts: teams_lite::store::ChannelAlerts::MentionsOnly,
                team_pos: 0,
                channel_pos: 0,
            })
            .unwrap();

        let v = channels_json(&store.channels().unwrap());
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let c = &arr[0];
        assert_eq!(c["id"], "19:general@thread.tacv2");
        assert_eq!(c["team_id"], "19:team@thread.tacv2");
        assert_eq!(c["team_name"], "Engineering");
        assert_eq!(c["team_group_id"], "00000000-1111-2222-3333-444444444444");
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

    // ---- mail (read-only Outlook surface) ----------------------------------

    /// No mail method may ever join the write lock's list — not because mail writes
    /// are gated, but because none exists. If someone adds one, this test is where
    /// they have to come and think about it (and about consent) first.
    #[test]
    fn no_mail_method_is_outward_facing() {
        for method in OUTWARD_METHODS {
            assert!(
                !method.starts_with("mail"),
                "`{method}` suggests the mail surface can act outward. It cannot: the backend \
                 has no send/reply/delete/move path at all (see src/mail.rs). Adding one is a \
                 deliberate feature needing its own consent gate."
            );
        }
        // And every mail method reads, so none of them needs the token.
        for method in [
            "mail_folders",
            "mail_list",
            "mail_backfill",
            "mail_body",
            "mail_attachment",
        ] {
            assert!(check_write_allowed(method, &json!({}), Some("tok")).is_ok(), "{method}");
            assert!(check_write_allowed(method, &json!({}), None).is_ok(), "{method}");
        }
    }

    #[test]
    fn page_limit_is_bounded_and_defaults() {
        assert_eq!(page_limit(&json!({}), 40), 40);
        assert_eq!(page_limit(&json!({ "limit": 10 }), 40), 10);
        // A client cannot ask the server (and thus Graph) for an unbounded page.
        assert_eq!(page_limit(&json!({ "limit": 100_000 }), 40), 100);
        assert_eq!(page_limit(&json!({ "limit": 0 }), 40), 1);
        // A nonsensical value falls back to the default rather than erroring.
        assert_eq!(page_limit(&json!({ "limit": "many" }), 40), 40);
    }

    #[test]
    fn mail_has_more_older_reads_both_the_cache_and_the_server() {
        let store = Store::open_in_memory().expect("in-memory store");
        store
            .upsert_mail_folder(&teams_lite::store::MailFolderUpdate {
                id: "f",
                display_name: "Inbox",
                well_known: "Inbox",
                total_count: 0,
                unread_count: 0,
                position: 0,
            })
            .unwrap();

        fn mail<'a>(id: &'a str, received: &'a str) -> teams_lite::store::MailMessageUpdate<'a> {
            teams_lite::store::MailMessageUpdate {
                id,
                folder_id: "f",
                conversation_id: "c",
                subject: "s",
                from_name: "n",
                from_address: "a@b",
                to_addresses: "[]",
                cc_addresses: "[]",
                received,
                is_read: true,
                has_attachments: false,
                importance: "normal",
                preview: "p",
            }
        }
        store.upsert_mail_message(&mail("m1", "2026-07-01T09:00:00Z")).unwrap();
        store.upsert_mail_message(&mail("m2", "2026-07-05T09:00:00Z")).unwrap();
        // History reaches back to m1, and the server holds nothing older.
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", false).unwrap();

        // A page stopping above the local frontier still has cached mail behind it,
        // so the UI must offer to page further WITHOUT a network round-trip.
        let head = store.mail_page("f", None, 1).unwrap();
        assert!(mail_has_more_older(&store, "f", &head).unwrap());

        // A page that reaches the frontier, with nothing older on the server, is the
        // end of the folder.
        let all = store.mail_page("f", None, 10).unwrap();
        assert!(!mail_has_more_older(&store, "f", &all).unwrap());

        // Once the server reports more, the end of the cache is not the end.
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", true).unwrap();
        assert!(mail_has_more_older(&store, "f", &all).unwrap());

        // An empty page defers entirely to the server.
        assert!(mail_has_more_older(&store, "f", &[]).unwrap());
        store.set_mail_frontier("f", "2026-07-01T09:00:00Z", false).unwrap();
        assert!(!mail_has_more_older(&store, "f", &[]).unwrap());
    }
}
