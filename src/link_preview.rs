// Rich link previews: one answer shape for every integration.
//
// A chat message can carry a link to any of the trackers the user works in. The
// UI asks one question — "is this link something you can enrich?" — through the
// `enrich_link` RPC (src/bin/server.rs), and each integration module answers for
// its own host: `gitlab` for merge requests, issues and projects, `linear` for
// issues, projects and documents.
//
// This module owns the only thing they share: the ORDER they are tried in, and
// the `provider` tag that tells the front-end which card to render. The tag is
// load-bearing rather than cosmetic — both providers have a "project" and an
// "issue" kind, so `kind` alone is ambiguous and only the pair
// (`provider`, `kind`) names a card.
//
// Dispatch is by host, so exactly one integration can ever claim a link and the
// order is a formality, not a race: a `linear.app` URL is not a GitLab host, and
// a GitLab host is not `linear.app`. Adding a provider means adding a variant
// here plus its module — never widening an existing one.

use anyhow::Result;
use serde::Serialize;

use crate::{gitlab, linear};

/// Metadata for one enriched link, tagged with the integration it came from.
/// Serializes to the provider's own fields plus `provider: "gitlab" | "linear"`,
/// which is what `web/src/lib/protocol.ts` mirrors as a discriminated union.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "provider")]
pub enum Preview {
    // Spelled out rather than derived from the variant name: `rename_all` would
    // make `GitLab` into "git_lab", and the tag is a wire contract.
    #[serde(rename = "gitlab")]
    GitLab(gitlab::LinkMetadata),
    #[serde(rename = "linear")]
    Linear(linear::LinkMetadata),
}

/// Enrich `url` with whichever integration recognizes it.
///
/// - `Ok(Some(preview))` — one integration claimed the link and resolved it.
/// - `Ok(None)` — no integration recognizes the host, or the one that does cannot
///   see the resource (private, absent, or no token configured). Definitively "no
///   card"; the caller may cache this.
/// - `Err(_)` — a transient failure the caller should retry later.
///
/// Each provider is host-scoped and best-effort in the same way, so this is a
/// plain "first one that answers wins".
pub async fn enrich(
    http: &reqwest::Client,
    settings: &Settings,
    url: &str,
) -> Result<Option<Preview>> {
    if let Some(meta) =
        gitlab::fetch_metadata(http, &settings.gitlab_host, settings.gitlab_token.as_deref(), url)
            .await?
    {
        return Ok(Some(Preview::GitLab(meta)));
    }
    if let Some(meta) = linear::fetch_metadata(http, settings.linear_token.as_deref(), url).await? {
        return Ok(Some(Preview::Linear(meta)));
    }
    Ok(None)
}

/// What the integrations need from the stored app settings: the GitLab host to
/// pin requests to, and one access token per provider. Read from the store on
/// each request (see `enrich_link`), so saving a token takes effect immediately.
///
/// A token is `None` when unset, never `Some("")`: both providers treat a blank
/// token as absent, and normalizing here keeps that decision in one place.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub gitlab_host: String,
    pub gitlab_token: Option<String>,
    pub linear_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_a_provider_tag() {
        let preview = Preview::Linear(linear::LinkMetadata {
            kind: "issue",
            url: "https://linear.app/acme/issue/ENG-1/x".to_string(),
            title: "Ship it".to_string(),
            identifier: "ENG-1".to_string(),
            team: None,
            state: Some("Todo".to_string()),
            state_type: Some("unstarted".to_string()),
            state_color: None,
            assignee_name: None,
            lead_name: None,
            creator_name: None,
            priority: None,
            priority_label: None,
            project: None,
            parent: None,
            labels: Vec::new(),
            description: None,
            due_date: None,
            target_date: None,
            progress: None,
        });
        let value = serde_json::to_value(&preview).unwrap();
        assert_eq!(value["provider"], "linear");
        assert_eq!(value["kind"], "issue");
        assert_eq!(value["identifier"], "ENG-1");
        // Absent optionals stay off the wire.
        assert!(value.get("assignee_name").is_none());
    }

    #[test]
    fn both_providers_are_distinguishable_at_the_same_kind() {
        // The reason `provider` exists: "project" means two different cards.
        let gitlab = serde_json::to_value(Preview::GitLab(gitlab::LinkMetadata {
            kind: "project",
            url: "https://gitlab.com/acme/webapp".to_string(),
            title: "acme / webapp".to_string(),
            project_path: "acme/webapp".to_string(),
            reference: String::new(),
            state: None,
            draft: None,
            author_name: None,
            source_branch: None,
            target_branch: None,
            labels: Vec::new(),
            milestone: None,
            description: None,
            created_at: None,
            updated_at: None,
            pipeline_status: None,
        }))
        .unwrap();
        assert_eq!(gitlab["provider"], "gitlab");
        assert_eq!(gitlab["kind"], "project");
        assert_eq!(gitlab["project_path"], "acme/webapp");
    }
}
