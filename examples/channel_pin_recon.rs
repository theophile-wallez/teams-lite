// Manual live check: what CSA says about a CHANNEL's placement in the sidebar.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (one GET of
// `users/me`, the same request `teams_read::fetch_csa` makes on every sync). It
// writes nothing and changes no setting.
//
// It answers the question the parser cannot answer on its own: does `isFavorite`
// mean "the user pinned this channel" (a small hand-picked set) or "the channel is
// shown rather than hidden" (nearly all of them)? And does CSA carry a SEPARATE
// pin/hidden key that the parser reads today?
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example channel_pin_recon
use anyhow::Result;
use serde_json::Value;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// A key worth reporting: anything that could decide where a channel sits.
fn is_interesting(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("favor") || k.contains("pin") || k.contains("hidden") || k.contains("hide")
        || k.contains("show") || k.contains("order") || k.contains("rank") || k.contains("follow")
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;

    let resp = http
        .get(CSA_URL)
        .bearer_auth(&token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await?;
    let status = resp.status();
    let v: Value = serde_json::from_str(&resp.text().await?)?;
    println!("== CSA users/me -> {status} (region={})", session.region);

    // ---- every key a channel object carries, and how often -----------------------
    let teams = v.get("teams").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let mut key_counts: std::collections::BTreeMap<String, usize> = Default::default();
    let mut total = 0usize;
    let mut fav = 0usize;
    for team in &teams {
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            total += 1;
            if ch.get("isFavorite").and_then(|x| x.as_bool()).unwrap_or(false) {
                fav += 1;
            }
            for k in ch.as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
                *key_counts.entry(k).or_default() += 1;
            }
        }
    }
    println!("\n-- {total} channels across {} teams; isFavorite=true on {fav}", teams.len());
    for flag in ["isPinned", "isFollowed", "isMember", "isFavoriteByDefault"] {
        let n = teams
            .iter()
            .flat_map(|t| t.get("channels").and_then(|c| c.as_array()).cloned().unwrap_or_default())
            .filter(|ch| ch.get(flag).and_then(|x| x.as_bool()).unwrap_or(false))
            .count();
        println!("-- {flag}=true on {n}/{total}");
    }
    println!("-- placement-related channel keys:");
    for (k, n) in &key_counts {
        if is_interesting(k) {
            println!("   {k}: present on {n}/{total}");
        }
    }
    println!("-- all channel keys: {:?}", key_counts.keys().collect::<Vec<_>>());

    // ---- the same question at team level, and in the user's own settings ---------
    if let Some(team) = teams.first() {
        let team_keys: Vec<&String> =
            team.as_object().into_iter().flatten().map(|(k, _)| k).filter(|k| is_interesting(k)).collect();
        println!("\n-- placement-related TEAM keys: {team_keys:?}");
    }
    for (k, val) in v.as_object().into_iter().flatten() {
        if k == "teams" {
            continue;
        }
        let shape = match val {
            Value::Array(a) => format!("array[{}]", a.len()),
            Value::Object(o) => format!("object{{{}}}", o.len()),
            other => other.to_string().chars().take(60).collect(),
        };
        println!("   top-level {k}: {shape}");
    }

    // ---- a favorite/non-favorite example, printed whole --------------------------
    for want in [true, false] {
        let sample = teams.iter().flat_map(|t| {
            t.get("channels").and_then(|c| c.as_array()).cloned().unwrap_or_default()
        }).find(|ch| ch.get("isFavorite").and_then(|x| x.as_bool()).unwrap_or(false) == want);
        if let Some(ch) = sample {
            let mut trimmed = ch.clone();
            if let Some(o) = trimmed.as_object_mut() {
                o.remove("lastMessage");
                o.remove("members");
            }
            println!("\n-- a channel with isFavorite={want}:\n{}", serde_json::to_string_pretty(&trimmed)?);
        }
    }

    Ok(())
}
