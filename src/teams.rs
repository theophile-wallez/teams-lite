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
pub struct Session {
    pub skypetoken: String,
    pub region: String,
    pub gtms: Value, // regionGtms object
}

impl Session {
    /// Look up a region service endpoint by its regionGtms key
    /// (e.g. "chatService", "calling_trouterUrl").
    pub fn endpoint(&self, key: &str) -> Option<&str> {
        self.gtms.get(key).and_then(|v| v.as_str())
    }
}

/// Acquire a device-compliant token via the broker and exchange it for a
/// Teams skypetoken + region endpoints.
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

    Ok(Session { skypetoken, region, gtms })
}
