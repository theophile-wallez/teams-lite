// Teams session bootstrap: exchange a broker token for the Teams skypetoken and
// the region-correct service endpoints (regionGtms) via the authz endpoint.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::auth;

const SKYPE_SCOPE: &str = "https://api.spaces.skype.com/.default";
const AUTHZ_HOSTS: &[&str] = &[
    "https://teams.cloud.microsoft/api/authsvc/v1.0/authz",
    "https://teams.microsoft.com/api/authsvc/v1.0/authz",
];

/// A live Teams session: the skypetoken plus the region service directory.
#[derive(Clone)]
pub struct Session {
    pub skypetoken: String,
    pub region: String,
    pub gtms: Value, // regionGtms object
    /// Our own display name (e.g. "Théophile WALLEZ"), used as `imdisplayname`
    /// when sending and to identify our own messages in 1:1 name derivation.
    pub self_name: String,
    /// Our own mri (e.g. "8:orgid:<guid>").
    pub self_mri: String,
}

impl Session {
    /// Look up a region service endpoint by its regionGtms key
    /// (e.g. "chatService", "calling_trouterUrl").
    pub fn endpoint(&self, key: &str) -> Option<&str> {
        self.gtms.get(key).and_then(|v| v.as_str())
    }
}

/// Acquire a device-compliant token via the broker and exchange it for a
/// Teams skypetoken + region endpoints, then fetch our own identity.
pub async fn connect(client: &reqwest::Client) -> Result<Session> {
    let skype = auth::get_token(SKYPE_SCOPE).await.context("acquire skype token")?;

    let mut authz: Option<Value> = None;
    for url in AUTHZ_HOSTS {
        let r = client
            .post(*url)
            .bearer_auth(&skype)
            .header("content-type", "application/json")
            .body("{}".to_string())
            .send()
            .await?;
        if r.status().is_success() {
            authz = Some(r.json().await?);
            break;
        }
    }
    let authz = authz.context("authz failed on all hosts")?;

    let skypetoken = authz
        .pointer("/tokens/skypeToken")
        .and_then(|v| v.as_str())
        .context("authz response had no skypetoken")?
        .to_string();
    let region = authz.get("region").and_then(|v| v.as_str()).unwrap_or("?").to_string();
    let gtms = authz.get("regionGtms").cloned().unwrap_or(Value::Null);

    let mut session = Session { skypetoken, region, gtms, self_name: String::new(), self_mri: String::new() };
    // Best-effort self identity; failure here must not block the session.
    if let Ok((name, mri)) = fetch_self_identity(client, &session).await {
        session.self_name = name;
        session.self_mri = mri;
    }
    Ok(session)
}

/// Fetch our own display name + mri from chatService /v1/users/ME/properties.
/// `userDetails.name` holds the display name; `skypeName` is the mri (minus "8:").
async fn fetch_self_identity(client: &reqwest::Client, session: &Session) -> Result<(String, String)> {
    let chat = session.endpoint("chatService").context("no chatService endpoint")?.trim_end_matches('/');
    let resp = client
        .get(format!("{chat}/v1/users/ME/properties"))
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await?;
    let v: Value = serde_json::from_str(&resp.text().await?).context("parse /properties")?;
    // `userDetails` is a JSON-encoded STRING (double-encoded), not a nested object,
    // so we parse it a second time to read the display name.
    let name = v
        .get("userDetails")
        .and_then(|x| x.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|ud| ud.get("name").and_then(|n| n.as_str()).map(String::from))
        // fall back to the object form in case the API ever returns it un-encoded
        .or_else(|| v.pointer("/userDetails/name").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    // skypeName is like "orgid:<guid>"; the mri form used in messages is "8:orgid:<guid>".
    let raw = v.get("skypeName").and_then(|x| x.as_str()).unwrap_or("");
    let mri = if raw.is_empty() {
        String::new()
    } else if raw.starts_with("8:") {
        raw.to_string()
    } else {
        format!("8:{raw}")
    };
    Ok((name, mri))
}
