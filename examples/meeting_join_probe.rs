// Live probe: does a meeting join really work, in both of its shapes?
//
// A join is ONE POST to the conversation service, and the client's own builder makes two
// bodies from one function: the conversation request alone (the roster, which is what a
// pre-join screen shows) and the same body carrying a `callInvitation` with the offer.
// This runs both against a real meeting and prints what the service answers.
//
// It is the shapes that are asked about, not the audio. Three earlier refusals came from
// bodies nobody could see were wrong — an SDK envelope the transport strips, two
// credentials where the client sends one, and `addModality`, which grows a group modality
// on a 1:1 call and answers `subCode 5021` to a join.
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
use serde_json::json;
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

    // Two joins, in the two shapes the client's own builder makes, one after the other:
    // the roster alone (what a pre-join screen sends, and what the capture pins), then
    // the same body carrying the microphone. Both are ONE POST.
    let correlation = uuid::Uuid::new_v4().to_string();
    println!("\n---- roster only: join with no media");
    match calling::join_meeting(
        &http, &session, &ic3, &local, &meeting, &callbacks, &correlation, None,
    )
    .await
    {
        Ok(joined) => {
            println!("     ACCEPTED  state: {}", joined.state);
            println!("     links: {:?}", joined.links.names());
            leave(&http, &session, &ic3, &local, &joined, &correlation).await;
        }
        Err(e) => println!("     refused: {e:#}"),
    }

    println!("\n---- with audio: the same body, carrying the offer");
    let correlation = uuid::Uuid::new_v4().to_string();
    let joined = match calling::join_meeting(
        &http,
        &session,
        &ic3,
        &local,
        &meeting,
        &callbacks,
        &correlation,
        Some(&offer),
    )
    .await
    {
        Ok(joined) => {
            println!("     ACCEPTED");
            println!("     controller: {:?}", joined.controller);
            println!("     state: {}", joined.state);
            println!("     links: {:?}", joined.links.names());
            println!(
                "     media answer in the response: {}",
                calling::media_answer_from_frame(&joined.raw).is_some()
            );
            joined
        }
        Err(e) => {
            println!("     refused: {e:#}");
            return Ok(());
        }
    };

    // Leave again, whatever happened: a probe that stayed would be a silent participant.
    println!("\n---- leaving");
    leave(&http, &session, &ic3, &local, &joined, &correlation).await;

    println!("\n== done. Both shapes are ONE POST to the conversation service: the roster");
    println!("   alone, or the same body carrying the offer. `addModality` is neither.");
    Ok(())
}

/// Leave the meeting on whichever link its answer named. Called after every accepted
/// join, because a probe that joined and stayed is a silent participant in a real
/// meeting.
async fn leave(
    http: &reqwest::Client,
    session: &teams_lite::teams::Session,
    ic3: &str,
    local: &calling::LocalParticipant,
    joined: &calling::JoinedConversation,
    correlation: &str,
) {
    let Some(url) = joined.links.get(&["leave", "hangup"]) else {
        println!("     no link to leave on; if this joined, leave it in Teams");
        return;
    };
    let body = json!({ "participants": { "from": {
        "id": local.id, "displayName": local.display_name,
        "endpointId": local.endpoint_id, "participantId": local.participant_id,
        "languageId": "en-us" } } });
    match calling::post_signal(http, url, session, ic3, correlation, &body).await {
        Ok(_) => println!("     left"),
        Err(e) => println!("     could not leave: {e:#} — leave it in Teams if it stuck"),
    }
}
