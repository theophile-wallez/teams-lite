// Startup update check: is a newer `teams` build available?
//
// teams-lite ships as a ROLLING `latest` GitHub release — CI republishes the
// `latest` tag on every push to master. There is no semantic version, so a
// build's identity is the git commit it was compiled from (embedded at build
// time as `TEAMS_BUILD_REV`; see build.rs). This module answers one question:
// "does the `latest` release point at a DIFFERENT commit than the one I'm
// running?" If so, a newer build exists and the user can reinstall to get it.
//
// It lives in the backend, not the UI, because the UI never touches the network
// (local-first is enforced server-side). The server runs this once at startup,
// best-effort, and pushes an `update_available` event to the UI.
//
// The network call is deliberately unwrapped from the shared retry policy: an
// update check is a nicety, not core function — a single attempt that fails
// silently is exactly the right behaviour (offline, rate-limited, etc.).

use std::time::Duration;

use anyhow::{Context, Result};

/// The GitHub repository that publishes the rolling `latest` release.
pub const REPO: &str = "theophile-wallez/teams-lite";

/// How long to wait on the GitHub API before giving up. An update check must
/// never hold anything up, so this is short.
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// A newer release than the one currently running. `current`/`latest` are short
/// commit SHAs for display; `url` points at the release page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub url: String,
}

/// The commit this binary was built from, or `None` for a dev build.
///
/// build.rs always defines `TEAMS_BUILD_REV`, but leaves it empty for local
/// builds (CI sets it to the release commit). An empty value means "built from
/// source" — we return `None` so the caller skips the check entirely rather than
/// comparing against a blank and nagging every developer.
pub fn build_rev() -> Option<&'static str> {
    match option_env!("TEAMS_BUILD_REV") {
        Some(rev) if !rev.trim().is_empty() => Some(rev.trim()),
        _ => None,
    }
}

/// Check GitHub for a newer `latest` release than `current_rev`.
///
/// Returns `Ok(Some(info))` when the published `latest` release was built from a
/// different commit, `Ok(None)` when up to date (or the remote commit could not
/// be determined), and `Err` only on a network/HTTP failure the caller should
/// swallow. The `http` client is reused from the backend (it already carries a
/// User-Agent, which the GitHub API requires).
pub async fn check(http: &reqwest::Client, current_rev: &str) -> Result<Option<UpdateInfo>> {
    let api = format!("https://api.github.com/repos/{REPO}/releases/tags/latest");
    let resp = http
        .get(&api)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("github releases request")?;

    // Non-2xx (rate limit, no release yet, transient 5xx): treat as "no info".
    // Bail with the status so the caller can log it; it is never fatal.
    if !resp.status().is_success() {
        anyhow::bail!("github releases -> {}", resp.status());
    }

    let body: serde_json::Value = resp.json().await.context("github releases body")?;
    let target = body.get("target_commitish").and_then(|v| v.as_str());
    let notes = body.get("body").and_then(|v| v.as_str());
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest"));

    let Some(latest) = parse_release_rev(target, notes) else {
        // We reached GitHub but couldn't identify the release's commit. Don't
        // guess — say "no update" rather than risk a false alarm.
        return Ok(None);
    };

    if is_update(current_rev, &latest) {
        Ok(Some(UpdateInfo {
            current: short_rev(current_rev),
            latest: short_rev(&latest),
            url: html_url,
        }))
    } else {
        Ok(None)
    }
}

/// Determine the commit a release was built from.
///
/// We publish the commit in TWO independent places (see .github/workflows/
/// build.yml): the release's `target_commitish` (set to the full SHA) and the
/// release notes body ("Rolling build from <SHA> — <timestamp>"). We prefer the
/// structured `target_commitish` when it is a full SHA, and fall back to
/// scanning the notes — so the check keeps working even if GitHub ever resolves
/// `target_commitish` to a branch name instead of the SHA.
pub fn parse_release_rev(target_commitish: Option<&str>, notes: Option<&str>) -> Option<String> {
    if let Some(t) = target_commitish {
        let t = t.trim();
        if is_full_sha(t) {
            return Some(t.to_lowercase());
        }
    }
    notes.and_then(extract_sha40)
}

/// Is a newer commit than what we're running? True only when both sides name a
/// commit and they are not the same build. Short/full SHAs compare by prefix, so
/// `abc1234` and its 40-char form are treated as identical. Empty inputs (dev
/// build, unknown remote) yield `false` — never nag without a real comparison.
pub fn is_update(local: &str, remote: &str) -> bool {
    let local = local.trim().to_lowercase();
    let remote = remote.trim().to_lowercase();
    if local.is_empty() || remote.is_empty() {
        return false;
    }
    // Same build if one SHA is a prefix of the other (handles short vs full).
    if local.starts_with(&remote) || remote.starts_with(&local) {
        return false;
    }
    true
}

/// Shorten a SHA for display (first 7 chars, git-style). Non-SHA/short strings
/// pass through unchanged.
fn short_rev(rev: &str) -> String {
    let rev = rev.trim();
    if rev.len() > 7 && rev.chars().all(|c| c.is_ascii_hexdigit()) {
        rev[..7].to_lowercase()
    } else {
        rev.to_string()
    }
}

/// Is `s` exactly a 40-character hex string (a full git SHA-1)?
fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Find the first maximal run of exactly 40 hex characters in `s` (a full SHA
/// embedded in free text, e.g. the release notes). Runs of a different length
/// (like the digit groups of an ISO timestamp) are ignored. Returned lowercased.
fn extract_sha40(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        if chars[i].is_ascii_hexdigit() {
            let start = i;
            while i < n && chars[i].is_ascii_hexdigit() {
                i += 1;
            }
            if i - start == 40 {
                return Some(chars[start..i].iter().collect::<String>().to_lowercase());
            }
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "0123456789abcdef0123456789abcdef01234567";
    const SHA_B: &str = "fedcba9876543210fedcba9876543210fedcba98";

    #[test]
    fn is_update_same_commit_is_not_an_update() {
        assert!(!is_update(SHA_A, SHA_A));
    }

    #[test]
    fn is_update_different_commit_is_an_update() {
        assert!(is_update(SHA_A, SHA_B));
    }

    #[test]
    fn is_update_short_and_full_of_same_commit_match() {
        // The 7-char prefix of SHA_A is the same build, not an update.
        assert!(!is_update(&SHA_A[..7], SHA_A));
        assert!(!is_update(SHA_A, &SHA_A[..7]));
    }

    #[test]
    fn is_update_is_case_insensitive() {
        assert!(!is_update(&SHA_A.to_uppercase(), SHA_A));
    }

    #[test]
    fn is_update_empty_side_never_nags() {
        assert!(!is_update("", SHA_A));
        assert!(!is_update(SHA_A, ""));
        assert!(!is_update("  ", SHA_A));
    }

    #[test]
    fn parse_prefers_full_sha_target_commitish() {
        let got = parse_release_rev(Some(SHA_A), Some("Rolling build from deadbeef — 2026."));
        assert_eq!(got.as_deref(), Some(SHA_A));
    }

    #[test]
    fn parse_falls_back_to_notes_when_target_is_a_branch() {
        // GitHub sometimes returns a branch name here; the notes still carry the SHA.
        let notes = format!("Rolling build from {SHA_B} — 2026-07-20T23:00:00Z.");
        let got = parse_release_rev(Some("master"), Some(&notes));
        assert_eq!(got.as_deref(), Some(SHA_B));
    }

    #[test]
    fn parse_ignores_timestamp_digits_in_notes() {
        // No 40-hex SHA present: the ISO timestamp must not be mistaken for one.
        let got = parse_release_rev(Some("master"), Some("Built at 2026-07-20T23:00:00Z."));
        assert_eq!(got, None);
    }

    #[test]
    fn parse_returns_none_without_any_commit() {
        assert_eq!(parse_release_rev(None, None), None);
        assert_eq!(parse_release_rev(Some(""), Some("")), None);
    }

    #[test]
    fn extract_sha40_finds_embedded_sha() {
        let text = format!("prefix {SHA_A} suffix");
        assert_eq!(extract_sha40(&text).as_deref(), Some(SHA_A));
    }

    #[test]
    fn extract_sha40_rejects_39_and_41_char_runs() {
        let short = "a".repeat(39);
        let long = "a".repeat(41);
        assert_eq!(extract_sha40(&short), None);
        assert_eq!(extract_sha40(&long), None);
    }

    #[test]
    fn short_rev_trims_full_sha_to_seven() {
        assert_eq!(short_rev(SHA_A), "0123456");
    }

    #[test]
    fn short_rev_passes_through_non_sha() {
        assert_eq!(short_rev("dev"), "dev");
    }
}
