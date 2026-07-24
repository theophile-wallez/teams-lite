// Fetch real profile photos for people and Teams "teams" (the parent groups that
// contain channels), falling back to tinted initials in the UI when none exists.
//
// Proven shape (recon against the live tenant):
//   User photo: GET https://teams.microsoft.com/api/mt/beta/users/{id}/profilepicturev2?displayName=&size=HR192x192
//     {id} is an MRI ("8:orgid:<guid>") or a bare AAD object id. 404 when the
//     person has no photo set.
//   Team photo: GET https://teams.microsoft.com/api/mt/beta/teams/{groupId}/profilepicturev2?size=HR192x192
//     {groupId} is the AAD group id (a bare GUID) taken from the CSA payload's
//     `teamSiteInformation.groupId` — NOT the team thread id, which the endpoint
//     rejects ("Invalid Group Id").
//   Auth for BOTH: `Authorization: Bearer {PROFILE_SCOPE token}` + `x-skypetoken`.
//   The skypetoken alone 401s; the CSA-audience token is also rejected here.
//
// Two safety rails mirror the media proxy (see teams_media.rs):
//   - The id is validated to a strict charset before it is ever interpolated into
//     the URL path, so a hostile id cannot inject a new path segment, query, or
//     host (SSRF / path-traversal). The base host is a fixed constant.
//   - The response is size-capped (shared MAX_MEDIA_BYTES) so a huge body cannot
//     blow up memory or the base64 WebSocket frame.

use anyhow::{Context, Result};

use crate::teams::Session;
use crate::teams_media::{Media, MAX_MEDIA_BYTES};

/// The fixed host every photo request targets. A constant (never derived from
/// caller input), so the credentialed request can only ever reach Microsoft.
const AVATAR_HOST: &str = "https://teams.microsoft.com";

/// The single photo size we fetch. High enough to stay crisp on retina displays
/// at every render site (sidebar ~36px, headers a little larger), and a single
/// fixed size keeps the UI-side cache keyed by identity alone.
const AVATAR_SIZE: &str = "HR192x192";

/// Which kind of subject a photo id refers to. The endpoint path differs, but the
/// auth and response handling are identical.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AvatarKind {
    /// A person, addressed by MRI ("8:orgid:<guid>") or bare AAD object id.
    User,
    /// A Teams "team" (the group owning channels), addressed by AAD group id.
    Team,
}

impl AvatarKind {
    /// Parse the wire string used by the WS protocol.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "team" => Some(Self::Team),
            _ => None,
        }
    }

    /// The path segment naming the collection for this kind.
    fn path_segment(self) -> &'static str {
        match self {
            Self::User => "users",
            Self::Team => "teams",
        }
    }
}

/// True when `id` is safe to interpolate into a photo URL path. Ids we accept are
/// MRIs ("8:orgid:<guid>") and bare GUIDs, so the only characters that can ever
/// legitimately appear are ASCII alphanumerics, ':', and '-'. Rejecting anything
/// else keeps a hostile id from injecting a new path segment ('/'), a query/
/// fragment ('?', '#'), an escape ('%'), or a userinfo/host ('@'), and bounds the
/// length so it cannot balloon the request line.
pub fn is_valid_avatar_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
}

/// Fetch one profile photo. Returns `Ok(None)` when the subject has no photo (the
/// endpoint answers 404), so the caller can fall back to initials; `Ok(Some(..))`
/// with the image bytes otherwise. Any other non-success status is an error.
///
/// `id` MUST already be a plausible identifier; this re-validates defensively so a
/// future caller mistake cannot turn the credentialed request into an SSRF vector.
pub async fn fetch_avatar(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    kind: AvatarKind,
    id: &str,
) -> Result<Option<Media>> {
    anyhow::ensure!(is_valid_avatar_id(id), "refusing to fetch avatar for a malformed id");

    // `displayName` is only meaningful for users (it seeds a generated monogram
    // server-side); we always fall back to our own initials, so we send it empty.
    let url = match kind {
        AvatarKind::User => format!(
            "{AVATAR_HOST}/api/mt/beta/{}/{id}/profilepicturev2?displayName=&size={AVATAR_SIZE}",
            kind.path_segment(),
        ),
        AvatarKind::Team => format!(
            "{AVATAR_HOST}/api/mt/beta/{}/{id}/profilepicturev2?size={AVATAR_SIZE}",
            kind.path_segment(),
        ),
    };

    let resp = http
        .get(&url)
        .bearer_auth(profile_token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await
        .context("profile-picture request")?;

    let status = resp.status();
    // No photo set for this subject — a normal, expected outcome, not an error.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        anyhow::bail!("profile-picture -> {status}");
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = resp.bytes().await.context("read profile-picture body")?;
    anyhow::ensure!(
        bytes.len() <= MAX_MEDIA_BYTES,
        "profile picture too large: {} bytes",
        bytes.len()
    );
    // Some tenants answer 200 with an empty body instead of 404 when no photo is
    // set; treat that as "no photo" so the UI falls back to initials cleanly.
    if bytes.is_empty() {
        return Ok(None);
    }

    Ok(Some(Media {
        content_type,
        bytes: bytes.to_vec(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_mris_and_guids() {
        assert!(is_valid_avatar_id("8:orgid:00000000-1111-2222-3333-444444444444"));
        assert!(is_valid_avatar_id("00000000-1111-2222-3333-444444444444"));
        assert!(is_valid_avatar_id("8:orgid:abcDEF123"));
    }

    #[test]
    fn rejects_path_and_query_injection() {
        // A '/' would open a new path segment (could change the endpoint).
        assert!(!is_valid_avatar_id("8:orgid:x/../../teams/y"));
        // Query / fragment injection.
        assert!(!is_valid_avatar_id("guid?size=HR999"));
        assert!(!is_valid_avatar_id("guid#frag"));
        // Percent-escape, userinfo/host, whitespace, dots.
        assert!(!is_valid_avatar_id("gu%2fid"));
        assert!(!is_valid_avatar_id("guid@evil.example"));
        assert!(!is_valid_avatar_id("gu id"));
        assert!(!is_valid_avatar_id("teams.microsoft.com"));
        // Empty and over-long.
        assert!(!is_valid_avatar_id(""));
        assert!(!is_valid_avatar_id(&"a".repeat(129)));
    }

    #[test]
    fn wire_kind_round_trips() {
        assert_eq!(AvatarKind::from_wire("user"), Some(AvatarKind::User));
        assert_eq!(AvatarKind::from_wire("team"), Some(AvatarKind::Team));
        assert_eq!(AvatarKind::from_wire("channel"), None);
        assert_eq!(AvatarKind::User.path_segment(), "users");
        assert_eq!(AvatarKind::Team.path_segment(), "teams");
    }
}
