// Linear link enrichment: turn a plain Linear URL into rich metadata.
//
// When a chat message contains a Linear link (an issue, a project, or a
// document), the UI wants to show a rich preview card — title, workflow state,
// assignee, labels, progress — instead of a bare URL. Linear does not expose that
// data in the link itself, so the backend fetches it from the Linear GraphQL API
// and hands the structured result back over the WebSocket (see `enrich_link` in
// src/bin/server.rs). The front-ends never touch the network directly, exactly
// like every other read path. This mirrors src/gitlab.rs, whose shape it follows.
//
// Three safety rails:
//   - THE ENDPOINT IS A CONSTANT. `API_URL` is hard-coded and never derived from
//     the link being enriched, so the user's Linear key can only ever reach
//     Linear. GitLab needs host *pinning* because its host is configurable; here
//     the same guarantee is structural — there is no host to get wrong.
//   - READ-ONLY BY CONSTRUCTION. A Linear personal API key carries full write
//     access (it can create, edit and comment on issues as the user), so nothing
//     at the API level stops a write. What stops it is that this module only ever
//     sends GraphQL *queries*: every request goes through `run_query`, and a test
//     scans the module's own source for `mutation`. Enriching a link must never
//     become a way to change the user's workspace.
//   - BEST-EFFORT. Enrichment is a nicety, not core function. A private/absent
//     resource, or no configured key, yields "no card" (Ok(None)); only a
//     transient failure (network, 5xx, rate limit, parse) is an error the caller
//     may retry later.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::tracker_people::Person;

/// Linear's GraphQL endpoint. A constant on purpose — see the module doc: the
/// user's API key is only ever sent here, never to a host taken from a link.
pub const API_URL: &str = "https://api.linear.app/graphql";

/// The one host whose links this module enriches. Linear is SaaS-only: there is
/// no self-hosted instance, so unlike the GitLab host this is not configurable.
pub const WEB_HOST: &str = "linear.app";

/// How long to wait on the Linear API before giving up. Enrichment must never
/// hold a chat render up, so this is short.
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// Upper bound on the description snippet we surface (characters). The full body
/// can be arbitrarily long; a card only shows a teaser.
const MAX_DESCRIPTION_CHARS: usize = 240;

/// How many labels we carry to the UI. The card shows a few and counts the rest.
const MAX_LABELS: usize = 10;

/// A Linear resource we know how to enrich, parsed from a web URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resource {
    /// `linear.app/<workspace>/issue/<TEAM-123>/<slug>` — looked up by its
    /// human identifier, which Linear's `issue(id:)` accepts directly.
    Issue { identifier: String },
    /// `linear.app/<workspace>/project/<name>-<slugId>` — looked up by the
    /// trailing slug id.
    Project { slug_id: String },
    /// `linear.app/<workspace>/document/<title>-<slugId>` — same shape.
    Document { slug_id: String },
}

/// One Linear label, with the colour Linear itself shows it in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Label {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Structured metadata for one Linear resource, serialized to the UI. Optional
/// fields are omitted from the JSON when absent so the wire stays compact and the
/// TypeScript mirror can treat every optional as truly optional.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkMetadata {
    /// Discriminant for the UI: "issue" | "project" | "document".
    pub kind: &'static str,
    /// Canonical web URL of the resource (Linear's own `url` when available).
    pub url: String,
    /// Human title (issue/project/document title).
    pub title: String,
    /// Human reference for an issue, e.g. "ENG-123"; empty for the others.
    pub identifier: String,
    /// Owning team(s) — one team's name for an issue, the joined names for a
    /// project (a Linear project can span teams).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Workflow state (issue) or status (project) name, as shown in Linear:
    /// "In Progress", "Pending Review", "Backlog", …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The state's *category*, which is what the card colours and shapes its icon
    /// from: an issue is "backlog" | "unstarted" | "started" | "completed" |
    /// "canceled" | "triage"; a project adds "planned" and "paused". Stable
    /// across workspaces, unlike the freely-renamed `state`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_type: Option<String>,
    /// The state's colour in Linear, as a CSS hex string ("#5e6ad2").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_color: Option<String>,
    /// Who the issue is assigned to.
    ///
    /// A PERSON rather than a bare name, and that is what lets the card draw the colleague
    /// the user already knows — their Teams face and the name this app calls them — instead
    /// of Linear's own words (see [`crate::tracker_people`], whose walk finds this shape).
    /// The three below are one rule: whichever of them the resource has is "who owns this".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<Person>,
    /// Who leads the project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<Person>,
    /// Who wrote the document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<Person>,
    /// Linear's numeric priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. The
    /// card decides from this whether a priority badge is worth the space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    /// The priority's own label ("Urgent", "High", …), which the badge shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority_label: Option<String>,
    /// The project an issue or document belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Parent issue identifier, for a sub-issue ("ENG-120").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<Label>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Issue due date, as Linear's plain "YYYY-MM-DD".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    /// Project target date, same format.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    /// Project completion, 0.0–1.0. The card draws a progress bar from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

/// Parse a Linear web URL into a supported [`Resource`].
///
/// Returns `None` when the URL is not `https`, its host is not `linear.app`, or
/// the path is not an issue, a project, or a document we can enrich. Every Linear
/// URL is scoped to a workspace, so the path is
/// `/<workspace>/<kind>/<id>[/<extra>…]`; the workspace itself is not needed for
/// the lookup, because the API key already determines which workspace we can see.
pub fn parse_url(url: &str) -> Option<Resource> {
    let (host, path) = split_host_path(url)?;
    if host != WEB_HOST {
        return None;
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // `/<workspace>/<kind>/<id>` is the shortest enrichable shape.
    let (kind, id) = match segments.as_slice() {
        [_workspace, kind, id, ..] => (*kind, *id),
        _ => return None,
    };

    match kind {
        "issue" => parse_identifier(id).map(|identifier| Resource::Issue { identifier }),
        "project" => parse_slug_id(id).map(|slug_id| Resource::Project { slug_id }),
        "document" => parse_slug_id(id).map(|slug_id| Resource::Document { slug_id }),
        // Cycles, roadmaps, saved views and team pages are not enriched yet.
        _ => None,
    }
}

/// Split an `https://` URL into its lowercased host and its path (without query
/// or fragment). Returns `None` for anything that is not a plain `https` URL.
/// Strips `userinfo@` and `:port`. Deliberately dependency-free, mirroring
/// `gitlab::split_host_path`.
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
    Some((host.to_ascii_lowercase(), after_authority[..path_end].to_string()))
}

/// Validate an issue identifier — a team key, a hyphen, and a number ("ENG-123").
/// Returned upper-cased, which is how Linear writes it everywhere. Anything else
/// is not an identifier and is not sent to the API.
fn parse_identifier(segment: &str) -> Option<String> {
    let (team, number) = segment.rsplit_once('-')?;
    if team.is_empty() || !team.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(segment.to_ascii_uppercase())
}

/// Extract the slug id that ends a project/document URL segment. Linear builds
/// these as `<title-slug>-<slugId>`, where the id is a fixed run of lowercase hex
/// — `fossilisation-refonte-sur-temporal-d6029dd5b9a8`. Only the id is needed:
/// `project(id:)` and `document(id:)` both accept it.
fn parse_slug_id(segment: &str) -> Option<String> {
    let candidate = segment.rsplit('-').next()?;
    let looks_like_id = candidate.len() >= 8
        && candidate.len() <= 36
        && candidate.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    looks_like_id.then(|| candidate.to_string())
}

/// Fetch metadata for the Linear resource named by `url`.
///
/// - `Ok(Some(meta))` — the resource was found and enriched.
/// - `Ok(None)` — the URL is not an enrichable Linear resource, no API key is
///   configured, or the resource is absent/forbidden for this key. Definitively
///   "no card"; the caller may cache this.
/// - `Err(_)` — a transient failure (network, timeout, 5xx, rate limit, malformed
///   body) the caller should treat as "try again later", not "no card".
///
/// Unlike GitLab, Linear has no anonymous read: without a key every request is a
/// 401, so an unconfigured integration skips the network entirely.
pub async fn fetch_metadata(
    http: &reqwest::Client,
    token: Option<&str>,
    url: &str,
) -> Result<Option<LinkMetadata>> {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let Some(resource) = parse_url(url) else {
        return Ok(None);
    };

    let (query, field, id) = match &resource {
        Resource::Issue { identifier } => (ISSUE_QUERY, "issue", identifier.as_str()),
        Resource::Project { slug_id } => (PROJECT_QUERY, "project", slug_id.as_str()),
        Resource::Document { slug_id } => (DOCUMENT_QUERY, "document", slug_id.as_str()),
    };

    let Some(entity) = run_query(http, token, query, id, field).await? else {
        return Ok(None);
    };
    Ok(Some(build_metadata(&resource, &entity, url)))
}

/// The issue query. Written as a parameterized GraphQL *query* with a variable —
/// never string-interpolated — so a link can carry no GraphQL of its own.
const ISSUE_QUERY: &str = "\
query IssueLink($id: String!) {
  issue(id: $id) {
    identifier
    title
    url
    description
    priority
    priorityLabel
    dueDate
    state { name type color }
    assignee { name displayName }
    team { name }
    project { name }
    parent { identifier }
    labels(first: 10) { nodes { name color } }
  }
}";

/// The project query. `progress` is a 0–1 fraction; `status` is the project's own
/// status object, the analogue of an issue's workflow state.
const PROJECT_QUERY: &str = "\
query ProjectLink($id: String!) {
  project(id: $id) {
    name
    url
    description
    progress
    targetDate
    status { name type color }
    lead { name displayName }
    teams(first: 5) { nodes { name } }
  }
}";

/// The document query. A document's body is `content` (Markdown), not
/// `description`.
const DOCUMENT_QUERY: &str = "\
query DocumentLink($id: String!) {
  document(id: $id) {
    title
    url
    content
    creator { name displayName }
    project { name }
  }
}";

/// GraphQL error codes that mean "try again later" rather than "no card". Linear
/// answers HTTP 200 with an `errors` array for a missing or forbidden entity, so
/// the body — not the status — decides which of the two happened. Everything not
/// listed here (a not-found entity, an input error, a permission error) is
/// definitive.
const TRANSIENT_ERROR_CODES: &[&str] = &[
    "RATELIMITED",
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "TIMEOUT",
    "NETWORK_ERROR",
];

/// Run one GraphQL query against Linear and return the named top-level field.
///
/// This is the module's ONLY request path, and it only ever sends a query — see
/// the read-only rail in the module doc. `Ok(None)` means "Linear answered, and
/// there is nothing to show"; `Err` means "ask again later".
async fn run_query(
    http: &reqwest::Client,
    token: &str,
    query: &str,
    id: &str,
    field: &str,
) -> Result<Option<serde_json::Value>> {
    let resp = http
        .post(API_URL)
        .header("Accept", "application/json")
        // A Linear personal API key is sent raw, with no "Bearer" prefix.
        .header("Authorization", token)
        .timeout(HTTP_TIMEOUT)
        .json(&serde_json::json!({ "query": query, "variables": { "id": id } }))
        .send()
        .await
        .context("linear api request")?;

    let status = resp.status();
    // A rejected or expired key is definitively "no card" — the same treatment
    // GitLab's 401/403 gets. It must not spin on retries.
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Ok(None);
    }
    // Anything else non-2xx (429, 5xx, …) is transient: surface it so the caller
    // can retry rather than caching a permanent "no card".
    if !status.is_success() {
        anyhow::bail!("linear api -> {status}");
    }

    let body: serde_json::Value = resp.json().await.context("linear api body")?;
    if let Some(code) = transient_error_code(&body) {
        anyhow::bail!("linear api error: {code}");
    }
    Ok(body
        .get("data")
        .and_then(|data| data.get(field))
        .filter(|entity| entity.is_object())
        .cloned())
}

/// The first transient error code in a GraphQL response body, if any. Used to
/// tell "come back later" apart from "there is no such issue".
fn transient_error_code(body: &serde_json::Value) -> Option<String> {
    body.get("errors")?
        .as_array()?
        .iter()
        .filter_map(|error| str_field(error.get("extensions")?, "code"))
        .find(|code| TRANSIENT_ERROR_CODES.contains(&code.as_str()))
}

/// Read a non-empty string field from a JSON object.
fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Read a nested non-empty string field (`value[outer][inner]`).
fn nested_str(value: &serde_json::Value, outer: &str, inner: &str) -> Option<String> {
    value.get(outer).and_then(|v| str_field(v, inner))
}

/// One person from a Linear user object, or `None` when the resource has nobody there.
///
/// Linear's `displayName` IS its handle ("clement.delbarre") and its `name` is the real name,
/// so the pair maps onto [`Person`]'s `name` / `username` — the same two words GitLab gives,
/// which is what makes ONE match rule cover both trackers. A user with no name set falls back
/// to the handle rather than to a blank, exactly as [`crate::gitlab::person`] does.
pub fn person(value: &serde_json::Value, key: &str) -> Option<Person> {
    let who = value.get(key).filter(|v| !v.is_null())?;
    let username = str_field(who, "displayName").unwrap_or_default();
    let name = str_field(who, "name").unwrap_or_else(|| username.clone());
    if name.is_empty() && username.is_empty() {
        return None;
    }
    Some(Person { name, username, avatar_url: None })
}

/// Read a `{ nodes: [...] }` connection into a plain slice of its nodes.
fn connection_nodes<'a>(value: &'a serde_json::Value, key: &str) -> &'a [serde_json::Value] {
    value
        .get(key)
        .and_then(|conn| conn.get("nodes"))
        .and_then(serde_json::Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Read the `labels` connection into name + colour pairs, dropping unnamed ones.
fn labels_field(body: &serde_json::Value) -> Vec<Label> {
    connection_nodes(body, "labels")
        .iter()
        .filter_map(|node| {
            Some(Label {
                name: str_field(node, "name")?,
                color: str_field(node, "color"),
            })
        })
        .take(MAX_LABELS)
        .collect()
}

/// Join the names of a project's teams — a Linear project can span several, and
/// the card shows them as one line.
fn team_names(body: &serde_json::Value) -> Option<String> {
    let names: Vec<String> = connection_nodes(body, "teams")
        .iter()
        .filter_map(|node| str_field(node, "name"))
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

/// Linear's priority scale, clamped to the 0–4 it actually uses. A value outside
/// that range is a scale we do not know, so it is dropped rather than shown.
fn priority(body: &serde_json::Value) -> Option<u8> {
    let raw = body.get("priority")?.as_f64()?.round();
    (0.0..=4.0).contains(&raw).then_some(raw as u8)
}

/// Given the index of a `[` in `chars`, find the matching `](…)` and return the
/// span of the link text plus the index just past the closing `)`. `None` when
/// the construct is not a complete Markdown link.
fn markdown_link_at(chars: &[char], open: usize) -> Option<(std::ops::Range<usize>, usize)> {
    let close = open + 1 + chars[open + 1..].iter().position(|c| *c == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let paren = close + 2 + chars[close + 2..].iter().position(|c| *c == ')')?;
    Some((open + 1..close, paren + 1))
}

/// Markers we drop wherever they appear, because in Linear's Markdown they are
/// always formatting: heading and quote markers, emphasis, code fences, and table
/// rules.
///
/// `_` is deliberately NOT here: in engineering prose a snake_case identifier is
/// far likelier than `_emphasis_`, and mangling `trace_state` to read `tracestate`
/// is worse than leaving an underscore in the teaser. `-` is not here either, for
/// the same reason (`well-known`, `-5`); a hyphen that opens a LINE is a bullet,
/// and that is [`strip_line_prefix`]'s job.
const MARKDOWN_MARKERS: &[char] = &['#', '*', '`', '>', '~', '|'];

/// Characters that open a bullet at the START of a line. `*` and `>` are also in
/// [`MARKDOWN_MARKERS`], which drops them anywhere; they are repeated here because
/// this pass has to step PAST the bullet to find a task-list box behind it, and
/// "* [ ] Ship it" must reduce to "Ship it" rather than to "[ ] Ship it".
const LINE_BULLETS: &[char] = &['-', '+', '*', '>'];

/// The task-list boxes Linear writes for a checklist item.
const TASK_BOXES: &[&str] = &["[ ]", "[x]", "[X]"];

/// Strip one line's leading list plumbing: a bullet, an ordered marker, and a
/// task-list box. Without this a checklist description — which is most of them —
/// reads as "- [ ] Admin access - [ ] Preprod" in the card's one-line teaser.
///
/// A marker only counts when whitespace (or the line's end) follows it, so a line
/// opening with "-5 degrees" or "1.5x" keeps its text intact.
fn strip_line_prefix(line: &str) -> &str {
    let mut rest = line.trim_start();

    let bullet = rest.trim_start_matches(|c| LINE_BULLETS.contains(&c));
    if bullet.len() < rest.len() && starts_with_space_or_ends(bullet) {
        rest = bullet.trim_start();
    } else {
        // An ordered item: "1. " or "2) ".
        let digits = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        let after_dot = digits.strip_prefix('.').or_else(|| digits.strip_prefix(')'));
        if let Some(after_dot) = after_dot.filter(|_| digits.len() < rest.len()) {
            if starts_with_space_or_ends(after_dot) {
                rest = after_dot.trim_start();
            }
        }
    }

    for box_ in TASK_BOXES {
        if let Some(stripped) = rest.strip_prefix(box_) {
            if starts_with_space_or_ends(stripped) {
                return stripped.trim_start();
            }
        }
    }
    rest
}

/// Whether `text` is empty or begins with whitespace — how we tell a list marker
/// from a hyphen or a decimal that merely happens to open a line.
fn starts_with_space_or_ends(text: &str) -> bool {
    text.chars().next().is_none_or(char::is_whitespace)
}

/// Turn a Markdown body into a one-line plain-text teaser: image embeds go, links
/// keep only their text, formatting markers are dropped, whitespace collapses, and
/// the result is truncated with an ellipsis.
///
/// Linear stores descriptions as Markdown, so without this a card would show
/// `## Context` and a raw `![image.png](https://uploads.linear.app/…)` URL.
fn markdown_snippet(raw: &str) -> Option<String> {
    // Line by line first, because a bullet and a task box are only plumbing where
    // they open a line; then character by character for the inline constructs.
    let delisted = raw.lines().map(strip_line_prefix).collect::<Vec<_>>().join("\n");
    let chars: Vec<char> = delisted.chars().collect();
    let mut plain = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // "![alt](url)" — an embed, dropped whole: its alt text and URL are noise.
        if c == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some((_, end)) = markdown_link_at(&chars, i + 1) {
                i = end;
                continue;
            }
        }
        // "[text](url)" — keep the text, drop the target.
        if c == '[' {
            if let Some((text, end)) = markdown_link_at(&chars, i) {
                plain.extend(&chars[text]);
                i = end;
                continue;
            }
        }
        if !MARKDOWN_MARKERS.contains(&c) {
            plain.push(c);
        }
        i += 1;
    }

    let collapsed = plain.split_whitespace().collect::<Vec<_>>().join(" ");
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

/// Build [`LinkMetadata`] from a Linear GraphQL entity for the given resource.
/// `fallback_url` is used when the entity has no `url` (so the card always links
/// somewhere sensible).
fn build_metadata(
    resource: &Resource,
    body: &serde_json::Value,
    fallback_url: &str,
) -> LinkMetadata {
    let url = str_field(body, "url").unwrap_or_else(|| fallback_url.to_string());

    match resource {
        Resource::Issue { identifier } => LinkMetadata {
            kind: "issue",
            url,
            title: str_field(body, "title").unwrap_or_else(|| identifier.clone()),
            identifier: str_field(body, "identifier").unwrap_or_else(|| identifier.clone()),
            team: nested_str(body, "team", "name"),
            state: nested_str(body, "state", "name"),
            state_type: nested_str(body, "state", "type"),
            state_color: nested_str(body, "state", "color"),
            assignee: person(body, "assignee"),
            lead: None,
            creator: None,
            priority: priority(body),
            priority_label: str_field(body, "priorityLabel"),
            project: nested_str(body, "project", "name"),
            parent: nested_str(body, "parent", "identifier"),
            labels: labels_field(body),
            description: str_field(body, "description")
                .and_then(|body| markdown_snippet(&body)),
            due_date: str_field(body, "dueDate"),
            target_date: None,
            progress: None,
        },
        Resource::Project { slug_id } => LinkMetadata {
            kind: "project",
            url,
            title: str_field(body, "name").unwrap_or_else(|| slug_id.clone()),
            identifier: String::new(),
            team: team_names(body),
            state: nested_str(body, "status", "name"),
            state_type: nested_str(body, "status", "type"),
            state_color: nested_str(body, "status", "color"),
            assignee: None,
            lead: person(body, "lead"),
            creator: None,
            priority: None,
            priority_label: None,
            project: None,
            parent: None,
            labels: Vec::new(),
            description: str_field(body, "description")
                .and_then(|body| markdown_snippet(&body)),
            due_date: None,
            target_date: str_field(body, "targetDate"),
            progress: body.get("progress").and_then(serde_json::Value::as_f64),
        },
        Resource::Document { slug_id } => LinkMetadata {
            kind: "document",
            url,
            title: str_field(body, "title").unwrap_or_else(|| slug_id.clone()),
            identifier: String::new(),
            team: None,
            state: None,
            state_type: None,
            state_color: None,
            assignee: None,
            lead: None,
            creator: person(body, "creator"),
            priority: None,
            priority_label: None,
            project: nested_str(body, "project", "name"),
            parent: None,
            labels: Vec::new(),
            description: str_field(body, "content").and_then(|body| markdown_snippet(&body)),
            due_date: None,
            target_date: None,
            progress: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE no-write guarantee, enforced on this module's own source: a Linear API
    /// key can create and edit issues as the user, and the only thing standing
    /// between this codebase and a write is that no query here is a mutation. A
    /// future edit that adds one fails this test instead of quietly gaining the
    /// ability to change the user's workspace. Mirrors the mail/calendar rails.
    #[test]
    fn module_sends_queries_only() {
        let source = include_str!("linear.rs");
        // Skip this test module, whose own body necessarily names the forbidden
        // keyword, then strip comments so the module doc does not match either.
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("async fn run_query"), "scanned the wrong text");
        for forbidden in ["mutation", "Mutation"] {
            assert!(
                !code.contains(forbidden),
                "src/linear.rs must send GraphQL queries only, found `{forbidden}`. Linear is \
                 read-only by construction: writing to the user's workspace is a deliberate \
                 feature that needs its own consent gate, not an edit to this module."
            );
        }
    }

    /// Strip `//` line comments so the source-scanning guardrail inspects CODE,
    /// not the prose that explains it. A `//` preceded by `:` is left alone so the
    /// `https://` inside a string literal survives. Mirrors `mail.rs`.
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| {
                let bytes = line.as_bytes();
                let mut cut = line.len();
                for i in 0..bytes.len().saturating_sub(1) {
                    if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                        cut = i;
                        break;
                    }
                }
                &line[..cut]
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn parses_an_issue_url() {
        assert_eq!(
            parse_url("https://linear.app/heka-internal/issue/STMN-3404/archived-traces"),
            Some(Resource::Issue {
                identifier: "STMN-3404".to_string()
            })
        );
    }

    #[test]
    fn parses_an_issue_url_without_a_slug() {
        assert_eq!(
            parse_url("https://linear.app/acme/issue/ENG-7"),
            Some(Resource::Issue {
                identifier: "ENG-7".to_string()
            })
        );
    }

    #[test]
    fn issue_identifier_is_upper_cased() {
        // Linear's own links are upper-case, but a hand-typed one may not be, and
        // the API accepts either — we normalize so the card reads like Linear.
        assert_eq!(
            parse_url("https://linear.app/acme/issue/eng-7/slug"),
            Some(Resource::Issue {
                identifier: "ENG-7".to_string()
            })
        );
    }

    #[test]
    fn comment_anchor_and_query_still_parse() {
        // A link to a comment on an issue is a link to the issue.
        assert_eq!(
            parse_url("https://linear.app/acme/issue/ENG-7/slug#comment-9f3a"),
            Some(Resource::Issue {
                identifier: "ENG-7".to_string()
            })
        );
        assert_eq!(
            parse_url("https://linear.app/acme/issue/ENG-7?tab=activity"),
            Some(Resource::Issue {
                identifier: "ENG-7".to_string()
            })
        );
    }

    #[test]
    fn parses_a_project_url() {
        assert_eq!(
            parse_url("https://linear.app/heka-internal/project/fossilisation-temporal-d6029dd5b9a8"),
            Some(Resource::Project {
                slug_id: "d6029dd5b9a8".to_string()
            })
        );
    }

    #[test]
    fn parses_a_project_url_with_a_tab_suffix() {
        assert_eq!(
            parse_url("https://linear.app/acme/project/website-redesign-a05573177921/issues"),
            Some(Resource::Project {
                slug_id: "a05573177921".to_string()
            })
        );
    }

    #[test]
    fn parses_a_document_url() {
        assert_eq!(
            parse_url("https://linear.app/acme/document/system-design-ebc85c4d4d74"),
            Some(Resource::Document {
                slug_id: "ebc85c4d4d74".to_string()
            })
        );
    }

    #[test]
    fn rejects_a_different_host() {
        // The API key only ever goes to api.linear.app, but a look-alike host must
        // not even produce a card claiming to be Linear.
        assert_eq!(parse_url("https://linear.app.evil.com/acme/issue/ENG-1"), None);
        assert_eq!(parse_url("https://notlinear.app/acme/issue/ENG-1"), None);
    }

    #[test]
    fn rejects_non_https() {
        assert_eq!(parse_url("http://linear.app/acme/issue/ENG-1"), None);
    }

    #[test]
    fn host_match_is_case_insensitive() {
        assert_eq!(
            parse_url("https://Linear.app/acme/issue/ENG-1"),
            Some(Resource::Issue {
                identifier: "ENG-1".to_string()
            })
        );
    }

    #[test]
    fn rejects_unsupported_and_malformed_paths() {
        // Workspace root, and a kind we do not enrich.
        assert_eq!(parse_url("https://linear.app/acme"), None);
        assert_eq!(parse_url("https://linear.app/acme/team/ENG/all"), None);
        assert_eq!(parse_url("https://linear.app/acme/settings/members"), None);
        // An "issue" segment that is not an identifier.
        assert_eq!(parse_url("https://linear.app/acme/issue/not-an-issue"), None);
        assert_eq!(parse_url("https://linear.app/acme/issue/ENG-"), None);
        assert_eq!(parse_url("https://linear.app/acme/issue/-7"), None);
        // A project segment with no slug id to look up.
        assert_eq!(parse_url("https://linear.app/acme/project/website"), None);
        assert_eq!(parse_url("https://linear.app/acme/project/website-redesign"), None);
    }

    #[test]
    fn slug_id_must_look_like_one() {
        assert_eq!(parse_slug_id("website-redesign-a05573177921").as_deref(), Some("a05573177921"));
        // Too short, not hex, or upper-case: not a Linear slug id.
        assert_eq!(parse_slug_id("website-abc123"), None);
        assert_eq!(parse_slug_id("website-zzzzzzzzzzzz"), None);
        assert_eq!(parse_slug_id("website-A05573177921"), None);
    }

    #[test]
    fn markdown_snippet_strips_markup_and_truncates() {
        assert_eq!(
            markdown_snippet("## Context\n\nToday an **archived** trace is a filter.").as_deref(),
            Some("Context Today an archived trace is a filter.")
        );
        // An image embed goes entirely; a link keeps its text.
        assert_eq!(
            markdown_snippet("See ![shot](https://uploads.linear.app/a/b) and [the ADR](https://x)")
                .as_deref(),
            Some("See and the ADR")
        );
        // A snake_case identifier survives, unlike under a naive `_` strip.
        assert_eq!(
            markdown_snippet("`createLink` never inspects trace_state.archived").as_deref(),
            Some("createLink never inspects trace_state.archived")
        );
        assert_eq!(markdown_snippet("   \n\n  ").as_deref(), None);
        let long = "word ".repeat(200);
        let out = markdown_snippet(&long).unwrap();
        assert!(out.chars().count() <= MAX_DESCRIPTION_CHARS + 1); // +1 for the ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn markdown_snippet_drops_list_plumbing() {
        // The shape most Linear descriptions actually have: a checklist. Without
        // this the teaser reads "- [ ] Admin access - [ ] Preprod".
        assert_eq!(
            markdown_snippet("Access:\n- [ ] Admin access\n- [x] Preprod\n").as_deref(),
            Some("Access: Admin access Preprod")
        );
        // Every bullet style, and an ordered list.
        assert_eq!(
            markdown_snippet("* One\n+ Two\n1. Three\n2) Four").as_deref(),
            Some("One Two Three Four")
        );
        // A box behind a bullet the global pass would otherwise strip first.
        assert_eq!(markdown_snippet("* [ ] Ship it").as_deref(), Some("Ship it"));
        // A horizontal rule contributes nothing rather than a row of hyphens.
        assert_eq!(markdown_snippet("Before\n--- \nAfter").as_deref(), Some("Before After"));
    }

    #[test]
    fn markdown_snippet_keeps_a_hyphen_or_a_decimal_that_is_not_a_bullet() {
        // The reason a marker must be followed by whitespace: these are text.
        assert_eq!(markdown_snippet("-5 degrees").as_deref(), Some("-5 degrees"));
        assert_eq!(markdown_snippet("1.5x faster").as_deref(), Some("1.5x faster"));
        assert_eq!(markdown_snippet("well-known ports").as_deref(), Some("well-known ports"));
        // A bracket that is not a task box, and not a link, is left alone.
        assert_eq!(markdown_snippet("[draft] the plan").as_deref(), Some("[draft] the plan"));
    }

    #[test]
    fn builds_issue_metadata_from_api_body() {
        let body = serde_json::json!({
            "identifier": "STMN-3404",
            "title": "Archived traces: freeze actions",
            "url": "https://linear.app/heka-internal/issue/STMN-3404/archived-traces",
            "description": "## Goal\n\nMake it unmistakable when a trace is archived.",
            "priority": 3,
            "priorityLabel": "Medium",
            "dueDate": "2026-09-01",
            "state": { "name": "Pending Review", "type": "started", "color": "#f2994a" },
            "assignee": { "name": "Clément DELBARRE", "displayName": "clement.delbarre" },
            "team": { "name": "Stratumn Engine" },
            "project": { "name": "Trace lifecycle" },
            "parent": { "identifier": "STMN-3400" },
            "labels": { "nodes": [
                { "name": "bug", "color": "#eb5757" },
                { "name": "ux" }
            ] }
        });
        let resource = Resource::Issue {
            identifier: "STMN-3404".to_string(),
        };
        let meta = build_metadata(&resource, &body, "https://fallback");
        assert_eq!(meta.kind, "issue");
        assert_eq!(meta.title, "Archived traces: freeze actions");
        assert_eq!(meta.identifier, "STMN-3404");
        assert_eq!(meta.state.as_deref(), Some("Pending Review"));
        assert_eq!(meta.state_type.as_deref(), Some("started"));
        assert_eq!(meta.state_color.as_deref(), Some("#f2994a"));
        // A person, not a bare name: the handle travels beside the real name, which is what
        // matches this colleague to the Teams person the card then draws.
        let assignee = meta.assignee.as_ref().expect("the issue names its assignee");
        assert_eq!(assignee.name, "Clément DELBARRE");
        assert_eq!(assignee.username, "clement.delbarre");
        assert_eq!(meta.team.as_deref(), Some("Stratumn Engine"));
        assert_eq!(meta.project.as_deref(), Some("Trace lifecycle"));
        assert_eq!(meta.parent.as_deref(), Some("STMN-3400"));
        assert_eq!(meta.priority, Some(3));
        assert_eq!(meta.priority_label.as_deref(), Some("Medium"));
        assert_eq!(meta.due_date.as_deref(), Some("2026-09-01"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Goal Make it unmistakable when a trace is archived.")
        );
        assert_eq!(
            meta.labels,
            vec![
                Label { name: "bug".to_string(), color: Some("#eb5757".to_string()) },
                Label { name: "ux".to_string(), color: None },
            ]
        );
        // Project/document-only fields stay absent on an issue.
        assert_eq!(meta.progress, None);
        assert_eq!(meta.lead, None);
        assert_eq!(meta.creator, None);
    }

    #[test]
    fn issue_metadata_falls_back_when_fields_missing() {
        let resource = Resource::Issue {
            identifier: "ENG-9".to_string(),
        };
        let meta = build_metadata(&resource, &serde_json::json!({}), "https://fallback");
        assert_eq!(meta.title, "ENG-9");
        assert_eq!(meta.identifier, "ENG-9");
        assert_eq!(meta.url, "https://fallback");
        assert!(meta.labels.is_empty());
        assert_eq!(meta.description, None);
        assert_eq!(meta.state, None);
        assert_eq!(meta.priority, None);
    }

    #[test]
    fn assignee_falls_back_to_the_display_name() {
        let body = serde_json::json!({ "assignee": { "displayName": "ada" } });
        let meta = build_metadata(
            &Resource::Issue { identifier: "ENG-1".to_string() },
            &body,
            "https://fallback",
        );
        let assignee = meta.assignee.as_ref().expect("a handle is still somebody");
        assert_eq!(assignee.name, "ada", "a user with no name set falls back to their handle");
        assert_eq!(assignee.username, "ada");
    }

    #[test]
    fn drops_a_priority_outside_linears_scale() {
        // A scale we do not know is not rendered as if we did.
        for raw in [-1, 5, 99] {
            let body = serde_json::json!({ "priority": raw });
            let meta = build_metadata(
                &Resource::Issue { identifier: "ENG-1".to_string() },
                &body,
                "https://fallback",
            );
            assert_eq!(meta.priority, None, "priority {raw}");
        }
    }

    #[test]
    fn builds_project_metadata_from_api_body() {
        let body = serde_json::json!({
            "name": "Fossilisation on Temporal",
            "url": "https://linear.app/heka-internal/project/fossilisation-d6029dd5b9a8",
            "description": "Bring fossilisation back on staging, replacing Kafka.",
            "progress": 0.42,
            "targetDate": "2026-09-11",
            "status": { "name": "In Progress", "type": "started", "color": "#f2c94c" },
            "lead": { "name": "Théophile" },
            "teams": { "nodes": [{ "name": "Stratumn Engine" }, { "name": "Platform" }] }
        });
        let meta = build_metadata(
            &Resource::Project { slug_id: "d6029dd5b9a8".to_string() },
            &body,
            "https://fallback",
        );
        assert_eq!(meta.kind, "project");
        assert_eq!(meta.title, "Fossilisation on Temporal");
        assert_eq!(meta.identifier, "");
        assert_eq!(meta.state.as_deref(), Some("In Progress"));
        assert_eq!(meta.state_type.as_deref(), Some("started"));
        assert_eq!(meta.lead.as_ref().map(|p| p.name.as_str()), Some("Théophile"));
        assert_eq!(meta.team.as_deref(), Some("Stratumn Engine, Platform"));
        assert_eq!(meta.progress, Some(0.42));
        assert_eq!(meta.target_date.as_deref(), Some("2026-09-11"));
        // Issue-only fields stay absent on a project.
        assert_eq!(meta.assignee, None);
        assert_eq!(meta.priority, None);
        assert!(meta.labels.is_empty());
    }

    #[test]
    fn builds_document_metadata_from_api_body() {
        let body = serde_json::json!({
            "title": "Scalable Batch Actions — System Design",
            "url": "https://linear.app/heka-internal/document/scalable-batch-ebc85c4d4d74",
            "content": "# Scalable Batch Actions\n\n> Status: Draft for review",
            "creator": { "name": "Théophile" },
            "project": { "name": "Scalable Batch Actions" }
        });
        let meta = build_metadata(
            &Resource::Document { slug_id: "ebc85c4d4d74".to_string() },
            &body,
            "https://fallback",
        );
        assert_eq!(meta.kind, "document");
        assert_eq!(meta.title, "Scalable Batch Actions — System Design");
        assert_eq!(meta.creator.as_ref().map(|p| p.name.as_str()), Some("Théophile"));
        assert_eq!(meta.project.as_deref(), Some("Scalable Batch Actions"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Scalable Batch Actions Status: Draft for review")
        );
        assert_eq!(meta.state, None);
    }

    #[test]
    fn transient_errors_are_told_apart_from_definitive_ones() {
        // "Entity not found" comes back with HTTP 200 and an input error: there is
        // no such issue, so the card is skipped and the answer may be cached.
        let not_found = serde_json::json!({
            "errors": [{
                "message": "Entity not found: Issue",
                "extensions": { "code": "INPUT_ERROR", "type": "invalid input" }
            }],
            "data": null
        });
        assert_eq!(transient_error_code(&not_found), None);

        // A rate limit is the opposite: ask again later.
        let throttled = serde_json::json!({
            "errors": [{ "extensions": { "code": "RATELIMITED" } }]
        });
        assert_eq!(transient_error_code(&throttled).as_deref(), Some("RATELIMITED"));

        // A clean answer has no errors at all.
        assert_eq!(transient_error_code(&serde_json::json!({ "data": {} })), None);
    }

    #[tokio::test]
    async fn no_token_means_no_request() {
        // Linear has no anonymous read, so an unconfigured integration must not
        // even reach the network. A client with no permitted target would error if
        // a request were made, which is exactly what this asserts against.
        let http = reqwest::Client::new();
        let url = "https://linear.app/acme/issue/ENG-1";
        assert_eq!(fetch_metadata(&http, None, url).await.unwrap(), None);
        assert_eq!(fetch_metadata(&http, Some("   "), url).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_non_linear_url_makes_no_request() {
        let http = reqwest::Client::new();
        assert_eq!(
            fetch_metadata(&http, Some("lin_api_x"), "https://example.com/issue/ENG-1")
                .await
                .unwrap(),
            None
        );
    }
}
