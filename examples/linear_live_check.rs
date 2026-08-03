// Manual live check for the READ-ONLY Linear link previews, through the production
// code path.
//
// Exercises `teams_lite::linear` end to end against the real workspace — URL
// parsing, the GraphQL queries, and the metadata each resource kind yields — and
// reports what it found. This is the Linear sibling of `mail_live_check.rs`: not a
// unit test, a hands-on verification that the implementation works against Linear.
//
//   LINEAR_API_KEY=lin_api_… cargo run --example linear_live_check -- <url>…
//
// With no URL it checks the ones the caller cannot get wrong: an unparseable link, a
// link on another host, and a well-formed link to an issue that does not exist. Pass
// real issue/project/document URLs to see live cards resolved.
//
// The KEY COMES FROM THE ENVIRONMENT, never from the source or the store: this
// example is committed, and a key pasted into a tracked file is a leaked key. It also
// never touches the app's own settings, so running it cannot change what the user's
// backend holds.
//
// READS ONLY. `linear` sends GraphQL queries and nothing else (a test enforces that
// on its source), so no amount of running this can alter an issue.
use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let key = std::env::var("LINEAR_API_KEY")
        .context("set LINEAR_API_KEY to a Linear personal API key")?;
    let http = reqwest::Client::new();

    let urls: Vec<String> = std::env::args().skip(1).collect();
    let urls = if urls.is_empty() {
        vec![
            // Not a Linear URL at all, and a look-alike host: both must be refused
            // before any request is made.
            "https://example.com/issue/ENG-1".to_string(),
            "https://linear.app.evil.com/acme/issue/ENG-1".to_string(),
            // Well-formed, but no such issue in any workspace this key can see: the
            // "no card" answer, which must not be reported as a failure.
            "https://linear.app/acme/issue/ZZZZ-99999".to_string(),
        ]
    } else {
        urls
    };

    for url in &urls {
        println!("== {url}");
        match teams_lite::linear::parse_url(url) {
            None => println!("  parse    -> not an enrichable Linear link (no request made)"),
            Some(resource) => println!("  parse    -> {resource:?}"),
        }
        match teams_lite::linear::fetch_metadata(&http, Some(&key), url).await {
            Ok(None) => println!("  enrich   -> no card (absent, or not visible to this key)"),
            Ok(Some(meta)) => {
                println!("  kind     -> {}", meta.kind);
                println!("  title    -> {}", meta.title);
                if !meta.identifier.is_empty() {
                    println!("  ref      -> {}", meta.identifier);
                }
                if let Some(state) = &meta.state {
                    println!(
                        "  state    -> {state} (type={}, color={})",
                        meta.state_type.as_deref().unwrap_or("-"),
                        meta.state_color.as_deref().unwrap_or("-"),
                    );
                }
                for (label, value) in [
                    ("team", &meta.team),
                    ("assignee", &meta.assignee_name),
                    ("lead", &meta.lead_name),
                    ("creator", &meta.creator_name),
                    ("project", &meta.project),
                    ("parent", &meta.parent),
                    ("priority", &meta.priority_label),
                    ("due", &meta.due_date),
                    ("target", &meta.target_date),
                ] {
                    if let Some(value) = value {
                        println!("  {label:<8} -> {value}");
                    }
                }
                if let Some(progress) = meta.progress {
                    println!("  progress -> {:.0}%", progress * 100.0);
                }
                if !meta.labels.is_empty() {
                    let labels: Vec<String> = meta
                        .labels
                        .iter()
                        .map(|l| format!("{}({})", l.name, l.color.as_deref().unwrap_or("-")))
                        .collect();
                    println!("  labels   -> {}", labels.join(" "));
                }
                // The snippet proves the Markdown stripper ran on a real body.
                if let Some(description) = &meta.description {
                    println!("  snippet  -> {} chars: {description}", description.chars().count());
                }
                println!("  url      -> {}", meta.url);
            }
            Err(e) => println!("  enrich   -> TRANSIENT FAILURE: {e:#}"),
        }
    }
    Ok(())
}
