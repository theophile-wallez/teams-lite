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
// It also reports WHO a person on the issue is in the user's own Teams, which is the honest
// check for the Linear half of that match (see `tracker_people`): there is no "list every
// issue" read in this app, so a workspace's people can only be counted one real link at a
// time. It prints the handle and the verdict, never a colleague's name.
//
// READS ONLY, twice over: `linear` sends GraphQL queries and nothing else (a test enforces
// that on its source), and the roster comes from the local store.
use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let key = std::env::var("LINEAR_API_KEY")
        .context("set LINEAR_API_KEY to a Linear personal API key")?;
    let http = reqwest::Client::new();

    // The people this machine has been told the name of, so a real issue can say whether its
    // assignee is a colleague this app already knows. Read-only, and optional: with no store
    // the rest of the check still runs, since the enrichment is what it is really about.
    let roster = teams_lite::store::Store::open(&db_path())
        .ok()
        .and_then(|store| store.named_people().ok())
        .map(teams_lite::tracker_people::Roster::from_people);
    match &roster {
        Some(roster) => println!("== teams · {} names resolve to one person", roster.len()),
        None => println!("== teams · no store on this machine, so nobody can be matched"),
    }

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
                // Whoever owns it, and WHO THAT IS IN TEAMS — the question the card's face
                // answers (see `tracker_people`). This is the honest check for the Linear half
                // of that match: there is no "list every issue" read here, so a workspace's
                // people can only be counted one real link at a time.
                for (label, who) in [
                    ("assignee", &meta.assignee),
                    ("lead", &meta.lead),
                    ("creator", &meta.creator),
                ] {
                    if let Some(who) = who {
                        let teams = roster
                            .as_ref()
                            .and_then(|roster| roster.mri_for(&who.name))
                            .map_or("no colleague of that name in this store", |_| {
                                "resolves to a colleague — the card draws their Teams face"
                            });
                        println!("  {label:<8} -> @{} · {teams}", who.username);
                    }
                }
                for (label, value) in [
                    ("team", &meta.team),
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

/// The store the backend keeps, resolved the way it resolves it. Absent is not an error here:
/// this example is about the enrichment, and the roster only adds who somebody is.
fn db_path() -> String {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    format!("{base}/teams-lite/teams-lite.sqlite")
}
