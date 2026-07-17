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
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Broker access tokens live ~1h; refresh well before that to avoid 401s mid-use.
const TOKEN_TTL: Duration = Duration::from_secs(50 * 60);

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

async fn call(proxy: &zbus::Proxy<'_>, method: &str, sid: &str, payload: &Value) -> Result<Value> {
    let s = payload.to_string();
    let resp: String = proxy
        .call(method, &("0.0", sid, s.as_str()))
        .await
        .with_context(|| format!("D-Bus call {method} failed"))?;
    serde_json::from_str(&resp).with_context(|| format!("parse {method} response"))
}

/// Acquire a device-compliant access token for `scope`, silently, via the PRT.
/// Example scopes:
///   "https://ic3.teams.office.com/Teams.AccessAsUser.All"
///   "https://api.spaces.skype.com/.default"
pub async fn get_token(scope: &str) -> Result<String> {
    let conn = zbus::Connection::session().await.context("connect to session bus")?;
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
        .ok_or_else(|| anyhow!("no account registered with the broker"))?;
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
        .ok_or_else(|| anyhow!("no accessToken in broker response for scope {scope}"))
}
