// Manual live check: WHERE a chat's pin / mute / hide lives on the service, so this
// app can publish one instead of holding it locally.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY. It issues GETs
// only, and every one of them is a read the app already makes or could make:
//
//   1. GET {chatService}/v1/users/ME/conversations?view=msnp24Equivalent
//      the conversation list the chat service itself holds, WITH each conversation's
//      own `properties` object — which is the set of keys a `PUT …/properties?name=…`
//      can address — the same shape the read-position write addresses one key of.
//   2. GET {chatService}/v1/users/ME/conversations/{id}
//      one conversation, for a chat named on the command line.
//   3. GET the CSA aggregator, for the flags the sidebar reads today (`isSticky`,
//      `isMuted`, `hidden`).
//
// It then CORRELATES the two: for every property key, how often it appears on a chat
// CSA calls muted versus not, pinned versus not, hidden versus not. A key that tracks
// one of those flags is the key the write has to address.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example chat_settings_recon
//
//   # dump one chat's properties in full
//   … cargo run --example chat_settings_recon -- --conv 19:<id>@thread.v2
use anyhow::Result;
use serde_json::Value;
use std::collections::BTreeMap;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// How a chat stands in the user's own Teams client, per CSA.
#[derive(Default, Clone, Copy)]
struct CsaFlags {
    pinned: bool,
    muted: bool,
    hidden: bool,
}

/// How a property key's VALUES distribute against one CSA flag. A single sampled
/// value proves nothing — a key that carries the flag has to separate the two groups,
/// which only a histogram shows.
#[derive(Default)]
struct Correlation {
    on: BTreeMap<String, usize>,
    off: BTreeMap<String, usize>,
}

impl Correlation {
    fn count(map: &BTreeMap<String, usize>) -> usize {
        map.values().sum()
    }

    /// The histogram, shortest-first, capped so one noisy key cannot bury the report.
    fn histogram(map: &BTreeMap<String, usize>) -> String {
        let mut entries: Vec<_> = map.iter().collect();
        entries.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
        entries
            .iter()
            .take(3)
            .map(|(value, count)| format!("{count}×{value}"))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.chars().count() > 60 {
        format!("{}…", s.chars().take(60).collect::<String>())
    } else {
        s
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let named: Vec<String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| *a == "--conv" && args.len() > i + 1)
        .map(|(i, _)| args[i + 1].clone())
        .collect();

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let chat_service = session
        .endpoint("chatService")
        .expect("no chatService endpoint")
        .trim_end_matches('/')
        .to_string();
    println!("== region={} chatService={chat_service}", session.region);

    // ---- 1. the flags the sidebar reads today, from CSA -------------------------
    let token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
    let csa: Value = serde_json::from_str(
        &http
            .get(CSA_URL)
            .bearer_auth(&token)
            .header("x-skypetoken", &session.skypetoken)
            .send()
            .await?
            .text()
            .await?,
    )?;
    let mut flags: BTreeMap<String, CsaFlags> = BTreeMap::new();
    for chat in csa.get("chats").and_then(|c| c.as_array()).into_iter().flatten() {
        let Some(id) = chat.get("id").and_then(|x| x.as_str()) else { continue };
        flags.insert(
            id.to_string(),
            CsaFlags {
                pinned: chat.get("isSticky").and_then(|x| x.as_bool()).unwrap_or(false),
                muted: chat.get("isMuted").and_then(|x| x.as_bool()).unwrap_or(false),
                hidden: chat.get("hidden").and_then(|x| x.as_bool()).unwrap_or(false),
            },
        );
    }
    // Every TOP-LEVEL key of the CSA payload, with the size of each array: a pin the
    // chat objects do not carry may well be a list of its own.
    println!("-- CSA top-level keys:");
    for (key, value) in csa.as_object().into_iter().flatten() {
        let shape = match value {
            Value::Array(a) => format!("array[{}]", a.len()),
            Value::Object(o) => format!("object{{{}}}", o.len()),
            other => short(other),
        };
        println!("   {key:34} = {shape}");
    }
    let pinned_count = flags.values().filter(|f| f.pinned).count();
    let muted_count = flags.values().filter(|f| f.muted).count();
    let hidden_count = flags.values().filter(|f| f.hidden).count();
    println!(
        "== CSA: {} chats — {pinned_count} pinned (isSticky), {muted_count} muted, {hidden_count} hidden",
        flags.len()
    );

    // ---- 2. the chat service's own conversation list, with `properties` ---------
    let list_url = format!(
        "{chat_service}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=200&startTime=1"
    );
    let resp = http
        .get(&list_url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    println!("== GET /v1/users/ME/conversations -> {status} ({} bytes)", body.len());
    if !status.is_success() {
        println!("   body: {}", body.chars().take(400).collect::<String>());
    }
    let list: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let conversations = list
        .get("conversations")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    println!("== {} conversations from the chat service", conversations.len());

    // Every top-level key one conversation object carries, so nothing is missed.
    let mut object_keys: BTreeMap<String, usize> = BTreeMap::new();
    for conversation in &conversations {
        for key in conversation.as_object().into_iter().flatten().map(|(k, _)| k) {
            *object_keys.entry(key.clone()).or_default() += 1;
        }
    }
    println!("-- conversation object keys:");
    for (key, count) in &object_keys {
        println!("   {key:40} {count}");
    }

    // ---- 3. correlate every property BAG's keys with each CSA flag -------------
    // Three bags carry state for a conversation and any of them could hold the
    // setting: `properties` (user-scoped), `threadProperties` (the thread's own) and
    // `memberProperties` (this member's).
    let bags = ["properties", "threadProperties", "memberProperties"];
    let mut by_bag: BTreeMap<&str, BTreeMap<&'static str, BTreeMap<String, Correlation>>> =
        BTreeMap::new();
    // CHATS ONLY. The chat service returns channels in the same list, and a channel's
    // `favorite` is Teams' Show/Hide switch — true on most of them — which drowns
    // every chat signal if it is counted in.
    let mut chats_seen = 0usize;
    for conversation in &conversations {
        let Some(id) = conversation.get("id").and_then(|x| x.as_str()) else { continue };
        let Some(flag) = flags.get(id).copied() else { continue };
        chats_seen += 1;
        for bag in bags {
            let Some(properties) = conversation.get(bag).and_then(|p| p.as_object()) else {
                continue;
            };
            for (name, value) in properties {
                for (label, on) in
                    [("pinned", flag.pinned), ("muted", flag.muted), ("hidden", flag.hidden)]
                {
                    let entry = by_bag
                        .entry(bag)
                        .or_default()
                        .entry(label)
                        .or_default()
                        .entry(name.clone())
                        .or_default();
                    let bucket = if on { &mut entry.on } else { &mut entry.off };
                    *bucket.entry(short(value)).or_default() += 1;
                }
            }
        }
    }
    println!("== {chats_seen} of those conversations are chats CSA also lists");
    for (bag, by_flag) in &by_bag {
        for (label, keys) in by_flag {
            println!("-- `{bag}` keys vs CSA `{label}`:");
            for (name, c) in keys {
                let on = Correlation::count(&c.on);
                let off = Correlation::count(&c.off);
                // A key worth a line either appears in the flagged group, or splits the
                // unflagged one — a key with one value everywhere carries nothing.
                if on == 0 && c.off.len() < 2 {
                    continue;
                }
                println!(
                    "   {name:30} on={on:<4} [{}]  off={off:<4} [{}]",
                    Correlation::histogram(&c.on),
                    Correlation::histogram(&c.off)
                );
            }
        }
    }

    // ---- 3b. one chat of each kind, in full ------------------------------------
    // The correlation above is over whatever page the service returned; these are the
    // ground truth for the three states, whichever page they came from.
    let sample = |predicate: fn(&CsaFlags) -> bool| -> Option<String> {
        conversations.iter().find_map(|c| {
            let id = c.get("id").and_then(|x| x.as_str())?;
            let flag = flags.get(id)?;
            predicate(flag).then(|| id.to_string())
        })
    };
    for (label, id) in [
        ("hidden", sample(|f| f.hidden)),
        ("muted", sample(|f| f.muted)),
        ("plain", sample(|f| !f.hidden && !f.muted && !f.pinned)),
    ] {
        let Some(id) = id else {
            println!("-- no {label} chat on this page");
            continue;
        };
        let Some(conversation) = conversations
            .iter()
            .find(|c| c.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
        else {
            continue;
        };
        println!("-- a {label} chat, as the chat service holds it ({id}):");
        for bag in bags {
            if let Some(map) = conversation.get(bag).and_then(|p| p.as_object()) {
                for (name, value) in map {
                    println!("   {bag}.{name:32} = {}", short(value));
                }
            }
        }
    }

    // ---- 4. one chat in full, when asked ---------------------------------------
    for id in &named {
        // CSA first: it is the payload the sidebar's own flags are parsed from, so its
        // keys are what a mis-read flag has to be checked against.
        if let Some(chat) = csa
            .get("chats")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .find(|c| c.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
        {
            println!("== CSA chat object {id}:");
            for (key, value) in chat.as_object().into_iter().flatten() {
                println!("   {key:34} = {}", short(value));
            }
        } else {
            println!("== CSA does not list {id}");
        }

        let url =
            format!("{chat_service}/v1/users/ME/conversations/{}", urlencoding::encode(id));
        let resp = http
            .get(&url)
            .header("authentication", format!("skypetoken={}", session.skypetoken))
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        println!("== GET one conversation {id} -> {status}");
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v)?),
            Err(_) => println!("{}", text.chars().take(600).collect::<String>()),
        }
        if let Some(flag) = flags.get(id) {
            println!(
                "   CSA says: pinned={} muted={} hidden={}",
                flag.pinned, flag.muted, flag.hidden
            );
        }
    }

    Ok(())
}
