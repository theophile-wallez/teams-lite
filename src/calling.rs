// Native audio calling — the signaling plane, mimicking the Teams WEB client.
//
// NATIVE-CALLING.md is the protocol map this module implements; read it first. The
// short version:
//
//   * A call is a set of LINKS. We publish ours on our calling trouter socket
//     (`{surl}callAgent/{sessionId}/{causeId}{path}`) and the service publishes its
//     own in every frame it sends us. After setup neither side needs a fixed API:
//     each answer names the URLs for the next step.
//   * Placing a call is ONE POST to `calling_conversationServiceUrl`, read from the
//     authz directory this app already fetches (see `endpoints`).
//   * The media description is a stock WebRTC SDP wearing the label
//     `application/sdp-ngc-1.0`. This module never looks inside it: the browser
//     makes it and the browser consumes it (see `web/src/lib/call-media.ts`).
//
// This module is the network half only. It holds no state and starts nothing: the
// backend owns the live call (see `CallSession` in `src/bin/server.rs`), which is
// what keeps "who may place a call" one decision in one place.
//
// NOTHING here rings anybody on its own. Every function is called from an RPC the
// user's own click reached, and each of those is an `OUTWARD_METHODS` entry.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::teams::Session;

/// The content type the web client labels its SDP with. It is a LABEL on an
/// ordinary WebRTC offer/answer, not a dialect: the client's own stack produces the
/// blob with `RTCPeerConnection.createOffer` and reads it back with
/// `setRemoteDescription`. `…-0.5` is the older spelling the service still accepts.
pub const SDP_CONTENT_TYPE: &str = "application/sdp-ngc-1.0";

/// The one modality this app negotiates. Video is deliberately absent: it is one
/// more m-line and one more renderer, and audio has to be solid first.
pub const MODALITY_AUDIO: &str = "audio";

/// The trouter path segment every callback link is built under (`URL_BASE.CALLAGENT`
/// in the web client's own calling bundle).
const CALL_AGENT: &str = "callAgent";

/// Trailing paths of the callback links we publish. The service POSTs to these on
/// our trouter socket, so the set we publish IS the set of frames we can be sent.
/// Names match the web client's `CALLBACK_PATHS` one for one.
pub mod paths {
    pub const CALL_ACCEPTANCE: &str = "/call/acceptance/";
    pub const CALL_PROGRESS: &str = "/call/progress/";
    pub const CALL_END: &str = "/call/end/";
    pub const CALL_MEDIA_ANSWER: &str = "/call/mediaAnswer/";
    pub const CALL_MEDIA_ACKNOWLEDGEMENT: &str = "/call/mediaAcknowledgement/";
    pub const CALL_MEDIA_RENEGOTIATION: &str = "/call/mediaRenegotiation/";
    pub const CALL_REDIRECTION: &str = "/call/redirection/";
    pub const CALL_TRANSFER: &str = "/call/transfer/";
    pub const CALL_REPLACEMENT: &str = "/call/replacement/";
    pub const CONVERSATION_END: &str = "/conversation/conversationEnd/";
    pub const CONVERSATION_UPDATE: &str = "/conversation/conversationUpdate/";
    pub const CONVERSATION_ROSTER_UPDATE: &str = "/conversation/rosterUpdate/";
    pub const CONVERSATION_LOCAL_PARTICIPANT_UPDATE: &str =
        "/conversation/localParticipantUpdate/";
    pub const CONVERSATION_ADD_PARTICIPANT_SUCCESS: &str =
        "/conversation/addParticipantSuccess/";
    pub const CONVERSATION_ADD_PARTICIPANT_FAILURE: &str =
        "/conversation/addParticipantFailure/";
    pub const CONVERSATION_ADD_MODALITY_SUCCESS: &str = "/conversation/addModalitySuccess/";
    pub const CONVERSATION_ADD_MODALITY_FAILURE: &str = "/conversation/addModalityFailure/";
    pub const CONVERSATION_CONFIRM_UNMUTE: &str = "/conversation/confirmUnmute/";
    pub const CONVERSATION_RECEIVE_MESSAGE: &str = "/conversation/receiveMessage/";
}

/// The calling plane's endpoints, read from the authz directory (`regionGtms`) this
/// app already fetches for `chatService`.
///
/// Every key is the one the real web client reads
/// (`serviceUrls.calling_conversationServiceUrl` and friends), which is what makes
/// this a lookup rather than a guess — see NATIVE-CALLING.md § 3.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Where a call is created: one POST with the whole invitation.
    pub conversation_service: String,
    /// The trouter the calling endpoint registers on — a different regional host
    /// from the messaging one, and a connection of its own.
    pub trouter: String,
    /// The registrar the calling endpoint registers with (same one messaging uses).
    pub registrar: String,
    /// The media transport host, as `udp://host:port`. Its host is a STUN/TURN
    /// server: we use it for STUN, which needs no credentials.
    pub udp_transport: Option<String>,
}

/// Read the calling endpoints out of a live session's directory.
pub fn endpoints(session: &Session) -> Result<Endpoints> {
    let conversation_service = session
        .endpoint("calling_conversationServiceUrl")
        .context("no calling_conversationServiceUrl in regionGtms")?
        .to_string();
    let trouter = session
        .endpoint("calling_trouterUrl")
        .context("no calling_trouterUrl in regionGtms")?
        .to_string();
    // The registrar is the same host messaging registers with, and the directory
    // names it too; fall back to the messaging constant rather than failing, because
    // a call can be set up without ever re-reading this key.
    let registrar = session
        .endpoint("calling_registrarUrl")
        .unwrap_or(crate::trouter::REGISTRAR)
        .to_string();
    Ok(Endpoints {
        conversation_service,
        trouter,
        registrar,
        udp_transport: session.endpoint("calling_udpTransportUrl").map(String::from),
    })
}

/// Our own identity for one call. `id` is our mri; the two ids are generated per
/// call and per endpoint and mean nothing outside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalParticipant {
    pub id: String,
    pub display_name: String,
    /// The calling endpoint's registration id — stable while the endpoint is up.
    pub endpoint_id: String,
    /// This participant leg, fresh per call.
    pub participant_id: String,
}

impl LocalParticipant {
    /// The `sender` / `participants.from` object every payload repeats.
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "displayName": self.display_name,
            "endpointId": self.endpoint_id,
            "participantId": self.participant_id,
            "languageId": "en-US",
        })
    }
}

/// A media description as it travels: an SDP blob plus its label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaContent {
    pub blob: String,
    pub content_type: String,
}

impl MediaContent {
    /// Wrap an SDP the browser just produced.
    pub fn sdp(blob: impl Into<String>) -> Self {
        Self { blob: blob.into(), content_type: SDP_CONTENT_TYPE.to_string() }
    }

    fn json(&self) -> Value {
        json!({ "blob": self.blob, "contentType": self.content_type })
    }

    /// Read one out of a frame, accepting either spelling of the SDP label and
    /// refusing a content type we cannot hand a browser.
    fn parse(value: &Value) -> Option<Self> {
        let blob = value.get("blob").and_then(Value::as_str)?;
        if blob.trim().is_empty() {
            return None;
        }
        let content_type = value
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or(SDP_CONTENT_TYPE);
        if !content_type.starts_with("application/sdp") {
            return None;
        }
        Some(Self { blob: blob.to_string(), content_type: content_type.to_string() })
    }
}

/// Where our callback links live: our calling trouter's surl plus the signaling
/// session id we made for this call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackBase {
    /// The trouter surl of the CALLING connection, with a trailing slash.
    pub surl: String,
    /// One signaling session per call (a uuid), so links of two calls never collide.
    pub session_id: String,
    /// An 8-hex cause id, exactly as the web client's `ti()` makes one.
    pub cause_id: String,
}

impl CallbackBase {
    /// Build one callback link: `{surl}callAgent/{sessionId}/{causeId}{path}`.
    pub fn link(&self, path: &str) -> String {
        let surl = if self.surl.ends_with('/') {
            self.surl.clone()
        } else {
            format!("{}/", self.surl)
        };
        format!("{surl}{CALL_AGENT}/{}/{}{path}", self.session_id, self.cause_id)
    }
}

/// The links the SERVICE hands us, flattened into one map.
///
/// The frames nest `links` objects at several depths and under several names
/// (`callNotification.links`, `conversation.links`, `mediaNegotiation.links`), and
/// the exact nesting differs between an invite, an acceptance and a renegotiation.
/// Collecting every `links` object in the frame into one map is what makes the
/// caller independent of that shape — and the names inside are stable, because they
/// are the web client's own `LINKS` table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Links(BTreeMap<String, String>);

impl Links {
    /// Walk a frame and merge every `links` object found in it. A later (deeper)
    /// occurrence wins, because a per-call link is nested under the per-conversation
    /// one and is the more specific of the two.
    pub fn collect(frame: &Value) -> Self {
        let mut map = BTreeMap::new();
        collect_links(frame, &mut map);
        Self(map)
    }

    /// The first of `names` this frame carried. Several spellings are tried per
    /// action because the service names the same action differently depending on
    /// which frame carries it (`accept` on one, `acceptance` on another).
    pub fn get(&self, names: &[&str]) -> Option<&str> {
        names.iter().find_map(|n| self.0.get(*n).map(String::as_str))
    }

    /// Every link name this frame carried, for a journal line that has to explain
    /// why an action was not available.
    pub fn names(&self) -> Vec<&str> {
        self.0.keys().map(String::as_str).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Accept an incoming call (we take the call; media is negotiated separately).
    pub fn accept(&self) -> Option<&str> {
        self.get(&["accept", "acceptance"])
    }

    /// Refuse an incoming call.
    pub fn reject(&self) -> Option<&str> {
        self.get(&["reject", "rejection", "mediaRejection"])
    }

    /// Answer the media offer with our own SDP.
    pub fn media_answer(&self) -> Option<&str> {
        self.get(&["mediaAnswer"])
    }

    /// Acknowledge an answer we received (the caller's side of the handshake).
    pub fn media_acknowledgement(&self) -> Option<&str> {
        self.get(&["mediaAcknowledgement"])
    }

    /// End the call. `hangup` ends OUR leg; `leave` leaves the conversation.
    pub fn hangup(&self) -> Option<&str> {
        self.get(&["hangup", "end", "leave", "conversationEnd"])
    }

    /// Keep the service from tearing the call down while it is still up.
    pub fn keep_alive(&self) -> Option<&str> {
        self.get(&["keepAlive"])
    }

    pub fn mute(&self) -> Option<&str> {
        self.get(&["mute"])
    }

    pub fn unmute(&self) -> Option<&str> {
        self.get(&["unmute"])
    }

    /// Merge newer links over these. Every frame may refresh them, and a link the
    /// new frame does not mention stays valid.
    pub fn merge(&mut self, other: &Links) {
        for (k, v) in &other.0 {
            self.0.insert(k.clone(), v.clone());
        }
    }
}

/// Merge this level's own `links` FIRST, then recurse — so a deeper (more specific)
/// link overwrites the one above it whatever order the keys happen to be in.
fn collect_links(value: &Value, out: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            if let Some(links) = map.get("links").and_then(Value::as_object) {
                for (name, url) in links {
                    // A `links` object also carries flags; only a URL may enter the
                    // table, because every entry is later POSTed to.
                    if let Some(url) = url.as_str()
                        && url.starts_with("http")
                    {
                        out.insert(name.clone(), url.to_string());
                    }
                }
            }
            map.values().for_each(|child| collect_links(child, out));
        }
        Value::Array(items) => items.iter().for_each(|i| collect_links(i, out)),
        _ => {}
    }
}

/// A call somebody is offering us, read out of a decoded trouter frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingCall {
    /// The service's own id for this call, used to tell one call's frames apart.
    pub call_id: String,
    pub caller_mri: String,
    pub caller_name: String,
    /// The chat or channel the call belongs to, when the invite names one.
    pub thread_id: Option<String>,
    /// The modalities the caller offered; audio-only when it holds just `"audio"`.
    pub modalities: Vec<String>,
    /// The caller's SDP offer, when the invite carried one. A call with no offer is
    /// answered by asking for one (`attach`), which this app does not do yet.
    pub offer: Option<MediaContent>,
    pub links: Links,
    /// The participant leg the service assigned us, echoed back in our answers.
    pub participant_id: Option<String>,
}

impl IncomingCall {
    /// True when the caller offered audio and nothing else. Video is not refused —
    /// it is simply not answered with a camera (see `MODALITY_AUDIO`).
    pub fn has_audio(&self) -> bool {
        self.modalities.iter().any(|m| m.eq_ignore_ascii_case(MODALITY_AUDIO))
    }
}

/// Read an incoming-call invite out of a decoded calling frame, or `None` when the
/// frame is any of the other things the calling socket carries (progress, roster,
/// hangup, telemetry).
///
/// The frame is what `trouter_events::CallFrame` produced: the outer envelope, with
/// the nested `cp`/`gp` payload expanded under `_decoded`. The notification is
/// looked for in both places, because whether it arrives wrapped depends on its
/// size rather than on its kind.
pub fn incoming_call_from_frame(frame: &Value) -> Option<IncomingCall> {
    let notification = ["/_decoded/callNotification", "/callNotification"]
        .iter()
        .find_map(|p| frame.pointer(p))?;

    let caller_mri = notification
        .pointer("/from/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // A caller we cannot name is still a caller: the backend resolves the name from
    // its own store afterwards, exactly as it does for a message.
    let caller_name = notification
        .pointer("/from/displayName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if caller_mri.is_empty() {
        return None;
    }

    let call_id = ["/callId", "/debugContent/callId", "/conversationId"]
        .iter()
        .find_map(|p| notification.pointer(p).and_then(Value::as_str))
        .or_else(|| frame.get("callId").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    let thread_id = ["/groupChat/threadId", "/threadId", "/conversationId"]
        .iter()
        .find_map(|p| notification.pointer(p).and_then(Value::as_str))
        .filter(|t| t.starts_with("19:"))
        .map(String::from);

    let modalities = notification
        .get("callModalities")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect()
        })
        .unwrap_or_else(|| vec![MODALITY_AUDIO.to_string()]);

    Some(IncomingCall {
        call_id,
        caller_mri,
        caller_name,
        thread_id,
        modalities,
        offer: notification.get("mediaContent").and_then(MediaContent::parse),
        links: Links::collect(notification),
        participant_id: notification
            .pointer("/to/participantId")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

/// Why a call we were in is over, read out of a `callEnd` / `conversationEnd` frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEnded {
    pub call_id: String,
    /// The service's own code, kept verbatim for the journal.
    pub code: i64,
    /// The service's own phrase (e.g. `"CallEndReasonHangup"`), or empty.
    pub phrase: String,
}

/// Read a call-ending frame, or `None` when the frame is something else.
///
/// Both endings are one case on purpose: whichever of the two arrives, the call is
/// over and the browser must stop holding the microphone.
pub fn call_ended_from_frame(frame: &Value) -> Option<CallEnded> {
    let end = ["/_decoded/callEnd", "/callEnd", "/_decoded/conversationEnd", "/conversationEnd"]
        .iter()
        .find_map(|p| frame.pointer(p))?;
    let code = ["/code", "/transactionEnd/code"]
        .iter()
        .find_map(|p| end.pointer(p).and_then(Value::as_i64))
        .unwrap_or(0);
    let phrase = ["/phrase", "/transactionEnd/phrase"]
        .iter()
        .find_map(|p| end.pointer(p).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let call_id = ["/callId", "/debugContent/callId"]
        .iter()
        .find_map(|p| end.pointer(p).and_then(Value::as_str))
        .or_else(|| frame.get("callId").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    Some(CallEnded { call_id, code, phrase })
}

/// Read the far side's SDP answer out of a `mediaAnswer` frame, or `None` when the
/// frame is something else. This is what turns a ringing outgoing call into audio.
pub fn media_answer_from_frame(frame: &Value) -> Option<MediaContent> {
    ["/_decoded/mediaAnswer", "/mediaAnswer", "/_decoded/mediaNegotiation", "/mediaNegotiation"]
        .iter()
        .find_map(|p| frame.pointer(p))
        .and_then(|answer| answer.get("mediaContent"))
        .and_then(MediaContent::parse)
}

/// True when the frame says the far side accepted (they picked up). Audio still
/// waits for the media answer; this is what stops the ringing tone.
pub fn call_accepted_in_frame(frame: &Value) -> bool {
    ["/_decoded/callAcceptance", "/callAcceptance", "/_decoded/callConnected"]
        .iter()
        .any(|p| frame.pointer(p).is_some())
}

/// Build the ONE POST that places a call (NATIVE-CALLING.md § 2.3).
///
/// `to` is one mri per person to ring; `thread_id` is the chat the call belongs to,
/// so the call shows up in that thread for everybody in it. Audio only.
pub fn invitation_payload(
    local: &LocalParticipant,
    to: &[String],
    thread_id: Option<&str>,
    offer: &MediaContent,
    callbacks: &CallbackBase,
) -> Value {
    let recipients: Vec<Value> = to.iter().map(|id| json!({ "id": id })).collect();
    json!({
        "payload": {
            "conversationRequest": {
                // "Delta" is what the web client sends: send me roster changes, not
                // the whole roster every time.
                "roster": {
                    "type": "Delta",
                    "rosterUpdate": callbacks.link(paths::CONVERSATION_ROSTER_UPDATE),
                },
                "properties": {
                    "enableGroupCallEventMessages": true,
                },
                "links": {
                    "conversationEnd": callbacks.link(paths::CONVERSATION_END),
                    "conversationUpdate": callbacks.link(paths::CONVERSATION_UPDATE),
                    "localParticipantUpdate":
                        callbacks.link(paths::CONVERSATION_LOCAL_PARTICIPANT_UPDATE),
                    "addParticipantSuccess":
                        callbacks.link(paths::CONVERSATION_ADD_PARTICIPANT_SUCCESS),
                    "addParticipantFailure":
                        callbacks.link(paths::CONVERSATION_ADD_PARTICIPANT_FAILURE),
                    "addModalitySuccess":
                        callbacks.link(paths::CONVERSATION_ADD_MODALITY_SUCCESS),
                    "addModalityFailure":
                        callbacks.link(paths::CONVERSATION_ADD_MODALITY_FAILURE),
                    "confirmUnmute": callbacks.link(paths::CONVERSATION_CONFIRM_UNMUTE),
                    "receiveMessage": callbacks.link(paths::CONVERSATION_RECEIVE_MESSAGE),
                },
            },
            "participants": { "from": local.json(), "to": recipients },
            // The thread the call belongs to. Without it the call exists but belongs
            // to no conversation, and nobody in the thread sees that it happened.
            "groupChat": thread_id.map(|t| json!({ "threadId": t, "messageId": null })),
            "callInvitation": {
                "callModalities": [MODALITY_AUDIO],
                "links": {
                    "progress": callbacks.link(paths::CALL_PROGRESS),
                    "mediaAnswer": callbacks.link(paths::CALL_MEDIA_ANSWER),
                    "acceptance": callbacks.link(paths::CALL_ACCEPTANCE),
                    "redirection": callbacks.link(paths::CALL_REDIRECTION),
                    "end": callbacks.link(paths::CALL_END),
                },
                "mediaContent": offer.json(),
            },
        }
    })
}

/// Build the body that accepts an incoming call: we take it, and we publish the
/// links the service may use for the rest of the call.
pub fn acceptance_payload(
    local: &LocalParticipant,
    answer: &MediaContent,
    callbacks: &CallbackBase,
) -> Value {
    json!({
        "payload": {
            "callAcceptance": {
                "sender": local.json(),
                "acceptedCallModalities": [MODALITY_AUDIO],
                "links": {
                    "mediaRenegotiation": callbacks.link(paths::CALL_MEDIA_RENEGOTIATION),
                    "transfer": callbacks.link(paths::CALL_TRANSFER),
                    "replacement": callbacks.link(paths::CALL_REPLACEMENT),
                    "end": callbacks.link(paths::CALL_END),
                },
                "mediaContent": answer.json(),
            }
        }
    })
}

/// Build the body that answers a media offer on its own (a renegotiation, or an
/// acceptance the service asked us to split in two).
pub fn media_answer_payload(
    local: &LocalParticipant,
    answer: &MediaContent,
    callbacks: &CallbackBase,
) -> Value {
    json!({
        "payload": {
            "mediaAnswer": {
                "sender": local.json(),
                "callModalities": [MODALITY_AUDIO],
                "links": {
                    "mediaAcknowledgement": callbacks.link(paths::CALL_MEDIA_ACKNOWLEDGEMENT),
                },
                "mediaContent": answer.json(),
            }
        }
    })
}

/// Build the body that ends our leg of a call.
pub fn hangup_payload(local: &LocalParticipant) -> Value {
    json!({
        "payload": {
            "callEnd": {
                "sender": local.json(),
                // 0 is "the user hung up" — the ordinary ending, and the only one
                // this app ever reports about itself.
                "code": 0,
                "phrase": "CallEndReasonHangup",
            }
        }
    })
}

/// Build the body that refuses an incoming call.
pub fn rejection_payload(local: &LocalParticipant) -> Value {
    json!({
        "payload": {
            "callRejection": {
                "sender": local.json(),
                "code": 603,
                "phrase": "Decline",
            }
        }
    })
}

/// Build the body that mutes or unmutes our own microphone SERVER-side.
///
/// The browser stops sending audio on its own (the track is disabled), and this is
/// the other half: it tells everybody else in the call that we are muted, which is
/// what draws the crossed-out microphone next to our name in their client.
pub fn mute_payload(local: &LocalParticipant, muted: bool) -> Value {
    json!({
        "payload": {
            "muteUnmute": {
                "sender": local.json(),
                "muted": muted,
                "scope": "Myself",
            }
        }
    })
}

/// A call the service accepted: the links it answered with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedCall {
    pub links: Links,
    /// The conversation the service created for this call, when it named one.
    pub conversation_url: Option<String>,
    /// The whole response, for the journal while the schema is still young.
    pub raw: Value,
}

/// POST one signaling frame and return the parsed response (or `Value::Null` for an
/// empty 200, which is the normal answer to an acknowledgement).
///
/// Both tokens travel because the service decides which one it wants per endpoint
/// and answers `www-authenticate` when it disagrees; sending the pair is what the
/// web client does when it holds both, and it is one round trip instead of two.
pub async fn post_signal(
    http: &reqwest::Client,
    url: &str,
    session: &Session,
    ic3: &str,
    correlation_id: &str,
    payload: &Value,
) -> Result<Value> {
    let response = http
        .post(url)
        .header("content-type", "application/json")
        .header("X-Skypetoken", &session.skypetoken)
        .header("authorization", format!("Bearer {ic3}"))
        .header("X-Microsoft-Skype-Chain-ID", correlation_id)
        .header("X-MS-Migration", "True")
        .header("api-version", "2")
        .json(payload)
        .send()
        .await
        .context("calling: signaling POST failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // Keep the service's own words: its phrases name the real cause ("this user
        // has no calling licence", "conversation does not exist") and a generic
        // message here would hide them.
        return Err(anyhow!(
            "calling: {status} from {}: {}",
            redact_url(url),
            text.chars().take(400).collect::<String>()
        ));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// Place a call: one POST to the conversation service.
#[allow(clippy::too_many_arguments)]
pub async fn place_call(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    local: &LocalParticipant,
    to: &[String],
    thread_id: Option<&str>,
    offer: &MediaContent,
    callbacks: &CallbackBase,
    correlation_id: &str,
) -> Result<PlacedCall> {
    if to.is_empty() {
        anyhow::bail!("calling: a call needs somebody to ring");
    }
    let endpoints = endpoints(session)?;
    let payload = invitation_payload(local, to, thread_id, offer, callbacks);
    let raw =
        post_signal(http, &endpoints.conversation_service, session, ic3, correlation_id, &payload)
            .await?;
    Ok(PlacedCall {
        links: Links::collect(&raw),
        conversation_url: ["/conversationUrl/Location", "/conversation/url", "/Location"]
            .iter()
            .find_map(|p| raw.pointer(p).and_then(Value::as_str))
            .map(String::from),
        raw,
    })
}

/// An ICE server in the shape `RTCPeerConnection` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

impl IceServer {
    pub fn json(&self) -> Value {
        let mut object = serde_json::Map::new();
        object.insert("urls".into(), json!(self.urls));
        if let Some(u) = &self.username {
            object.insert("username".into(), json!(u));
        }
        if let Some(c) = &self.credential {
            object.insert("credential".into(), json!(c));
        }
        Value::Object(object)
    }
}

/// The STUN server named by `calling_udpTransportUrl` (`udp://host:port`).
///
/// STUN needs no credentials, and it is what lets the browser learn its own public
/// address — enough for a call whose far side publishes reachable candidates of its
/// own, which is the ordinary Teams case (the media path terminates on a Microsoft
/// media server). A RELAYED path additionally needs the TURN credentials in
/// [`ice_servers_from_relay_config`].
pub fn stun_from_udp_transport(udp_transport: &str) -> Option<IceServer> {
    let rest = udp_transport.strip_prefix("udp://")?;
    let host_port = rest.trim_end_matches('/');
    if host_port.is_empty() || !host_port.contains(':') {
        return None;
    }
    Some(IceServer {
        urls: vec![format!("stun:{host_port}")],
        username: None,
        credential: None,
    })
}

/// Turn the service's own relay description into ICE servers, exactly as the web
/// client does: `turn:{host}:{port}?transport=udp`, the TCP form, and the TLS form
/// on the fqdn — each carrying the username and password from the relay token.
///
/// `relay` is the `Relay.Turn` object the service sent (`addresses`, `fqdns`,
/// `udpPort`, `tcpPort`, `tlsPort`); `credentials` is one entry of the token
/// response (`username`, `password`). Both come from the service, so a change in
/// either is a change we follow rather than one we have to predict.
pub fn ice_servers_from_relay_config(relay: &Value, credentials: &Value) -> Vec<IceServer> {
    let address = relay
        .get("addresses")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str);
    let fqdn = relay
        .get("fqdns")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str);
    let host = fqdn.or(address);
    let Some(host) = host else { return Vec::new() };

    let username = credentials.get("username").and_then(Value::as_str).map(String::from);
    let credential = credentials
        .get("password")
        .or_else(|| credentials.get("credential"))
        .and_then(Value::as_str)
        .map(String::from);

    let port = |name: &str| relay.get(name).and_then(Value::as_u64);
    let mut urls = Vec::new();
    if let Some(p) = port("udpPort") {
        urls.push(format!("turn:{host}:{p}?transport=udp"));
    }
    if let Some(p) = port("tcpPort") {
        urls.push(format!("turn:{host}:{p}?transport=tcp"));
    }
    // TLS is addressed by name only: a certificate is issued to the fqdn, never to
    // the bare address.
    if let (Some(p), Some(fqdn)) = (port("tlsPort"), fqdn) {
        urls.push(format!("turns:{fqdn}:{p}"));
    }
    if urls.is_empty() {
        return Vec::new();
    }
    vec![IceServer { urls, username, credential }]
}

/// Fetch the relay (TURN) credentials from the URL the service itself named
/// (`relayConfig.Service.tokenUrl`).
///
/// One GET with the skypetoken, exactly as the web client's legacy token path does.
/// The answer is `{tokens:[{realm, username, password}], expires}` — the credentials
/// stay in the backend, and only the built ICE servers ever reach the browser.
pub async fn fetch_relay_credentials(
    http: &reqwest::Client,
    token_url: &str,
    session: &Session,
) -> Result<Value> {
    let response = http
        .get(token_url)
        .header("X-Skypetoken", &session.skypetoken)
        .header("api-version", "2")
        .send()
        .await
        .context("calling: relay token request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("calling: relay token -> {status}"));
    }
    serde_json::from_str(&text).context("calling: relay token is not JSON")
}

/// Read the relay configuration a frame carried (`relayConfig`, wherever the
/// service nested it), so a call can build its ICE servers from the service's own
/// description rather than from anything hard-coded here.
pub fn relay_config_in_frame(frame: &Value) -> Option<Value> {
    fn walk(value: &Value) -> Option<Value> {
        match value {
            Value::Object(map) => {
                if let Some(config) = map.get("relayConfig") {
                    return Some(config.clone());
                }
                map.values().find_map(walk)
            }
            Value::Array(items) => items.iter().find_map(walk),
            _ => None,
        }
    }
    walk(frame)
}

/// Build every ICE server a call should offer the browser: the directory's STUN
/// server, plus the service's TURN relay when we hold its credentials.
pub fn ice_servers(
    endpoints: &Endpoints,
    relay: Option<&Value>,
    credentials: Option<&Value>,
) -> Vec<IceServer> {
    let mut servers = Vec::new();
    if let Some(udp) = &endpoints.udp_transport
        && let Some(stun) = stun_from_udp_transport(udp)
    {
        servers.push(stun);
    }
    if let (Some(relay), Some(credentials)) = (relay, credentials) {
        servers.extend(ice_servers_from_relay_config(relay, credentials));
    }
    servers
}

/// The first credential entry of a relay-token response, whatever realm it names.
/// A response carries one entry per realm and a browser can only be given one pair.
pub fn first_relay_credential(token_response: &Value) -> Option<Value> {
    if let Some(first) =
        token_response.get("tokens").and_then(Value::as_array).and_then(|t| t.first())
    {
        return Some(first.clone());
    }
    // A single-realm response is the object itself.
    token_response
        .get("username")
        .is_some()
        .then(|| token_response.clone())
}

/// A URL with its query string dropped, for an error message. A signaling link
/// carries routing ids in its path and sometimes a token in its query, and an error
/// string ends up in a journal that is read for weeks.
fn redact_url(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local() -> LocalParticipant {
        LocalParticipant {
            id: "8:orgid:me".into(),
            display_name: "Me".into(),
            endpoint_id: "endpoint-1".into(),
            participant_id: "participant-1".into(),
        }
    }

    fn callbacks() -> CallbackBase {
        CallbackBase {
            surl: "https://trouter.example/v4/f/abc/".into(),
            session_id: "session-1".into(),
            cause_id: "0a1b2c3d".into(),
        }
    }

    #[test]
    fn a_callback_link_is_built_the_way_the_web_client_builds_it() {
        let link = callbacks().link(paths::CALL_MEDIA_ANSWER);
        assert_eq!(
            link,
            "https://trouter.example/v4/f/abc/callAgent/session-1/0a1b2c3d/call/mediaAnswer/"
        );
    }

    /// The surl the trouter hands back has sometimes carried no trailing slash, and
    /// a link with a doubled or a missing slash is a link the service cannot reach.
    #[test]
    fn a_surl_without_a_trailing_slash_still_makes_one_link() {
        let base = CallbackBase {
            surl: "https://trouter.example/v4/f/abc".into(),
            session_id: "s".into(),
            cause_id: "c".into(),
        };
        assert_eq!(base.link("/call/end/"), "https://trouter.example/v4/f/abc/callAgent/s/c/call/end/");
    }

    #[test]
    fn links_are_collected_from_every_depth_and_the_deepest_wins() {
        let frame = json!({
            "conversation": {
                "links": { "conversationEnd": "https://x/conv/end", "hangup": "https://x/outer" },
                "call": { "links": { "hangup": "https://x/inner", "mediaAnswer": "https://x/ma" } }
            }
        });
        let links = Links::collect(&frame);
        assert_eq!(links.media_answer(), Some("https://x/ma"));
        // The nested (per-call) hangup wins over the per-conversation one.
        assert_eq!(links.hangup(), Some("https://x/inner"));
    }

    /// A link table is only useful if a non-URL value can never enter it: a
    /// `links` object also carries flags, and a `true` posted as a URL is a panic
    /// waiting for a live call.
    #[test]
    fn a_links_object_only_takes_urls() {
        let links = Links::collect(&json!({ "links": { "hangup": true, "accept": "https://x/a" } }));
        assert_eq!(links.hangup(), None);
        assert_eq!(links.accept(), Some("https://x/a"));
    }

    #[test]
    fn an_incoming_invite_is_read_out_of_a_wrapped_frame() {
        let frame = json!({
            "callId": "call-9",
            "_decoded": {
                "callNotification": {
                    "from": { "id": "8:orgid:her", "displayName": "Her" },
                    "to": { "participantId": "leg-7" },
                    "callModalities": ["audio"],
                    "groupChat": { "threadId": "19:thread@thread.v2" },
                    "mediaContent": { "blob": "v=0\r\n", "contentType": "application/sdp-ngc-1.0" },
                    "links": {
                        "accept": "https://x/accept",
                        "mediaAnswer": "https://x/media-answer",
                        "reject": "https://x/reject"
                    }
                }
            }
        });
        let call = incoming_call_from_frame(&frame).expect("an invite");
        assert_eq!(call.caller_mri, "8:orgid:her");
        assert_eq!(call.caller_name, "Her");
        assert_eq!(call.call_id, "call-9");
        assert_eq!(call.thread_id.as_deref(), Some("19:thread@thread.v2"));
        assert_eq!(call.participant_id.as_deref(), Some("leg-7"));
        assert!(call.has_audio());
        assert_eq!(call.offer.as_ref().map(|o| o.blob.as_str()), Some("v=0\r\n"));
        assert_eq!(call.links.accept(), Some("https://x/accept"));
        assert_eq!(call.links.media_answer(), Some("https://x/media-answer"));
    }

    /// The invite arrives un-wrapped when it is small enough, and it must read the
    /// same either way.
    #[test]
    fn an_unwrapped_invite_reads_the_same() {
        let frame = json!({
            "callNotification": {
                "from": { "id": "8:orgid:her" },
                "callModalities": ["audio", "video"],
            }
        });
        let call = incoming_call_from_frame(&frame).expect("an invite");
        assert_eq!(call.caller_mri, "8:orgid:her");
        assert!(call.has_audio());
        assert_eq!(call.offer, None);
    }

    /// Every other frame on the calling socket must read as "not an invite", or the
    /// app rings for a hangup.
    #[test]
    fn a_frame_that_is_not_an_invite_is_not_read_as_one() {
        for frame in [
            json!({ "_decoded": { "callEnd": { "code": 0 } } }),
            json!({ "_decoded": { "rosterUpdate": {} } }),
            json!({ "evt": "telemetry" }),
            // An invite with no caller names nobody, so it is not one.
            json!({ "callNotification": { "callModalities": ["audio"] } }),
        ] {
            assert_eq!(incoming_call_from_frame(&frame), None, "frame: {frame}");
        }
    }

    #[test]
    fn an_ending_is_read_from_either_name() {
        let end = call_ended_from_frame(&json!({
            "_decoded": { "callEnd": { "code": 410, "phrase": "Gone", "callId": "c1" } }
        }))
        .expect("an ending");
        assert_eq!(end.code, 410);
        assert_eq!(end.phrase, "Gone");
        assert_eq!(end.call_id, "c1");
        assert!(call_ended_from_frame(&json!({ "conversationEnd": {} })).is_some());
        assert!(call_ended_from_frame(&json!({ "callNotification": {} })).is_none());
    }

    #[test]
    fn an_answer_sdp_is_read_out_of_a_media_answer_frame() {
        let answer = media_answer_from_frame(&json!({
            "_decoded": { "mediaAnswer": {
                "mediaContent": { "blob": "v=0 answer", "contentType": "application/sdp-ngc-1.0" }
            } }
        }))
        .expect("an answer");
        assert_eq!(answer.blob, "v=0 answer");
        assert!(media_answer_from_frame(&json!({ "callEnd": {} })).is_none());
    }

    /// A content type we cannot hand a browser must be refused rather than passed
    /// on: `setRemoteDescription` on a non-SDP blob is an exception in the page.
    #[test]
    fn a_media_content_that_is_not_sdp_is_refused() {
        assert_eq!(
            MediaContent::parse(&json!({ "blob": "x", "contentType": "application/x-ngc" })),
            None
        );
        assert_eq!(MediaContent::parse(&json!({ "blob": "  " })), None);
        // The older label the service still uses is accepted.
        assert!(MediaContent::parse(
            &json!({ "blob": "v=0", "contentType": "application/sdp-ngc-0.5" })
        )
        .is_some());
    }

    #[test]
    fn an_invitation_names_the_person_the_thread_and_our_own_links() {
        let payload = invitation_payload(
            &local(),
            &["8:orgid:her".to_string()],
            Some("19:thread@thread.v2"),
            &MediaContent::sdp("v=0 offer"),
            &callbacks(),
        );
        let invitation = payload.pointer("/payload/callInvitation").expect("an invitation");
        assert_eq!(invitation["callModalities"], json!(["audio"]));
        assert_eq!(invitation["mediaContent"]["blob"], "v=0 offer");
        assert_eq!(invitation["mediaContent"]["contentType"], SDP_CONTENT_TYPE);
        assert!(invitation["links"]["mediaAnswer"]
            .as_str()
            .unwrap()
            .ends_with("/call/mediaAnswer/"));
        assert_eq!(payload.pointer("/payload/participants/to/0/id").unwrap(), "8:orgid:her");
        assert_eq!(payload.pointer("/payload/participants/from/id").unwrap(), "8:orgid:me");
        assert_eq!(
            payload.pointer("/payload/groupChat/threadId").unwrap(),
            "19:thread@thread.v2"
        );
    }

    /// Audio only, everywhere, in every direction. A video m-line would be
    /// negotiated for a camera this app never opens.
    #[test]
    fn every_payload_offers_audio_and_only_audio() {
        let offer = MediaContent::sdp("v=0");
        let invitation =
            invitation_payload(&local(), &["8:orgid:her".into()], None, &offer, &callbacks());
        let acceptance = acceptance_payload(&local(), &offer, &callbacks());
        let answer = media_answer_payload(&local(), &offer, &callbacks());
        assert_eq!(invitation.pointer("/payload/callInvitation/callModalities").unwrap(), &json!(["audio"]));
        assert_eq!(
            acceptance.pointer("/payload/callAcceptance/acceptedCallModalities").unwrap(),
            &json!(["audio"])
        );
        assert_eq!(answer.pointer("/payload/mediaAnswer/callModalities").unwrap(), &json!(["audio"]));
        let whole = format!("{invitation}{acceptance}{answer}");
        assert!(!whole.contains("video"), "no payload may ever offer video: {whole}");
    }

    #[test]
    fn a_hangup_and_a_rejection_name_who_sent_them() {
        assert_eq!(hangup_payload(&local()).pointer("/payload/callEnd/sender/id").unwrap(), "8:orgid:me");
        assert_eq!(
            rejection_payload(&local()).pointer("/payload/callRejection/sender/id").unwrap(),
            "8:orgid:me"
        );
        assert_eq!(mute_payload(&local(), true).pointer("/payload/muteUnmute/muted").unwrap(), true);
    }

    #[test]
    fn the_directory_udp_transport_becomes_one_stun_server() {
        let stun = stun_from_udp_transport("udp://api-emea.flightproxy.teams.microsoft.com:3478")
            .expect("a stun server");
        assert_eq!(stun.urls, vec!["stun:api-emea.flightproxy.teams.microsoft.com:3478"]);
        assert!(stun.username.is_none());
        assert_eq!(stun_from_udp_transport("https://x:3478"), None);
        assert_eq!(stun_from_udp_transport("udp://no-port"), None);
    }

    #[test]
    fn a_relay_config_becomes_the_ice_servers_a_browser_takes() {
        let relay = json!({
            "addresses": ["52.113.1.2"],
            "fqdns": ["relay.example.net"],
            "udpPort": 3478,
            "tcpPort": 443,
            "tlsPort": 443
        });
        let credentials = json!({ "username": "user", "password": "secret", "realm": "\"r\"" });
        let servers = ice_servers_from_relay_config(&relay, &credentials);
        assert_eq!(servers.len(), 1);
        let server = &servers[0];
        assert_eq!(
            server.urls,
            vec![
                "turn:relay.example.net:3478?transport=udp",
                "turn:relay.example.net:443?transport=tcp",
                "turns:relay.example.net:443",
            ]
        );
        assert_eq!(server.username.as_deref(), Some("user"));
        assert_eq!(server.credential.as_deref(), Some("secret"));
        // The browser shape carries exactly the three keys it knows.
        let rendered = server.json();
        assert!(rendered.get("urls").is_some());
        assert_eq!(rendered.get("credential").unwrap(), "secret");
    }

    #[test]
    fn a_relay_config_with_no_host_yields_nothing_rather_than_a_broken_url() {
        assert!(ice_servers_from_relay_config(&json!({ "udpPort": 3478 }), &json!({})).is_empty());
        assert!(ice_servers_from_relay_config(&json!({ "fqdns": ["r"] }), &json!({})).is_empty());
    }

    #[test]
    fn the_ice_server_list_holds_stun_without_credentials_and_turn_with_them() {
        let endpoints = Endpoints {
            conversation_service: "https://conv".into(),
            trouter: "https://trouter/v3/c".into(),
            registrar: "https://registrar".into(),
            udp_transport: Some("udp://media.example:3478".into()),
        };
        let stun_only = ice_servers(&endpoints, None, None);
        assert_eq!(stun_only.len(), 1);
        assert!(stun_only[0].urls[0].starts_with("stun:"));

        let both = ice_servers(
            &endpoints,
            Some(&json!({ "fqdns": ["relay.example"], "udpPort": 3478 })),
            Some(&json!({ "username": "u", "password": "p" })),
        );
        assert_eq!(both.len(), 2);
        assert!(both[1].urls[0].starts_with("turn:"));
    }

    #[test]
    fn a_relay_token_response_yields_its_first_credential_either_shape() {
        let listed = json!({ "expires": 1, "tokens": [{ "realm": "a", "username": "u1", "password": "p1" }] });
        assert_eq!(first_relay_credential(&listed).unwrap()["username"], "u1");
        let single = json!({ "realm": "a", "username": "u2", "password": "p2" });
        assert_eq!(first_relay_credential(&single).unwrap()["username"], "u2");
        assert_eq!(first_relay_credential(&json!({ "expires": 1 })), None);
    }

    #[test]
    fn a_relay_config_is_found_wherever_the_service_nested_it() {
        let frame = json!({ "a": { "b": { "relayConfig": { "Relay": { "Turn": {} } } } } });
        assert!(relay_config_in_frame(&frame).is_some());
        assert!(relay_config_in_frame(&json!({ "a": 1 })).is_none());
    }

    /// An error string is read out of a journal for weeks, and a signaling link can
    /// carry a token in its query.
    #[test]
    fn an_error_never_repeats_a_link_query() {
        assert_eq!(redact_url("https://x/call/end/?access_token=secret"), "https://x/call/end/");
        assert_eq!(redact_url("https://x/call/end/"), "https://x/call/end/");
    }
}
