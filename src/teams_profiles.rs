// Resolve mri -> display name via the middleTier fetchShortProfile endpoint.
//
// Proven shape (recon):
//   POST https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true
//   Auth: Bearer {spaces-audience token} + x-skypetoken   (the chatsvcagg token 204s here)
//   Body: ["", "8:orgid:<guid>", ...]                     (leading "" is required)
//   Resp: { "type": "...MiddleTier...", "value": [ { "mri": "...", "displayName": "...", "givenName": ..., ... } ] }
//
// This is what names 1:1 conversations, whose CSA `title` is blank and whose
// members carry only ids.

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;

use crate::teams::Session;

/// The token audience that this endpoint accepts (the skypetoken alone 401/204s).
pub const PROFILE_SCOPE: &str = "https://api.spaces.skype.com/.default";

const FETCH_URL: &str =
    "https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true";

/// Resolve a batch of mris to display names. Unknown/failed mris are simply absent
/// from the returned map (best-effort — naming is not critical-path).
pub async fn fetch_names(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    mris: &[String],
) -> Result<HashMap<String, String>> {
    if mris.is_empty() {
        return Ok(HashMap::new());
    }
    // the endpoint wants a leading empty string in the array
    let mut arr: Vec<&str> = Vec::with_capacity(mris.len() + 1);
    arr.push("");
    arr.extend(mris.iter().map(|s| s.as_str()));
    let body = serde_json::to_string(&arr).unwrap();

    let resp = http
        .post(FETCH_URL)
        .bearer_auth(profile_token)
        .header("x-skypetoken", &session.skypetoken)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .context("fetchShortProfile request")?;
    if !resp.status().is_success() {
        anyhow::bail!("fetchShortProfile -> {}", resp.status());
    }
    let v: Value = serde_json::from_str(&resp.text().await?).context("parse fetchShortProfile")?;
    Ok(parse_names(&v))
}

/// Extract { mri -> displayName } from the `{ value: [ {mri, displayName} ] }` envelope.
fn parse_names(v: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let items = v.get("value").and_then(|x| x.as_array());
    for item in items.into_iter().flatten() {
        let mri = item.get("mri").and_then(|x| x.as_str());
        // prefer displayName, fall back to givenName+surname
        let name = item
            .get("displayName")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                let g = item.get("givenName").and_then(|x| x.as_str()).unwrap_or("");
                let s = item.get("surname").and_then(|x| x.as_str()).unwrap_or("");
                let full = format!("{g} {s}");
                let full = full.trim().to_string();
                if full.is_empty() { None } else { Some(full) }
            });
        if let (Some(mri), Some(name)) = (mri, name) {
            map.insert(mri.to_string(), name);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_value_envelope() {
        let v = json!({
            "type": "Microsoft.SkypeSpaces.MiddleTier.Models.User[]",
            "value": [
                { "mri": "8:orgid:aaa", "displayName": "Leonor GROELL", "givenName": "Leonor", "surname": "GROELL" },
                { "mri": "8:orgid:bbb", "displayName": "", "givenName": "Jean", "surname": "Dupont" },
                { "mri": "8:orgid:ccc" } // no name at all -> skipped
            ]
        });
        let m = parse_names(&v);
        assert_eq!(m.get("8:orgid:aaa").map(String::as_str), Some("Leonor GROELL"));
        // empty displayName falls back to given + surname
        assert_eq!(m.get("8:orgid:bbb").map(String::as_str), Some("Jean Dupont"));
        // no name at all -> not present
        assert!(!m.contains_key("8:orgid:ccc"));
    }

    #[test]
    fn empty_or_malformed_is_empty_map() {
        assert!(parse_names(&json!({})).is_empty());
        assert!(parse_names(&json!({ "value": [] })).is_empty());
        assert!(parse_names(&json!({ "value": "nope" })).is_empty());
    }
}
