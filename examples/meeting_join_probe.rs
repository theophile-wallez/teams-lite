// Live probe: WHERE does a meeting join go, and in what shape?
//
// The first real attempt was refused — `400 Bad Request` with an empty body — and the
// service's own headers said why it could not have worked: the flightproxy forwarded
// our POST to `cc/v1/calls`, the CALL CONTROLLER, which creates a call. A join is not a
// call; the web client posts it to a CONVERSATION url, which it resolves first.
//
// The client's own code names that resolution: a create whose conversation already
// exists is answered `409` with `conversationUrl.Location`, and the client then joins
// that Location with `scenario: "409RedirectJoin"`. This walks exactly that, one
// variant at a time, and prints what the service answers to each.
//
// THIS REACHES A REAL MEETING, so two rails hold it:
//
//   * The meeting is PINNED as a const below — the one the user explicitly authorized
//     for testing, and their own. Nothing is taken from an argument, so this probe can
//     never address another meeting.
//   * Every attempt that SUCCEEDS is undone immediately: the probe leaves the meeting
//     on whichever link the answer named. A probe that joined and stayed would put a
//     silent participant in somebody's meeting.
//
// The SDP is a placeholder, not real media: this asks whether the SHAPE is accepted,
// and the browser is what produces a real offer (see web/src/lib/call-media.ts). So a
// successful join carries no audio in either direction.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example meeting_join_probe
use anyhow::{Context, Result};
use serde_json::{json, Value};
use teams_lite::calling;

/// The one meeting this probe may ever address: the user's own, authorized out loud for
/// exactly this test. Pinned as a const for the same reason a send probe pins the
/// sandbox chat — a target taken from an argument is a mistake waiting for a typo.
///
/// Its SUBJECT, because the link that matters is not the short one in the invitation
/// body: Graph hands the app the LONG form (thread + `{Tid, Oid}` context), and that is
/// what the app really sent. So the probe reads the event's own `joinUrl` from the
/// calendar and refuses to run unless the event it found is this one.
const MEETING_SUBJECT: &str = "Onboard";

/// A syntactically valid audio offer. It negotiates nothing: the question here is
/// whether the service accepts the envelope.
const PLACEHOLDER_SDP: &str = "v=0\r\n\
o=- 46117317 0 IN IP4 127.0.0.1\r\n\
s=teams-lite-probe\r\n\
t=0 0\r\n\
a=msid-semantic: WMS *\r\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n\
c=IN IP4 0.0.0.0\r\n\
a=rtcp-mux\r\n\
a=rtpmap:111 opus/48000/2\r\n\
a=setup:actpass\r\n\
a=mid:audio\r\n\
a=sendrecv\r\n\
a=ice-ufrag:probe\r\n\
a=ice-pwd:probeprobeprobeprobeprobe\r\n\
a=fingerprint:sha-256 \
00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await.context("sign in")?;
    let ic3 = teams_lite::auth::get_token("https://ic3.teams.office.com/Teams.AccessAsUser.All")
        .await
        .context("ic3 token")?;
    let endpoints = calling::endpoints(&session)?;

    // The authorized meeting's own join link, out of the calendar. Nothing else in this
    // file names a meeting, so this is the only one it can ever address.
    let graph = teams_lite::auth::get_token(teams_lite::calendar::CALENDAR_SCOPE).await?;
    let calendars = teams_lite::calendar::fetch_calendars(&http, &graph).await?;
    let mut join_url = String::new();
    let mut subject = String::new();
    for calendar in &calendars {
        let view = teams_lite::calendar::fetch_view(
            &http,
            &graph,
            &calendar.id,
            "2026-07-01T00:00:00Z",
            "2026-09-01T00:00:00Z",
        )
        .await?;
        if let Some(event) = view
            .events
            .into_iter()
            .find(|e| e.subject.contains(MEETING_SUBJECT) && !e.join_url.trim().is_empty())
        {
            join_url = event.join_url.clone();
            subject = event.subject.clone();
            break;
        }
    }
    anyhow::ensure!(
        subject.contains(MEETING_SUBJECT),
        "no `{MEETING_SUBJECT}` meeting with a join link in this window — this probe \
         addresses that meeting and no other"
    );
    println!("== meeting: {subject:?}");
    let meeting = calling::MeetingJoin::from_join_url(&join_url).context("parse the link")?;

    println!("== self={} region={}", session.self_mri, session.region);
    println!("== conversationService = {}", endpoints.conversation_service);
    println!(
        "== meeting: thread={:?} code={:?} passcode={}",
        meeting.thread_id,
        meeting.meeting_code,
        meeting.passcode.is_some()
    );

    let local = calling::LocalParticipant {
        id: session.self_mri.clone(),
        display_name: session.self_name.clone(),
        endpoint_id: uuid::Uuid::new_v4().to_string(),
        participant_id: uuid::Uuid::new_v4().to_string(),
    };
    // A trouter surl this probe never listens on: the service is only asked whether it
    // ACCEPTS the request, and the answer comes back in the HTTP response. A real call
    // publishes links on a live socket (see `trouter::Role::Calling`).
    let callbacks = calling::CallbackBase {
        surl: "https://go-eu.trouter.teams.microsoft.com/v4/f/probe/".into(),
        session_id: uuid::Uuid::new_v4().to_string(),
        cause_id: "0badcafe".into(),
    };
    let offer = calling::MediaContent::sdp(PLACEHOLDER_SDP);

    // STEP 1: join the conversation. No media — that is what the real client sends when
    // it opens the pre-join screen, captured field for field.
    println!("\n---- step 1: join the conversation (no media)");
    let correlation = uuid::Uuid::new_v4().to_string();
    let joined = calling::join_meeting(
        &http,
        &session,
        &ic3,
        &local,
        &meeting,
        &callbacks,
        &correlation,
    )
    .await;
    let joined = match joined {
        Ok(joined) => {
            println!("     ACCEPTED");
            println!("     controller: {:?}", joined.controller);
            println!("     state: {}", joined.state);
            println!("     links: {:?}", joined.links.names());
            joined
        }
        Err(e) => {
            println!("     refused: {e:#}");
            return Ok(());
        }
    };

    // STEP 2: add audio, on the link the answer named. This is the half the capture did
    // not show — the real client sends it when the user presses "Join now".
    println!("\n---- step 2: add audio");
    match calling::add_audio(
        &http,
        &session,
        &ic3,
        &local,
        &joined,
        &offer,
        &callbacks,
        &correlation,
    )
    .await
    {
        Ok(answer) => println!("     ACCEPTED: {}", one_line(&answer)),
        Err(e) => println!("     refused: {e:#}"),
    }

    // Leave again, whatever happened: a probe that stayed would be a silent participant.
    println!("\n---- leaving");
    if let Some(leave) = joined.links.get(&["leave", "hangup"]) {
        match calling::post_signal(
            &http,
            leave,
            &session,
            &ic3,
            &correlation,
            &json!({ "participants": { "from": {
                "id": local.id, "displayName": local.display_name,
                "endpointId": local.endpoint_id, "participantId": local.participant_id,
                "languageId": "en-us" } } }),
        )
        .await
        {
            Ok(_) => println!("     left"),
            Err(e) => println!("     could not leave: {e:#} — leave it in Teams if it stuck"),
        }
    }

    println!("\n== done. A 409 with a `conversationUrl.Location` is the answer we want:");
    println!("   it names the conversation this meeting already has, which is what a join joins.");
    Ok(())
}

/// POST one variant, print what came back, and leave the meeting again if it worked.
async fn attempt(
    http: &reqwest::Client,
    session: &teams_lite::teams::Session,
    ic3: &str,
    what: &str,
    url: &str,
    payload: &Value,
) {
    let correlation = uuid::Uuid::new_v4().to_string();
    println!("\n---- {what}\n     POST {url}");
    match calling::post_signal(http, url, session, ic3, &correlation, payload).await {
        Ok(answer) => {
            println!("     ACCEPTED: {}", one_line(&answer));
            let links = calling::Links::collect(&answer);
            println!("     links: {:?}", links.names());
            // Undo it at once: a probe that joined and stayed is a silent participant
            // in a real meeting.
            if let Some(leave) = links.hangup() {
                let body = calling::hangup_payload(&local_of(session));
                match calling::post_signal(http, leave, session, ic3, &correlation, &body).await {
                    Ok(_) => println!("     left again"),
                    Err(e) => println!("     COULD NOT LEAVE: {e:#} — leave it in Teams"),
                }
            } else {
                println!("     no link to leave on; if this joined, leave it in Teams");
            }
        }
        // The whole point of the probe: what the refusal says.
        Err(e) => println!("     refused: {e:#}"),
    }
}

fn local_of(session: &teams_lite::teams::Session) -> calling::LocalParticipant {
    calling::LocalParticipant {
        id: session.self_mri.clone(),
        display_name: session.self_name.clone(),
        endpoint_id: uuid::Uuid::new_v4().to_string(),
        participant_id: uuid::Uuid::new_v4().to_string(),
    }
}

/// A JSON answer on one line, short enough to read in a terminal.
fn one_line(value: &Value) -> String {
    let text = value.to_string();
    text.chars().take(600).collect()
}

/// POST with the credentials named rather than the ones `post_signal` always sends, so
/// the AUTHORIZATION can be varied independently of the payload.
async fn raw_attempt(
    http: &reqwest::Client,
    session: &teams_lite::teams::Session,
    bearer: Option<&str>,
    what: &str,
    url: &str,
    payload: &Value,
) {
    println!("     -- {what}");
    let mut request = http
        .post(url)
        .header("content-type", "application/json")
        .header("X-Skypetoken", &session.skypetoken)
        .header("X-Microsoft-Skype-Chain-ID", uuid::Uuid::new_v4().to_string())
        .header("X-MS-Migration", "True")
        .header("api-version", "2");
    if let Some(bearer) = bearer {
        request = request.header("authorization", format!("Bearer {bearer}"));
    }
    match request.json(payload).send().await {
        Ok(response) => {
            let status = response.status();
            // `www-authenticate` is how the service names the token types it accepts, and
            // it is the one header that would turn this from a guess into an answer.
            let challenge = response
                .headers()
                .get("www-authenticate")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("<none>")
                .to_string();
            let body = response.text().await.unwrap_or_default();
            println!(
                "        {status} challenge={challenge} body={}",
                body.chars().take(300).collect::<String>()
            );
        }
        Err(e) => println!("        network: {e}"),
    }
}

/// The first line of an error, for a one-line report.
fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}
