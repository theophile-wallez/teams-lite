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
            Self::Other => "other",
        }
    }

    /// Can restarting the Intune container plausibly fix this? Only the signature
    /// whose known cause is the locked keyring. Everything else either needs a
    /// human (`Refused`, `NoAccount`) or is not about the container at all.
    pub fn is_repairable(self) -> bool {
        matches!(self, Self::Disconnected)
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
fn record(outcome: &Result<String>) {
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
    record(&outcome);
    outcome
}

async fn acquire_token(scope: &str) -> Result<String> {
    let conn = connect_broker_bus().await?;
    let proxy = zbus::Proxy::new(&conn, BROKER_NAME, BROKER_PATH, BROKER_IFACE)
        .await
        .context("create broker proxy")?;
    let sid = Uuid::new_v4().to_string();

    let accounts = call(&proxy, "getAccounts", &sid, &json!({
        "clientId": EDGE_CLIENT_ID,
        "redirectUri": sid,
    })).await?;
    let account = accounts
        .get("accounts")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| {
            anyhow!("no account registered with the broker").context(BrokerFailure::NoAccount)
        })?;
    let username = account.get("username").and_then(|u| u.as_str()).unwrap_or_default();

    let req = json!({
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
    });
    let resp = call(&proxy, "acquireTokenSilently", &sid, &req).await?;
    let btr = resp.get("brokerTokenResponse").unwrap_or(&resp);
    btr.get("accessToken")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            // The broker answered and said no. Its own words decide whether a human
            // has to act (a sign-in the PRT can no longer do silently) or whether
            // this is something else entirely.
            let reason = broker_failure(&resp);
            let failure = classify_refusal(&reason);
            anyhow!("no accessToken for scope {scope}: {reason}").context(failure)
        })
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
    fn only_the_dropped_call_is_repairable() {
        for failure in [
            BrokerFailure::Unresponsive,
            BrokerFailure::Unreachable,
            BrokerFailure::Refused,
            BrokerFailure::NoAccount,
            BrokerFailure::Other,
        ] {
            assert!(!failure.is_repairable(), "{failure:?} must not be auto-repaired");
        }
        assert!(BrokerFailure::Disconnected.is_repairable());
    }

    #[test]
    fn every_failure_carries_a_distinct_wire_tag_and_a_sentence() {
        let all = [
            BrokerFailure::Disconnected,
            BrokerFailure::Unresponsive,
            BrokerFailure::Unreachable,
            BrokerFailure::Refused,
            BrokerFailure::NoAccount,
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
