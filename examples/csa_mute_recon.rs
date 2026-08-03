// Manual live check: what the CSA aggregator says about MUTED conversations.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (one GET of
// `users/me`, the same request `teams_read::fetch_csa` makes on every sync). It
// writes nothing and never touches a notification setting.
//
// It answers two questions the code cannot answer on its own:
//   1. which key carries a CHAT's mute state, and how many chats are muted;
//   2. whether a CHANNEL carries a mute/notification key at all (the parser reads
//      none today, so a per-channel mute would be invisible to the app).
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example csa_mute_recon
use anyhow::Result;
use serde_json::Value;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// A key worth reporting: anything that could carry a mute or notification setting.
fn is_interesting(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("mute") || k.contains("notif") || k.contains("alert") || k.contains("follow")
}

/// Every key of an object, plus the keys of its nested objects one level down
/// (CSA nests some settings under a sub-object).
fn keys_of(v: &Value) -> Vec<String> {
    let Some(map) = v.as_object() else { return Vec::new() };
    let mut out = Vec::new();
    for (k, value) in map {
        out.push(k.clone());
        if let Some(nested) = value.as_object() {
            for nk in nested.keys() {
                out.push(format!("{k}.{nk}"));
            }
        }
    }
    out
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

    // ---- chats ----------------------------------------------------------------
    let chats: Vec<&Value> = v.get("chats").and_then(|c| c.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
    let mut chat_keys: Vec<String> = Vec::new();
    for chat in &chats {
        for k in keys_of(chat) {
            if is_interesting(&k) && !chat_keys.contains(&k) {
                chat_keys.push(k);
            }
        }
    }
    chat_keys.sort();
    println!("\n-- chats: {} total", chats.len());
    println!("   mute-ish keys seen: {chat_keys:?}");
    for chat in &chats {
        if chat.get("isMuted").and_then(|x| x.as_bool()) != Some(true) {
            continue;
        }
        println!(
            "   MUTED {} — {:?} (threadType={:?})",
            chat.get("id").and_then(|x| x.as_str()).unwrap_or("?"),
            chat.get("title").and_then(|x| x.as_str()).unwrap_or(""),
            chat.get("threadType").and_then(|x| x.as_str()).unwrap_or(""),
        );
    }

    // ---- teams / channels -----------------------------------------------------
    let teams: Vec<&Value> = v.get("teams").and_then(|t| t.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
    let mut team_keys: Vec<String> = Vec::new();
    let mut channel_keys: Vec<String> = Vec::new();
    let mut channel_count = 0usize;
    for team in &teams {
        for k in keys_of(team) {
            if is_interesting(&k) && !team_keys.contains(&k) {
                team_keys.push(k);
            }
        }
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            channel_count += 1;
            for k in keys_of(ch) {
                if is_interesting(&k) && !channel_keys.contains(&k) {
                    channel_keys.push(k);
                }
            }
        }
    }
    team_keys.sort();
    channel_keys.sort();
    println!("\n-- teams: {} total, {channel_count} channels", teams.len());
    println!("   team mute-ish keys seen:    {team_keys:?}");
    println!("   channel mute-ish keys seen: {channel_keys:?}");

    // The values, not only the key names: which channels are muted, and what a
    // per-channel notification setting actually looks like.
    for team in &teams {
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            let muted = ch.get("isMuted").and_then(|x| x.as_bool()).unwrap_or(false);
            let settings = ch.get("channelNotificationSettings");
            let interesting = muted || settings.is_some_and(|s| !s.is_null());
            if !interesting {
                continue;
            }
            println!(
                "   {} · {} — isMuted={muted} isFollowed={:?} settings={}",
                team.get("displayName").and_then(|x| x.as_str()).unwrap_or("?"),
                ch.get("displayName").and_then(|x| x.as_str()).unwrap_or("?"),
                ch.get("isFollowed").and_then(|x| x.as_bool()),
                settings.map(ToString::to_string).unwrap_or_else(|| "absent".into()),
            );
        }
    }

    // Does `isFollowed` ever stand alone, without a `channelNotificationSettings`
    // object? If it does, it is the only signal for "notify me about every post"
    // and the derivation must read it.
    let mut followed_without_settings = 0usize;
    let mut followed_with_settings = 0usize;
    let mut settings_absent = 0usize;
    for team in &teams {
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            let followed = ch.get("isFollowed").and_then(|x| x.as_bool()).unwrap_or(false);
            let has_settings = ch.get("channelNotificationSettings").is_some_and(|s| !s.is_null());
            if !has_settings {
                settings_absent += 1;
            }
            match (followed, has_settings) {
                (true, false) => followed_without_settings += 1,
                (true, true) => followed_with_settings += 1,
                _ => {}
            }
        }
    }
    println!(
        "\n   followed without settings={followed_without_settings}, \
         followed with settings={followed_with_settings}, settings absent={settings_absent}"
    );

    // A team can be muted as a whole (`isUserMuted`), and a channel spells its
    // unread flag differently from a chat — count both, since the parser reads
    // neither.
    let mut with_is_read = 0usize;
    let mut with_is_message_read = 0usize;
    for team in &teams {
        println!(
            "   team {:?} isUserMuted={:?} isFollowed={:?}",
            team.get("displayName").and_then(|x| x.as_str()).unwrap_or("?"),
            team.get("isUserMuted").and_then(|x| x.as_bool()),
            team.get("isFollowed").and_then(|x| x.as_bool()),
        );
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            if ch.get("isRead").is_some() {
                with_is_read += 1;
            }
            if ch.get("isMessageRead").is_some() {
                with_is_message_read += 1;
            }
        }
    }
    println!("   channels carrying isRead={with_is_read}, isMessageRead={with_is_message_read}");

    // Print the full key set of one channel, so a differently-spelled setting is
    // visible even when the filter above misses it.
    if let Some(sample) = teams
        .iter()
        .filter_map(|t| t.get("channels").and_then(|c| c.as_array()))
        .flatten()
        .next()
    {
        let mut keys = keys_of(sample);
        keys.sort();
        println!("\n-- every key of one channel:\n   {keys:?}");
    }
    Ok(())
}
