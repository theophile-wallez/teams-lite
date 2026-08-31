// Manual live check: does Teams tell us whether a channel is drawn as POSTS or as a
// CONVERSATION?
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY: one GET of
// `users/me` (the request `teams_read::fetch_csa` already makes on every sync) and one
// GET per channel of that channel's own thread properties (the request
// `teams_members::fetch_members` already makes). It writes nothing and changes no
// setting.
//
// It exists because the two layouts are two different surfaces and the choice is not
// ours: a channel the user reads as a wall of cards in Teams must not be drawn here as a
// column of chat bubbles. So the question is exactly "which key states it, if any" —
// and the answer decides whether this app can draw both or has to pick one.
//
// It prints KEY NAMES, counts, and the small scalar VALUES of anything that could be a
// layout — never a post, never a colleague's words. Channel and team names ARE printed:
// they are the user's own, this runs in their own terminal, and without them the answer
// cannot be checked against what their own client draws.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example channel_layout_recon
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::BTreeMap;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// How many channels to ask the chat service about. The CSA sweep is one request for
/// every channel the user has; this second read is one request EACH, so it is bounded.
/// It reads them ALL because the distribution is the answer: which channels carry a
/// modality, what the absent case is, and whether the two the user can name in their own
/// client come back the way their own client draws them.
const THREAD_READS: usize = 200;

/// A key worth reporting: anything that could name a layout, a mode or a channel kind.
/// Deliberately wide — the whole point is to find a name nobody here has guessed.
fn is_interesting(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    [
        "layout", "mode", "kind", "type", "experience", "view", "template", "format",
        "thread", "post", "conversation", "reply", "style", "setting", "feature",
    ]
    .iter()
    .any(|needle| k.contains(needle))
}

/// A value small enough to print: a layout is a word or a flag, never a document.
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if s.len() <= 40 => Some(format!("{s:?}")),
        Value::String(s) => Some(format!("<{} chars>", s.len())),
        _ => None,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let csa_token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;

    let resp = http
        .get(CSA_URL)
        .bearer_auth(&csa_token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await?;
    let status = resp.status();
    let csa: Value = serde_json::from_str(&resp.text().await?)?;
    println!("== CSA users/me -> {status} (region={})\n", session.region);

    let teams = csa.get("teams").and_then(|t| t.as_array()).cloned().unwrap_or_default();

    // ---- 1. every key a CSA channel carries, and how often ----------------------
    let mut channel_keys: BTreeMap<String, usize> = BTreeMap::new();
    let mut team_keys: BTreeMap<String, usize> = BTreeMap::new();
    let mut channels: Vec<(String, String, Value)> = Vec::new(); // team, channel, object
    for team in &teams {
        for (k, _) in team.as_object().into_iter().flatten() {
            *team_keys.entry(k.clone()).or_default() += 1;
        }
        let team_name = team
            .get("displayName")
            .and_then(|x| x.as_str())
            .unwrap_or("(unnamed team)")
            .to_string();
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            for (k, _) in ch.as_object().into_iter().flatten() {
                *channel_keys.entry(k.clone()).or_default() += 1;
            }
            let name = ch
                .get("displayName")
                .and_then(|x| x.as_str())
                .unwrap_or("(unnamed channel)")
                .to_string();
            channels.push((team_name.clone(), name, ch.clone()));
        }
    }
    println!("{} teams, {} channels\n", teams.len(), channels.len());

    println!("-- every key on a CSA CHANNEL object (count / {}) --", channels.len());
    for (k, n) in &channel_keys {
        let mark = if is_interesting(k) { "  <-- interesting" } else { "" };
        println!("  {n:5}  {k}{mark}");
    }

    println!("\n-- every key on a CSA TEAM object (count / {}) --", teams.len());
    for (k, n) in &team_keys {
        let mark = if is_interesting(k) { "  <-- interesting" } else { "" };
        println!("  {n:5}  {k}{mark}");
    }

    // ---- 2. the VALUES of the interesting channel keys, per channel -------------
    // A key present on every channel with one value everywhere says nothing; the answer
    // we are looking for is a key whose value DIFFERS between two channels the user
    // knows are drawn differently.
    let interesting: Vec<String> =
        channel_keys.keys().filter(|k| is_interesting(k)).cloned().collect();
    if interesting.is_empty() {
        println!("\nNo CSA channel key looks like a layout.");
    } else {
        println!("\n-- those keys' values, per channel --");
        for (team, name, ch) in &channels {
            let mut parts: Vec<String> = Vec::new();
            for k in &interesting {
                if let Some(v) = ch.get(k).and_then(scalar) {
                    parts.push(format!("{k}={v}"));
                }
            }
            if !parts.is_empty() {
                println!("  [{team}] {name}: {}", parts.join("  "));
            }
        }
        // And the DISTINCT value sets, which is what actually answers the question.
        for k in &interesting {
            let mut seen: BTreeMap<String, usize> = BTreeMap::new();
            for (_, _, ch) in &channels {
                let v = ch.get(k).and_then(scalar).unwrap_or_else(|| "(absent)".into());
                *seen.entry(v).or_default() += 1;
            }
            if seen.len() > 1 {
                let shown: Vec<String> =
                    seen.iter().map(|(v, n)| format!("{v} x{n}")).collect();
                println!("  DIFFERS  {k}: {}", shown.join(", "));
            }
        }
    }

    // ---- 3. the channel THREAD's own properties ---------------------------------
    // CSA is a sidebar payload; the thread itself is where a per-channel setting would
    // more naturally live (it is where `alerts` and the roster live).
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/')
        .to_string();
    println!("\n-- channel THREAD properties (first {THREAD_READS}) --");
    let mut prop_keys: BTreeMap<String, usize> = BTreeMap::new();
    // Which channels carry which modality — the distribution is what says whether this
    // can drive a rendering, and what an ABSENT value has to mean.
    let mut modality: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut read = 0usize;
    for (team, name, ch) in &channels {
        if read >= THREAD_READS {
            break;
        }
        let Some(id) = ch.get("id").and_then(|x| x.as_str()) else { continue };
        let url = format!("{chat_service}/v1/threads/{id}?view=msnp24Equivalent");
        let r = http
            .get(&url)
            .header("Authentication", format!("skypetoken={}", session.skypetoken))
            .send()
            .await;
        let Ok(r) = r else { continue };
        let st = r.status();
        let body: Value = match serde_json::from_str(&r.text().await.unwrap_or_default()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        read += 1;
        let props = body.get("properties").cloned().unwrap_or(Value::Null);
        let seen = props
            .get("chatModalityType")
            .and_then(|x| x.as_str())
            .unwrap_or("(absent)")
            .to_string();
        modality.entry(seen).or_default().push(format!("[{team}] {name}"));
        let mut parts: Vec<String> = Vec::new();
        for (k, v) in props.as_object().into_iter().flatten() {
            *prop_keys.entry(k.clone()).or_default() += 1;
            if is_interesting(k) {
                if let Some(s) = scalar(v) {
                    parts.push(format!("{k}={s}"));
                }
            }
        }
        println!(
            "  {st} [{team}] {name}{}",
            if parts.is_empty() { String::new() } else { format!(" :: {}", parts.join("  ")) }
        );
    }
    println!("\n-- every key on a channel thread's `properties` (count / {read}) --");
    for (k, n) in &prop_keys {
        let mark = if is_interesting(k) { "  <-- interesting" } else { "" };
        println!("  {n:5}  {k}{mark}");
    }

    println!(
        "\n-- chatModalityType, which is the answer: {} of {read} channels carry one --",
        modality.values().map(|v: &Vec<String>| v.len()).sum::<usize>()
    );
    for (value, names) in &modality {
        println!("  {value}: {} channel(s)", names.len());
        for n in names {
            println!("      {n}");
        }
    }

    Ok(())
}
