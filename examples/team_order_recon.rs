// Manual live check: does CSA state the ORDER the user's teams sit in?
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (one GET of
// `users/me`, the same request `teams_read::fetch_csa` makes on every sync). It
// writes nothing.
//
// The sidebar sorts teams by their position in the CSA `teams` array, and channels
// by their position in each team's `channels` array (see `channels()` in
// src/store.rs). That is only faithful if the array order IS the order Microsoft
// Teams shows. This measures whether anything in the payload says so:
//
//   1. every key a TEAM object carries, so an explicit rank cannot hide;
//   2. the array order itself, against the orders it could accidentally match
//      (alphabetical, by id, by newest message);
//   3. the payload's `metadata`, the only other place a user preference could sit.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example team_order_recon
use anyhow::Result;
use serde_json::Value;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// A key that could carry a position rather than a property.
fn is_order_like(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["order", "rank", "index", "position", "sort", "seq", "priority"]
        .iter()
        .any(|needle| k.contains(needle))
}

/// The newest `lastMessage.composeTime` across a team's channels. Kept as the raw
/// ISO-8601 string: every one CSA sends is UTC in the same shape, so comparing them
/// as text orders them correctly and needs no date library.
fn newest_message(team: &Value) -> String {
    team.get("channels")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
        .filter_map(|ch| ch.get("lastMessage")?.get("composeTime")?.as_str())
        .map(str::to_string)
        .max()
        .unwrap_or_default()
}

fn name_of(v: &Value) -> String {
    ["displayName", "name", "title"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
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

    let teams = v.get("teams").and_then(|t| t.as_array()).cloned().unwrap_or_default();

    // ---- 1. every key a team carries, and any that looks like a position ---------
    let mut team_keys: std::collections::BTreeMap<String, usize> = Default::default();
    for team in &teams {
        for k in team.as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
            *team_keys.entry(k).or_default() += 1;
        }
    }
    println!("\n-- {} teams; all team keys:", teams.len());
    println!("   {:?}", team_keys.keys().collect::<Vec<_>>());
    let ranks: Vec<&String> = team_keys.keys().filter(|k| is_order_like(k)).collect();
    println!("-- order-like team keys: {ranks:?}");

    // ---- 2. the array order, against the orders it could coincide with ----------
    let names: Vec<String> = teams.iter().map(name_of).collect();
    println!("\n-- the CSA array order:");
    for (i, team) in teams.iter().enumerate() {
        println!(
            "   {i:2}. {:<32} newest={} created={}",
            names[i],
            newest_message(team),
            team.get("creationTime").and_then(|x| x.as_str()).unwrap_or("-"),
        );
    }
    let mut alphabetical = names.clone();
    alphabetical.sort_by_key(|n| n.to_lowercase());
    println!("-- matches alphabetical? {}", alphabetical == names);
    let by_recency: Vec<String> = {
        let mut pairs: Vec<(String, String)> =
            teams.iter().map(|t| (newest_message(t), name_of(t))).collect();
        pairs.sort_by(|a, b| b.0.cmp(&a.0));
        pairs.into_iter().map(|(_, n)| n).collect()
    };
    println!("-- matches newest-message-first? {}", by_recency == names);
    // Every scalar key a team carries is a candidate: if the array order matches one
    // of them, the order is that field's, NOT an arrangement the user chose.
    println!("-- does the array order match a sort by one of the team's own keys?");
    let mut explained = false;
    for key in team_keys.keys() {
        let mut ascending: Vec<(String, String)> = teams
            .iter()
            .map(|t| {
                let raw = t.get(key).map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                });
                (raw.unwrap_or_default(), name_of(t))
            })
            .collect();
        // Skip a key that cannot order anything (absent, or the same value everywhere).
        if ascending.iter().all(|(v, _)| v.is_empty())
            || ascending.iter().all(|(v, _)| *v == ascending[0].0)
        {
            continue;
        }
        ascending.sort();
        let asc: Vec<String> = ascending.iter().map(|(_, n)| n.clone()).collect();
        let desc: Vec<String> = asc.iter().rev().cloned().collect();
        if asc == names || desc == names {
            let direction = if asc == names { "ascending" } else { "descending" };
            println!("   MATCH: {key} ({direction})");
            explained = true;
        }
    }
    if !explained {
        println!("   none — no key of a team reproduces the array order");
    }

    // Where each team's General channel sits in its own `channels` array. The sidebar
    // forces General first; if CSA already put it there, that override is redundant.
    println!("\n-- position of General inside each team's channels array:");
    for team in &teams {
        let id = team.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let channels = team.get("channels").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let at = channels.iter().position(|ch| {
            ch.get("isGeneral").and_then(|x| x.as_bool()).unwrap_or(false)
                || ch.get("id").and_then(|x| x.as_str()) == Some(id)
        });
        println!(
            "   {:<32} General at {} of {}",
            name_of(team),
            at.map(|i| i.to_string()).unwrap_or_else(|| "ABSENT".into()),
            channels.len(),
        );
    }

    // The per-team UI state CSA does carry, which the sidebar keeps locally instead.
    println!("\n-- what CSA says about each team's own fold state:");
    for team in &teams {
        println!(
            "   {:<32} isCollapsed={:?} isFavorite={:?} isGeneralChannelFavorite={:?}",
            name_of(team),
            team.get("isCollapsed").and_then(|x| x.as_bool()),
            team.get("isFavorite").and_then(|x| x.as_bool()),
            team.get("isGeneralChannelFavorite").and_then(|x| x.as_bool()),
        );
    }

    // ---- 3. the only other place a preference could sit -------------------------
    println!("\n-- metadata: {}", serde_json::to_string(v.get("metadata").unwrap_or(&Value::Null))?);

    // ---- and the same question one level down, for channels ---------------------
    if let Some(team) = teams.iter().max_by_key(|t| {
        t.get("channels").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0)
    }) {
        println!("\n-- the biggest team, {}, in CSA channel order:", name_of(team));
        for (i, ch) in
            team.get("channels").and_then(|c| c.as_array()).into_iter().flatten().enumerate()
        {
            println!(
                "   {i:2}. {:<40} general={} shown={}",
                name_of(ch),
                ch.get("isGeneral").and_then(|x| x.as_bool()).unwrap_or(false),
                ch.get("isFavorite").and_then(|x| x.as_bool()).unwrap_or(false),
            );
        }
    }

    Ok(())
}
