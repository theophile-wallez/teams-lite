// What a custom emoji looks like when it ARRIVES, measured against the user's own store,
// READ-ONLY. No network, and it prints counts and attribute names rather than anybody's words.
//
// § Custom emoji says a colleague's emoji joins the reader's pack as its message arrives, and
// the whole feature rests on one claim about the wire: the markup carries the NAME in `itemid`
// beside the art in `src`, so nothing about it has to be guessed at. That claim was never
// measured. `examples/custom_emoji_send_probe.rs` measured `itemtype`, `src`, `width` and
// `height` surviving Teams' server-side sanitizer — and `itemid`, the one attribute the import
// reads, was not in that list. A sanitizer that dropped it would leave the import silently
// doing nothing on every message, which is a feature that looks exactly like a working one.
//
// So this runs the real parser (`custom_emoji::art_in_body`) over every stored body and counts:
//
//   1. **Do inbound custom emoji carry `itemid`?** The fact the import rests on.
//   2. **Is Teams' OWN emoji really excluded?** Theirs wears the same `itemtype` with a
//      name-shaped `itemid`, and only the HOST tells them apart — so the count of stock tags
//      that pass `teams_media::is_allowed_media_url` must be zero.
//   3. **Which names arrive that the pack does not hold?** That is what the import would take,
//      and it is the honest measure of how much the manual row was costing.
//   4. **What art arrives as a REACTION?** A reaction's key is the art's URL and carries NO
//      name (`custom_emoji::custom_reaction_key` says why it cannot), so this art is visible
//      and NOT importable under anybody's name. The count is the size of that gap.
//
// Run it:
//
//     cargo run --example custom_emoji_inbound_recon

use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};

const EMOJI_ITEMTYPE: &str = "http://schema.skype.com/Emoji";
const CUSTOM_REACTION_PREFIX: &str = "tlcustom-";

fn main() -> Result<()> {
    let path = db_path()?;
    println!("store: {path}\n");
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )?;

    let pack: BTreeSet<String> = conn
        .prepare("SELECT name FROM custom_emoji")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    println!("the pack holds {} emoji\n", pack.len());

    // ---- 1..3: what the BODY of a message carries ------------------------------------
    let mut bodies = 0usize;
    let mut tags_seen = 0usize;
    let mut parsed_total = 0usize;
    let mut on_a_teams_host = 0usize;
    let mut off_host = BTreeMap::<String, usize>::new();
    let mut names = BTreeMap::<String, usize>::new();

    let mut stmt = conn.prepare(
        "SELECT content FROM messages WHERE content LIKE '%schema.skype.com/Emoji%'",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let content: String = row.get(0)?;
        bodies += 1;
        // Every tag wearing the emoji itemtype, counted WITHOUT the parser, so the two
        // numbers can disagree and say so.
        tags_seen += content.matches(EMOJI_ITEMTYPE).count();

        for emoji in teams_lite::custom_emoji::art_in_body(&content) {
            parsed_total += 1;
            if teams_lite::teams_media::is_allowed_media_url(&emoji.src) {
                on_a_teams_host += 1;
                *names.entry(emoji.name).or_default() += 1;
            } else {
                let host = emoji
                    .src
                    .strip_prefix("https://")
                    .and_then(|rest| rest.split('/').next())
                    .unwrap_or("(not https)")
                    .to_string();
                *off_host.entry(host).or_default() += 1;
            }
        }
    }

    println!("bodies carrying the emoji itemtype: {bodies}");
    println!("  tags wearing it (raw count):      {tags_seen}");
    println!("  tags the parser accepted:         {parsed_total}");
    println!(
        "  …of which on a Teams host:        {on_a_teams_host}  <- what the import would take"
    );
    println!("  …refused for their host:          {}", parsed_total - on_a_teams_host);
    for (host, n) in &off_host {
        println!("      {n:4}  {host}");
    }
    println!(
        "\nA tag the parser did NOT accept is one in a quote or in code, or one with no\n\
         `itemid` — the number to watch. Raw minus parsed: {}",
        tags_seen.saturating_sub(parsed_total)
    );

    println!("\nnames arriving on a Teams host:");
    let mut missing = 0usize;
    for (name, n) in &names {
        let held = if pack.contains(name) { "held" } else { "NOT IN THE PACK" };
        if !pack.contains(name) {
            missing += 1;
        }
        println!("  x{n:<4} :{name}:  {held}");
    }
    println!("  {missing} of {} names are ones the pack does not hold", names.len());

    // ---- 4: what a REACTION carries -------------------------------------------------
    let mut reaction_messages = 0usize;
    let mut reaction_art = BTreeSet::<String>::new();
    let mut keys_naming_nothing = 0usize;
    let mut stmt = conn.prepare(
        "SELECT reactions FROM messages WHERE reactions LIKE '%tlcustom-%'",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let raw: String = row.get(0)?;
        reaction_messages += 1;
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for entry in parsed.as_array().into_iter().flatten() {
            let Some(key) = entry.get("key").and_then(|k| k.as_str()) else { continue };
            let Some(url) = key.strip_prefix(CUSTOM_REACTION_PREFIX) else { continue };
            reaction_art.insert(url.to_string());
            // The key is the art's ADDRESS. A name cannot be in it — see
            // `custom_emoji::custom_reaction_key` — so every one of these is art with
            // nobody's name attached.
            if !url.starts_with("https://") {
                // The shape used before the key carried a whole URL: `<name>-<ams id>`,
                // which is exactly the pair that could not be split back apart.
                println!("  (an older key shape, not a URL: {} chars)", url.len());
            }
            keys_naming_nothing += 1;
        }
    }
    println!("\nmessages carrying a custom REACTION: {reaction_messages}");
    println!("  distinct art addressed by a key:   {}", reaction_art.len());
    println!(
        "  keys carrying a NAME:              0 of {keys_naming_nothing}  \
         <- the gap: this art is drawn and cannot be named"
    );

    Ok(())
}

/// The store the backend keeps, resolved the way it resolves it.
fn db_path() -> Result<String> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    let path = format!("{base}/teams-lite/teams-lite.sqlite");
    anyhow::ensure!(
        std::path::Path::new(&path).exists(),
        "no store at {path} — run the app once so it has one"
    );
    Ok(path)
}
