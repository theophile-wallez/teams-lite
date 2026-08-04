// Manual live check: WHERE the user's chat with THEMSELVES lives — the "(You)" row the
// official Teams client puts at the top of its chat list. This app's sidebar shows every
// other one-to-one chat and not that one, so the question is whether Teams reports it at
// all.
//
// Measured on this tenant, 2026-08-04 — the answer is NO, in three independent reads:
//
//   1. CSA (`users/me`), the payload the sidebar IS built from, reports 957 chats — 98 of
//      them one-to-one — and NOT ONE names us twice. `metadata.hasMoreChats` is false and
//      `isPartialData` is false, so that list is complete rather than a first page.
//   2. The chat service's own conversation list names no such thread either.
//   3. Asked for BY NAME, the thread does not exist: `19:<oid>_<oid>@unq.gbl.spaces`
//      answers 404 `LocationLookupFailed` on both `/v1/threads/{id}` and its messages,
//      and the Skype-era spelling — the conversation addressed by our own MRI — answers
//      400 "The Thread Id is invalid" / 403 "Invalid conversation".
//
// So the "(You)" row is drawn by the official CLIENT, and the thread behind it is created
// by the first message sent into it. A list built from what Teams reports has nothing to
// show, which is the whole reason that chat is missing here.
//
// One trap this recon exists to record: a CSA chat's `members` array is NOT the roster.
// It lists only us on 281 of the 957 chats — 66 of the plain chats included — so "the
// members are only me" finds hundreds of ordinary colleagues' chats and proves nothing.
// The id is the reliable signal: a one-to-one thread is `19:<oid-a>_<oid-b>@unq.gbl.spaces`,
// so a chat with oneself is the one that spells the SAME oid twice.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY. It issues GETs only,
// and every one of them is a read the app already makes.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example self_chat_recon
//
//   # keep the raw payloads for a closer look
//   … cargo run --example self_chat_recon -- --dump
use anyhow::Result;
use serde_json::Value;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// The member MRIs a chat object lists — which is a SUBSET of the roster, and often
/// just us. Kept only to measure how unreliable it is.
fn members(chat: &Value) -> Vec<String> {
    chat.get("members")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("mri").and_then(|x| x.as_str()))
        .map(str::to_string)
        .collect()
}

/// Does this conversation id name `guid` twice? That is the shape of a one-to-one
/// thread with oneself, and the only signal that does not lie (see the header).
fn names_us_twice(id: &str, guid: &str) -> bool {
    !guid.is_empty() && id.matches(guid).count() >= 2
}

/// Print the fields the chat-list sync reads, so a chat that never reaches the sidebar
/// names its own reason.
fn describe(chat: &Value) {
    for key in [
        "id",
        "title",
        "chatType",
        "threadType",
        "isOneOnOne",
        "isEmptyConversation",
        "hidden",
        "isSticky",
    ] {
        match chat.get(key) {
            Some(v) => println!("   {key:21} = {v}"),
            None => println!("   {key:21} = (absent)"),
        }
    }
    println!("   members               = {:?}", members(chat));
}

#[tokio::main]
async fn main() -> Result<()> {
    let dump = std::env::args().any(|a| a == "--dump");
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let chat_service = session
        .endpoint("chatService")
        .expect("no chatService endpoint")
        .trim_end_matches('/')
        .to_string();
    // The oid inside our MRI is what a one-to-one thread id is built from.
    let guid = session.self_mri.rsplit(':').next().unwrap_or("").to_string();
    println!("== me={} oid={guid} region={}", session.self_mri, session.region);

    // ---- 1. the chat list the sidebar is built from -----------------------------
    let token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
    let body = http
        .get(CSA_URL)
        .bearer_auth(&token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await?
        .text()
        .await?;
    if dump {
        std::fs::write("/tmp/csa-users-me.json", body.as_bytes())?;
        println!("   CSA payload written to /tmp/csa-users-me.json");
    }
    let csa: Value = serde_json::from_str(&body)?;
    let chats: Vec<&Value> =
        csa.get("chats").and_then(|c| c.as_array()).into_iter().flatten().collect();
    let one_on_one = chats.iter().filter(|c| c.get("isOneOnOne") == Some(&Value::Bool(true))).count();
    let plain = chats.iter().filter(|c| c.get("threadType").and_then(|x| x.as_str()) == Some("chat"));
    let members_only_us = chats
        .iter()
        .filter(|c| members(c) == vec![session.self_mri.clone()])
        .count();
    println!(
        "== CSA: {} chats, {one_on_one} one-to-one — and {members_only_us} of them list us as \
         their only member, which is why `members` proves nothing",
        chats.len(),
    );
    println!("   metadata = {}", csa.get("metadata").map(|m| m.to_string()).unwrap_or_default());
    println!("   plain chats (threadType=chat): {}", plain.count());

    let mut found = 0;
    for chat in &chats {
        let id = chat.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if names_us_twice(id, &guid) {
            found += 1;
            println!("-- CSA chat naming us twice:");
            describe(chat);
        }
    }
    println!("== CSA names us twice in {found} chat(s)");

    // ---- 2. the chat service's own list, in case CSA omits the thread -----------
    let list_url = format!(
        "{chat_service}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=200&startTime=1"
    );
    let body = http
        .get(&list_url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await?
        .text()
        .await?;
    if dump {
        std::fs::write("/tmp/chatservice-conversations.json", body.as_bytes())?;
        println!("   chat service list written to /tmp/chatservice-conversations.json");
    }
    let list: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let conversations: Vec<&Value> = list
        .get("conversations")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
        .collect();
    let mut ids: Vec<String> = Vec::new();
    for conversation in &conversations {
        let id = conversation.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if names_us_twice(id, &guid) {
            ids.push(id.to_string());
        }
    }
    println!(
        "== chatService: {} conversations, {} naming us twice",
        conversations.len(),
        ids.len(),
    );

    // ---- 3. the two spellings, asked for BY NAME --------------------------------
    // A list that omits a thread does not prove the thread is absent, so ask the
    // service for it: the modern one-to-one id, then the Skype-era conversation
    // addressed by the person's own MRI.
    if !guid.is_empty() {
        ids.push(format!("19:{guid}_{guid}@unq.gbl.spaces"));
    }
    ids.push(session.self_mri.clone());
    for id in &ids {
        for (what, url) in [
            ("thread", format!("{chat_service}/v1/threads/{}?view=msnp24Equivalent", urlencoding::encode(id))),
            (
                "messages",
                format!(
                    "{chat_service}/v1/users/ME/conversations/{}/messages?pageSize=20&view=msnp24Equivalent",
                    urlencoding::encode(id)
                ),
            ),
        ] {
            let resp = http
                .get(&url)
                .header("authentication", format!("skypetoken={}", session.skypetoken))
                .send()
                .await?;
            let status = resp.status();
            let body = resp.text().await?;
            println!("== GET {what} {id} -> {status}");
            println!("   {}", body.chars().take(240).collect::<String>());
        }
    }
    Ok(())
}
