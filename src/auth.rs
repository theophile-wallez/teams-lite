// Silent, device-compliant token acquisition via the Microsoft Identity Broker.
//
// The broker (com.microsoft.identity.broker1) uses the machine's Primary Refresh
// Token to mint access tokens carrying the `deviceid` claim, so they satisfy a
// tenant's Conditional Access "compliant device" policy. We use the Microsoft
// Office client id (a FOCI family member) because it is both broker-usable and
// authorized for the Teams resources.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Broker access tokens live ~1h; refresh well before that to avoid 401s mid-use.
const TOKEN_TTL: Duration = Duration::from_secs(50 * 60);

/// How long the AUTOMATIC rescue waits for the broker before it gives up and takes back
/// whatever window went up (see {@link rescue}).
///
/// Short on purpose: this attempt runs inside a token call nobody is watching — the
/// real-time client's own retry, a mail poll — and a caller that blocked here would freeze
/// that feature for as long as a human takes. What the deadline separates is "the broker
/// could do it from the PRT" (measured: well under a second) from "the broker is waiting for
/// a person", and those two are seconds and minutes apart.
const RESCUE_DEADLINE: Duration = Duration::from_secs(8);

/// How often the automatic rescue may run. Every attempt that needs a human puts a window on
/// the broker's display and is then taken back, so an unbounded one would open and close a
/// window every 30 seconds for as long as the outage lasts. `REPAIR_MIN_INTERVAL` in
/// src/bin/server.rs is the same idea for the container restart.
const RESCUE_MIN_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// How long a sign-in a HUMAN is watching may take. Generous: they have to read a page, type
/// a password and reach for a phone, and the one thing this must not do is give up while
/// somebody is still typing. Ours rather than the bus's — zbus imposes no timeout of its own
/// (`Connection::method_timeout` defaults to `None`), so this is the whole of the deadline.
pub const SIGNIN_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// Why the broker could not mint a token — as far as the failure itself shows.
///
/// Each variant is named for what was OBSERVED, never for the cause it suggests.
/// `Disconnected` is the one to understand: on a containerized install its known
/// cause is the container's login keyring re-locking (the broker activates, cannot
/// read its secrets, and drops off the bus), which a container restart repairs — so
/// it is the only variant the automatic repair acts on. But the same signature also
/// appears when the broker is killed, or when the container is stopped while a call
/// is in flight, including by the repair itself. That is why the repair is rate
/// limited rather than merely conditional.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerFailure {
    /// Took the call, then dropped off the bus without answering.
    Disconnected,
    /// On the bus, but did not answer in time.
    Unresponsive,
    /// Nothing to talk to: no bus socket, no owner for the name, a refused handshake.
    Unreachable,
    /// Answered and refused. Needs a human: an interactive sign-in, a revoked
    /// device, a scope the tenant will not consent to.
    Refused,
    /// Works, but holds no account — the device enrolment is gone.
    NoAccount,
    /// On the bus and answering, but its login keyring is locked, so it can read
    /// neither the account nor the tokens it holds. A container restart unlocks it,
    /// so this is repairable — unlike `NoAccount`, which it looks exactly like from
    /// `getAccounts` alone (an empty account list), and is told apart from only by
    /// reading the keyring's own `Locked` property. The ~18h re-lock, named.
    KeyringLocked,
    /// Anything else. Never repaired automatically.
    Other,
}

impl BrokerFailure {
    /// One English sentence for a person, used in the log line and in the app.
    pub fn message(self) -> &'static str {
        match self {
            Self::Disconnected => {
                "The identity broker stopped answering. Its keyring is usually locked."
            }
            Self::Unresponsive => "The identity broker is not answering.",
            Self::Unreachable => "The identity broker is not reachable on the D-Bus session bus.",
            Self::Refused => "The identity broker refused to sign in silently.",
            Self::NoAccount => "The identity broker holds no account for this device.",
            Self::KeyringLocked => "The identity broker's keyring is locked.",
            Self::Other => "The identity broker could not mint a token.",
        }
    }

    /// The stable machine-readable tag carried on the wire (see the `broker_status`
    /// event in src/bin/server.rs and `BrokerStatus` in web/src/lib/protocol.ts).
    pub fn tag(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Unresponsive => "unresponsive",
            Self::Unreachable => "unreachable",
            Self::Refused => "refused",
            Self::NoAccount => "no_account",
            Self::KeyringLocked => "keyring_locked",
            Self::Other => "other",
        }
    }

    /// Can restarting the Intune container plausibly fix this? The two signatures whose
    /// known cause is the locked keyring — the broker dropping the call (`Disconnected`),
    /// and the broker answering but holding no readable account (`KeyringLocked`).
    /// Everything else either needs a human (`Refused`, `NoAccount`) or is not about the
    /// container at all.
    pub fn is_repairable(self) -> bool {
        matches!(self, Self::Disconnected | Self::KeyringLocked)
    }
}

impl std::fmt::Display for BrokerFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// Classify a D-Bus failure, from the typed error rather than from its text.
///
/// The name and the detail are one single element of an anyhow chain (zbus renders
/// `MethodError` as "{name}: {detail}" and returns no `source`), so once this error
/// is wrapped in context the type is gone. Classify here, while it is still typed.
///
/// Reading the DETAIL matters, not only the name: a reply timeout and a service that
/// died mid-call both arrive as `org.freedesktop.DBus.Error.NoReply`, and only the
/// second one is worth restarting a container for.
fn classify(err: &zbus::Error) -> BrokerFailure {
    match err {
        zbus::Error::MethodError(name, detail, _) => {
            classify_method_error(name.as_str(), detail.as_deref().unwrap_or(""))
        }
        zbus::Error::Address(_) | zbus::Error::InputOutput(_) | zbus::Error::Handshake(_) => {
            BrokerFailure::Unreachable
        }
        _ => BrokerFailure::Other,
    }
}

/// The signature half of {@link classify}, split out so the D-Bus error names are
/// unit-tested without constructing a `Message` (the third field of `MethodError`).
fn classify_method_error(name: &str, detail: &str) -> BrokerFailure {
    match name {
        "org.freedesktop.DBus.Error.NoReply"
            if detail.contains("disconnected from message bus") =>
        {
            BrokerFailure::Disconnected
        }
        "org.freedesktop.DBus.Error.NoReply" | "org.freedesktop.DBus.Error.TimedOut" => {
            BrokerFailure::Unresponsive
        }
        "org.freedesktop.DBus.Error.ServiceUnknown"
        | "org.freedesktop.DBus.Error.NameHasNoOwner"
        | "org.freedesktop.DBus.Error.Spawn.ChildExited"
        | "org.freedesktop.DBus.Error.Spawn.ExecFailed" => BrokerFailure::Unreachable,
        _ => BrokerFailure::Other,
    }
}

/// What the broker last did, for the whole process.
///
/// Process-wide on purpose, like the token cache it sits beside: `get_token` is the
/// single funnel every acquisition passes through — `TokenCache::get`,
/// `TokenCache::refresh` and the direct call in `teams::connect` alike — so one
/// recorder there covers every path, and a per-instance field would miss the one
/// caller that holds no cache.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrokerState {
    /// `None` means the last acquisition succeeded.
    pub failure: Option<BrokerFailure>,
    /// The full cause chain (`{e:#}`) of that failure, for the journal and the app.
    pub detail: String,
    /// How many acquisitions have failed in a row.
    pub consecutive_failures: u32,
    /// The scope that last failed, empty when the last acquisition succeeded.
    ///
    /// A failure here is per RESOURCE — measured: Graph minted fine while the skype scope
    /// refused (SIGN-IN.md § 1) — so "sign-in is broken" is really "this one resource's refresh
    /// token has died". A served sign-in acquires THIS scope (`Ctx::signin_scope`), because a
    /// sign-in that answered a different resource would report success over a feature still
    /// broken.
    pub scope: String,
}

impl BrokerState {
    pub fn is_ok(&self) -> bool {
        self.failure.is_none()
    }
}

static BROKER_STATE: Mutex<Option<BrokerState>> = Mutex::new(None);
type BrokerObserver = Box<dyn Fn(BrokerState) + Send + Sync>;
static BROKER_OBSERVER: OnceLock<BrokerObserver> = OnceLock::new();

/// The broker's current state, or `None` before the first acquisition.
pub fn broker_state() -> Option<BrokerState> {
    BROKER_STATE.lock().ok().and_then(|s| s.clone())
}

/// Watch for CHANGES of broker state — healthy to failing, one failure class to
/// another, or back to healthy. Called once, by the binary, at startup.
///
/// Changes only, never every failure: the mail poller retries each minute and the
/// real-time client every 30 seconds at its cap, so an observer called per failure
/// would flood whatever it feeds.
pub fn observe_broker(observer: impl Fn(BrokerState) + Send + Sync + 'static) {
    let _ = BROKER_OBSERVER.set(Box::new(observer));
}

/// Fold one acquisition outcome into the state, and notify on a change.
fn record(outcome: &Result<String>, scope: &str) {
    let next = match outcome {
        Ok(_) => BrokerState::default(),
        Err(e) => {
            // `anyhow::Error::downcast_ref` searches the error AND its context values,
            // which is where `classify` attached the class. `chain()` cannot be used
            // here: it yields `&dyn StdError`, and a classification tag is not an error.
            let failure = e
                .downcast_ref::<BrokerFailure>()
                .copied()
                .unwrap_or(BrokerFailure::Other);
            let previous = broker_state().map(|s| s.consecutive_failures).unwrap_or(0);
            BrokerState {
                failure: Some(failure),
                detail: format!("{e:#}"),
                consecutive_failures: previous.saturating_add(1),
                scope: scope.to_string(),
            }
        }
    };

    let changed = {
        let Ok(mut held) = BROKER_STATE.lock() else { return };
        let changed = held.as_ref().map(|s| s.failure) != Some(next.failure);
        *held = Some(next.clone());
        changed
    };

    if changed {
        if let Some(observer) = BROKER_OBSERVER.get() {
            observer(next);
        }
    }
}

/// A process-wide cache of broker tokens keyed by scope. Re-acquires silently via
/// the PRT when a token is missing or older than [`TOKEN_TTL`]. Cheap to clone.
#[derive(Clone, Default)]
pub struct TokenCache {
    inner: std::sync::Arc<Mutex<HashMap<String, (String, Instant)>>>,
}

impl TokenCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a valid token for `scope`, refreshing through the broker if the
    /// cached one is missing or near expiry.
    pub async fn get(&self, scope: &str) -> Result<String> {
        // fast path: a fresh token is already cached
        if let Some(tok) = self.cached_fresh(scope) {
            return Ok(tok);
        }
        // slow path: acquire a new one, then cache it
        let tok = get_token(scope).await?;
        if let Ok(mut map) = self.inner.lock() {
            map.insert(scope.to_string(), (tok.clone(), Instant::now()));
        }
        Ok(tok)
    }

    /// Force a refresh for `scope` (e.g. after an unexpected 401) and cache it.
    pub async fn refresh(&self, scope: &str) -> Result<String> {
        let tok = get_token(scope).await?;
        if let Ok(mut map) = self.inner.lock() {
            map.insert(scope.to_string(), (tok.clone(), Instant::now()));
        }
        Ok(tok)
    }

    fn cached_fresh(&self, scope: &str) -> Option<String> {
        let map = self.inner.lock().ok()?;
        let (tok, at) = map.get(scope)?;
        if at.elapsed() < TOKEN_TTL {
            Some(tok.clone())
        } else {
            None
        }
    }
}

const BROKER_NAME: &str = "com.microsoft.identity.broker1";
const BROKER_PATH: &str = "/com/microsoft/identity/broker1";
const BROKER_IFACE: &str = "com.microsoft.identity.Broker1";
// Edge client is used only to enumerate accounts (as in linux-entra-sso).
const EDGE_CLIENT_ID: &str = "d7b530a4-7680-4c23-a8bf-c52c121d2e87";
// Microsoft Office: FOCI client, broker-usable and broadly authorized.
const OFFICE_CLIENT_ID: &str = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
const NATIVE_REDIRECT: &str = "https://login.microsoftonline.com/common/oauth2/nativeclient";

/// Connect to the broker's session bus, transparently handling both Intune
/// topologies.
///
/// In a **classic** install the broker runs as us on our own session bus, and the
/// default EXTERNAL handshake (which sends our real uid) is accepted.
///
/// In a **containerized** install (e.g. `intune-container`) the broker runs as us
/// but on the container's session bus, whose `dbus-daemon` lives in a user
/// namespace where we appear as uid 0. That daemon only accepts an EXTERNAL
/// handshake claiming uid 0, so zbus's default (our real host uid) is rejected
/// with "EXTERNAL rejected". We detect that and retry claiming uid 0 — the same
/// credential `busctl` negotiates implicitly via SO_PEERCRED.
///
/// The `teams` launcher points `DBUS_SESSION_BUS_ADDRESS` at the right bus; here
/// we only pick the uid the handshake must claim.
async fn connect_broker_bus() -> Result<zbus::Connection> {
    let address = zbus::Address::session()
        .map_err(|e| anyhow::Error::new(e).context(BrokerFailure::Unreachable))
        .context("resolve session bus address")?;

    // Default handshake first (correct for a classic, same-uid broker bus).
    match zbus::connection::Builder::address(address.clone())?
        .build()
        .await
    {
        Ok(conn) => Ok(conn),
        Err(zbus::Error::Handshake(msg)) if msg.contains("EXTERNAL rejected") => {
            // Containerized broker bus: its dbus-daemon expects the namespace
            // uid 0. Retry claiming it explicitly.
            zbus::connection::Builder::address(address)?
                .auth_mechanism(zbus::connection::AuthMechanism::External)
                .user_id(0)
                .build()
                .await
                .map_err(|e| {
                    let failure = classify(&e);
                    anyhow::Error::new(e).context(failure)
                })
                .context("connect to containerized broker bus as uid 0")
        }
        Err(e) => {
            let failure = classify(&e);
            Err(anyhow::Error::new(e).context(failure)).context("connect to session bus")
        }
    }
}

async fn call(proxy: &zbus::Proxy<'_>, method: &str, sid: &str, payload: &Value) -> Result<Value> {
    let s = payload.to_string();
    // Classify before the text context: after `with_context` the typed zbus error is
    // an opaque link in the chain, and the failure class can only be re-derived by
    // matching strings. Attached as a context of its own, it stays downcastable —
    // and its Display adds the plain-English half of the chain the journal prints.
    let resp: String = proxy
        .call(method, &("0.0", sid, s.as_str()))
        .await
        .map_err(|e| {
            let failure = classify(&e);
            anyhow::Error::new(e).context(failure)
        })
        .with_context(|| format!("D-Bus call {method} failed"))?;
    serde_json::from_str(&resp).with_context(|| format!("parse {method} response"))
}

/// Acquire a device-compliant access token for `scope`, silently, via the PRT.
/// Example scopes:
///   "https://ic3.teams.office.com/Teams.AccessAsUser.All"
///   "https://api.spaces.skype.com/.default"
///
/// Every acquisition in the process passes through here, so this is where the broker's
/// health is recorded (see {@link BrokerState}). Keep it that way: a caller that
/// reached the broker some other way would go unnoticed, and the app would show no
/// chats with nothing to explain why.
pub async fn get_token(scope: &str) -> Result<String> {
    let outcome = acquire_token(scope).await;
    record(&outcome, scope);
    outcome
}

// The login keyring, as org.freedesktop.secrets exposes it inside the container — the
// same names bin/teams-lite-broker-check.sh reads over busctl.
const SECRETS_NAME: &str = "org.freedesktop.secrets";
const SECRETS_PATH: &str = "/org/freedesktop/secrets/collection/login";
const SECRETS_IFACE: &str = "org.freedesktop.Secret.Collection";

/// Is the container's login keyring locked? `Some(true)`/`Some(false)` when the secret
/// service answers, `None` when it cannot be told — no service, an older interface, a
/// property that would not decode. `None` is deliberately NOT "locked": this only ever
/// escalates a refusal to a repairable one, and a repair must never fire on a guess (the
/// discipline bin/teams-lite-broker-check.sh keeps for the shell path). Asked over the
/// broker's own bus connection, so it costs no second handshake.
async fn keyring_locked(conn: &zbus::Connection) -> Option<bool> {
    let proxy = zbus::Proxy::new(conn, SECRETS_NAME, SECRETS_PATH, SECRETS_IFACE)
        .await
        .ok()?;
    proxy.get_property::<bool>("Locked").await.ok()
}

async fn acquire_token(scope: &str) -> Result<String> {
    let conn = connect_broker_bus().await?;
    let proxy = zbus::Proxy::new(&conn, BROKER_NAME, BROKER_PATH, BROKER_IFACE)
        .await
        .context("create broker proxy")?;
    let sid = Uuid::new_v4().to_string();
    let account = broker_account(&conn, &proxy, &sid).await?;

    let resp = call(&proxy, "acquireTokenSilently", &sid, &token_request(&account, scope)).await?;
    if let Some(token) = access_token(&resp) {
        return Ok(token);
    }

    // The broker answered and said no. Its own words decide whether a human has to act (a
    // sign-in the PRT can no longer do silently) or whether this is something else entirely.
    let reason = broker_failure(&resp);
    let failure = classify_refusal(&reason);
    if failure == BrokerFailure::Refused {
        // Measured on this tenant: the SILENT path refuses a resource whose own refresh
        // token has died, and the INTERACTIVE one mints it from the PRT with nobody in front
        // of it (SIGN-IN.md § 2). So the refusal is not the answer yet.
        if let Some(token) = rescue(scope, &proxy, &sid, &account).await {
            return Ok(token);
        }
    }
    Err(anyhow!("no accessToken for scope {scope}: {reason}").context(failure))
}

/// The access token in a broker answer, wherever the broker put it.
fn access_token(resp: &Value) -> Option<String> {
    let btr = resp.get("brokerTokenResponse").unwrap_or(resp);
    btr.get("accessToken")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// The one account the broker holds, or the failure that says which kind of nothing it is.
async fn broker_account(
    conn: &zbus::Connection,
    proxy: &zbus::Proxy<'_>,
    sid: &str,
) -> Result<Value> {
    let accounts = call(proxy, "getAccounts", sid, &json!({
        "clientId": EDGE_CLIENT_ID,
        "redirectUri": sid,
    })).await?;
    match accounts
        .get("accounts")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
    {
        Some(account) => Ok(account.clone()),
        None => {
            // An empty account list is ambiguous. The device may truly be unenrolled
            // (`NoAccount`, which needs a human sign-in) — or the container keyring
            // re-locked and the broker, though answering, cannot READ the account it
            // holds (`KeyringLocked`, which a container restart fixes). The two want
            // opposite remedies and look identical here, so ask the keyring's own
            // `Locked` property to tell them apart — the same cause
            // bin/teams-lite-broker-check.sh tests. Unknown is never "locked": a repair
            // must not fire on a guess.
            let failure = if keyring_locked(conn).await == Some(true) {
                BrokerFailure::KeyringLocked
            } else {
                BrokerFailure::NoAccount
            };
            Err(anyhow!("broker returned no account").context(failure))
        }
    }
}

/// The request both acquisitions send, byte for byte.
///
/// ONE builder for the silent call and the interactive one, and that is the measurement
/// rather than tidiness: what proved the whole feature is that the two calls differ in their
/// METHOD NAME and in nothing else (SIGN-IN.md § 2), so a second builder that drifted by a
/// field would make the interactive path fail for a reason no log would name.
///
/// `authorizationType: 1` is `CachedRefreshToken` — the PRT. On the interactive method the
/// broker refuses a "non-interactive authorization type" (its own binary says so) and does
/// NOT refuse this one: it is what returned a token.
fn token_request(account: &Value, scope: &str) -> Value {
    let username = account.get("username").and_then(|u| u.as_str()).unwrap_or_default();
    json!({
        "authParameters": {
            "account": account,
            "additionalQueryParametersForAuthorization": {},
            "authority": "https://login.microsoftonline.com/common",
            "authorizationType": 1, // CACHED_REFRESH_TOKEN => use the PRT
            "clientId": OFFICE_CLIENT_ID,
            "redirectUri": NATIVE_REDIRECT,
            "requestedScopes": [scope],
            "username": username,
            "uxContextHandle": -1,
        }
    })
}

/// How an interactive acquisition ended.
///
/// `StillWaiting` is OURS, not the broker's: it means our own deadline passed while the
/// broker had a window up. There is no signal from the broker that says "I am asking a
/// human" — the window going up is the signal, and a call that has not answered is the
/// nearest thing to it from this side.
#[derive(Debug)]
pub enum Interactive {
    /// The broker minted a token. Nobody had to do anything.
    Token(String),
    /// The window was closed — by the reader, or by us taking it back.
    Cancelled,
    /// Our deadline passed with the broker still waiting for a person.
    StillWaiting,
}

/// Acquire `scope` interactively: the broker mints from the PRT if it can, and asks a human
/// if it cannot. Waits at most `wait`.
///
/// This is the whole of what the served sign-in does. The window it may put up is found and
/// driven separately (`src/xwindow.rs`), because the broker offers no handle on it.
pub async fn interactive_token(
    _turn: &InteractiveTurn,
    scope: &str,
    wait: Duration,
) -> Result<Interactive> {
    // The turn is a parameter rather than something taken in here, so the caller cannot forget
    // it and — more to the point — knows WHEN its own call is the one out. Two at once would put
    // two windows on the broker's display and `SigninWindow::find` answers with one of them.
    let conn = connect_broker_bus().await?;
    let proxy = zbus::Proxy::new(&conn, BROKER_NAME, BROKER_PATH, BROKER_IFACE)
        .await
        .context("create broker proxy")?;
    let sid = Uuid::new_v4().to_string();
    let account = broker_account(&conn, &proxy, &sid).await?;
    interactive_on(_turn, &proxy, &sid, &account, scope, wait).await
}

/// The interactive call itself, on a broker session somebody else opened.
async fn interactive_on(
    _turn: &InteractiveTurn,
    proxy: &zbus::Proxy<'_>,
    sid: &str,
    account: &Value,
    scope: &str,
    wait: Duration,
) -> Result<Interactive> {
    let request = token_request(account, scope);
    let call = call(proxy, "acquireTokenInteractively", sid, &request);

    let Ok(answered) = tokio::time::timeout(wait, call).await else {
        return Ok(Interactive::StillWaiting);
    };
    let resp = answered?;
    if let Some(token) = access_token(&resp) {
        return Ok(Interactive::Token(token));
    }
    if was_cancelled(&resp) {
        return Ok(Interactive::Cancelled);
    }
    Err(anyhow!(
        "the interactive sign-in did not mint a token for {scope}: {}",
        broker_failure(&resp)
    )
    .context(BrokerFailure::Refused))
}

/// Did the flow end because its window was closed?
///
/// Measured (SIGN-IN.md § 3): closing the window ends the pending call with
/// `status: 7` and the context "The InteractiveRequest was canceled by the user". Both are
/// read, the number first — a status is a contract, and the sentence is prose that may be
/// translated or reworded by a broker update.
fn was_cancelled(resp: &Value) -> bool {
    let error = resp
        .get("brokerTokenResponse")
        .and_then(|b| b.get("error"))
        .or_else(|| resp.get("error"));
    let Some(error) = error else { return false };
    if error.get("status").and_then(Value::as_u64) == Some(7) {
        return true;
    }
    error
        .get("context")
        .and_then(Value::as_str)
        .is_some_and(|c| c.to_ascii_lowercase().contains("canceled by the user"))
}

/// One interactive attempt on a refusal, with nobody watching.
///
/// This is the automatic half of the whole feature, and the reason most outages should now
/// end without anybody being told there was one: measured on this tenant, the resource whose
/// refresh token had died came back from the PRT in under a second, and the app — which had
/// been retrying every 30 s for hours — reconnected on its own.
///
/// Bounded three ways, because it can also be the case that a human really is needed: a read
/// only backend never tries, at most one attempt runs at a time, and at most one every
/// {@link RESCUE_MIN_INTERVAL}. A window that goes up is taken back before returning, so the
/// broker's display does not collect abandoned sign-ins.
async fn rescue(
    scope: &str,
    proxy: &zbus::Proxy<'_>,
    sid: &str,
    account: &Value,
) -> Option<String> {
    if crate::read_only() {
        return None;
    }
    if !rescue_is_due() {
        say_standing_down("it was tried too recently");
        return None;
    }
    // Never waits, unlike the sign-in a reader started: if an interactive call is already out —
    // theirs, or another failing token call's — this one has nothing to add and would only put a
    // second window on the broker's display.
    let Some(turn) = try_interactive_turn() else {
        say_standing_down("another interactive acquisition is already out");
        return None;
    };
    say_standing_down("");
    eprintln!(
        "[broker] the silent path refuses {scope} — trying an interactive acquisition, which \
         needs nobody when the PRT can still do it"
    );
    let outcome = interactive_on(&turn, proxy, sid, account, scope, RESCUE_DEADLINE).await;
    // The rate limit is charged on an attempt that did NOT work. It used to be charged on every
    // attempt, which meant a successful rescue for one scope locked out the next nine and a half
    // minutes for all the others — and a PRT event kills several resources at once, so the
    // sidebar's own scope could stay broken behind a sign-in that had already succeeded.
    if !matches!(outcome, Ok(Interactive::Token(_))) {
        charge_rescue();
    }
    match outcome {
        Ok(Interactive::Token(token)) => {
            eprintln!("[broker] the interactive acquisition minted {scope} with nobody in front of it");
            Some(token)
        }
        Ok(Interactive::StillWaiting) => {
            // The broker is showing its window to an empty display. Take it back and let the
            // app offer the served sign-in instead — that one has a reader in front of it.
            let closed = tokio::task::spawn_blocking(crate::xwindow::close_open_signin_window)
                .await
                .unwrap_or(false);
            eprintln!(
                "[broker] the broker is asking a human to sign in{} — the app offers it now",
                if closed { ", so its window was taken back" } else { "" }
            );
            None
        }
        Ok(Interactive::Cancelled) => {
            eprintln!("[broker] the interactive acquisition was cancelled");
            None
        }
        Err(e) => {
            eprintln!("[broker] the interactive acquisition failed: {e:#}");
            None
        }
    }
}

/// The one interactive acquisition this process may have out at a time.
///
/// Held by every path that calls `acquireTokenInteractively`: the sign-in a reader started
/// WAITS for it, and the automatic rescue only tries. Two at once would put two windows on the
/// broker's display, and `SigninWindow::find` answers with one of them — so the reader could be
/// typing into the flow whose token nobody is listening for.
fn interactive_gate() -> &'static std::sync::Arc<tokio::sync::Mutex<()>> {
    static GATE: OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    GATE.get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
}

/// Proof that the holder is the one interactive acquisition out right now.
///
/// It is a VALUE rather than a hidden lock inside the call because the session needs to know
/// when its own call is the one out: only then may it look for a window and let a reader type
/// into it. Without that, a session promoted itself the moment ANY broker window was viewable —
/// including the one the automatic rescue had put up and was about to close, which is the
/// reader typing their password into the flow whose token nobody reads.
pub struct InteractiveTurn(#[allow(dead_code)] tokio::sync::OwnedMutexGuard<()>);

/// Wait for the turn. For a sign-in a person is watching: an automatic attempt is bounded by
/// {@link RESCUE_DEADLINE} and will be out of the way in seconds.
pub async fn interactive_turn() -> InteractiveTurn {
    InteractiveTurn(interactive_gate().clone().lock_owned().await)
}

/// Take the turn, or nothing. For the automatic rescue, which has nothing to add when a call is
/// already out.
fn try_interactive_turn() -> Option<InteractiveTurn> {
    interactive_gate().clone().try_lock_owned().ok().map(InteractiveTurn)
}

/// When the last automatic rescue that did not work was tried.
///
/// Single-flight is the turn above; this is only the rate limit, and it is the automatic path's
/// alone — a reader pressing the button is never told to come back in ten minutes. Two plain
/// functions rather than a guard struct: nothing is RELEASED here, and a `let _slot = …` binding
/// implied a lifetime it did not have.
static RESCUE_STATE: Mutex<Option<Instant>> = Mutex::new(None);

/// Say ONCE that the automatic rescue stood down, and why — and say when it stops.
///
/// **This is what made a real outage undiagnosable.** The rescue is the repair that ends most
/// sign-in outages with nobody being told there was one, and it had THREE silent early returns:
/// a read-only backend, the rate limit, and the interactive turn already being held. Two of
/// those can be permanent — a poisoned `RESCUE_STATE` makes `rescue_is_due` answer false for
/// ever, and a served sign-in nobody finished holds the turn for ever — and in both the app
/// retries silently every thirty seconds with no line anywhere saying the one thing that would
/// have explained it. Measured on the always-on instance: **167 `[auth]` lines, 775
/// `[realtime] no credentials` lines, and not one word from the rescue**, so which of the three
/// it was could not be told after the fact.
///
/// Deduped by REASON rather than rate-limited, because the reasons are a closed set of three
/// and what matters is the CHANGE: one line when it starts standing down, one when it stops.
/// A line per attempt would be 2 880 a day for a state that is one fact.
fn say_standing_down(reason: &str) {
    static SAID: Mutex<Option<String>> = Mutex::new(None);
    let Ok(mut said) = SAID.lock() else { return };
    // An absent value reads as "nothing was standing down", so the FIRST ordinary rescue — which
    // calls this with an empty reason — prints nothing extra.
    if said.as_deref().unwrap_or("") == reason {
        return;
    }
    *said = Some(reason.to_string());
    if reason.is_empty() {
        // It is trying again. Said only after it had stood down, so an ordinary first rescue
        // prints nothing extra.
        eprintln!("[broker] the automatic sign-in repair is being tried again");
    } else {
        eprintln!(
            "[broker] the automatic sign-in repair is standing down: {reason}. Sign in from the \
             app if this does not clear."
        );
    }
}

/// May the automatic rescue try again?
///
/// A lock this cannot take answers YES, and that direction is deliberate: the rate limit is an
/// optimisation — it spares the broker's display a second window — and never a safety rail, while
/// the turn above is what really guarantees one attempt at a time. It used to answer `false` on a
/// poisoned lock, which turns one panic anywhere near this state into the automatic sign-in repair
/// being disabled for the life of the process, silently. Failing OPEN costs at most one extra
/// interactive attempt; failing closed cost an outage nobody could explain.
fn rescue_is_due() -> bool {
    RESCUE_STATE
        .lock()
        .map(|last| !last.is_some_and(|at| at.elapsed() < RESCUE_MIN_INTERVAL))
        .unwrap_or(true)
}

/// Record an attempt that did not mint a token, so the next one waits.
fn charge_rescue() {
    if let Ok(mut last) = RESCUE_STATE.lock() {
        *last = Some(Instant::now());
    }
}

/// Classify a refusal the broker described itself, from the codes it returned.
///
/// Text-matched, unlike {@link classify}, because these values are the broker's own
/// strings rather than a typed D-Bus error. Kept narrow: only the codes that mean
/// "a human must sign in" become {@link BrokerFailure::Refused}; everything else stays
/// `Other`, so an unfamiliar code never claims a remedy it does not have.
fn classify_refusal(reason: &str) -> BrokerFailure {
    let lower = reason.to_ascii_lowercase();
    let needs_a_human = ["interaction_required", "interactive_required", "token_expired", "invalid_grant"]
        .iter()
        .any(|code| lower.contains(code));
    if needs_a_human {
        BrokerFailure::Refused
    } else {
        BrokerFailure::Other
    }
}

/// Why the broker refused, in one line, for the error above.
///
/// A silent acquisition fails for reasons the user has to act on — an expired PRT
/// needing an interactive sign-in, a revoked device, a scope the tenant does not
/// consent to — and the broker says which in its response. Reporting only "no
/// accessToken" turns all of them into the same dead end.
fn broker_failure(resp: &Value) -> String {
    let dig = |key: &str| -> Option<String> {
        for place in [resp.get("brokerTokenResponse"), resp.get("errorResponse"), Some(resp)] {
            if let Some(v) = place.and_then(|p| p.get(key)) {
                let text = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
                if !text.is_empty() && text != "null" {
                    return Some(text);
                }
            }
        }
        None
    };
    let parts: Vec<String> = ["errorCode", "errorStatus", "errorDescription", "error"]
        .iter()
        .filter_map(|k| dig(k).map(|v| format!("{k}={v}")))
        .collect();
    if parts.is_empty() {
        // Nothing recognizable: name the keys we did get, so the next reader can add
        // one here instead of guessing. Values are withheld — some carry tokens.
        let keys: Vec<&str> = btr_keys(resp);
        return format!("broker gave no error detail (keys: {})", keys.join(", "));
    }
    parts.join(" ")
}

/// The response's own keys, plus those of a nested `brokerTokenResponse`.
fn btr_keys(resp: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = resp.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    if let Some(inner) = resp.get("brokerTokenResponse").and_then(|b| b.as_object()) {
        keys.extend(inner.keys().map(String::as_str));
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact reply the bus daemon sends when the broker takes a call and then
    /// drops off without answering. Observed twice on this host, both times because
    /// the Intune container's login keyring had re-locked.
    const DISCONNECTED_DETAIL: &str =
        "Message recipient disconnected from message bus without replying";

    #[test]
    fn a_broker_that_drops_the_call_is_the_repairable_signature() {
        let failure =
            classify_method_error("org.freedesktop.DBus.Error.NoReply", DISCONNECTED_DETAIL);
        assert_eq!(failure, BrokerFailure::Disconnected);
        assert!(failure.is_repairable());
    }

    #[test]
    fn a_reply_timeout_is_not_repairable_even_though_it_shares_the_error_name() {
        // Same D-Bus error name, different detail. Restarting the container for a
        // slow answer would take the account down for nothing, so the predicate has
        // to read the detail and not only the name.
        let failure = classify_method_error(
            "org.freedesktop.DBus.Error.NoReply",
            "Did not receive a reply. Possible causes include: the remote application did not send a reply",
        );
        assert_eq!(failure, BrokerFailure::Unresponsive);
        assert!(!failure.is_repairable());
    }

    #[test]
    fn an_unactivatable_broker_is_unreachable() {
        for name in [
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.Spawn.ChildExited",
            "org.freedesktop.DBus.Error.Spawn.ExecFailed",
        ] {
            assert_eq!(classify_method_error(name, ""), BrokerFailure::Unreachable, "{name}");
        }
    }

    #[test]
    fn an_unknown_error_name_is_never_repaired() {
        let failure = classify_method_error("com.microsoft.identity.Broker1.SomethingElse", "");
        assert_eq!(failure, BrokerFailure::Other);
        assert!(!failure.is_repairable());
    }

    #[test]
    fn only_the_locked_keyring_signatures_are_repairable() {
        for failure in [
            BrokerFailure::Unresponsive,
            BrokerFailure::Unreachable,
            BrokerFailure::Refused,
            BrokerFailure::NoAccount,
            BrokerFailure::Other,
        ] {
            assert!(!failure.is_repairable(), "{failure:?} must not be auto-repaired");
        }
        // Both point at a locked keyring, which a container restart unlocks: the broker
        // dropping the call, and the broker answering with no account it can read.
        assert!(BrokerFailure::Disconnected.is_repairable());
        assert!(BrokerFailure::KeyringLocked.is_repairable());
    }

    #[test]
    fn every_failure_carries_a_distinct_wire_tag_and_a_sentence() {
        let all = [
            BrokerFailure::Disconnected,
            BrokerFailure::Unresponsive,
            BrokerFailure::Unreachable,
            BrokerFailure::Refused,
            BrokerFailure::NoAccount,
            BrokerFailure::KeyringLocked,
            BrokerFailure::Other,
        ];
        let mut tags: Vec<&str> = all.iter().map(|f| f.tag()).collect();
        tags.sort_unstable();
        let count = tags.len();
        tags.dedup();
        assert_eq!(tags.len(), count, "two failures share a wire tag");
        for failure in all {
            // The app shows this verbatim, so it must read as a sentence.
            assert!(failure.message().ends_with('.'), "{failure:?}");
            assert!(!failure.tag().is_empty());
        }
    }

    #[test]
    fn only_the_codes_that_need_a_human_become_a_refusal() {
        for reason in [
            "errorCode=interaction_required errorStatus=token_expired",
            "errorCode=invalid_grant",
            "errorStatus=INTERACTION_REQUIRED",
        ] {
            assert_eq!(classify_refusal(reason), BrokerFailure::Refused, "{reason}");
        }
        // An unfamiliar code must not claim a remedy it does not have.
        for reason in ["errorCode=something_new", "broker gave no error detail (keys: a, b)"] {
            assert_eq!(classify_refusal(reason), BrokerFailure::Other, "{reason}");
        }
    }

    #[test]
    fn a_closed_window_reads_as_a_cancellation_rather_than_a_failure() {
        // The exact answer the broker gave when its window was closed, measured on 2026-08-18
        // (SIGN-IN.md § 3). Telling this from a failure is what lets the app say "nothing
        // changed" instead of reporting a fault the reader caused on purpose.
        let cancelled = json!({"brokerTokenResponse": {"error": {
            "context": "The InteractiveRequest was canceled by the user",
            "diagnostics": null, "errorCode": 0, "status": 7, "subStatus": 0, "tag": 557155398
        }}});
        assert!(was_cancelled(&cancelled));
        // The status alone is enough, because prose can be reworded by a broker update.
        assert!(was_cancelled(&json!({"error": {"status": 7}})));
        // And the sentence alone is enough, because a status could move.
        assert!(was_cancelled(&json!({"error": {"context": "the request was CANCELED BY THE USER"}})));
        // A real refusal is not a cancellation: it must not be reported as one, or an expired
        // account would read as the reader having closed a window they never saw.
        let refused = json!({"brokerTokenResponse": {"error": {
            "context": "Recieved an error from AAD. Code: 'interaction_required'",
            "errorCode": 0, "status": 2, "subStatus": 0
        }}});
        assert!(!was_cancelled(&refused));
        assert!(!was_cancelled(&json!({})));
    }

    #[test]
    fn an_empty_access_token_is_no_token() {
        assert_eq!(access_token(&json!({"accessToken": "abc"})).as_deref(), Some("abc"));
        // Where the broker really puts it.
        assert_eq!(
            access_token(&json!({"brokerTokenResponse": {"accessToken": "abc"}})).as_deref(),
            Some("abc")
        );
        // An empty string is a refusal wearing a success's shape: returned as a token it would
        // be sent to Teams as `Authorization: Bearer `, and the failure would surface as a 401
        // somewhere else entirely.
        assert_eq!(access_token(&json!({"brokerTokenResponse": {"accessToken": ""}})), None);
        assert_eq!(access_token(&json!({"brokerTokenResponse": {}})), None);
    }

    #[test]
    fn both_acquisitions_send_the_one_request_builder() {
        // The measurement this whole feature rests on is that the silent call and the
        // interactive one differ in their METHOD NAME and in nothing else (SIGN-IN.md § 2). A
        // second request builder that drifted by a field would make the interactive path fail
        // for a reason no log would name, so the source is held to one.
        let whole = include_str!("auth.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        assert_eq!(
            source.matches("\"authParameters\"").count(),
            1,
            "the request is built in exactly one place"
        );
        for method in ["acquireTokenSilently", "acquireTokenInteractively"] {
            let at = source.find(&format!("\"{method}\", ")).unwrap_or_else(|| panic!("{method}"));
            let line_end = source[at..].find('\n').map(|n| at + n).unwrap_or(source.len());
            assert!(
                source[at..line_end].contains("token_request") || source[at..line_end].contains("request"),
                "{method} must send the shared request: {}",
                &source[at..line_end]
            );
        }
        // And the type the broker refuses on the interactive method is the one it accepts, with
        // the measurement written beside it.
        assert!(source.contains("\"authorizationType\": 1"));
    }

    #[test]
    fn only_the_sign_in_a_reader_started_waits_for_its_turn() {
        // Two interactive calls at once would put two windows on the broker's display, and the
        // reader could type their password into the flow whose token nobody reads. So one turn
        // holds both paths — and which of them WAITS is the whole of the policy: a person is
        // waiting for theirs, and an automatic attempt has nothing to add.
        let whole = include_str!("auth.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let rescue = source.find("async fn rescue(").expect("rescue");
        let after_rescue = &source[rescue..];
        assert!(
            after_rescue.contains("try_interactive_turn()"),
            "the automatic rescue must never wait"
        );
        assert!(
            !after_rescue.contains("interactive_turn().await"),
            "the automatic rescue must not block a token call on a human"
        );
        // And the waiting half exists for the session to call, taking the turn as a VALUE — so a
        // caller cannot forget it, and knows when its own call is the one out.
        assert!(source.contains("pub async fn interactive_turn() -> InteractiveTurn"));
        assert!(source.contains("_turn: &InteractiveTurn"), "the call is passed the turn");
    }

    #[test]
    fn a_rescue_that_worked_does_not_spend_the_next_ten_minutes() {
        // The rate limit is charged on an attempt that did NOT mint a token. Charged on every
        // attempt — which it was — a successful rescue for one scope locked out every other
        // scope for the next ten minutes, and a PRT event kills several resources at once, so
        // the sidebar could stay dark behind a sign-in that had already succeeded.
        let whole = include_str!("auth.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let rescue = source.find("async fn rescue(").expect("rescue");
        let body = &source[rescue..];
        let charge = body.find("charge_rescue()").expect("the charge");
        let guarded = &body[..charge];
        assert!(
            guarded.contains("if !matches!(outcome, Ok(Interactive::Token(_)))"),
            "the charge must be guarded on the outcome"
        );
        // And the check that reads it never writes: the two are separate on purpose.
        let due = source.find("fn rescue_is_due()").expect("rescue_is_due");
        let due_body = &source[due..due + source[due..].find("\n}").unwrap_or(0)];
        assert!(!due_body.contains("*last ="), "reading the limit must not charge it");
    }

    #[test]
    fn the_automatic_rescue_stands_down_on_a_read_only_backend() {
        // It signs in as the user, so it is as much out of bounds for a screenshot backend as a
        // send is. Asserted on the ORDER, because `read_only()` caches the environment: the
        // refusal is decided before anything reaches the broker.
        let whole = include_str!("auth.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let rescue = source.find("async fn rescue(").expect("rescue");
        let body = &source[rescue..];
        let read_only_at = body.find("crate::read_only()").expect("the read-only gate");
        let turn_at = body.find("try_interactive_turn()").expect("the single-flight turn");
        let call_at = body.find("interactive_on(").expect("the call");
        assert!(read_only_at < turn_at && turn_at < call_at, "read-only comes first");
    }

    /// THE AUTOMATIC REPAIR SAYS WHEN IT STANDS DOWN, and it used to stand down in silence.
    ///
    /// It is the thing that ends most sign-in outages with nobody being told there was one, and it
    /// had three silent early returns. Two of them can be PERMANENT — a poisoned `RESCUE_STATE`,
    /// and an interactive turn nobody released — and in both the app retries every thirty seconds
    /// for ever with no line anywhere naming the cause. Measured on the always-on instance: 167
    /// `[auth]` lines, 775 `[realtime] no credentials` lines, and not one word from the rescue.
    #[test]
    fn a_rescue_that_stands_down_says_which_of_its_reasons_it_was() {
        let whole = include_str!("auth.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let rescue = source.find("async fn rescue(").expect("rescue");
        // Bounded at BOTH ends: the next item, so a later function's own call cannot satisfy this.
        let body = &source[rescue..];
        let body = &body[..body.find("\n/// The one interactive").unwrap_or(body.len())];
        // Each of the two reachable stand-downs names itself, asserted on the EXACT call rather
        // than on one found somewhere after it. A window bounded by the next `return None;` was
        // written first and proved worthless: with the silent `?` restored there is no such
        // return, the slice ran to the end of the body, and a LATER `say_standing_down` satisfied
        // it — the mutation passed. The read-only stand-down deliberately says nothing: refusing
        // is that backend's whole purpose, and a screenshot run must not print a line about a
        // repair it was never going to make.
        assert!(
            body.contains(r#"say_standing_down("it was tried too recently")"#),
            "the rate limit stands down without saying so"
        );
        assert!(
            body.contains(r#"say_standing_down("another interactive acquisition is already out")"#),
            "the turn stands down without saying so"
        );
        // And the `?` form cannot come back: it is what made the turn's refusal invisible, and it
        // reads as ordinary Rust rather than as a missing line.
        assert!(
            !body.contains("try_interactive_turn()?"),
            "`try_interactive_turn()?` returns None with nothing said — use the `let … else` that \
             names the reason"
        );
        // And it says when it STOPS, or the line above would read as a state that never cleared.
        assert!(body.contains("say_standing_down(\"\")"), "nothing says the repair resumed");
        // The rate limit FAILS OPEN. Failing closed turns one panic near this state into the
        // repair being disabled for the life of the process.
        let due_at = source.find("fn rescue_is_due()").expect("rescue_is_due");
        let due_body = &source[due_at..due_at + source[due_at..].find("\n}").unwrap_or(0)];
        assert!(
            due_body.contains("unwrap_or(true)"),
            "a lock this cannot take must answer YES: the limit is an optimisation, and the TURN \
             is what guarantees one attempt at a time"
        );
    }

    #[test]
    fn the_class_survives_the_context_the_call_site_adds() {
        // Mirrors what `call` builds: the class first, the human text on top. The
        // recorder must still find the class, and the chain must still read well.
        let err = anyhow::Error::msg(format!(
            "org.freedesktop.DBus.Error.NoReply: {DISCONNECTED_DETAIL}"
        ))
        .context(BrokerFailure::Disconnected)
        .context("D-Bus call getAccounts failed");

        assert_eq!(err.downcast_ref::<BrokerFailure>().copied(), Some(BrokerFailure::Disconnected));
        let rendered = format!("{err:#}");
        assert!(rendered.starts_with("D-Bus call getAccounts failed"), "{rendered}");
        assert!(rendered.contains(DISCONNECTED_DETAIL), "{rendered}");
    }
}
