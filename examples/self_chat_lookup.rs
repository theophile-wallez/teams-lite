// Manual live check, second pass: FIND the user's chat with themselves. The official
// Teams client shows it, so the thread exists — the first pass only proved that the CSA
// snapshot and the FIRST page of the chat service's list do not name it, and that the
// id spelling I guessed (`19:<oid>_<oid>@unq.gbl.spaces`) is not the one.
//
// Three reads, each able to find it on its own:
//
//   1. Microsoft Graph `GET /me/chats?$expand=members` — the tenant's own view of the
//      user's chats, which carries `chatType` and the roster. A self chat is the one
//      whose members are us alone. Graph states the id, which is what everything else
//      needs.
//   2. The chat service's conversation list, paginated to the END through its own
//      `_metadata.backwardLink`, instead of the first page only.
//   3. The CSA aggregator again, this time WITHOUT guessing the id shape: every chat is
//      printed whose title or last-message sender is us and whose id names one oid only.
//
// READ-ONLY: GETs only.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example self_chat_lookup
use anyhow::Result;
use serde_json::Value;

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

/// The MRIs a Graph chat's expanded members report.
fn graph_member_ids(chat: &Value) -> Vec<String> {
    chat.get("members")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| {
            m.get("userId")
                .and_then(|x| x.as_str())
                .or_else(|| m.get("displayName").and_then(|x| x.as_str()))
        })
        .map(str::to_string)
        .collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let chat_service = session
        .endpoint("chatService")
        .expect("no chatService endpoint")
        .trim_end_matches('/')
        .to_string();
    let oid = session.self_mri.rsplit(':').next().unwrap_or("").to_string();
    println!("== me={} oid={oid}", session.self_mri);

    // ---- 1. Graph: the tenant's own view, with the roster ------------------------
    // A Graph token is a separate broker call, and it can fail on its own (the PRT
    // wants an interaction for that audience). That must not cost us reads 2 and 3.
    let graph = match teams_lite::auth::get_token(teams_lite::teams_media::GRAPH_SCOPE).await {
        Ok(token) => token,
        Err(e) => {
            println!("== Graph token unavailable: {e:#}");
            String::new()
        }
    };
    let mut url = (!graph.is_empty())
        .then(|| "https://graph.microsoft.com/v1.0/me/chats?$expand=members&$top=50".to_string());
    let mut page = 0;
    let mut graph_total = 0;
    while let Some(next) = url.take() {
        page += 1;
        let resp = http.get(&next).bearer_auth(&graph).send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            println!("== Graph /me/chats page {page} -> {status}");
            println!("   {}", body.chars().take(300).collect::<String>());
            break;
        }
        let v: Value = serde_json::from_str(&body)?;
        let chats: Vec<&Value> =
            v.get("value").and_then(|x| x.as_array()).into_iter().flatten().collect();
        graph_total += chats.len();
        for chat in chats {
            let ids = graph_member_ids(chat);
            let only_us = !ids.is_empty() && ids.iter().all(|id| id.eq_ignore_ascii_case(&oid));
            if only_us {
                println!("-- Graph chat whose ROSTER is us alone:");
                println!("   id         = {}", chat.get("id").and_then(|x| x.as_str()).unwrap_or(""));
                println!("   chatType   = {}", chat.get("chatType").unwrap_or(&Value::Null));
                println!("   topic      = {}", chat.get("topic").unwrap_or(&Value::Null));
                println!("   created    = {}", chat.get("createdDateTime").unwrap_or(&Value::Null));
                println!("   lastUpdate = {}", chat.get("lastUpdatedDateTime").unwrap_or(&Value::Null));
                println!("   members    = {ids:?}");
            }
        }
        url = v.get("@odata.nextLink").and_then(|x| x.as_str()).map(str::to_string);
        if page >= 20 {
            println!("   (stopped after 20 pages)");
            break;
        }
    }
    println!("== Graph: {graph_total} chats read");

    // ---- 2. the chat service's list, to the END ---------------------------------
    let mut next = Some(format!(
        "{chat_service}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=200&startTime=1"
    ));
    let mut seen = 0;
    let mut pages = 0;
    let mut doubled = Vec::new();
    while let Some(url) = next.take() {
        pages += 1;
        let body = http
            .get(&url)
            .header("authentication", format!("skypetoken={}", session.skypetoken))
            .send()
            .await?
            .text()
            .await?;
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let list: Vec<&Value> =
            v.get("conversations").and_then(|x| x.as_array()).into_iter().flatten().collect();
        seen += list.len();
        for conversation in list {
            let id = conversation.get("id").and_then(|x| x.as_str()).unwrap_or("");
            if !oid.is_empty() && id.matches(&oid).count() >= 2 {
                doubled.push(id.to_string());
            }
        }
        // An empty page ends the walk; the link is always present.
        let link = v
            .get("_metadata")
            .and_then(|m| m.get("backwardLink"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        next = if link.is_empty() || pages >= 15 || v
            .get("conversations")
            .and_then(|x| x.as_array())
            .is_none_or(|a| a.is_empty())
        {
            None
        } else {
            Some(link.to_string())
        };
    }
    println!("== chatService: {seen} conversations over {pages} page(s), {doubled:?} name us twice");

    // ---- 3. CSA, without guessing the id shape ----------------------------------
    // The aggregator needs its own AAD token, which can be refused on its own (the PRT
    // wants an interaction for that audience). The reads below run on the skypetoken, so
    // they must not go down with it.
    let csa = match teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await {
        Ok(token) => serde_json::from_str(
            &http
                .get(CSA_URL)
                .bearer_auth(&token)
                .header("x-skypetoken", &session.skypetoken)
                .send()
                .await?
                .text()
                .await?,
        )
        .unwrap_or(Value::Null),
        Err(e) => {
            println!("== CSA token unavailable: {e:#}");
            Value::Null
        }
    };
    let chats: Vec<&Value> =
        csa.get("chats").and_then(|c| c.as_array()).into_iter().flatten().collect();
    // A one-to-one id names two oids. A self chat can only be an id that names OURS and
    // no other, whatever the separator — so count the oids an id holds.
    let mut candidates = 0;
    for chat in &chats {
        let id = chat.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let ours = !oid.is_empty() && id.contains(&oid);
        let oid_like = id
            .trim_start_matches("19:")
            .trim_end_matches("@unq.gbl.spaces")
            .split('_')
            .filter(|part| part.len() == 36)
            .count();
        if ours && oid_like == 1 {
            candidates += 1;
            println!(
                "-- CSA chat naming our oid and no other: {id} oneOnOne={} title={} lm={}",
                chat.get("isOneOnOne").unwrap_or(&Value::Null),
                chat.get("title").unwrap_or(&Value::Null),
                chat.get("lastMessage")
                    .and_then(|m| m.get("content"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(50)
                    .collect::<String>(),
            );
        }
    }
    println!("== CSA: {} chats, {candidates} naming our oid alone", chats.len());

    // ---- 4. found it: `48:notes`, in privateFeeds ---------------------------------
    // The self chat is not a `19:` thread at all. It is the notes-to-self feed, which
    // CSA delivers beside the activity streams — so a list built from `chats` alone can
    // never hold it. Print the feed the parser now reads, then walk the thread through
    // this crate's OWN message parser, which is what the app will show.
    let feeds: Vec<&Value> =
        csa.get("privateFeeds").and_then(|f| f.as_array()).into_iter().flatten().collect();
    println!(
        "== CSA privateFeeds: {:?}",
        feeds.iter().filter_map(|f| f.get("id").and_then(|x| x.as_str())).collect::<Vec<_>>()
    );
    if let Some(notes) = feeds
        .iter()
        .find(|f| f.get("id").and_then(|x| x.as_str()) == Some(teams_lite::teams_activity::NOTES_THREAD))
    {
        println!("-- 48:notes as CSA delivers it:");
        println!("   threadType          = {}", notes.get("threadType").unwrap_or(&Value::Null));
        println!(
            "   isEmptyConversation = {}",
            notes.get("isEmptyConversation").unwrap_or(&Value::Null)
        );
        println!("   title               = {}", notes.get("title").unwrap_or(&Value::Null));
        for key in ["isRead", "isSticky", "hidden", "isMuted", "isLastMessageFromMe"] {
            println!("   {key:19} = {}", notes.get(key).unwrap_or(&Value::Null));
        }
        println!("   members             = {}", notes.get("members").unwrap_or(&Value::Null));
    }

    // The history runs on the skypetoken, so it answers even when CSA's own token does
    // not — which is what makes this the reliable half of the proof.
    {
        let page = teams_lite::teams_read::fetch_messages_page(
            &http,
            &session,
            teams_lite::teams_activity::NOTES_THREAD,
            None,
            20,
        )
        .await?;
        println!(
            "== our own parser over 48:notes: {} message(s), more_older={}",
            page.messages.len(),
            page.has_more_older
        );
        for m in page.messages.iter().rev().take(5) {
            println!(
                "   {} {} | {}",
                m.compose_time,
                m.sender,
                teams_lite::teams_read::plain_text_from_html(&m.content)
                    .chars()
                    .take(60)
                    .collect::<String>()
            );
        }
    }
    Ok(())
}
