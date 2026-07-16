// teams-lite — TROUTER REAL-TIME CLIENT (the <500ms proof)
//
// Full flow, reverse-engineered from EionRobb/purple-teams (teams_trouter.c):
//   1. POST go.trouter.teams.microsoft.com/v4/a?epid={uuid}   (x-skypetoken)
//        -> { socketio, surl, connectparams, ccid? }
//   2. GET  {socketio}socket.io/1/?v=v4&{connectparams}&tc=..&epid=..&auth=true
//        -> "<sessionId>:<hb>:<to>:<transports>"   (Socket.IO v1 handshake)
//   3. WS   wss://{socketio}socket.io/1/websocket/{sessionId}?...   (+X-Skypetoken)
//   4. on "1::" -> user.authenticate (Bearer ic3) + user.activity + registrar POST
//   5. messages arrive as "3:::{...}" whose url ends with "/messaging" -> timestamp
//
// Socket.IO v1 text framing: "<type>:<id>:<endpoint>:<data>".
// No raw tokens are printed.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use teams_lite::{auth, store::Store, teams, trouter_events};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";
const TROUTER_BEGIN: &str = "https://go.trouter.teams.microsoft.com/v4/a";
const REGISTRAR: &str = "https://teams.microsoft.com/registrar/prod/V2/registrations";
const TCCV: &str = "2024.23.01.2";
const CLIENT_VERSION: &str = "1415/26061118216"; // seen on a real Teams web session
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

fn socketio_query(connectparams: &Value, epid: &str, ccid: Option<&str>) -> String {
    let mut q = String::from("v=v4&");
    if let Some(obj) = connectparams.as_object() {
        for (k, v) in obj {
            if let Some(val) = v.as_str() {
                q.push_str(&format!("{k}={}&", urlencoding::encode(val)));
            }
        }
    }
    let tc = format!("{{\"cv\":\"{TCCV}\",\"ua\":\"TeamsCDL\",\"hr\":\"\",\"v\":\"{CLIENT_VERSION}\"}}");
    q.push_str(&format!("tc={}&", urlencoding::encode(&tc)));
    q.push_str("con_num=1234567890123_1&");
    q.push_str(&format!("epid={}&", urlencoding::encode(epid)));
    if let Some(c) = ccid {
        q.push_str(&format!("ccid={}&", urlencoding::encode(c)));
    }
    q.push_str("auth=true&timeout=40&");
    q
}

fn after_third_colon(s: &str) -> Option<&str> {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if c == ':' {
            n += 1;
            if n == 3 {
                return Some(&s[i + 1..]);
            }
        }
    }
    None
}

/// One-line, HTML-stripped preview of message content for the console.
fn snippet(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.chars().take(60).collect::<String>().replace('\n', " ")
}

fn now_hms() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let s = d.as_secs();
    format!("{:02}:{:02}:{:02}.{:03} UTC", (s / 3600) % 24, (s / 60) % 60, s % 60, d.subsec_millis())
}

async fn register(http: &reqwest::Client, skypetoken: &str, ic3: &str, surl: &str, epid: &str) -> Result<()> {
    let body = json!({
        "clientDescription": {
            "appId": "TeamsCDLWebWorker",
            "aesKey": "",
            "languageId": "en-US",
            "platform": "edge",
            "templateKey": "TeamsCDLWebWorker_2.1",
            "platformUIVersion": CLIENT_VERSION
        },
        "registrationId": epid,
        "nodeId": "",
        "transports": { "TROUTER": [{ "context": "", "path": surl, "ttl": 86400 }] }
    });
    let r = http
        .post(REGISTRAR)
        .header("content-type", "application/json")
        .header("X-Skypetoken", skypetoken)
        .header("authorization", format!("Bearer {ic3}"))
        .body(body.to_string())
        .send()
        .await?;
    println!("[registrar] TeamsCDLWebWorker -> {}", r.status());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;

    let ic3 = auth::get_token(IC3_SCOPE).await.context("ic3 token")?;
    let sess = teams::connect(&http).await?;
    println!("[ok] region={} | tokens ok", sess.region);
    let epid = Uuid::new_v4().to_string();

    // Slice 2: live events land in the same local-first store as history.
    let db_path = std::env::temp_dir().join("teams-lite-live.sqlite");
    let store = Store::open(db_path.to_str().unwrap())?;
    println!("[ok] store: {}", db_path.display());

    // 1. trouter connect
    let begin_url = format!("{TROUTER_BEGIN}?epid={}", urlencoding::encode(&epid));
    let r = http
        .post(&begin_url)
        .header("x-skypetoken", &sess.skypetoken)
        .header("content-length", "0")
        .send()
        .await?;
    let status = r.status();
    let body = r.text().await?;
    let info: Value = serde_json::from_str(&body)
        .with_context(|| format!("trouter begin -> {status}, body: {}", body.chars().take(200).collect::<String>()))?;
    let socketio = info.get("socketio").and_then(|v| v.as_str()).context("no socketio")?;
    let surl = info.get("surl").and_then(|v| v.as_str()).context("no surl")?.to_string();
    let connectparams = info.get("connectparams").cloned().unwrap_or(Value::Null);
    let ccid = info.get("ccid").and_then(|v| v.as_str());
    println!("[ok] trouter connect -> {status} (socketio host acquired)");

    // 2. socket.io v1 handshake
    let q = socketio_query(&connectparams, &epid, ccid);
    let hs_url = format!("{socketio}socket.io/1/?{q}");
    let hs = http.get(&hs_url).header("X-Skypetoken", &sess.skypetoken).send().await?;
    let hs_status = hs.status();
    let hs_body = hs.text().await?;
    if !hs_status.is_success() {
        return Err(anyhow!("socket.io handshake -> {hs_status}: {}", hs_body.chars().take(200).collect::<String>()));
    }
    let session_id = hs_body.split(':').next().unwrap_or("").to_string();
    if session_id.is_empty() {
        return Err(anyhow!("empty socket.io session id (body: {hs_body})"));
    }
    println!("[ok] socket.io session established");

    // 3. websocket connect
    let ws_url = format!("{socketio}socket.io/1/websocket/{session_id}?{q}")
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let mut req = ws_url.as_str().into_client_request().context("build ws request")?;
    req.headers_mut().insert("X-Skypetoken", sess.skypetoken.parse()?);
    req.headers_mut().insert("User-Agent", UA.parse()?);
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await.context("ws connect")?;
    println!("[ok] websocket connected — waiting for trouter handshake\n");
    let (mut write, mut read) = ws.split();

    let mut count = 1u32;
    let mut listen_start: Option<Instant> = None;
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            maybe = read.next() => {
                let Some(msg) = maybe else { println!("(stream ended)"); break; };
                let text = match msg.context("ws read")? {
                    Message::Text(t) => t.to_string(),
                    Message::Ping(p) => { write.send(Message::Pong(p)).await.ok(); continue; }
                    Message::Close(_) => { println!("(closed by server)"); break; }
                    _ => continue,
                };
                if text.is_empty() { continue; }

                match text.as_bytes()[0] {
                    b'1' => {
                        // connected -> authenticate + activity + register
                        let auth_msg = json!({
                            "name": "user.authenticate",
                            "args": [{
                                "headers": {
                                    "X-Ms-Test-User": "False",
                                    "Authorization": format!("Bearer {ic3}"),
                                    "X-MS-Migration": "True"
                                },
                                "connectparams": connectparams.clone()
                            }]
                        });
                        write.send(Message::Text(format!("5:::{auth_msg}").into())).await?;

                        let act = json!({"name":"user.activity","args":[{"state":"active","cv":"teamslite000000000000.0.1"}]});
                        write.send(Message::Text(format!("5:{count}+::{act}").into())).await?;
                        count += 1;

                        register(&http, &sess.skypetoken, &ic3, &surl, &epid).await?;
                        listen_start = Some(Instant::now());
                        println!("\n✅ CONNECTÉ & ENREGISTRÉ.");
                        println!("➡️  Envoie-toi un message Teams MAINTENANT (note-to-self ou n'importe quelle conv).\n");
                    }
                    b'3' => {
                        if let Some(payload) = after_third_colon(&text) {
                            if let Ok(reqv) = serde_json::from_str::<Value>(payload) {
                                let id = reqv.get("id").cloned().unwrap_or(json!(0));
                                let url = reqv.get("url").and_then(|u| u.as_str()).unwrap_or("");
                                // ack every request
                                let ack = json!({"id": id, "status": 200, "body": ""});
                                write.send(Message::Text(format!("3:::{ack}").into())).await?;

                                if url.ends_with("/messaging") {
                                    let when = listen_start
                                        .map(|s| format!(", +{} ms depuis la connexion", s.elapsed().as_millis()))
                                        .unwrap_or_default();
                                    println!("📩 [{}] MESSAGE reçu EN TEMPS RÉEL{when}", now_hms());

                                    // Slice 2: decode the push and persist into the store.
                                    match trouter_events::messages_from_request(&reqv) {
                                        Ok(msgs) => {
                                            for m in &msgs {
                                                // ensure the conversation row exists, then dedup-insert
                                                store.upsert_conversation(&m.conversation_id, "", m.compose_time).ok();
                                                match store.insert_message(m) {
                                                    Ok(true) => println!(
                                                        "   💾 stored [seq {}] {}: {}",
                                                        m.seq, m.sender, snippet(&m.content)
                                                    ),
                                                    Ok(false) => println!("   ↳ already in store (dedup) [seq {}]", m.seq),
                                                    Err(e) => println!("   ⚠️ store error: {e}"),
                                                }
                                            }
                                            if msgs.is_empty() {
                                                println!("   (event carried no chat message — e.g. edit/reaction/system)");
                                            }
                                        }
                                        Err(e) => println!("   ⚠️ decode error: {e}"),
                                    }
                                } else if url.contains("Presence") || url.ends_with("/unifiedPresenceService") {
                                    println!("·  [{}] push présence (le socket est VIVANT ✓)", now_hms());
                                } else {
                                    println!("·  [{}] push: {url}", now_hms());
                                }
                            }
                        }
                    }
                    _ => { /* '5' server msgs, '6' acks — ignore for the spike */ }
                }
            }
            _ = ping.tick() => {
                let _ = write.send(Message::Text(format!("5:{count}+::{{\"name\":\"ping\"}}").into())).await;
                count += 1;
            }
        }
    }

    Ok(())
}
