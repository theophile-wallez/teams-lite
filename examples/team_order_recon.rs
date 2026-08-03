// Manual live check: does the sidebar order teams the way Microsoft Teams does?
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (one GET per
// aggregator version, the v1 one being exactly what `teams_read::fetch_csa` makes on
// every sync). It writes nothing.
//
// The sidebar sorts teams by their position in the CSA `teams` array, and channels by
// their position in each team's `channels` array (see `channels()` in src/store.rs).
// This measures whether that is faithful, and it answers three questions:
//
//   1. Does CSA state an order at all? NO. No team and no channel carries a rank, an
//      order, a position or a sort key, and the array order matches no sort of any
//      field CSA does send. The array order is a server-held arrangement.
//   2. Is that arrangement the user's own? YES, for v1, verified against the client on
//      2026-08-03: `CLIENT_ORDER` below was read off the real Teams client, and v1
//      reproduces it. It is stable across calls, and it MOVES when the user
//      re-arranges their teams — a run earlier that day returned a different order,
//      and the store followed on the next sync (`team_pos` is re-written).
//   3. Which version to read? v1. Its sibling v2 answers 200 and returns the same 12
//      teams in a DIFFERENT order, which is not the client's. Do not switch.
//
// Two things the array order does NOT settle:
//
//   - General sits LAST in a team's `channels` array (index 41 of 42 in the biggest
//     team here). The read forces General first; the client in that screenshot showed
//     it last, so this is the open question, not a settled one.
//   - A team carries `isCollapsed`, its fold state in the user's own client, and it
//     tracks that client live (it flipped to match a screenshot taken between two runs
//     of this file). The web sidebar keeps the fold local instead, by choice.
//
// Endpoints that do NOT hold the order, so nobody probes them again: every
// `teams.microsoft.com/api/mt/**` spelling of `users/me/properties`, `users/me/settings`,
// `users/me/teamsOrder`, `users/me/teams` and `part/{region}/…` answers 404, as does
// `csa/api/v1/teams/users/me/settings`.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example team_order_recon
use anyhow::Result;
use serde_json::Value;
use std::collections::BTreeMap;

const V1: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";
const V2: &str = "https://teams.microsoft.com/api/csa/api/v2/teams/users/me?isPrefetch=false";

/// The order the real Teams client showed on 2026-08-03, read off the client itself.
/// Its list is truncated ("See all your teams"), so only its first entries are known —
/// a candidate order must reproduce THESE, in this sequence, among its own.
const CLIENT_ORDER: [&str; 4] = ["Stratumn", "SiaGPT - Core", "AD&Q", "Sia Group"];

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

fn teams_of(v: &Value) -> Vec<Value> {
    v.get("teams").and_then(|t| t.as_array()).cloned().unwrap_or_default()
}

/// Does this order reproduce the client's, among whatever else it holds? Compares whole
/// names: "AD&Q" is a PREFIX of "AD&Q_AIF", "AD&Q_LAB_ENG" and two more, so matching on
/// a prefix counts four teams as one and reports a false miss.
fn matches_client(names: &[String]) -> bool {
    let subsequence: Vec<&String> =
        names.iter().filter(|n| CLIENT_ORDER.contains(&n.as_str())).collect();
    subsequence.len() == CLIENT_ORDER.len()
        && subsequence.iter().zip(CLIENT_ORDER.iter()).all(|(got, want)| *got == want)
}

async fn fetch(http: &reqwest::Client, url: &str, token: &str, skypetoken: &str) -> Result<Value> {
    let body =
        http.get(url).bearer_auth(token).header("x-skypetoken", skypetoken).send().await?.text().await?;
    Ok(serde_json::from_str(&body)?)
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
    println!("== region={}", session.region);
    println!("== the order the client shows: {CLIENT_ORDER:?}");

    let v1 = fetch(&http, V1, &token, &session.skypetoken).await?;
    let v2 = fetch(&http, V2, &token, &session.skypetoken).await?;
    let teams = teams_of(&v1);

    // ---- which version reproduces the client's order ----------------------------
    for (label, payload) in [("v1 (what the app reads)", &v1), ("v2", &v2)] {
        let names: Vec<String> = teams_of(payload).iter().map(name_of).collect();
        println!(
            "\n-- {label}: {}{}",
            if matches_client(&names) { "MATCHES the client" } else { "does NOT match the client" },
            format!("\n   {names:?}"),
        );
    }

    // ---- 1. every key a team carries, and any that looks like a position ---------
    let mut team_keys: BTreeMap<String, usize> = Default::default();
    for team in &teams {
        for k in team.as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
            *team_keys.entry(k).or_default() += 1;
        }
    }
    println!("\n-- {} teams; {} distinct team keys", teams.len(), team_keys.len());
    println!(
        "-- order-like team keys: {:?}",
        team_keys.keys().filter(|k| is_order_like(k)).collect::<Vec<_>>()
    );

    // ---- 2. the array order, against the orders it could coincide with ----------
    let names: Vec<String> = teams.iter().map(name_of).collect();
    println!("\n-- the v1 array order:");
    for (i, team) in teams.iter().enumerate() {
        println!("   {i:2}. {:<32} newest={}", names[i], newest_message(team));
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

    // ---- 3. where General sits, which the read overrides ------------------------
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

    // ---- 4. the per-team UI state CSA does carry --------------------------------
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

    Ok(())
}
