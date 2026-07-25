// Resolve mri -> person via the middleTier fetchShortProfile endpoint.
//
// Proven shape (recon):
//   POST https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true
//   Auth: Bearer {spaces-audience token} + x-skypetoken   (the chatsvcagg token 204s here)
//   Body: ["", "8:orgid:<guid>", ...]                     (leading "" is required)
//   Resp: { "type": "...MiddleTier...", "value": [ {
//            "mri", "objectId", "displayName", "givenName", "surname", "email",
//            "userPrincipalName", "jobTitle", "department", "companyName",
//            "userLocation", "tenantName", "type", "userType" } ] }
//
// This is what names 1:1 conversations, whose CSA `title` is blank and whose
// members carry only ids, and what fills the person card shown on hover.

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;

use crate::teams::Session;

/// The token audience that this endpoint accepts (the skypetoken alone 401/204s).
pub const PROFILE_SCOPE: &str = "https://api.spaces.skype.com/.default";

const FETCH_URL: &str =
    "https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true";

/// How many mris one request may carry. The endpoint takes batches; the cap keeps
/// a caller (or a hostile payload) from building an unbounded request body.
pub const MAX_BATCH: usize = 100;

/// A person's directory card, as the short-profile endpoint reports it. Every
/// field but `mri` may legitimately be empty (a guest, a service account, or a
/// tenant that simply doesn't fill that attribute), so the UI renders only what
/// is there.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Profile {
    pub mri: String,
    /// AAD object id (a bare GUID) — the same identity as the mri, minus `8:orgid:`.
    pub object_id: String,
    pub display_name: String,
    pub given_name: String,
    pub surname: String,
    pub email: String,
    pub user_principal_name: String,
    pub job_title: String,
    pub department: String,
    pub company_name: String,
    /// The office/site the directory lists (Teams shows it as the work location).
    pub office_location: String,
    pub tenant_name: String,
    /// Directory user type — "Member" or "Guest" (empty when unreported).
    pub user_type: String,
}

/// True when `mri` is a person identity we may look up (`8:orgid:<guid>`,
/// `8:<skype-name>`), as opposed to a thread/channel/team mri (`19:…`) or a
/// hostile value. Only ASCII alphanumerics and a small punctuation set can appear
/// in a real person mri, and the length is bounded, so a mention or sender field
/// straight off the wire can never smuggle anything strange into a request body.
pub fn is_person_mri(mri: &str) -> bool {
    mri.starts_with("8:")
        && mri.len() <= 128
        && mri
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_' | b'.' | b'@'))
}

/// Fetch the full directory card for a batch of mris. Unknown/failed mris are
/// simply absent from the result (best-effort — a person card is never critical
/// path). Non-person mris are rejected before the request is built.
pub async fn fetch_profiles(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    mris: &[String],
) -> Result<Vec<Profile>> {
    if mris.is_empty() {
        return Ok(Vec::new());
    }
    anyhow::ensure!(mris.len() <= MAX_BATCH, "too many mris in one profile request");
    anyhow::ensure!(
        mris.iter().all(|m| is_person_mri(m)),
        "refusing to fetch a profile for a non-person mri"
    );
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
    Ok(parse_profiles(&v))
}

/// Resolve a batch of mris to display names. Unknown/failed mris are simply absent
/// from the returned map (best-effort — naming is not critical-path).
pub async fn fetch_names(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    mris: &[String],
) -> Result<HashMap<String, String>> {
    let profiles = fetch_profiles(http, session, profile_token, mris).await?;
    Ok(profiles
        .into_iter()
        .filter(|p| !p.display_name.is_empty())
        .map(|p| (p.mri, p.display_name))
        .collect())
}

/// Extract the profiles from the `{ value: [ … ] }` envelope. An entry without an
/// mri is dropped (it can't be matched to anyone).
fn parse_profiles(v: &Value) -> Vec<Profile> {
    let mut out = Vec::new();
    let items = v.get("value").and_then(|x| x.as_array());
    for item in items.into_iter().flatten() {
        let field = |key: &str| {
            item.get(key)
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
                .to_string()
        };
        let Some(mri) = item.get("mri").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let given_name = field("givenName");
        let surname = field("surname");
        // Prefer displayName, fall back to givenName + surname.
        let display_name = match field("displayName") {
            name if !name.is_empty() => name,
            _ => format!("{given_name} {surname}").trim().to_string(),
        };
        out.push(Profile {
            mri: mri.to_string(),
            object_id: field("objectId"),
            display_name,
            given_name,
            surname,
            email: field("email"),
            user_principal_name: field("userPrincipalName"),
            job_title: field("jobTitle"),
            department: field("department"),
            company_name: field("companyName"),
            office_location: field("userLocation"),
            tenant_name: field("tenantName"),
            user_type: field("userType"),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Names, as the conversation-naming path consumes them.
    fn names(v: &Value) -> HashMap<String, String> {
        parse_profiles(v)
            .into_iter()
            .filter(|p| !p.display_name.is_empty())
            .map(|p| (p.mri, p.display_name))
            .collect()
    }

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
        let m = names(&v);
        assert_eq!(m.get("8:orgid:aaa").map(String::as_str), Some("Leonor GROELL"));
        // empty displayName falls back to given + surname
        assert_eq!(m.get("8:orgid:bbb").map(String::as_str), Some("Jean Dupont"));
        // no name at all -> not present
        assert!(!m.contains_key("8:orgid:ccc"));
    }

    #[test]
    fn empty_or_malformed_is_empty_map() {
        assert!(names(&json!({})).is_empty());
        assert!(names(&json!({ "value": [] })).is_empty());
        assert!(names(&json!({ "value": "nope" })).is_empty());
    }

    #[test]
    fn parses_the_full_card_faithfully() {
        // A real tenant response (recon), field for field.
        let v = json!({
            "type": "Microsoft.SkypeSpaces.MiddleTier.Models.IUserIdentity",
            "value": [{
                "companyName": "AI, Data & Quantitative",
                "department": "AI Factory (AD&Q)",
                "displayName": "Matthieu GAUCHER",
                "email": "matthieu.gaucher@example.com",
                "givenName": "Matthieu",
                "isShortProfile": true,
                "jobTitle": "Senior Consultant",
                "mri": "8:orgid:e6d68aad",
                "objectId": "e6d68aad",
                "surname": "GAUCHER",
                "tenantName": "EXAMPLE",
                "type": "ADUser",
                "userLocation": "Paris (FIM)",
                "userPrincipalName": "matthieu.gaucher@example.com",
                "userType": "Member"
            }]
        });
        let p = parse_profiles(&v).remove(0);
        assert_eq!(
            p,
            Profile {
                mri: "8:orgid:e6d68aad".into(),
                object_id: "e6d68aad".into(),
                display_name: "Matthieu GAUCHER".into(),
                given_name: "Matthieu".into(),
                surname: "GAUCHER".into(),
                email: "matthieu.gaucher@example.com".into(),
                user_principal_name: "matthieu.gaucher@example.com".into(),
                job_title: "Senior Consultant".into(),
                department: "AI Factory (AD&Q)".into(),
                company_name: "AI, Data & Quantitative".into(),
                office_location: "Paris (FIM)".into(),
                tenant_name: "EXAMPLE".into(),
                user_type: "Member".into(),
            }
        );
    }

    #[test]
    fn missing_fields_are_empty_not_absent() {
        // A guest with nothing but an identity still yields a usable card.
        let v = json!({ "value": [{ "mri": "8:orgid:ddd", "displayName": "Guest" }] });
        let p = parse_profiles(&v).remove(0);
        assert_eq!(p.display_name, "Guest");
        assert!(p.job_title.is_empty() && p.email.is_empty() && p.office_location.is_empty());
    }

    #[test]
    fn accepts_person_mris_only() {
        assert!(is_person_mri("8:orgid:00000000-1111-2222-3333-444444444444"));
        assert!(is_person_mri("8:live:.cid.abc123"));
        // A channel/thread mri is not a person.
        assert!(!is_person_mri("19:yf2-R9Z4M9@thread.tacv2"));
        assert!(!is_person_mri("48:notifications"));
        assert!(!is_person_mri(""));
        // Nothing exotic gets into a request body.
        assert!(!is_person_mri("8:orgid:x\",\"y"));
        assert!(!is_person_mri("8:orgid:x y"));
        assert!(!is_person_mri(&format!("8:orgid:{}", "a".repeat(200))));
    }
}
