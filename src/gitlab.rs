// GitLab link enrichment: turn a plain GitLab URL into rich metadata.
//
// When a chat message contains a GitLab link (a merge request, an issue, or a
// project), the UI wants to show a rich preview card — title, state, author,
// branches, labels — instead of a bare URL. GitLab does not expose that data in
// the link itself, so the backend fetches it from the GitLab REST API v4 and
// hands the structured result back over the WebSocket (see `enrich_link` in
// src/bin/server.rs). The front-ends never touch the network directly, exactly
// like every other read path.
//
// Two safety rails mirror the media proxy (src/teams_media.rs):
//   - HOST PINNING: the user's GitLab token is only ever attached to (and a
//     request only ever made to) the ONE host they configured. A URL whose host
//     is not that host is not enriched, so the token can never leak to an
//     arbitrary attacker-supplied link — a token-exfiltration / SSRF vector.
//   - BEST-EFFORT: enrichment is a nicety, not core function. A private/absent
//     resource (401/403/404) yields "no card" (Ok(None)); only a transient
//     failure (network, 5xx, parse) is an error the caller may retry later.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

/// The default GitLab host used when the user has not configured one. The public
/// SaaS instance; a self-hosted instance is set in Settings.
pub const DEFAULT_HOST: &str = "gitlab.com";

/// How long to wait on the GitLab API before giving up. Enrichment must never
/// hold a chat render up, so this is short.
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// Upper bound on the description snippet we surface (characters). The full body
/// can be arbitrarily long; a card only shows a teaser.
const MAX_DESCRIPTION_CHARS: usize = 240;

/// A GitLab resource we know how to enrich, parsed from a web URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resource {
    MergeRequest { project_path: String, iid: u64 },
    Issue { project_path: String, iid: u64 },
    Project { project_path: String },
}

/// Structured metadata for one GitLab resource, serialized to the UI. Optional
/// fields are omitted from the JSON when absent so the wire stays compact and the
/// TypeScript mirror can treat every optional as truly optional.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkMetadata {
    /// Discriminant for the UI: "merge_request" | "issue" | "project".
    pub kind: &'static str,
    /// Canonical web URL of the resource (GitLab's own `web_url` when available).
    pub url: String,
    /// Human title (MR/issue title, or the project's name-with-namespace).
    pub title: String,
    /// Full project path, e.g. "group/subgroup/project".
    pub project_path: String,
    /// Short human reference: "!42" for an MR, "#7" for an issue, "" for a project.
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Top-level URL path segments that are GitLab application routes, never a user's
/// project. A URL whose first path segment is one of these is not treated as a
/// project (so a `/groups/...` or `/users/...` page never becomes a project card).
const RESERVED_TOP_SEGMENTS: &[&str] = &[
    "-", "admin", "api", "dashboard", "explore", "groups", "help", "profile", "projects", "search",
    "users",
];

/// Split an `https://` URL into its lowercased host and its path (without query
/// or fragment). Returns `None` for anything that is not a plain `https` URL —
/// the token is never attached to `http`, `data:`, etc. Strips `userinfo@` and
/// `:port`. Deliberately dependency-free, mirroring `teams_media::https_host`.
fn split_host_path(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    // The authority ends at the first '/', '?' or '#'.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return None;
    }
    // Drop any credentials ("user:pass@host") and the port.
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port.split(':').next().unwrap_or(host_port);
    if host.is_empty() {
        return None;
    }
    // The path runs from the authority up to the first '?' or '#'.
    let after_authority = &rest[authority_end..];
    let path_end = after_authority.find(['?', '#']).unwrap_or(after_authority.len());
    let path = &after_authority[..path_end];
    Some((host.to_ascii_lowercase(), path.to_string()))
}

/// Parse a GitLab web URL into a supported [`Resource`], given the configured
/// GitLab host.
///
/// Returns `None` when the URL is not `https`, its host is not exactly the
/// configured host, or the path is not a merge request, an issue, or a project
/// we can enrich. GitLab separates the (possibly nested) project path from a
/// resource path with a literal `/-/` segment, e.g.
/// `https://gitlab.com/group/sub/project/-/merge_requests/42`.
pub fn parse_url(url: &str, gitlab_host: &str) -> Option<Resource> {
    let (host, path) = split_host_path(url)?;
    if host != gitlab_host.trim().to_ascii_lowercase() {
        return None;
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        // A single segment (or none) is a user/group/root page, never a project.
        return None;
    }

    if let Some(dash) = segments.iter().position(|s| *s == "-") {
        // A project path followed by "/-/<resource>/...". The project path is
        // everything before the marker; it must be non-empty.
        if dash == 0 {
            return None;
        }
        let project_path = segments[..dash].join("/");
        match segments[dash + 1..] {
            ["merge_requests", iid, ..] => iid
                .parse::<u64>()
                .ok()
                .map(|iid| Resource::MergeRequest { project_path, iid }),
            ["issues", iid, ..] => iid
                .parse::<u64>()
                .ok()
                .map(|iid| Resource::Issue { project_path, iid }),
            // Other resources (commits, pipelines, blobs, …) are not enriched yet.
            _ => None,
        }
    } else {
        // No "/-/" marker: a bare project (or group) page. Skip GitLab's own
        // top-level routes so a "/groups/..." or "/users/..." link is not
        // mistaken for a project.
        let first = segments[0].to_ascii_lowercase();
        if RESERVED_TOP_SEGMENTS.contains(&first.as_str()) {
            return None;
        }
        Some(Resource::Project {
            project_path: segments.join("/"),
        })
    }
}

/// Fetch metadata for the GitLab resource named by `url`.
///
/// - `Ok(Some(meta))` — the resource was found and enriched.
/// - `Ok(None)` — the URL is not an enrichable GitLab resource on the configured
///   host, or the resource is private/absent (401/403/404). Definitively "no
///   card"; the caller may cache this.
/// - `Err(_)` — a transient failure (network, timeout, 5xx, malformed body) the
///   caller should treat as "try again later", not "no card".
///
/// The `token` (a GitLab personal access token, when configured) is sent only to
/// the configured host, as the `PRIVATE-TOKEN` header GitLab expects.
pub async fn fetch_metadata(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    url: &str,
) -> Result<Option<LinkMetadata>> {
    let Some(resource) = parse_url(url, gitlab_host) else {
        return Ok(None);
    };

    let host = gitlab_host.trim();
    let api_base = format!("https://{host}/api/v4");
    let endpoint = match &resource {
        Resource::MergeRequest { project_path, iid } => {
            format!("{api_base}/projects/{}/merge_requests/{iid}", encode_path(project_path))
        }
        Resource::Issue { project_path, iid } => {
            format!("{api_base}/projects/{}/issues/{iid}", encode_path(project_path))
        }
        Resource::Project { project_path } => {
            format!("{api_base}/projects/{}", encode_path(project_path))
        }
    };

    let mut request = http
        .get(&endpoint)
        .header("Accept", "application/json")
        .timeout(HTTP_TIMEOUT);
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        request = request.header("PRIVATE-TOKEN", token);
    }

    let resp = request.send().await.context("gitlab api request")?;
    let status = resp.status();

    // Private, forbidden, or gone: we reached GitLab but cannot enrich this one.
    // Not an error — the UI simply shows the plain link.
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
            | reqwest::StatusCode::NOT_FOUND
    ) {
        return Ok(None);
    }
    // Anything else non-2xx (429, 5xx, …) is transient: surface it so the caller
    // can retry rather than caching a permanent "no card".
    if !status.is_success() {
        anyhow::bail!("gitlab api -> {status}");
    }

    let body: serde_json::Value = resp.json().await.context("gitlab api body")?;
    Ok(Some(build_metadata(&resource, &body, url)))
}

/// Percent-encode a project path for use as a single GitLab API path segment.
/// GitLab accepts the URL-encoded `namespace/project` in place of a numeric id,
/// so the slashes must become `%2F`.
fn encode_path(project_path: &str) -> String {
    urlencoding::encode(project_path).into_owned()
}

/// Read a non-empty string field from a JSON object.
fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// Read a nested non-empty string field (`value[outer][inner]`).
fn nested_str(value: &serde_json::Value, outer: &str, inner: &str) -> Option<String> {
    value.get(outer).and_then(|v| str_field(v, inner))
}

/// Read a `labels: ["a", "b"]` array into a `Vec<String>`, dropping empties.
fn labels_field(value: &serde_json::Value) -> Vec<String> {
    value
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Collapse whitespace and truncate a description body to a short teaser.
fn short_description(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_DESCRIPTION_CHARS {
        return Some(trimmed.to_string());
    }
    let cut: String = trimmed.chars().take(MAX_DESCRIPTION_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// Build [`LinkMetadata`] from a GitLab API JSON body for the given resource.
/// `fallback_url` is used when the body has no `web_url` (so the card always
/// links somewhere sensible).
fn build_metadata(
    resource: &Resource,
    body: &serde_json::Value,
    fallback_url: &str,
) -> LinkMetadata {
    let web_url = str_field(body, "web_url").unwrap_or_else(|| fallback_url.to_string());
    let description = str_field(body, "description").and_then(|d| short_description(&d));
    let created_at = str_field(body, "created_at");
    let updated_at = str_field(body, "updated_at");

    match resource {
        Resource::MergeRequest { project_path, iid } => LinkMetadata {
            kind: "merge_request",
            url: web_url,
            title: str_field(body, "title").unwrap_or_else(|| format!("Merge request !{iid}")),
            project_path: project_path.clone(),
            reference: nested_str(body, "references", "short").unwrap_or_else(|| format!("!{iid}")),
            state: str_field(body, "state"),
            draft: body
                .get("draft")
                .and_then(serde_json::Value::as_bool)
                .or_else(|| body.get("work_in_progress").and_then(serde_json::Value::as_bool)),
            author_name: nested_str(body, "author", "name"),
            source_branch: str_field(body, "source_branch"),
            target_branch: str_field(body, "target_branch"),
            labels: labels_field(body),
            milestone: nested_str(body, "milestone", "title"),
            description,
            created_at,
            updated_at,
        },
        Resource::Issue { project_path, iid } => LinkMetadata {
            kind: "issue",
            url: web_url,
            title: str_field(body, "title").unwrap_or_else(|| format!("Issue #{iid}")),
            project_path: project_path.clone(),
            reference: nested_str(body, "references", "short").unwrap_or_else(|| format!("#{iid}")),
            state: str_field(body, "state"),
            draft: None,
            author_name: nested_str(body, "author", "name"),
            source_branch: None,
            target_branch: None,
            labels: labels_field(body),
            milestone: nested_str(body, "milestone", "title"),
            description,
            created_at,
            updated_at,
        },
        Resource::Project { project_path } => LinkMetadata {
            kind: "project",
            url: web_url,
            title: str_field(body, "name_with_namespace")
                .or_else(|| str_field(body, "name"))
                .unwrap_or_else(|| project_path.clone()),
            project_path: str_field(body, "path_with_namespace")
                .unwrap_or_else(|| project_path.clone()),
            reference: String::new(),
            state: None,
            draft: None,
            author_name: None,
            source_branch: None,
            target_branch: None,
            labels: Vec::new(),
            milestone: None,
            description,
            created_at,
            updated_at,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_merge_request_url() {
        assert_eq!(
            parse_url("https://gitlab.com/group/project/-/merge_requests/42", "gitlab.com"),
            Some(Resource::MergeRequest {
                project_path: "group/project".to_string(),
                iid: 42,
            })
        );
    }

    #[test]
    fn parses_a_nested_group_merge_request() {
        assert_eq!(
            parse_url(
                "https://gitlab.com/group/sub/project/-/merge_requests/7",
                "gitlab.com"
            ),
            Some(Resource::MergeRequest {
                project_path: "group/sub/project".to_string(),
                iid: 7,
            })
        );
    }

    #[test]
    fn parses_an_issue_url() {
        assert_eq!(
            parse_url("https://gitlab.com/group/project/-/issues/9", "gitlab.com"),
            Some(Resource::Issue {
                project_path: "group/project".to_string(),
                iid: 9,
            })
        );
    }

    #[test]
    fn merge_request_url_with_suffix_and_query_still_parses() {
        // A tab/diff suffix and a query string must not defeat the iid parse.
        assert_eq!(
            parse_url(
                "https://gitlab.com/group/project/-/merge_requests/42/diffs?tab=changes",
                "gitlab.com"
            ),
            Some(Resource::MergeRequest {
                project_path: "group/project".to_string(),
                iid: 42,
            })
        );
    }

    #[test]
    fn parses_a_project_url() {
        assert_eq!(
            parse_url("https://gitlab.com/group/project", "gitlab.com"),
            Some(Resource::Project {
                project_path: "group/project".to_string(),
            })
        );
    }

    #[test]
    fn trailing_slash_project_url_parses() {
        assert_eq!(
            parse_url("https://gitlab.com/group/project/", "gitlab.com"),
            Some(Resource::Project {
                project_path: "group/project".to_string(),
            })
        );
    }

    #[test]
    fn rejects_a_different_host() {
        // The token must never be sent to a host other than the configured one.
        assert_eq!(
            parse_url("https://gitlab.example.com/group/project/-/merge_requests/1", "gitlab.com"),
            None
        );
    }

    #[test]
    fn honors_a_self_hosted_host() {
        assert_eq!(
            parse_url(
                "https://gitlab.example.com/team/app/-/merge_requests/3",
                "gitlab.example.com"
            ),
            Some(Resource::MergeRequest {
                project_path: "team/app".to_string(),
                iid: 3,
            })
        );
    }

    #[test]
    fn rejects_non_https() {
        assert_eq!(
            parse_url("http://gitlab.com/group/project/-/merge_requests/1", "gitlab.com"),
            None
        );
    }

    #[test]
    fn rejects_reserved_top_level_routes() {
        assert_eq!(parse_url("https://gitlab.com/groups/my-group", "gitlab.com"), None);
        assert_eq!(parse_url("https://gitlab.com/users/someone", "gitlab.com"), None);
        assert_eq!(parse_url("https://gitlab.com/dashboard/issues", "gitlab.com"), None);
        assert_eq!(parse_url("https://gitlab.com/-/profile", "gitlab.com"), None);
    }

    #[test]
    fn rejects_single_segment_and_unsupported_resources() {
        // A single path segment is a user/group page, not a project.
        assert_eq!(parse_url("https://gitlab.com/gitlab-org", "gitlab.com"), None);
        // A commit / blob under "/-/" is not (yet) enriched.
        assert_eq!(
            parse_url("https://gitlab.com/group/project/-/commit/deadbeef", "gitlab.com"),
            None
        );
        assert_eq!(
            parse_url("https://gitlab.com/group/project/-/blob/main/README.md", "gitlab.com"),
            None
        );
    }

    #[test]
    fn host_match_is_case_insensitive() {
        assert_eq!(
            parse_url("https://GitLab.com/group/project/-/issues/1", "gitlab.com"),
            Some(Resource::Issue {
                project_path: "group/project".to_string(),
                iid: 1,
            })
        );
    }

    #[test]
    fn encode_path_escapes_slashes() {
        assert_eq!(encode_path("group/sub/project"), "group%2Fsub%2Fproject");
    }

    #[test]
    fn short_description_collapses_and_truncates() {
        assert_eq!(short_description("  hello   world  ").as_deref(), Some("hello world"));
        assert_eq!(short_description("   ").as_deref(), None);
        let long = "x ".repeat(300);
        let out = short_description(&long).unwrap();
        assert!(out.chars().count() <= MAX_DESCRIPTION_CHARS + 1); // +1 for the ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn builds_merge_request_metadata_from_api_body() {
        let body = serde_json::json!({
            "title": "Add rich link previews",
            "state": "opened",
            "draft": true,
            "web_url": "https://gitlab.com/group/project/-/merge_requests/42",
            "source_branch": "feat/links",
            "target_branch": "main",
            "author": { "name": "Ada Lovelace" },
            "references": { "short": "!42" },
            "labels": ["frontend", "enhancement"],
            "milestone": { "title": "v1.0" },
            "description": "This adds cards for GitLab links."
        });
        let resource = Resource::MergeRequest {
            project_path: "group/project".to_string(),
            iid: 42,
        };
        let meta = build_metadata(&resource, &body, "https://example");
        assert_eq!(meta.kind, "merge_request");
        assert_eq!(meta.title, "Add rich link previews");
        assert_eq!(meta.state.as_deref(), Some("opened"));
        assert_eq!(meta.draft, Some(true));
        assert_eq!(meta.reference, "!42");
        assert_eq!(meta.source_branch.as_deref(), Some("feat/links"));
        assert_eq!(meta.target_branch.as_deref(), Some("main"));
        assert_eq!(meta.author_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(meta.labels, vec!["frontend", "enhancement"]);
        assert_eq!(meta.milestone.as_deref(), Some("v1.0"));
    }

    #[test]
    fn merge_request_metadata_falls_back_when_fields_missing() {
        let resource = Resource::MergeRequest {
            project_path: "group/project".to_string(),
            iid: 5,
        };
        let meta = build_metadata(&resource, &serde_json::json!({}), "https://fallback");
        assert_eq!(meta.title, "Merge request !5");
        assert_eq!(meta.reference, "!5");
        assert_eq!(meta.url, "https://fallback");
        assert!(meta.labels.is_empty());
        assert_eq!(meta.description, None);
    }
}
