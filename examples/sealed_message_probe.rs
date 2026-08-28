// Manual live check for a SEALED message: can a ciphertext travel in a Teams message body
// and come back byte for byte?
//
// This is the de-risking spike for per-chat encryption (AGENTS.md § A sealed chat). The
// whole feature rests on one fact nothing on this side can know: Teams SANITIZES a message
// body server-side, so what a client reads back is not necessarily what it posted. A
// ciphertext that survives 99 bytes and is rewritten at 40 000 is a feature that works in
// every test and loses a colleague's message in the one thread that matters — and an AEAD
// has no partial credit: one byte changed anywhere and the whole message is unreadable, for
// everybody, for ever.
//
// Five things it measures, each one a decision:
//   1. THE CARRIER. A body that is ONE opaque base64url token and nothing else — no notice, no
//      words, no name of this app — read back and compared BYTE FOR BYTE at three sizes (a
//      one-line message, a long one, and one far past anything a person types). A ceiling, if
//      there is one, decides whether the envelope may carry the whole body at all.
//   2. THE ALPHABET. base64url (`A-Za-z0-9-_`, no padding) rather than standard base64:
//      nothing in it can be read as markup, and no `+` or `=` to be rewritten. If the
//      sanitizer linkifies or escapes a long token, this is where it shows.
//   3. AN EDIT. The agent posts a placeholder and EDITS it about once a second, so every
//      streaming frame is a re-seal. An edit that mangles the envelope breaks the whole
//      agent path and nothing else.
//   4. THE INVISIBLE CARRIER. `properties.<name>` is where `subject`, `emotions`,
//      `mentions` and `scheduledsendtime` all live, and a custom name there would keep the
//      ciphertext out of the body a stock Teams client draws. Measured because it is free to
//      measure — but the BODY is what ships, for the reason recorded under the numbers below.
//   5. THE ROUND TRIP THROUGH THIS CRATE. The store keeps what `teams_read` decoded, so the
//      last comparison is against the parser that really feeds it — not against raw JSON.
//
// It is NOT a unit test: it posts to real Teams. Two rails, both deliberate:
//   - the conversation is a CONST — the sandbox chat from AGENTS.md, the one place a send is
//     pre-authorized. Do not parameterize it (rule 1c of
//     .claude/hooks/guard-live-automation.sh refuses an example that can post anywhere).
//   - what it posts it removes: every message is deleted on the way out, so the sandbox
//     thread is left as it was found.
//
// Nothing secret is in it. The "ciphertext" is a deterministic pattern rather than a real
// seal: what is under test is the CARRIER, and a pattern makes the first differing byte
// something this probe can point at.
//
// MEASURED 2026-08-24 on the real tenant, and every number below decides something:
//   - THE BODY IS A CARRIER. A base64url envelope came back BYTE FOR BYTE at 374 chars and at
//     10 923 chars, through the sanitizer and through `teams_read`'s own parse. So the
//     ciphertext can travel where every Teams client already renders a body.
//   - AN EDIT KEEPS IT: the same comparison after `edit_message`, identical. That is the agent
//     path, whose every streaming frame is a re-seal.
//   - THE BODY'S CEILING IS 102 400 BYTES, the service's own `MessageSizeExceeded` on the
//     whole message ("max allowed size is 102400 bytes"). base64 is 4 bytes out for 3 in, so a
//     sealed message must be bounded on this side or the send is refused — which is why the
//     envelope DEFLATES the body first and why `MAX_SEALED_PLAINTEXT` exists.
//   - THE SENDER'S MRI ROUND-TRIPS IDENTICALLY: sealed under `Session::self_mri`, read back by
//     this crate's own parser as the same string byte for byte. That is what makes it safe to
//     BIND the sender into the AAD (`seal::aad`), which is what stops the tenant re-delivering
//     one colleague's sealed words under another colleague's name.
//   - THE CLIENTMESSAGEID COMES BACK (`Some("1787569374654")`), so a REPLAY of the same bytes at
//     a later moment could be bound out too. It is not bound today: `teams_read` parses no
//     clientmessageid off an inbound message, so the reader has nothing to compare against — a
//     stated gap rather than an unknown one.
//   - THE WHOLE CHAIN CLOSES. A real message sealed by `seal::seal`, posted through
//     `teams_send`, read back through `teams_read` and opened by `seal::open` came out WORD FOR
//     WORD: `<p>the merger closes on <b>Friday</b></p>`, 41 characters of words in a 142-character
//     body. With no passphrase at all the same message answers `UnknownKey([cb, b4, a8, 55])` —
//     which is the locked row, naming which passphrase is missing. Every measurement above is about
//     the carrier; this one is the feature.
//   - A CUSTOM `properties.tlsealed` IS KEPT, byte for byte — and its budget is a SEPARATE and
//     much smaller 28 672 bytes ("Message properties size exceeded"). It is the prettier
//     carrier (a stock Teams client would draw the notice alone, with no base64 under it) and
//     it is deliberately NOT what ships: it is an undocumented field, and the day the service
//     drops one the message is lost for everybody with nothing to report, while the BODY is
//     the field the service has never dropped. Measured so the next reader need not wonder.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example sealed_message_probe
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

use teams_lite::{seal, teams, teams_read, teams_send};

/// The sandbox chat (AGENTS.md § Sending messages). The only pre-authorized target, and the
/// only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// The property name the fourth measurement tries. Namespaced, so it can never collide with
/// a field the service knows.
const SEALED_PROPERTY: &str = "tlsealed";

/// The three sizes, in PLAINTEXT bytes before encoding. base64 is 4 bytes out per 3 in, so
/// the envelope is a third larger again.
///
/// 280 is a message somebody types. 8 KiB is a long one — an agent's answer, which is the
/// biggest thing this app posts. 96 KiB is far past anything real, and it is here to find a
/// ceiling rather than to ship: what is wanted is the FIRST size that fails, if any.
const SIZES: [(usize, &str); 3] = [(280, "a typed message"), (8 * 1024, "an agent's answer"), (96 * 1024, "far past anything real")];

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    let mut posted: Vec<String> = Vec::new();

    // 1-3. The carrier, at three sizes, compared byte for byte.
    println!("\n=== 1. the envelope in the body, byte for byte ===");
    let mut widest_ok = 0usize;
    for (bytes, note) in SIZES {
        let envelope = envelope_of(bytes);
        let body = sealed_body(&envelope);
        println!("\n{note}: {bytes} plaintext bytes -> {} envelope chars, {} body chars", envelope.len(), body.len());
        match post(&http, &session, &body).await {
            Err(e) => println!("  the SEND was refused: {e:#}"),
            Ok(id) => {
                posted.push(id.clone());
                let raw = read_raw(&http, &session, &id).await?;
                let stored = raw.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
                report("raw read", &envelope, &stored);
                let parsed = read_through_parser(&http, &session, &id).await?;
                report("this crate's parser", &envelope, &parsed.unwrap_or_default());
                if envelope_in(&stored).as_deref() == Some(envelope.as_str()) {
                    widest_ok = widest_ok.max(bytes);
                }
            }
        }
    }
    println!("\nthe widest plaintext that survived the body: {widest_ok} bytes");

    // 4. An edit, which is what every streaming frame of an agent's answer really is.
    println!("\n=== 2. an EDIT re-seals, and the new envelope must survive too ===");
    let first = envelope_of(280);
    let id = post(&http, &session, &sealed_body(&first)).await?;
    posted.push(id.clone());
    let second = envelope_of(1024);
    teams_send::edit_message(
        &http, &session, SANDBOX_THREAD, &id, "", Some(&sealed_body(&second)), &[], None, None,
    )
        .await
        .context("edit a sealed message")?;
    let raw = read_raw(&http, &session, &id).await?;
    report("after an edit", &second, raw.get("content").and_then(Value::as_str).unwrap_or_default());

    // 5. The invisible carrier: a property of our own beside the ones the service knows.
    println!("\n=== 3. a custom `properties.{SEALED_PROPERTY}` — is it kept? ===");
    let hidden = envelope_of(280);
    match post_with_property(&http, &session, &hidden).await {
        Err(e) => println!("  the SEND was refused: {e:#}"),
        Ok(id) => {
            posted.push(id.clone());
            let raw = read_raw(&http, &session, &id).await?;
            let got = property_of(&raw, SEALED_PROPERTY);
            match got.as_deref() {
                Some(v) if v == hidden => println!("  KEPT, byte for byte — the envelope can stay OUT of the body"),
                Some(v) => println!("  kept but REWRITTEN ({} chars vs {}): not a carrier", v.len(), hidden.len()),
                None => println!("  DROPPED — the service keeps only the properties it knows, so the BODY is the carrier"),
            }
        }
    }

    // 5. WHAT ELSE THE ENVELOPE COULD BE BOUND TO. The AAD binds the conversation today, so a
    //    ciphertext cannot be replayed into another chat — but nothing binds the SENDER, and the
    //    service owns the `from` field. Binding the sender's mri would stop the tenant
    //    re-delivering one colleague's sealed words as another's, which is the one thing this app
    //    promises never to misstate. Binding is only safe if the mri the reader sees is the mri
    //    the sealer used, BYTE FOR BYTE — a mismatch would make every message unreadable, so it
    //    is measured rather than assumed. The clientmessageid is measured beside it, because
    //    binding that is what would stop a replay of the same bytes at a later moment.
    println!("\n=== 5. what the envelope could also be bound to ===");
    {
        let id = post(&http, &session, &sealed_body(&envelope_of(280))).await?;
        posted.push(id.clone());
        let page = teams_read::fetch_newest(&http, &session, SANDBOX_THREAD).await?;
        match page.messages.iter().find(|m| m.id == id) {
            None => println!("  the message did not come back through the parser"),
            Some(parsed) => println!(
                "  sender mri: sealed as {:?}, read back as {:?} — {}",
                session.self_mri,
                parsed.sender_mri,
                if parsed.sender_mri == session.self_mri {
                    "IDENTICAL, so the sender can be bound into the AAD"
                } else {
                    "DIFFERENT: binding the sender would make every message unreadable"
                }
            ),
        }
        let raw = read_raw(&http, &session, &id).await?;
        let cmid = raw.get("clientmessageid").and_then(Value::as_str);
        println!(
            "  clientmessageid on the way back: {:?} — {}",
            cmid,
            match cmid {
                Some(_) => "present, so a replay could be bound out",
                None => "ABSENT: the service does not return it, so a replay cannot be bound out yet",
            }
        );
    }

    // 6. THE WHOLE CHAIN, through the code that really ships. Everything above measures the
    //    CARRIER with a stand-in pattern; this seals a real message with `seal::seal`, posts it
    //    through `teams_send`, reads it back through `teams_read`, and opens it with `seal::open`.
    //    If this says WORDS, then a sealed chat works end to end against the real tenant.
    println!("\n=== 6. a real seal, posted and opened again ===");
    {
        let words = "<p>the merger closes on <b>Friday</b></p>";
        let key = seal::derive("probe passphrase", SANDBOX_THREAD)?;
        let body = seal::seal(&key, SANDBOX_THREAD, &session.self_mri, words)?;
        println!("  sealed {} chars of words into a {} char body", words.len(), body.len());
        let id = post(&http, &session, &body).await?;
        posted.push(id.clone());

        let page = teams_read::fetch_newest(&http, &session, SANDBOX_THREAD).await?;
        let stored = page
            .messages
            .iter()
            .find(|m| m.id == id)
            .context("the message did not come back")?;
        // The sender the reader really sees, which is what the envelope binds.
        match seal::open(&[key], SANDBOX_THREAD, &stored.sender_mri, &stored.content) {
            seal::Opened::Words(back) if back == words => {
                println!("  OPENED, word for word: {back:?}")
            }
            seal::Opened::Words(back) => println!("  opened but CHANGED: {back:?}"),
            other => println!("  FAILED: {other:?} — the chain does not close"),
        }
        // And what a reader with NO passphrase sees: a locked row, naming which key it needs.
        let without = seal::open(&[], SANDBOX_THREAD, &stored.sender_mri, &stored.content);
        println!("  with no passphrase at all: {without:?}");
    }

    // 7. The CEILING, in the service's own words, and which half of the message it counts.
    //    An AEAD has no partial credit and base64 is 4 bytes out for 3 in, so the largest
    //    message this app may seal is a number the feature has to know — and whether the
    //    envelope is cheaper in a property than in the body decides which carrier ships.
    println!("\n=== 4. the ceiling the service enforces ===");
    for (where_, in_body) in [("in the body", true), ("in the property", false)] {
        let envelope = envelope_of(96 * 1024);
        let refusal = raw_send_refusal(&http, &session, &envelope, in_body).await;
        match refusal {
            Ok(id) => {
                posted.push(id);
                println!("  {where_}: ACCEPTED at {} envelope chars", envelope.len());
            }
            Err(e) => println!("  {where_}: {e:#}"),
        }
    }

    // Leave the sandbox as it was found. A deletion is final, which is exactly why the probe
    // removes only the messages it posted itself, addressed by the ids the sends answered with.
    println!();
    for id in &posted {
        teams_send::delete_message(&http, &session, SANDBOX_THREAD, id)
            .await
            .with_context(|| format!("remove the probe's own message {id}"))?;
    }
    println!("removed all {} of the probe's messages", posted.len());
    Ok(())
}

/// A stand-in ciphertext of `bytes` plaintext bytes, base64url-encoded with no padding.
///
/// The pattern is deterministic on purpose: a real seal is noise, and noise makes "the 4
///102nd character differs" impossible to say anything about. Every byte value appears, so a
/// sanitizer that objects to one of them objects to this.
fn envelope_of(bytes: usize) -> String {
    let payload: Vec<u8> = (0..bytes).map(|i| (i % 256) as u8).collect();
    URL_SAFE_NO_PAD.encode(&payload)
}

/// The body a sealed message really carries: ONE opaque token and nothing else.
///
/// There is deliberately no notice, no words and no name of this app in it. A sentence saying
/// "sealed with teams-lite" would tell the tenant which client the user runs and tell every
/// colleague that this conversation has something to hide — and it would be the one part of a
/// sealed message that is readable, which is the opposite of the point. What marks the message
/// is inside the token: a magic and a version in its first decoded bytes, which is a marker
/// this app can find and nobody can read.
///
/// The cost is stated where the rule is: a colleague on a stock Teams client, or one who has
/// not been given the passphrase, is shown a token with nothing to explain it. That is the
/// user's own choice, and the app's own reader draws a locked row instead.
fn sealed_body(envelope: &str) -> String {
    format!("<p>{envelope}</p>")
}

/// The envelope inside a body, read back the way the app will read it: the body's whole text,
/// which for a sealed message is one token.
fn envelope_in(body: &str) -> Option<String> {
    let inner = body.strip_prefix("<p>")?.strip_suffix("</p>")?.trim();
    (!inner.is_empty() && inner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .then(|| inner.to_string())
}

/// Say whether what came back is what went out, and where the first difference is — the one
/// fact that turns "it did not work" into something actionable.
fn report(label: &str, sent: &str, body: &str) {
    match envelope_in(body) {
        None => println!("  {label}: the envelope LINE is gone (body {} chars) — the sanitizer removed the carrier", body.len()),
        Some(got) if got == sent => println!("  {label}: identical, {} chars", got.len()),
        Some(got) => {
            let at = got.bytes().zip(sent.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(sent.len()));
            println!(
                "  {label}: DIFFERS — {} chars back vs {} sent, first difference at {at} ({:?} vs {:?})",
                got.len(),
                sent.len(),
                &got.chars().skip(at.saturating_sub(8)).take(24).collect::<String>(),
                &sent.chars().skip(at.saturating_sub(8)).take(24).collect::<String>(),
            );
        }
    }
}

/// Post one body through this crate's own send, so what is measured is what ships.
async fn post(http: &reqwest::Client, session: &teams::Session, body: &str) -> Result<String> {
    let sent = teams_send::send_message(
        http,
        session,
        "",
        SANDBOX_THREAD,
        // No thread: every probe posts to the sandbox chat, which has no threads to post into.
        None,
        "",
        None,
        Some(body),
        &[],
        &[],
        // A probe mentions nobody: a mention notifies the person it names.
        &[],
        None,
        None,
        // A probe seals nothing: it posts to the sandbox chat in the clear.
        None,
    )
    .await
    .context("send a sealed message")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send answered with no id to address");
    Ok(sent.id)
}

/// Post a message whose envelope travels in a PROPERTY rather than in the body. Hand-built,
/// because `build_body` deliberately spells only the properties this app knows — measuring a
/// carrier is exactly the reason to reach past it once.
async fn post_with_property(
    http: &reqwest::Client,
    session: &teams::Session,
    envelope: &str,
) -> Result<String> {
    let chat = session.endpoint("chatService").context("no chatService endpoint")?.trim_end_matches('/');
    let url = format!("{chat}/v1/users/ME/conversations/{}/messages", urlencoding::encode(SANDBOX_THREAD));
    let body = serde_json::json!({
        "content": "<p>tl</p>",
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": session.self_name,
        "clientmessageid": format!("{}", uuid::Uuid::new_v4().as_u128() % 1_000_000_000_000_000_000),
        "properties": { SEALED_PROPERTY: envelope },
    });
    let resp = http
        .post(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("send with a custom property")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "send -> {status}: {}", text.chars().take(200).collect::<String>());
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(parsed
        .get("id")
        .or_else(|| parsed.get("OriginalArrivalTime"))
        .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))
        .unwrap_or_default())
}

/// Post one deliberately oversized message and report the service's WHOLE refusal — the app's
/// own send truncates an error at 160 characters, and the number the service names is the one
/// fact this measurement exists for. Returns the id if it was accepted after all.
async fn raw_send_refusal(
    http: &reqwest::Client,
    session: &teams::Session,
    envelope: &str,
    in_body: bool,
) -> Result<String> {
    let chat = session.endpoint("chatService").context("no chatService endpoint")?.trim_end_matches('/');
    let url = format!("{chat}/v1/users/ME/conversations/{}/messages", urlencoding::encode(SANDBOX_THREAD));
    let mut body = serde_json::json!({
        "content": if in_body { sealed_body(envelope) } else { "<p>ceiling probe</p>".to_string() },
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": session.self_name,
        "clientmessageid": format!("{}", uuid::Uuid::new_v4().as_u128() % 1_000_000_000_000_000_000),
    });
    if !in_body {
        body["properties"] = serde_json::json!({ SEALED_PROPERTY: envelope });
    }
    let resp = http
        .post(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("oversized send")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "refused {status}: {text}");
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(parsed
        .get("id")
        .or_else(|| parsed.get("OriginalArrivalTime"))
        .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))
        .unwrap_or_default())
}

/// One message as the service really answers it.
async fn read_raw(http: &reqwest::Client, session: &teams::Session, message_id: &str) -> Result<Value> {
    let chat = session.endpoint("chatService").context("no chatService endpoint")?.trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(SANDBOX_THREAD),
        urlencoding::encode(message_id)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("read the message back")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "read -> {status}: {}", text.chars().take(300).collect::<String>());
    serde_json::from_str(&text).context("the message is not JSON")
}

/// One property of a message, whichever of the two shapes the service answers with.
fn property_of(message: &Value, name: &str) -> Option<String> {
    let properties = message.get("properties")?;
    let object = match properties {
        Value::String(s) => serde_json::from_str::<Value>(s).ok()?,
        other => other.clone(),
    };
    match object.get(name)? {
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// The body one message carries, read back through the parser that really feeds the store —
/// so what is compared is what the app would hold rather than what the wire said.
async fn read_through_parser(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
) -> Result<Option<String>> {
    let page = teams_read::fetch_newest(http, session, SANDBOX_THREAD)
        .await
        .context("read the thread back")?;
    Ok(page.messages.iter().find(|m| m.id == message_id).map(|m| m.content.clone()))
}
