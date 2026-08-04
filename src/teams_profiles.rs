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
//
// The same endpoint also resolves an SMTP ADDRESS, and `isMailAddress=true` is the
// whole difference (recon: examples/mail_avatar_recon.rs). That is what gives the
// READ-ONLY mail surface a real face for a sender it only knows by address: the
// address resolves to an mri, and the mri is what the photo proxy takes. A colleague
// resolves; an external sender, a distribution list and a shared mailbox do not, and
// are simply absent from the answer — the UI then keeps its tinted initials.

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;

use crate::teams::Session;

/// The token audience that this endpoint accepts (the skypetoken alone 401/204s).
pub const PROFILE_SCOPE: &str = "https://api.spaces.skype.com/.default";

const FETCH_URL: &str =
    "https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true";

/// The same endpoint, told that the subjects are mail addresses rather than mris.
const FETCH_BY_MAIL_URL: &str =
    "https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=true&enableGuest=true&skypeTeamsInfo=true";

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

/// True when `address` is a mail address we may look up. It travels in a JSON body
/// rather than in a URL, so the risk it guards against is not injection but waste:
/// a display name, a header fragment or a whole mailbox list must never become a
/// directory request. Only a single-`@`, bounded, printable-ASCII address passes,
/// and the separators a mail header uses to join several addresses ('<', '>', ',',
/// ';', a space) are refused so one entry can only ever name one person.
pub fn is_mail_address(address: &str) -> bool {
    if address.is_empty() || address.len() > 320 {
        return false;
    }
    if !address.bytes().all(|b| {
        b.is_ascii_graphic() && !matches!(b, b'"' | b'\\' | b'<' | b'>' | b',' | b';' | b'(' | b')')
    }) {
        return false;
    }
    let Some((local, domain)) = address.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
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
    fetch_short_profiles(http, session, profile_token, FETCH_URL, mris).await
}

/// Resolve a batch of mail addresses to directory cards, each paired with the
/// address it answers for. An address the directory does not know — an external
/// sender, a distribution list, a shared mailbox — is simply absent from the
/// result, so the caller keeps whatever the message itself said about it.
///
/// The pairing is by the card's own `email` / `userPrincipalName`, because the
/// payload is an unordered set that names only the people it found (see
/// [`pair_with_addresses`]).
pub async fn fetch_profiles_by_address(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    addresses: &[String],
) -> Result<Vec<(String, Profile)>> {
    if addresses.is_empty() {
        return Ok(Vec::new());
    }
    anyhow::ensure!(addresses.len() <= MAX_BATCH, "too many addresses in one profile request");
    anyhow::ensure!(
        addresses.iter().all(|a| is_mail_address(a)),
        "refusing to fetch a profile for a malformed mail address"
    );
    let profiles =
        fetch_short_profiles(http, session, profile_token, FETCH_BY_MAIL_URL, addresses).await?;
    Ok(pair_with_addresses(addresses, profiles))
}

/// POST one batch of subjects (mris or mail addresses) to the short-profile
/// endpoint. The two callers differ only in the URL and in what they validated.
async fn fetch_short_profiles(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    url: &str,
    subjects: &[String],
) -> Result<Vec<Profile>> {
    // the endpoint wants a leading empty string in the array
    let mut arr: Vec<&str> = Vec::with_capacity(subjects.len() + 1);
    arr.push("");
    arr.extend(subjects.iter().map(|s| s.as_str()));
    let body = serde_json::to_string(&arr).unwrap();

    let resp = http
        .post(url)
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

/// Attribute each returned card to the address that asked for it, case-insensitively
/// on the card's `email` and then on its `userPrincipalName`. A card matching neither
/// is dropped: the mail UI shows the person a message names, so a face we cannot tie
/// to that address is worse than tinted initials.
fn pair_with_addresses(addresses: &[String], profiles: Vec<Profile>) -> Vec<(String, Profile)> {
    let wanted: HashMap<String, &String> =
        addresses.iter().map(|a| (a.to_lowercase(), a)).collect();
    let mut out = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let asked = [&profile.email, &profile.user_principal_name]
            .into_iter()
            .filter(|s| !s.is_empty())
            .find_map(|s| wanted.get(&s.to_lowercase()));
        if let Some(address) = asked {
            out.push(((*address).clone(), profile));
        }
    }
    out
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

    #[test]
    fn accepts_plain_mail_addresses_only() {
        assert!(is_mail_address("theophile.wallez@example.com"));
        assert!(is_mail_address("no-reply@sns.amazonaws.com"));
        assert!(is_mail_address("a+tag@sub.domain.co.uk"));
        // Not an address at all.
        assert!(!is_mail_address(""));
        assert!(!is_mail_address("Théophile WALLEZ"));
        assert!(!is_mail_address("nobody"));
        assert!(!is_mail_address("nobody@localhost"));
        assert!(!is_mail_address("@example.com"));
        assert!(!is_mail_address("a@@example.com"));
        assert!(!is_mail_address("a@.example.com"));
        assert!(!is_mail_address("a@example.com."));
        // A whole mail header, or a name with its address, names more than one thing.
        assert!(!is_mail_address("Ada <ada@example.com>"));
        assert!(!is_mail_address("ada@example.com, bob@example.com"));
        assert!(!is_mail_address("ada@example.com; bob@example.com"));
        assert!(!is_mail_address("ada@example.com bob@example.com"));
        assert!(!is_mail_address("\"ada\"@example.com"));
        assert!(!is_mail_address(&format!("{}@example.com", "a".repeat(320))));
    }

    #[test]
    fn pairs_every_card_with_the_address_that_asked_for_it() {
        // The payload is an unordered set naming only the people it found, so the
        // answer for the second address can arrive first, under a different case.
        let addresses = vec!["Ada.Lovelace@Example.com".to_string(), "bob@example.com".to_string()];
        let v = json!({ "value": [
            { "mri": "8:orgid:bbb", "displayName": "Bob", "email": "BOB@example.com" },
            // Matched on the UPN, since the mailbox address is not the `email` field.
            { "mri": "8:orgid:aaa", "displayName": "Ada", "email": "a.l@example.com",
              "userPrincipalName": "ada.lovelace@example.com" },
        ]});
        let paired = pair_with_addresses(&addresses, parse_profiles(&v));
        assert_eq!(paired.len(), 2);
        // The address is handed back exactly as the caller spelled it, so a caller
        // keyed on its own string finds the answer.
        assert_eq!(paired[0].0, "bob@example.com");
        assert_eq!(paired[0].1.display_name, "Bob");
        assert_eq!(paired[1].0, "Ada.Lovelace@Example.com");
        assert_eq!(paired[1].1.mri, "8:orgid:aaa");
    }

    #[test]
    fn drops_a_card_no_address_asked_for() {
        // A face we cannot tie to the address on the message is worse than initials.
        let addresses = vec!["ada@example.com".to_string()];
        let v = json!({ "value": [
            { "mri": "8:orgid:ccc", "displayName": "Someone Else", "email": "eve@example.com" },
            { "mri": "8:orgid:ddd", "displayName": "Nameless" },
        ]});
        assert!(pair_with_addresses(&addresses, parse_profiles(&v)).is_empty());
    }
}
