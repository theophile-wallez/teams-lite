// teams-lite — BROKER SPIKE (iteration 2)
//
// Goal: acquire a *device-compliant* Teams access token SILENTLY through the
// Microsoft Identity Broker (com.microsoft.identity.broker1) over D-Bus.
// No device-code, no browser. The broker uses the machine's Primary Refresh
// Token (PRT) so the minted token carries the `deviceid` claim => passes the
// tenant's Conditional Access "compliant device" policy.
//
// Iteration 2: the Edge client is NOT authorized for Teams resources, so we
// switch to the Teams first-party client id (observed as `appid` on a real
// browser token). A Graph control proves the mechanism yields a compliant token.
//
// Protocol learned from Siemens' linux-entra-sso (linux-entra-sso.py).
// This spike NEVER prints the raw token — only non-secret claims.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use uuid::Uuid;

const BROKER_NAME: &str = "com.microsoft.identity.broker1";
const BROKER_PATH: &str = "/com/microsoft/identity/broker1";
const BROKER_IFACE: &str = "com.microsoft.identity.Broker1";

// Microsoft Edge: broker-enabled first-party client (from linux-entra-sso).
const EDGE_CLIENT_ID: &str = "d7b530a4-7680-4c23-a8bf-c52c121d2e87";
// Broker/FOCI-friendly public clients: members of the Family of Client IDs
// share the PRT's refresh token, so the broker can mint tokens for any of them.
const OFFICE_CLIENT_ID: &str = "d3590ed6-52b3-4102-aeff-aad2292ab01c"; // Microsoft Office (FOCI)
const TEAMS_FOCI_CLIENT_ID: &str = "1fec8e78-bce4-4aaf-ab1b-5451cc387264"; // Microsoft Teams (FOCI)
const NATIVE_REDIRECT: &str = "https://login.microsoftonline.com/common/oauth2/nativeclient";

// (label, client_id, redirect_uri, scope)
const TRIALS: &[(&str, &str, &str, &str)] = &[
    ("CONTROL — Edge + Graph .default", EDGE_CLIENT_ID, NATIVE_REDIRECT,
        "https://graph.microsoft.com/.default"),
    ("Office(FOCI) + ic3 Teams.AccessAsUser.All", OFFICE_CLIENT_ID, NATIVE_REDIRECT,
        "https://ic3.teams.office.com/Teams.AccessAsUser.All"),
    ("Office(FOCI) + ic3 .default", OFFICE_CLIENT_ID, NATIVE_REDIRECT,
        "https://ic3.teams.office.com/.default"),
    ("Office(FOCI) + api.spaces.skype.com .default", OFFICE_CLIENT_ID, NATIVE_REDIRECT,
        "https://api.spaces.skype.com/.default"),
    ("Teams(FOCI 1fec8e78) + ic3 Teams.AccessAsUser.All", TEAMS_FOCI_CLIENT_ID, NATIVE_REDIRECT,
        "https://ic3.teams.office.com/Teams.AccessAsUser.All"),
];

async fn broker_call(
    proxy: &zbus::Proxy<'_>,
    method: &str,
    session_id: &str,
    payload: &Value,
) -> Result<Value> {
    let payload_str = payload.to_string();
    let resp: String = proxy
        .call(method, &("0.0", session_id, payload_str.as_str()))
        .await
        .with_context(|| format!("D-Bus call {method} failed"))?;
    serde_json::from_str(&resp).with_context(|| format!("parse {method} response"))
}

/// Decode the JWT payload (middle segment) without verifying — just to read claims.
fn decode_claims(token: &str) -> Option<Value> {
    let mid = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(mid).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tokio::main]
async fn main() -> Result<()> {
    let conn = zbus::Connection::session().await.context("connect to session bus")?;
    let proxy = zbus::Proxy::new(&conn, BROKER_NAME, BROKER_PATH, BROKER_IFACE)
        .await
        .context("create broker proxy")?;
    let session_id = Uuid::new_v4().to_string();

    // 0. Sanity check: is the broker actually answering?
    match broker_call(&proxy, "getLinuxBrokerVersion", &session_id,
        &json!({"msalCppVersion": "teams-lite-0.1"})).await
    {
        Ok(v) => println!("[ok] broker reachable — version {}",
            v.get("linuxBrokerVersion").and_then(|x| x.as_str()).unwrap_or("?")),
        Err(e) => println!("[warn] getLinuxBrokerVersion failed: {e}"),
    }

    // 1. Which accounts are registered with the broker?
    let accounts = broker_call(&proxy, "getAccounts", &session_id, &json!({
        "clientId": EDGE_CLIENT_ID,
        "redirectUri": session_id,
    })).await?;
    let list = accounts
        .get("accounts")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        return Err(anyhow!("no accounts registered with the broker — is the device Entra-joined and signed in?"));
    }
    let account = &list[0];
    let username = account.get("username").and_then(|u| u.as_str()).unwrap_or("?");
    println!("[ok] using account: {username}\n");

    // 2. Try each (client, redirect, scope) combination silently via the PRT.
    println!("== silent token acquisition (via PRT) ==");
    let mut success = false;
    for &(label, client_id, redirect, scope) in TRIALS {
        let req = json!({
            "authParameters": {
                "account": account,
                "additionalQueryParametersForAuthorization": {},
                "authority": "https://login.microsoftonline.com/common",
                "authorizationType": 1, // CACHED_REFRESH_TOKEN => use the PRT
                "clientId": client_id,
                "redirectUri": redirect,
                "requestedScopes": [scope],
                "username": username,
                "uxContextHandle": -1,
            }
        });
        match broker_call(&proxy, "acquireTokenSilently", &session_id, &req).await {
            Ok(resp) => {
                let btr = resp.get("brokerTokenResponse").unwrap_or(&resp);
                match btr.get("accessToken").and_then(|t| t.as_str()) {
                    Some(tok) => {
                        let claims = decode_claims(tok);
                        let aud = claims.as_ref().and_then(|c| c.get("aud")).and_then(|a| a.as_str()).unwrap_or("?");
                        let scp = claims.as_ref().and_then(|c| c.get("scp")).and_then(|s| s.as_str()).unwrap_or("?");
                        let has_device = claims.as_ref().map(|c| c.get("deviceid").is_some()).unwrap_or(false);
                        println!("  ✅ {label}");
                        println!("       aud={aud}  scp=\"{scp}\"  deviceid_claim={}",
                            if has_device { "YES → passes Conditional Access ✅" } else { "NO ⚠️" });
                        success = true;
                    }
                    None => {
                        let err = btr.get("error").or_else(|| resp.get("error"));
                        let msg = err.map(|e| e.to_string())
                            .unwrap_or_else(|| resp.to_string().chars().take(220).collect());
                        println!("  ❌ {label}\n       {msg}");
                    }
                }
            }
            Err(e) => println!("  ❌ {label} — {e}"),
        }
    }

    println!();
    if success {
        println!("===== RESULT: a working combination was found. Note which ✅ line has deviceid_claim=YES. =====");
    } else {
        println!("===== RESULT: still no token. If even the Graph CONTROL failed, the plumbing/scope shape is off; if only Teams failed, it's a client/redirect authorization issue. =====");
    }
    Ok(())
}
