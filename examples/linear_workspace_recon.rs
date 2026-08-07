// What a bare `ENG-123` can be turned into: the workspace one Linear key belongs to,
// measured against the real one.
//
// A reference written in a message, in an agent's answer or in a merge request's
// description names an issue by its identifier alone (see AGENTS.md § A tracker
// reference). Two facts are needed before that can become a link, and neither is
// configured anywhere in this app:
//
//   1. the workspace's own url key, which is what addresses the issue;
//   2. every team key the workspace holds, which is what says `ENG-123` names an issue
//      while `UTF-8`, `SHA-1` and `RFC-2119` name nothing.
//
// So this recon reads them through the production path (`linear::fetch_workspace`) and
// then checks the pair that matters: that the URL this app WRITES from an identifier is
// one Linear resolves, and one this app READS back to the same issue.
//
//   LINEAR_API_KEY=lin_api_… cargo run --example linear_workspace_recon -- [ENG-123]…
//
// READ-ONLY, twice over: `linear` sends GraphQL queries and nothing else (a test enforces
// that on its source), and nothing here touches the app's own settings. The KEY COMES FROM
// THE ENVIRONMENT, never from the source or the store — this example is committed, and a
// key pasted into a tracked file is a leaked key.
//
// It prints the workspace's url key and its team keys, which are neither secrets nor
// anybody's words: they are in every issue URL the workspace has ever published, and they
// are the whole subject of the measurement.
use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let key = std::env::var("LINEAR_API_KEY")
        .context("set LINEAR_API_KEY to a Linear personal API key")?;
    let http = reqwest::Client::new();

    let Some(workspace) = teams_lite::linear::fetch_workspace(&http, Some(&key)).await? else {
        println!("== no workspace: the key is absent or Linear refused it");
        println!("   a bare identifier then stays the text it is, which is the safe direction");
        return Ok(());
    };
    println!("== workspace");
    println!("  url key   -> {}", workspace.url_key);
    println!("  teams     -> {} keys: {}", workspace.team_keys.len(), workspace.team_keys.join(" "));
    println!(
        "  so `{}-123` is a reference here, and `UTF-8` is not",
        workspace.team_keys.first().map_or("ENG", String::as_str)
    );

    // The identifiers the caller named, plus one nobody can get wrong: a team key that
    // does not exist must resolve to nothing rather than to a link.
    let mut identifiers: Vec<String> = std::env::args().skip(1).collect();
    identifiers.push("ZZZZ-99999".to_string());

    for identifier in &identifiers {
        let url = teams_lite::linear::issue_url(&workspace.url_key, identifier);
        println!("== {identifier}");
        println!("  written   -> {url}");
        // The address this app writes must be one it also reads: `parse_url` is what the
        // enrichment and the preview card both go through.
        match teams_lite::linear::parse_url(&url) {
            Some(resource) => println!("  parsed    -> {resource:?}"),
            None => println!("  parsed    -> NOT a Linear link this app reads (a bug in issue_url)"),
        }
        match teams_lite::linear::fetch_metadata(&http, Some(&key), &url).await {
            Ok(Some(meta)) => {
                println!("  resolved  -> {} · {}", meta.identifier, meta.title);
                // Linear's OWN canonical url beside the one this app wrote: the slug it
                // appends is decoration, and this is the line that proves it.
                println!("  linear's  -> {}", meta.url);
                let same = meta.url == url;
                println!(
                    "  verdict   -> {}",
                    if same {
                        "identical to what this app writes"
                    } else {
                        "Linear adds a slug; the app's own address still resolves to it"
                    }
                );
            }
            Ok(None) => println!("  resolved  -> no such issue for this key (no link is drawn)"),
            Err(e) => println!("  resolved  -> TRANSIENT FAILURE: {e:#}"),
        }
    }
    Ok(())
}
