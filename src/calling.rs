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

/// The capability masks a working client sent, and this app repeats.
///
/// Not computed: the conversation service refuses a request with `400` and an empty body
/// and never names the field it disliked, so a value nobody has seen accepted is a guess
/// with no feedback. These two came off a real request from this tenant (see
/// NATIVE-CALLING.md § 2.3a). Revisit them together with the join payload, never alone.
const CAPTURED_ENDPOINT_CAPABILITIES: u32 = 73463;
const CAPTURED_CLIENT_CAPABILITIES: u32 = 63928042;

/// The four modalities the service names (`I.MEDIA_TYPES` in the client's own bundle).
///
/// The capitals are the client's; its comparison lowercases both sides, which is why the
/// `"audio"` this app has always sent is accepted. Sending a screen and WATCHING one are two
/// modalities, not one, and that split is why they cost so differently (NATIVE-CALLING.md
/// § 10.5).
pub const MODALITY_AUDIO: &str = "audio";
/// A camera, sent or received.
pub const MODALITY_VIDEO: &str = "Video";
/// Sending a screen. Nothing in this app declares it yet.
pub const MODALITY_SCREEN_SHARER: &str = "ScreenSharer";
/// WATCHING somebody else's screen — the modality a viewer declares, which publishes
/// nothing about the user.
pub const MODALITY_SCREEN_VIEWER: &str = "ScreenViewer";

/// The media labels the service reads, one per section (`MEDIA_LABEL` in the bundle).
///
/// The label is how a shared screen is told from a camera: both are `m=video` sections, and
/// only this says which. Measured on the wire in both directions (NATIVE-CALLING.md § 10.2).
pub mod labels {
    pub const AUDIO: &str = "main-audio";
    pub const VIDEO: &str = "main-video";
    pub const SHARING: &str = "applicationsharing-video";
    pub const DATA: &str = "data";
}

/// The trouter path segment every callback link is built under (`URL_BASE.CALLAGENT`
/// in the web client's own calling bundle).
const CALL_AGENT: &str = "callAgent";

/// Who this client says it is, in the format the CALLING service takes.
///
/// Not the Skype-era `os=…; clientName=…` shape the messaging services want: the captured
/// calling request sends `SkypeSpaces/{build}/{platform}/TsCallingVersion=…`, and this
/// mirrors it. `TsCallingVersion` is the version of the calling stack the real client
/// runs, which is what the service reads to decide what a client understands.
const CLIENT_IDENTITY: &str = "SkypeSpaces/1415/26061118216/os=linux; osVer=undefined; \
     deviceType=computer; browser=chrome; browserVer=150.0.0.0/TsCallingVersion=2026.24.01.6";

/// The partition a region's users live in, as the captured request states it (`fr` →
/// `fr01`).
///
/// Derived from ONE observation, so it is a function rather than a constant: if the
/// service ever refuses it, this is the one line to correct, and the region it is built
/// from comes from the user's own authz answer.
fn teams_partition(region: &str) -> String {
    format!("{region}01")
}

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
    /// Where the service refuses media we offered. `/call/rejection/` in the client's own
    /// table — the same path a refused CALL arrives on, which is why it is spelled once.
    pub const CALL_MEDIA_REJECTION: &str = "/call/rejection/";
    pub const CALL_REDIRECTION: &str = "/call/redirection/";
    pub const CALL_TRANSFER: &str = "/call/transfer/";
    pub const CALL_REPLACEMENT: &str = "/call/replacement/";
    // The four the acknowledgement of an acceptance publishes beside the three above.
    // This app acts on none of them — it neither transfers a call nor sends video — but
    // the client sends all seven, and a link we do not publish is a frame the service
    // has nowhere to deliver.
    pub const CALL_BALANCE_UPDATE: &str = "/call/balanceUpdate/";
    pub const CALL_RETARGET_COMPLETION: &str = "/call/retargetCompletion/";
    pub const CALL_CONTROL_VIDEO_STREAMING: &str = "/call/controlVideoStreaming/";
    pub const CALL_UPDATE_MEDIA_DESCRIPTIONS: &str = "/call/updateMediaDescriptions/";
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
    /// A media offer the service makes on its own, when a modality is not already
    /// negotiated. Measured: it POSTs `mediaRenegotiation` unprompted, and its offer holds
    /// the section for a shared screen (NATIVE-CALLING.md § 10.3a) — so a link we do not
    /// publish is the shared screen we never see.
    pub const CALL_NEW_MEDIA_OFFER: &str = "/call/newMediaOffer/";
    /// Who is talking, and the contributing sources behind a mixed stream. Neither is acted
    /// on yet; both are published so the service has somewhere to put them.
    pub const CALL_DOMINANT_SPEAKER_INFO: &str = "/call/dominantSpeakerInfo/";
    pub const CALL_CSRC_INFO: &str = "/call/csrcInfo/";
    /// A content-sharing session starting and ending, which is how a meeting says whose
    /// screen it is looking at.
    pub const CONVERSATION_CONTENT_SHARING_UPDATE: &str = "/conversation/contentSharingUpdate/";
    pub const CONVERSATION_CONTENT_SHARING_END: &str = "/conversation/contentSharingEnd/";
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
            "languageId": "en-us",
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

/// A surl with its allocation id replaced by an ellipsis, for a journal line.
///
/// The links a join publishes live on this address, and a refusal that names nothing
/// makes the address the first thing to compare with a working client's. Only its
/// SHAPE is printed — the host and the path, never the id: that id is what routes a
/// frame to this connection, so it is a key and the journal is not the place for it.
pub fn surl_shape(surl: &str) -> String {
    let Some((prefix, rest)) = surl.split_once("/v4/") else {
        return surl.to_string();
    };
    // `/v4/f/{id}/` — the flavour letter says which allocate flow answered, and the
    // segment after it is the id.
    let mut parts = rest.splitn(2, '/');
    let flavour = parts.next().unwrap_or_default();
    match parts.next() {
        Some(_) => format!("{prefix}/v4/{flavour}/…/"),
        None => format!("{prefix}/v4/{flavour}"),
    }
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
    /// Where OUR own new media is offered — the link the service hands us on the
    /// acceptance, and the one an outgoing renegotiation is POSTed to.
    pub fn media_renegotiation(&self) -> Option<&str> {
        self.get(&["mediaRenegotiation"])
    }

    /// Where a MODALITY is added to a live conversation — a group modality on a 1:1, and the
    /// content-sharing session a screen share needs (see [`content_sharing_payload`]). It is
    /// not the second half of a JOIN, which is what reading it as one cost a debugging round.
    pub fn add_modality(&self) -> Option<&str> {
        self.get(&["addModality"])
    }

    pub fn keep_alive(&self) -> Option<&str> {
        self.get(&["keepAlive"])
    }

    pub fn mute(&self) -> Option<&str> {
        self.get(&["mute"])
    }

    /// Where a source request goes — the NEWER of the two spellings, which is what the
    /// client's own configuration uses on this tenant.
    ///
    /// Neither of these is in a join answer: both arrive on the `callAcceptance` frame, so
    /// they exist only because `merge` keeps every link the service has ever named
    /// (NATIVE-CALLING.md § 10.2).
    pub fn apply_channel_parameters(&self) -> Option<&str> {
        self.get(&["applyChannelParameters"])
    }

    /// The older spelling of the same thing, kept because the service offers both and a
    /// tenant that stops offering the newer one must not lose video with it.
    pub fn control_video_streaming(&self) -> Option<&str> {
        self.get(&["controlVideoStreaming"])
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

/// The name this app gives an ending the service reported as "no callee endpoints were
/// found": the person has no client signed in, so nothing could ring and the call was over
/// before it began.
///
/// It follows the `CallEndReason…` spelling every other explained ending uses, because the
/// page maps a NAME to a sentence — the service's own phrase is prose, and a sentence keyed
/// on prose breaks the day it is reworded.
pub const END_REASON_UNREACHABLE: &str = "CallEndReasonNobodyReachable";

/// The service could not ring anybody it was asked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteFailed {
    /// The service's own sentence, kept verbatim for the journal.
    pub phrase: String,
    /// Whether it says the callee has no endpoint at all — nothing of theirs to ring, as
    /// opposed to a device that rang and refused.
    pub no_endpoints: bool,
}

/// Sub-codes the service uses for "there was nothing to ring". Measured on this tenant, on a
/// one-to-one call to somebody with no client signed in.
const NO_ENDPOINT_SUB_CODES: [i64; 2] = [10037, 5205];

/// Read an `addParticipantFailure` frame — the service saying the invitation reached nobody.
///
/// **It is the only frame that names the CAUSE.** Measured, in order, on a call to somebody
/// with no client signed in:
///
/// ```text
/// /conversation/addParticipantFailure/  code 480 subCode 10037 "No callee endpoints were found."
///                                      code 580 subCode 5205  "Audio-video modality controller …"
/// /call/end/                            code 0   subCode 5003  "Removing modality controller …"
/// /conversation/conversationEnd/        code 0   subCode 5013  "This conversation has ended as
///                                                              no one else has joined …"
/// ```
///
/// `call_ended_from_frame` reads the third of those, whose phrase names the SYMPTOM. So this
/// is read first and remembered, or the only thing the user is ever told about an unreachable
/// colleague is "The call ended." — which is what happened, and it read as this app dropping
/// the call two seconds in.
///
/// The frame is recognised by the callback path it was POSTed to, because its body carries no
/// wrapper naming it; the reason is then found wherever it sits, since the service nests one
/// per participant and one for the modality controller.
pub fn invite_failed(url: &str, body: &Value) -> Option<InviteFailed> {
    if !url.contains("addParticipantFailure") {
        return None;
    }
    let mut phrase = String::new();
    let mut no_endpoints = false;
    walk_failure(body, &mut phrase, &mut no_endpoints);
    Some(InviteFailed { phrase, no_endpoints })
}

/// The first `phrase` at any depth, and whether any sub-code (or any phrase) says there was
/// nothing to ring. Both halves are read, because a sub-code is a stable key and a phrase is
/// what a reader of the journal understands.
fn walk_failure(value: &Value, phrase: &mut String, no_endpoints: &mut bool) {
    match value {
        Value::Object(map) => {
            if let Some(text) = map.get("phrase").and_then(Value::as_str) {
                if phrase.is_empty() {
                    *phrase = text.to_string();
                }
                if text.to_lowercase().contains("no callee endpoints") {
                    *no_endpoints = true;
                }
            }
            if let Some(code) = map.get("subCode").and_then(Value::as_i64) {
                if NO_ENDPOINT_SUB_CODES.contains(&code) {
                    *no_endpoints = true;
                }
            }
            for child in map.values() {
                walk_failure(child, phrase, no_endpoints);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_failure(item, phrase, no_endpoints);
            }
        }
        _ => {}
    }
}

/// Read the far side's SDP answer out of a `mediaAnswer` frame, or `None` when the
/// frame is something else. This is what turns a ringing outgoing call into audio.
pub fn media_answer_from_frame(frame: &Value) -> Option<MediaContent> {
    [
        "/_decoded/mediaAnswer",
        "/mediaAnswer",
        "/_decoded/mediaNegotiation",
        "/mediaNegotiation",
        // A `callAcceptance` carries the answer TOO, and for a meeting join it is the
        // only frame that ever does — the service accepts and answers in one. Reading
        // only the two names above left the page holding an offer nothing ever answered,
        // so the call sat at "Joining…" until the service gave up on it.
        "/_decoded/callAcceptance",
        "/callAcceptance",
    ]
    .iter()
    .find_map(|p| frame.pointer(p))
    .and_then(|answer| answer.get("mediaContent"))
    .and_then(MediaContent::parse)
}

/// One line per media SECTION of an SDP: its kind, whether the far side accepted it, its mid
/// and the label that says what it carries.
///
/// **It exists because a screen share failed live and left nothing on this machine to read.**
/// The user shared their screen, the service answered by REJECTING the section, and the
/// journal said only that an offer had gone out — so which section was refused, and whether
/// the answer carried the audio at all, were unanswerable after the fact. The modalities were
/// logged and they are a claim about what we asked for; this is what came back.
///
/// It prints the SHAPE and never the content, which is the rule `web/scripts/join-live.ts`
/// already follows for the same job: no candidate, no fingerprint, no ICE credential and no
/// key ever reaches a log line here. A port is stated only as accepted or rejected, because
/// zero is the whole fact and the number is a relay's address.
pub fn media_sections(sdp: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut section: Option<(String, bool)> = None;
    let mut mid: Option<String> = None;
    let mut label: Option<String> = None;
    let mut flush = |section: &Option<(String, bool)>, mid: &Option<String>, label: &Option<String>, out: &mut Vec<String>| {
        let Some((kind, rejected)) = section else {
            return;
        };
        let mut line = kind.clone();
        if let Some(mid) = mid {
            line.push_str(&format!(" mid={mid}"));
        }
        if let Some(label) = label {
            line.push_str(&format!(" label={label}"));
        }
        line.push_str(if *rejected { " REJECTED" } else { " accepted" });
        out.push(line);
    };
    for line in sdp.lines().map(str::trim_end) {
        if let Some(rest) = line.strip_prefix("m=") {
            flush(&section, &mid, &label, &mut out);
            mid = None;
            label = None;
            let mut fields = rest.split(' ');
            let kind = fields.next().unwrap_or("?").to_string();
            // `m=<kind> <port> …` — a zero port is how either side says the section is gone.
            let rejected = fields.next() == Some("0");
            section = Some((kind, rejected));
        } else if let Some(rest) = line.strip_prefix("a=mid:") {
            mid = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("a=label:") {
            label = Some(rest.trim().to_string());
        }
    }
    flush(&section, &mid, &label, &mut out);
    out
}

/// The content-sharing SESSION a meeting grants, and the links it hands back.
///
/// **A meeting has ONE screen at a time, so sharing one is a session rather than a track.**
/// Measured on 2026-08-06: a meeting answered an `applicationsharing-video` section of ours
/// by rejecting it outright — no mid, no label, just a zeroed port — with the section
/// negotiated correctly, labelled correctly and offering the codecs a client offers. What
/// this app never did is ASK to be the presenter, which the client does first
/// (`startContentSharingAsync` → the session's `start`, POSTing a `contentSharing` blob to
/// the `addModality` link and setting `isPresenter` on the answer).
///
/// The links come back on that answer, and they are kept APART from the call's own
/// ([`Links::collect`] takes the deepest of a name, and this answer carries a `leave` of its
/// own — merged in, it would overwrite the link this app hangs a CALL up on).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContentSharing {
    /// The correlation id this app minted for the session, which every later call to it
    /// carries — in a header on the way out, and in the frames the service sends back.
    pub correlation_id: String,
    /// The service's own id for the session, once it names one.
    pub session_id: Option<String>,
    /// Where to give the session up. Without it a share could be started and never stopped,
    /// which is the shape this project refuses on principle.
    pub leave: Option<String>,
}

impl ContentSharing {
    /// Read the session out of the `addModalitySuccess` FRAME, which is where it really
    /// arrives.
    ///
    /// Measured 2026-08-06 with `bun run join-live -- --share`: the POST answers `{}` with no
    /// links at all, and the service then POSTs to our own `addModalitySuccess` callback
    /// carrying the session's six — `contentSharingController`, `leave`, `notificationLinks`,
    /// `sync`, `takeControl`, `updateSessionState`. The client's own `start` says the same
    /// thing in its shape: it returns a deferred that the frame resolves, so it WAITS for this
    /// before it offers anything.
    pub fn from_frame(correlation_id: &str, frame: &Value) -> Option<Self> {
        // Collected at every DEPTH rather than read off a pointer. The service names the
        // frame's own body after its type and wraps it differently on different paths — the
        // shape was guessed twice and missed twice — and the collector is the reader this crate
        // already trusts for exactly that reason. It is safe HERE because nothing is merged
        // into the call's links: one value is taken out, and the session keeps it.
        let leave = Links::collect(frame).get(&["leave"])?.to_string();
        Some(Self {
            correlation_id: correlation_id.to_string(),
            session_id: session_id_in(frame),
            leave: Some(leave),
        })
    }

    /// Read the session out of the answer to the `addModality` POST.
    ///
    /// Only two things are taken: the id the service named it, and the way out. The other
    /// four links it offers — `contentSharingController`, `takeControl`, `updateSessionState`,
    /// `sync` — belong to features this app does not have, and a link nothing posts to is a
    /// link that goes stale in a struct.
    pub fn from_answer(correlation_id: &str, answer: &Value) -> Self {
        let sharing = ["/_decoded/contentSharing", "/contentSharing"]
            .iter()
            .find_map(|p| answer.pointer(p));
        Self {
            correlation_id: correlation_id.to_string(),
            session_id: sharing
                .and_then(|s| s.get("sessionId"))
                .and_then(Value::as_str)
                .map(String::from),
            leave: sharing
                .and_then(|s| s.get("links"))
                .and_then(|l| l.get("leave").or_else(|| l.get("contentSharingLeave")))
                .and_then(Value::as_str)
                .map(String::from),
        }
    }
}

/// Find `contentSharingSessionId` at any depth, which is where the service really puts it:
/// on the grant's own frame, and on the roster's `contentSharing.sessionInformation`.
fn session_id_in(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(id) = map.get("contentSharingSessionId").and_then(Value::as_str) {
                return Some(id.to_string());
            }
            map.values().find_map(session_id_in)
        }
        Value::Array(items) => items.iter().find_map(session_id_in),
        _ => None,
    }
}

/// Ask a meeting to make this endpoint the presenter of a content-sharing session.
///
/// The client's own `j2`, field for field: the local participant, an empty `to`, the
/// `contentSharing` blob and the two callbacks the service reports the session's own changes
/// on. `subject` and `sessionState` are NULL because the client's builder passes
/// `i || null` / `t || null` and this app has neither to state — a screen has no subject and
/// the state is the service's to decide. `sequenceNumber` is 1, which is the literal the
/// client sends on a start.
///
/// It carries no `payload` envelope, for the reason § Joining a meeting gives: every builder
/// in the client's bundle returns one and its transport strips it, so a wrapped body is
/// refused `400` with `{}` and names nothing.
pub fn content_sharing_payload(
    local: &LocalParticipant,
    callbacks: &CallbackBase,
    identifier: &str,
) -> Value {
    json!({
        "participants": { "from": local.json(), "to": [] },
        "contentSharing": {
            "identifier": identifier,
            "subject": Value::Null,
            "sessionState": Value::Null,
            "sequenceNumber": 1,
            "links": {
                "sessionUpdate": callbacks.link(paths::CONVERSATION_CONTENT_SHARING_UPDATE),
                "sessionEnd": callbacks.link(paths::CONVERSATION_CONTENT_SHARING_END),
            },
        },
        "links": {
            "addModalitySuccess": callbacks.link(paths::CONVERSATION_ADD_MODALITY_SUCCESS),
            "addModalityFailure": callbacks.link(paths::CONVERSATION_ADD_MODALITY_FAILURE),
        },
    })
}

/// Give the session up: the body the client's own `K2` sends, which names the same two
/// callbacks and nothing else.
pub fn content_sharing_leave_payload(local: &LocalParticipant, callbacks: &CallbackBase) -> Value {
    json!({
        "participants": { "from": local.json() },
        "contentSharing": {
            "links": {
                "sessionUpdate": callbacks.link(paths::CONVERSATION_CONTENT_SHARING_UPDATE),
                "sessionEnd": callbacks.link(paths::CONVERSATION_CONTENT_SHARING_END),
            },
        },
    })
}

/// A media OFFER the service made mid-call, and where to answer it.
///
/// **This is how a shared screen arrives, and it arrives unprompted.** Measured: ~9 s into
/// every join the service POSTs a `mediaRenegotiation` whose offer carries the sections it
/// is willing to send — and one second after somebody shares their screen, that offer grows
/// `label:applicationsharing-video` at mid 3, `sendonly`, with its SSRC range declared
/// (NATIVE-CALLING.md § 10.3a). So there is nothing to ask for: the section is offered, and
/// the only question is whether this app answers.
///
/// It was previously read as an ANSWER (`media_answer_from_frame` matches `mediaNegotiation`
/// too), which meant the page was handed an offer where it expected an answer, checked its
/// signaling state, and dropped it — every time, silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRenegotiation {
    pub offer: MediaContent,
    /// The link to POST the answer to. **The frame's OWN link**, never the merged set: the
    /// service names where this negotiation is answered, and an older call's link would
    /// answer nothing.
    pub answer_link: String,
    /// Where to refuse it instead, when it offers something this app cannot carry.
    pub reject_link: Option<String>,
    /// What the offer says it is for, when it says.
    pub modalities: Vec<String>,
}

/// Read a renegotiation offer out of a frame, or `None` when the frame is not one.
///
/// The test is the ANSWER LINK, not the body's name: a frame that offers media and tells us
/// where to answer is a renegotiation, and one that does not is the answer to something we
/// offered. That keeps the two apart without either reader guessing from a url.
pub fn media_renegotiation_from_frame(frame: &Value) -> Option<MediaRenegotiation> {
    let negotiation = [
        "/_decoded/mediaNegotiation",
        "/mediaNegotiation",
        "/_decoded/newMediaOffer",
        "/newMediaOffer",
    ]
    .iter()
    .find_map(|p| frame.pointer(p))?;
    let links = negotiation.get("links");
    let answer_link = links
        .and_then(|l| l.get("mediaAnswer"))
        .and_then(Value::as_str)
        // Some frames put the links beside the negotiation rather than inside it.
        .or_else(|| frame.pointer("/links/mediaAnswer").and_then(Value::as_str))?;
    let offer = negotiation.get("mediaContent").and_then(MediaContent::parse)?;
    Some(MediaRenegotiation {
        offer,
        answer_link: answer_link.to_string(),
        reject_link: links
            .and_then(|l| l.get("rejection").or_else(|| l.get("mediaRejection")))
            .and_then(Value::as_str)
            .map(String::from),
        modalities: negotiation
            .get("callModalities")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    })
}

/// What a source request asks for when the caller names nothing better.
///
/// An H.264 fmtp, and the shape is the client's own capability probe — `max-fps` is in
/// hundredths of a frame per second (RFC 6184), so `3000` is 30. `profile-level-id=42C02A`
/// is constrained baseline at level 4.2, which is what Teams negotiates and what every
/// browser decodes. A page drawing several tiles should ask for less than this per tile; a
/// page drawing one shared screen wants all of it, because a screen is text.
pub const DEFAULT_VIDEO_FMTP: &str = "max-fs=8160;max-mbps=245000;max-fps=3000;\
     profile-level-id=42C02A;packetization-mode=1";

/// One stream to subscribe to: put `source_id` on the section named `mid`.
///
/// `stream_msid` and `mid` are the PAGE's own — the receive stream's id as the browser
/// reported it on the `track` event, and the section it arrived on. Neither exists before the
/// answer is applied, which is why a subscription is strictly after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRequest {
    pub mid: String,
    pub source_id: i64,
    pub stream_msid: String,
    /// An H.264 fmtp, which is how a client asks for a small tile rather than a full stream.
    /// The client's own builder throws without it, so it is not optional here either.
    pub fmt_params: String,
}

/// Build the body that subscribes one of our receive sections to somebody's stream.
///
/// Two spellings, because the client sends whichever its config names and both links arrive
/// on the `callAcceptance` frame (NATIVE-CALLING.md § 10.2). `applyChannelParameters` is the
/// newer one — it addresses the section by mid, and its media parameter is a JSON STRING
/// inside the JSON, which is the service's own shape and not an accident of this port.
pub fn source_request_payload(request: &SourceRequest, sequence: u64, modern: bool) -> Value {
    let control = json!({
        "sourceId": request.source_id,
        "streamMsid": request.stream_msid,
        "fmtParams": request.fmt_params,
    });
    if modern {
        let parameter = json!({
            "controlVideoStreaming": { "sequenceNumber": sequence, "controlInfo": control }
        });
        return json!({
            "applyChannelParameters": {
                "multiChannelParameter": {
                    "mids": [request.mid],
                    // A string, deliberately: `JSON.stringify` in the client's own message
                    // generator, and the service reads it back the same way.
                    "mediaParameter": parameter.to_string(),
                }
            }
        });
    }
    // The older shape, whose `controlInfo` is an ARRAY and which names the control itself.
    json!({
        "controlVideoStreaming": {
            "sequenceNumber": sequence,
            "controlInfo": [{
                "control": "start",
                "sourceId": request.source_id,
                "streamMsid": request.stream_msid,
                "fmtParams": request.fmt_params,
            }]
        }
    })
}

/// The url a `callAcceptance` must be acknowledged on, if it named one.
///
/// It is the acceptance's OWN link and never the merged set: the service waits for this
/// one POST and ends the call without it —
/// `Call Controller timed out while waiting for acknowledgement` after 30 seconds,
/// which is what a joined meeting that never carried audio looked like.
pub fn acceptance_acknowledgement_link(frame: &Value) -> Option<&str> {
    ["/_decoded/callAcceptance/links", "/callAcceptance/links"]
        .iter()
        .find_map(|p| frame.pointer(p))
        .and_then(|links| {
            ["acknowledgement", "acknowledgment"].iter().find_map(|name| links.get(name))
        })
        .and_then(Value::as_str)
}

/// The body of that acknowledgement: the links the rest of the call may use.
///
/// It carries no media and confirms nothing about the answer — it is the client's own
/// `callAcceptanceAcknowledgement`, which publishes where the service may renegotiate,
/// transfer or replace this call. Seven links, exactly the ones the real client sends.
pub fn acceptance_acknowledgement_payload(callbacks: &CallbackBase) -> Value {
    json!({
        "callAcceptanceAcknowledgement": {
            "links": {
                "mediaRenegotiation": callbacks.link(paths::CALL_MEDIA_RENEGOTIATION),
                "transfer": callbacks.link(paths::CALL_TRANSFER),
                "replacement": callbacks.link(paths::CALL_REPLACEMENT),
                "balanceUpdate": callbacks.link(paths::CALL_BALANCE_UPDATE),
                "retargetCompletion": callbacks.link(paths::CALL_RETARGET_COMPLETION),
                "controlVideoStreaming": callbacks.link(paths::CALL_CONTROL_VIDEO_STREAMING),
                "updateMediaDescriptions":
                    callbacks.link(paths::CALL_UPDATE_MEDIA_DESCRIPTIONS),
            }
        }
    })
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
///
/// **Several recipients is a GROUP call**, and it is the same POST: the service rings every
/// mri in `to`, the thread they share is the conversation the call belongs to, and
/// `properties.enableGroupCallEventMessages` — already here, because the capture carried it
/// — is what posts the call line into that thread for all of them. So the shape a group
/// chat's call button needs is the shape a 1:1 already sends; what a group adds is the
/// roster the answer starts reporting, which [`CallSession::others`] already reads.
pub fn invitation_payload(
    local: &LocalParticipant,
    to: &[String],
    thread_id: Option<&str>,
    offer: &MediaContent,
    callbacks: &CallbackBase,
) -> Value {
    let recipients: Vec<Value> = to.iter().map(|id| json!({ "id": id })).collect();
    json!({
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
        // Everything on the next few lines is here because the JOIN taught it, and a call
        // goes to the same endpoint: the conversation service refuses a request it does
        // not recognise with `400` and an empty body, naming no field, so the only values
        // this app has ever seen accepted are a working client's. A 1:1 has never been
        // rung (NATIVE-CALLING.md § 8) — sending it the shape that IS known to work is
        // the difference between one round of debugging and five.
        "subject": Value::Null,
        "groupContext": Value::Null,
        "capabilities": Value::Null,
        "endpointCapabilities": CAPTURED_ENDPOINT_CAPABILITIES,
        "clientEndpointCapabilities": CAPTURED_CLIENT_CAPABILITIES,
        "endpointMetadata": { "holographicCapabilities": 3 },
        "endpointState": {
            "endpointStateSequenceNumber": 0,
            "endpointProperties": {
                "additionalEndpointProperties": { "infoShownInReportMode": "FullInformation" }
            }
        },
        "debugContent": { "causeId": callbacks.cause_id },
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
    })
}

/// Build the body that answers a media offer on its own (a renegotiation, or an
/// acceptance the service asked us to split in two).
/// `modalities` is what the answer DECLARES, and it is the caller's because only the caller
/// knows what the answer really carries: audio alone for the original handshake, and audio
/// plus `ScreenViewer` for an answer that accepts a shared screen. A declaration wider than
/// the SDP is a claim about the user's camera that the SDP does not back.
pub fn media_answer_payload(
    local: &LocalParticipant,
    answer: &MediaContent,
    callbacks: &CallbackBase,
    modalities: &[&str],
) -> Value {
    json!({
        "mediaAnswer": {
            "sender": local.json(),
            "callModalities": modalities,
            "links": {
                "mediaAcknowledgement": callbacks.link(paths::CALL_MEDIA_ACKNOWLEDGEMENT),
            },
            "mediaContent": answer.json(),
        }
    })
}

/// Build the body that offers NEW media on a call that is already up.
///
/// This is the outgoing twin of [`media_renegotiation_from_frame`], and it is how a camera or
/// a shared screen goes out: the call was negotiated with audio alone, so adding either means
/// offering a section that does not exist yet. The client's own builder is the same shape, and
/// the service refuses one on a call that is not established —
/// `"media renegotiation can only be performed on an established call"`.
///
/// `modalities` is what the offer DECLARES, and it must match what the SDP carries:
/// `ScreenSharer` for a screen, `Video` for a camera. The service reads the words, so a
/// declaration wider than the blob is a claim about the user's machine that nothing backs.
pub fn media_offer_payload(
    local: &LocalParticipant,
    offer: &MediaContent,
    callbacks: &CallbackBase,
    modalities: &[&str],
) -> Value {
    json!({
        "mediaNegotiation": {
            "sender": local.json(),
            "callModalities": modalities,
            "links": {
                // Where the service answers this offer, and where it may refuse it. Both are
                // ours: an offer nobody can answer is an offer that hangs.
                "mediaAnswer": callbacks.link(paths::CALL_MEDIA_ANSWER),
                "mediaAcknowledgement": callbacks.link(paths::CALL_MEDIA_ACKNOWLEDGEMENT),
                "rejection": callbacks.link(paths::CALL_MEDIA_REJECTION),
            },
            "mediaContent": offer.json(),
        }
    })
}

/// Build the body that ends our leg of a call.
pub fn hangup_payload(local: &LocalParticipant) -> Value {
    json!({
        // WHO is leaving. The service refuses a body that names nobody with a `400`, and
        // then the user is out of the call HERE while Teams still has them in it — a
        // phantom participant everybody else can see. Measured: our own `callEnd` shape
        // was refused on every `leave` of a joined meeting.
        "participants": { "from": local.json() },
        // Why the CONVERSATION ended for us, and why the CALL leg did. The client sends
        // both, and both are the ordinary ending: nothing failed, the user left.
        "conversationTransactionEnd": {
            "reason": "noError",
            "code": 0,
            "phrase": "ConversationEndedNoModality",
        },
        "callTransactionEnd": {
            "code": 0,
            "phrase": "LocalUserInitiated",
        },
    })
}

/// Build the body that refuses an incoming call.
pub fn rejection_payload(local: &LocalParticipant) -> Value {
    json!({
        "callRejection": {
            "sender": local.json(),
            "code": 603,
            "phrase": "Decline",
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
        "muteUnmute": {
            "sender": local.json(),
            "muted": muted,
            "scope": "Myself",
        }
    })
}

/// Everything a meeting join needs, read out of the link the calendar already holds.
///
/// A Teams join link carries all of it (`onlineMeeting.joinUrl` from Graph):
///
/// ```text
/// https://teams.microsoft.com/l/meetup-join/{threadId}/{messageId}?context={"Tid":…,"Oid":…}
/// ```
///
/// The thread is the meeting's own conversation, the message id is `0` for a meeting
/// from the calendar and a real id for a channel meeting, and the context names the
/// tenant and the organizer — which is exactly the `meetingInfo` the calling service
/// asks for. So joining needs no new service: the link the user could click is the
/// whole address. `examples/meeting_join_recon.rs` checks this parse against the
/// user's own real meetings, READ-ONLY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingJoin {
    /// The meeting's thread (`19:meeting_…@thread.v2`, or a channel's own thread).
    /// Absent on a SHORT link, which names a meeting code instead of a thread.
    pub thread_id: Option<String>,
    /// The message the meeting hangs off. `"0"` for a calendar meeting.
    pub message_id: String,
    /// The tenant the meeting belongs to, from the link's context.
    pub tenant_id: Option<String>,
    /// The organizer's object id, as the link states it. The service's `meetingInfo`
    /// wants exactly that — a bare oid, NOT an mri (captured from the real client).
    pub organizer_mri: Option<String>,
    /// The meeting code, from a short link (`/meet/{code}`). Teams' newer meetings are
    /// addressed this way, and the service takes it as `meetingData.meetingCode`.
    pub meeting_code: Option<String>,
    /// The passcode that goes with that code (`?p=…`).
    pub passcode: Option<String>,
    /// The link itself, which the service wants back as `meetingData.meetingUrl`.
    pub join_url: String,
}

impl MeetingJoin {
    /// Read a join link, in either shape Teams writes one.
    ///
    /// `None` when it is neither — a link to something else, or a shape this does not
    /// know, which is a thing to add rather than to guess at.
    pub fn from_join_url(url: &str) -> Option<Self> {
        let (base, query) = match url.split_once('?') {
            Some((base, query)) => (base, Some(query)),
            None => (url, None),
        };
        // The SHORT shape, which Teams' newer meetings use: `…/meet/{code}?p={passcode}`.
        // It names no thread at all, so the service is given the code and the passcode
        // instead (`meetingData`) — and this is the shape the user's own meetings have.
        if let Some(after) = base.split("/meet/").nth(1) {
            let code = decode(after.split('/').next().unwrap_or_default());
            if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
                return None;
            }
            return Some(Self {
                thread_id: None,
                message_id: "0".into(),
                tenant_id: None,
                organizer_mri: None,
                meeting_code: Some(code),
                passcode: query
                    .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("p=")))
                    .map(decode)
                    .filter(|p| !p.is_empty()),
                join_url: url.to_string(),
            });
        }
        // The long shape: `…/l/meetup-join/{thread}/{message}?context={…}`.
        let after = base.split("/meetup-join/").nth(1)?;
        let mut segments = after.split('/').filter(|s| !s.is_empty());
        let thread_id = decode(segments.next()?);
        if !thread_id.starts_with("19:") {
            return None;
        }
        let message_id = segments.next().map(decode).unwrap_or_else(|| "0".into());

        // The context is a JSON object, URL-encoded, and its keys are capitalised the
        // way Teams writes them. A link without one still joins: the thread is what
        // addresses the meeting, and `meetingInfo` is what the service prefers.
        let context = query
            .and_then(|q| {
                q.split('&').find_map(|pair| pair.strip_prefix("context=").map(decode))
            })
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let field = |name: &str| {
            context
                .as_ref()
                .and_then(|c| c.get(name))
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        Some(Self {
            thread_id: Some(thread_id),
            message_id,
            tenant_id: field("Tid"),
            // The BARE object id, exactly as the link states it: the captured
            // `meetingInfo.organizerId` is an oid, not an mri.
            organizer_mri: field("Oid"),
            meeting_code: None,
            passcode: None,
            join_url: url.to_string(),
        })
    }

    /// The address of a meeting reached from the CHAT it already has here, rather than
    /// from a calendar link.
    ///
    /// Teams mints one thread per meeting and puts it in the chat list, so the meeting the
    /// user is looking at is addressable without finding a link at all: the thread IS what
    /// a long join link carries in its own first segment, and the `meetingInfo` beside it is
    /// what the service PREFERS rather than what it requires (a long link with no context
    /// joins by its thread — see `a_meeting_link_with_no_context_still_joins_by_its_thread`).
    /// That matters on this tenant, whose own invitations carry the SHORT link shape: the
    /// code lives in the calendar event and nowhere in the conversation, so a chat with no
    /// matching event could otherwise offer nothing.
    ///
    /// `None` for anything but a meeting thread. A plain group chat has no meeting to join —
    /// it is CALLED instead — and a channel meeting hangs off a message id a thread alone
    /// cannot name, so guessing `"0"` there would address the channel and not the meeting
    /// inside it.
    pub fn from_thread_id(thread_id: &str) -> Option<Self> {
        if !thread_id.starts_with("19:meeting_") {
            return None;
        }
        Some(Self {
            thread_id: Some(thread_id.to_string()),
            // The same string the captured request sends for a meeting that hangs off no
            // message, and a calendar meeting's own long link carries.
            message_id: "0".into(),
            tenant_id: None,
            organizer_mri: None,
            meeting_code: None,
            passcode: None,
            // No link was involved, and nothing may invent one: `meetingData.meetingUrl` is
            // only ever the url the user's own invitation carried.
            join_url: String::new(),
        })
    }

    /// True for a meeting that lives in a CHANNEL rather than on the calendar alone.
    /// Its thread is the channel's, and the message id is the post the meeting hangs
    /// off — so both have to travel, or the join addresses the channel instead of the
    /// meeting inside it.
    pub fn is_channel_meeting(&self) -> bool {
        self.thread_id.as_ref().is_some_and(|thread| !thread.starts_with("19:meeting_"))
            && self.message_id != "0"
    }

    /// What the service is told about the meeting when the link named a code rather
    /// than a thread (`meetingData` — `{meetingCode, passcode, meetingUrl}`, the shape
    /// the client's own conversation query reads).
    fn meeting_data(&self) -> Option<Value> {
        let code = self.meeting_code.as_ref()?;
        let mut data = json!({ "meetingCode": code, "meetingUrl": self.join_url });
        if let Some(passcode) = &self.passcode {
            data["passcode"] = json!(passcode);
        }
        Some(data)
    }

    /// The `meetingInfo` object the service wants, or `None` when the link named no
    /// context. Only the two fields the client sends are included; a meeting type or
    /// a reply chain would be added here, not guessed.
    fn meeting_info(&self) -> Option<Value> {
        let tenant = self.tenant_id.as_ref()?;
        let organizer = self.organizer_mri.as_ref()?;
        Some(json!({ "tenantId": tenant, "organizerId": organizer }))
    }
}

/// Percent-decode one URL piece, leaving it alone when it is not encoded.
fn decode(value: &str) -> String {
    urlencoding::decode(value).map(|v| v.into_owned()).unwrap_or_else(|_| value.to_string())
}

/// Build the ONE POST that joins a meeting, with or without a microphone.
///
/// The fields are the captured request of the real web client (2026-08-05, this tenant,
/// this user's own meeting), and `offer` is the one thing the capture did not show,
/// because it was taken on the pre-join screen. The client's own builder settles it: it
/// composes the conversation request and then adds EITHER `stream: {}` (subscribe to the
/// roster and nothing more) OR `callInvitation` with the media — one body, one POST,
/// whichever the user asked for.
///
/// `addModality` is NOT that second request, and reading it as one cost a round: it is
/// how a 1:1 call grows a group modality (`addModalityAsync`, whose body carries no media
/// at all), so the service answers `subCode 5021 — no modality blob in the request`.
///
/// Everything below is the captured shape, field for field:
///
/// * `messageId` is the STRING `"0"` for a meeting on the calendar, not null.
/// * `meetingInfo.organizerId` is the BARE object id, not an mri.
/// * `properties.allowConversationWithoutHost` is true — a scheduled meeting is hostless.
/// * `capabilities` is null, and the two capability masks are the working client's own
///   (see `CAPTURED_ENDPOINT_CAPABILITIES`).
pub fn join_payload(
    local: &LocalParticipant,
    meeting: &MeetingJoin,
    callbacks: &CallbackBase,
    offer: Option<&MediaContent>,
) -> Value {
    let mut payload = json!({
        "conversationRequest": {
            "subject": Value::Null,
            "roster": {
                "type": "Delta",
                "rosterUpdate": callbacks.link(paths::CONVERSATION_ROSTER_UPDATE),
            },
            "properties": {
                "allowConversationWithoutHost": true,
                "enableGroupCallEventMessages": true,
                "enableGroupCallUpgradeMessage": false,
                "enableGroupCallMeetupGeneration": false,
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
                "receiveMessage": callbacks.link(paths::CONVERSATION_RECEIVE_MESSAGE),
            },
        },
        "groupContext": Value::Null,
        "participants": { "from": local.json() },
        "capabilities": Value::Null,
        // The capability masks the captured request carries, copied rather than computed.
        //
        // They are DECLARATIONS of client features, and the service refuses a request it
        // does not recognise without saying which field it disliked — so the only values
        // this app has ever seen accepted are the ones a working client sent. The bits
        // this crate can name (`getEndpointCapabilities` in the web client's own bundle)
        // are all ones it can honour: joining a group call, a hostless conference, and a
        // compressed service payload, which `trouter_events` already inflates.
        "endpointCapabilities": CAPTURED_ENDPOINT_CAPABILITIES,
        "clientEndpointCapabilities": CAPTURED_CLIENT_CAPABILITIES,
        "endpointMetadata": { "holographicCapabilities": 3 },
        // The client states how much of itself it shows in a report; the captured value
        // is the only one this app has seen a service accept.
        "endpointState": {
            "endpointStateSequenceNumber": 0,
            "endpointProperties": {
                "additionalEndpointProperties": { "infoShownInReportMode": "FullInformation" }
            }
        },
        "debugContent": { "causeId": callbacks.cause_id },
    });
    // How the meeting is addressed, and it is one of two ways: a long link names the
    // thread, a short one names a code the service resolves itself.
    if let Some(thread) = &meeting.thread_id {
        payload["groupChat"] = json!({
            "threadId": thread,
            // A string, and "0" when the meeting hangs off no message. The captured
            // request sends "0" rather than null.
            "messageId": if meeting.message_id.is_empty() { "0" } else { &meeting.message_id },
        });
    }
    if let Some(data) = meeting.meeting_data() {
        payload["meetingData"] = data;
    }
    if let Some(info) = meeting.meeting_info() {
        payload["meetingInfo"] = info;
    }
    // The MEDIA, when this join is the one that opens a microphone. It rides in a
    // `callInvitation` — the same envelope a call's own offer travels in, minus
    // `participants.to`, because a join rings nobody.
    if let Some(offer) = offer {
        payload["callInvitation"] = json!({
            "callModalities": [MODALITY_AUDIO],
            "links": {
                "progress": callbacks.link(paths::CALL_PROGRESS),
                "mediaAnswer": callbacks.link(paths::CALL_MEDIA_ANSWER),
                "acceptance": callbacks.link(paths::CALL_ACCEPTANCE),
                "redirection": callbacks.link(paths::CALL_REDIRECTION),
                "end": callbacks.link(paths::CALL_END),
            },
            "mediaContent": offer.json(),
        });
    }
    payload
}

/// The conversation a join landed in: where it lives, and what may be done to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinedConversation {
    /// The conversation's own URL — every later action on the MEETING (rather than on
    /// one call leg) is addressed under it.
    pub controller: Option<String>,
    /// Every link the answer named: `leave`, `addModality`, `mute`, `unmute`, `admit`, …
    pub links: Links,
    /// What the service says this conversation is: `"scheduledMeeting"`, hostless or
    /// not, multi-party or not.
    pub state: Value,
    /// The whole answer, for the journal while the schema is still young.
    pub raw: Value,
}

/// Join a meeting: ONE POST, and it carries the microphone when there is one.
///
/// `offer` absent joins for the roster alone, which is what a pre-join screen does.
pub async fn join_meeting(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    local: &LocalParticipant,
    meeting: &MeetingJoin,
    callbacks: &CallbackBase,
    correlation_id: &str,
    offer: Option<&MediaContent>,
) -> Result<JoinedConversation> {
    let endpoints = endpoints(session)?;
    let payload = join_payload(local, meeting, callbacks, offer);
    let raw =
        post_signal(http, &endpoints.conversation_service, session, ic3, correlation_id, &payload)
            .await?;
    Ok(JoinedConversation {
        controller: raw.get("conversationController").and_then(Value::as_str).map(String::from),
        links: Links::collect(&raw),
        state: raw.get("state").cloned().unwrap_or(Value::Null),
        raw,
    })
}


/// Where a join has landed: in the meeting, or in its lobby waiting to be let in.
///
/// The lobby is not a failure and not a connection. Teams reports it as a state of its
/// own (`ConnectedForRosterOnly`), the user is told nobody has admitted them yet, and
/// the same call continues when somebody does — so it must be visible rather than
/// hidden behind "connecting…".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LobbyState {
    /// In the meeting.
    Admitted,
    /// Waiting for somebody in the meeting to admit us.
    Waiting,
}

/// Read the lobby state out of a frame, or `None` when it says nothing about it.
///
/// Two spellings, because the service states it two ways: the call's own status, and a
/// participant's state in the roster.
pub fn lobby_state_in_frame(frame: &Value) -> Option<LobbyState> {
    fn state_of(value: &str) -> Option<LobbyState> {
        match value {
            "ConnectedForRosterOnly" | "Lobby" | "InLobby" => Some(LobbyState::Waiting),
            "Connected" => Some(LobbyState::Admitted),
            _ => None,
        }
    }
    fn walk(value: &Value) -> Option<LobbyState> {
        match value {
            Value::Object(map) => {
                for key in ["callState", "state", "participantState", "status"] {
                    if let Some(found) = map.get(key).and_then(Value::as_str).and_then(state_of) {
                        return Some(found);
                    }
                }
                map.values().find_map(walk)
            }
            Value::Array(items) => items.iter().find_map(walk),
            _ => None,
        }
    }
    walk(frame)
}

/// One stream a participant publishes into the meeting.
///
/// **`source_id` is the whole point of this type**: it is the media source id a
/// subscription is addressed by, and the roster is the only place it exists
/// (NATIVE-CALLING.md § 10.2). Measured values are small integers, per meeting, and they
/// move between joins — so one is never cached across calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterStream {
    /// `main-audio` / `main-video` / `applicationsharing-video` / `data`. The label is the
    /// wire name, and the only thing that tells a shared screen from a camera.
    pub label: String,
    /// What the frame calls it, which FOLLOWS the label rather than the m-line kind: a
    /// shared screen is `applicationsharing-video`, not `video`.
    pub kind: String,
    /// The media source id — what a source request names.
    pub source_id: i64,
    /// That endpoint's own direction, which is what says who is doing what: a sharer's
    /// section is `sendonly`, and a camera nobody turned on is `recvonly`.
    pub direction: String,
    pub server_muted: bool,
}

impl RosterStream {
    /// Whether this stream is a SHARED SCREEN being sent. The client's own test, verbatim
    /// (`N2` in its bundle) — and measured against a real share.
    pub fn is_shared_screen(&self) -> bool {
        self.label == labels::SHARING && self.direction == "sendonly"
    }

    /// Whether this stream is a CAMERA being sent.
    pub fn is_camera(&self) -> bool {
        self.label == labels::VIDEO && self.direction != "recvonly" && self.direction != "inactive"
    }

    pub fn json(&self) -> Value {
        json!({
            "label": self.label,
            "kind": self.kind,
            "source_id": self.source_id,
            "direction": self.direction,
            "server_muted": self.server_muted,
            // Decided HERE so the page never has to know the label vocabulary twice.
            "shared_screen": self.is_shared_screen(),
            "camera": self.is_camera(),
        })
    }
}

/// One person in a meeting, as a roster frame names them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterMember {
    pub mri: String,
    pub display_name: String,
    /// True while they are only in the lobby, so a count of who can hear us is honest.
    pub in_lobby: bool,
    /// False when the roster says this person is no longer in the meeting. A delta frame
    /// announces a departure by turning their state, not by omitting them, so a reader
    /// that ignored this would keep naming somebody who left.
    pub present: bool,
    /// Everything they publish, across every endpoint they are joined from. One person on
    /// a laptop and a phone has several, which is why this is flattened rather than kept
    /// per endpoint: a subscription names a source id and nothing else.
    pub streams: Vec<RosterStream>,
}

/// A roster frame's contents: who it names, and whether that is the WHOLE meeting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterUpdate {
    pub members: Vec<RosterMember>,
    /// True when the frame carries only the participants that CHANGED (`type: "Delta"`),
    /// which is what this app asks for in every join and call payload
    /// (`roster: {type: "Delta"}`). Measured: consecutive frames from one meeting carried
    /// one participant, then two, then one — never the roster whole. So a delta must be
    /// MERGED, and replacing the list with it makes the meeting flicker between the people
    /// in it.
    pub delta: bool,
}

/// Read the roster out of a `rosterUpdate` frame, or `None` when the frame is not one.
///
/// Everybody the frame names, us included: the caller knows its own mri and drops it,
/// and doing that here would make an empty roster and "only me" the same answer.
///
/// **The shape here is measured, and it is not the one the web client's own types
/// describe** (NATIVE-CALLING.md § 10.2). The earlier version of this function read
/// `/rosterUpdate/participants` as an ARRAY, which no real frame has ever been: it returned
/// `None` every time, so a joined meeting named nobody and the call bar said "In the
/// meeting" where it should have said who was in it. Three differences, and every one of
/// them alone was enough to lose the whole roster:
///
/// * the frame BODY *is* the roster — `{type, sequenceNumber, participantCounts,
///   participants}` — because the callback url it arrived on is what names it;
/// * `participants` is an OBJECT keyed by mri, not an array of people carrying an `id`;
/// * the display name is under `details`, and `state` is `"active"` / `"inactive"` rather
///   than the `"Connected"` / `"Lobby"` spellings a call leg uses.
///
/// Every older spelling is still tried first, because they cost one pointer lookup each and
/// this tenant is one tenant.
pub fn roster_in_frame(frame: &Value) -> Option<RosterUpdate> {
    let roster = ["/_decoded/rosterUpdate", "/rosterUpdate"]
        .iter()
        .find_map(|p| frame.pointer(p))
        // The body itself, which is the shape this tenant really sends. It is recognised by
        // holding a `participants` map rather than by its `type`, so a frame that names one
        // is never mistaken for a roster.
        .or_else(|| frame.get("participants").map(|_| frame))?;
    let participants = roster.get("participants")?;
    // Either shape: the object this tenant sends, keyed by mri, or the array the client's
    // own types describe.
    let people: Vec<(Option<&str>, &Value)> = match participants {
        Value::Object(map) => map.iter().map(|(mri, person)| (Some(mri.as_str()), person)).collect(),
        Value::Array(items) => items.iter().map(|person| (None, person)).collect(),
        _ => return None,
    };
    let members: Vec<RosterMember> = people
        .into_iter()
        .filter_map(|(key, person)| {
            let mri = key
                .or_else(|| person.get("id").and_then(Value::as_str))
                .filter(|id| id.starts_with('8') || id.starts_with('4'))?;
            let state = person.get("state").and_then(Value::as_str).unwrap_or_default();
            Some(RosterMember {
                mri: mri.to_string(),
                display_name: display_name_in_roster(person),
                in_lobby: matches!(state, "Lobby" | "InLobby" | "ConnectedForRosterOnly"),
                // An unstated state is presence: the array shape never carried one, and a
                // person the roster names is in the meeting until it says otherwise.
                present: !matches!(state, "inactive" | "Inactive" | "Disconnected"),
                streams: streams_of(person),
            })
        })
        .collect();
    Some(RosterUpdate {
        members,
        delta: roster.get("type").and_then(Value::as_str) == Some("Delta"),
    })
}

/// Everything one participant publishes, from every endpoint they are joined from.
///
/// The nesting is measured: `endpoints` is an OBJECT keyed by endpoint id, and the streams
/// sit under that endpoint's `call`. `endpointDetails[]` — which the web client's own types
/// describe — is its normalized form and never travels, so both are read: one pointer each,
/// and the one that finds nothing costs nothing.
fn streams_of(person: &Value) -> Vec<RosterStream> {
    let endpoints = match person.get("endpoints") {
        Some(Value::Object(map)) => map.values().collect::<Vec<_>>(),
        // The client's own shape, in case another tenant sends it.
        Some(Value::Array(items)) => items.iter().collect(),
        _ => return Vec::new(),
    };
    endpoints
        .into_iter()
        .flat_map(|endpoint| {
            // `endpointDetails` is itself an array of endpoints in that other shape, so a
            // single level of either is handled without a second walk.
            let under_call = endpoint.pointer("/call/mediaStreams").and_then(Value::as_array);
            let bare = endpoint.get("mediaStreams").and_then(Value::as_array);
            under_call.or(bare).map(Vec::as_slice).unwrap_or_default().iter()
        })
        .filter_map(|stream| {
            // A stream with no source id cannot be subscribed to, so it is not one this app
            // has any use for.
            let source_id = stream.get("sourceId").and_then(Value::as_i64)?;
            let label = stream.get("label").and_then(Value::as_str).unwrap_or_default();
            Some(RosterStream {
                label: label.to_string(),
                kind: stream
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(label)
                    .to_string(),
                source_id,
                direction: stream
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                server_muted: stream.get("serverMuted").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// A roster participant's name, from wherever that frame keeps it.
///
/// `details.displayName` is what this tenant sends; the bare `displayName` is the client's
/// own normalized form and what the older test invented.
fn display_name_in_roster(person: &Value) -> String {
    ["/details/displayName", "/displayName", "/details/name"]
        .iter()
        .find_map(|p| person.pointer(p))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Fold a roster frame into the list a call holds, and return whether anything moved.
///
/// A delta names only what changed, so it is merged by mri and a departure removes its
/// person; a full frame replaces the list. Either way the order is the order people were
/// first seen, because a roster that re-sorts itself under the reader moves the name they
/// were reading.
pub fn apply_roster_update(current: &mut Vec<RosterMember>, update: RosterUpdate) -> bool {
    let before = current.clone();
    if !update.delta {
        current.clear();
    }
    for member in update.members {
        let at = current.iter().position(|held| held.mri == member.mri);
        match (at, member.present) {
            (Some(at), false) => {
                current.remove(at);
            }
            (Some(at), true) => current[at] = member,
            (None, true) => current.push(member),
            // Somebody who left and was never here needs no room made for them.
            (None, false) => {}
        }
    }
    *current != before
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
    // What we SENT, when the capture switch is on: a payload the service refuses is
    // diagnosed by comparing it with the real client's, and it cannot be compared if it
    // was never written down. Redacted of nothing, because it is the user's own machine
    // and the SDP is theirs — see `record_call_frame` for where this must not be pointed.
    if std::env::var("TEAMS_LITE_CALL_DEBUG").as_deref() == Ok("1") {
        eprintln!(
            "[calling] POST {}\n{}",
            redact_url(url),
            serde_json::to_string_pretty(payload).unwrap_or_default()
        );
    }
    // Every header below was copied off a request this service ACCEPTED (captured from
    // the real client, 2026-08-05). Two of them are absences, and they are the point:
    //
    //   * NO `X-Skypetoken`. The captured request authenticates with the ic3 bearer
    //     ALONE. This app sent both, and a calling request carrying two credentials is a
    //     shape the real client never produces — the likeliest reading of a `400` that
    //     names nothing.
    //   * NO `api-version`. The conversation service is not versioned that way; the
    //     header belongs to the relay-token GET, which is a different service.
    let response = http
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "*/*")
        .header("authorization", format!("Bearer {ic3}"))
        // Who this client is, in the format the CALLING service takes — which is not the
        // Skype-era one: `SkypeSpaces/{version}/{platform}/TsCallingVersion=…`.
        .header("X-Microsoft-Skype-Client", CLIENT_IDENTITY)
        .header("X-Microsoft-Skype-Chain-ID", correlation_id)
        // One id per REQUEST, beside the chain id that spans the call.
        .header("X-Microsoft-Skype-Message-ID", uuid::Uuid::new_v4().to_string())
        .header("X-MS-Migration", "True")
        // Where this user lives. The service routes on all three, and the captured
        // request carries them on every call.
        .header("ms-teams-region", &session.region)
        .header("ms-teams-partition", teams_partition(&session.region))
        .header("ms-teams-ring", "general")
        .json(payload)
        .send()
        .await
        .context("calling: signaling POST failed")?;

    let status = response.status();
    // The service explains a refusal in HEADERS as often as in the body: a validation
    // failure answers `{}` and names the field in `x-microsoft-skype-*`. A 400 with an
    // empty body and no headers is an error nobody can act on, and this app got one.
    let reasons: Vec<String> = response
        .headers()
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();
            name.starts_with("x-microsoft-skype") || name.starts_with("x-ms-") || name == "ms-cv"
        })
        .filter_map(|(name, value)| value.to_str().ok().map(|v| format!("{name}: {v}")))
        .collect();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // A refusal says so in the journal, exactly as a refused write does. It used to
        // reach the page and nowhere else, so the only record of a call this machine
        // could not place was the sentence the user read out by hand. The url is
        // redacted and the credentials are never named.
        eprintln!(
            "[calling] refused: {status} from {} — {} [{}]",
            redact_url(url),
            text.chars().take(200).collect::<String>(),
            reasons.join("; ")
        );
        // Keep the service's own words: its phrases name the real cause ("this user
        // has no calling licence", "conversation does not exist") and a generic
        // message here would hide them.
        return Err(anyhow!(
            "calling: {status} from {} — {} [{}]",
            redact_url(url),
            text.chars().take(400).collect::<String>(),
            reasons.join("; ")
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

    /// The frame that names the CAUSE of a call that ends two seconds in, in the shape the
    /// tenant really sends it (`web/scripts/call-live.ts` measured this one).
    #[test]
    fn an_invitation_that_reached_nobody_is_read_and_told_apart() {
        let url = "https://pub.trouter.example/v4/f/x/callAgent/a/b/conversation/\
                   addParticipantFailure/";
        let failed = invite_failed(
            url,
            &json!({
                "participantInfos": [{
                    "code": 480,
                    "subCode": 10037,
                    "reason": "clientError",
                    "phrase": "No callee endpoints were found."
                }],
                "participants": { "8:orgid:x": { "code": 580, "subCode": 5205 } }
            }),
        )
        .expect("a failed invitation");
        assert!(failed.no_endpoints);
        assert_eq!(failed.phrase, "No callee endpoints were found.");

        // A device that rang and refused is NOT this: somebody was reachable, and the
        // ending's own phrase is the honest thing to report.
        let refused = invite_failed(
            url,
            &json!({ "participantInfos": [{ "code": 486, "subCode": 10004, "phrase": "Busy here." }] }),
        )
        .expect("a failed invitation");
        assert!(!refused.no_endpoints);
        assert_eq!(refused.phrase, "Busy here.");

        // And it is recognised by its own callback path, never by a body shape another
        // frame could share.
        assert!(invite_failed("…/conversation/rosterUpdate/", &json!({ "phrase": "x" })).is_none());
    }

    /// The name of that ending is a CONTRACT with the page: the backend states it and
    /// `web/src/lib/call.ts` turns it into the sentence the user reads. Two spellings of one
    /// name would leave the user with "The call ended." and no way to notice why.
    #[test]
    fn the_page_knows_the_name_of_an_unreachable_ending() {
        let call_ts = include_str!("../web/src/lib/call.ts");
        assert!(
            call_ts.contains(END_REASON_UNREACHABLE),
            "web/src/lib/call.ts must name {END_REASON_UNREACHABLE}, or an unreachable \
             colleague is reported as \"The call ended.\""
        );
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

    /// What an answer GRANTED, stated for a journal — and never anything a journal must
    /// not hold.
    ///
    /// The measurement that asked for it: a screen share was offered live, the service
    /// answered by rejecting the section, and this machine's own log said only that an
    /// offer had gone out. Which section came back refused was unanswerable afterwards.
    #[test]
    fn an_answers_sections_are_stated_as_accepted_or_rejected() {
        let answer = [
            "v=0",
            "o=- 0 0 IN IP4 127.0.0.1",
            "a=fingerprint:sha-256 AA:BB:CC",
            "m=audio 3478 RTP/SAVP 111",
            "a=mid:0",
            "a=label:main-audio",
            "a=candidate:1 1 udp 2130706431 10.1.2.3 51234 typ host",
            "m=video 0 RTP/SAVP 107",
            "a=mid:5",
            "a=label:applicationsharing-video",
            "",
        ]
        .join("\r\n");
        let sections = media_sections(&answer);
        assert_eq!(
            sections,
            vec![
                "audio mid=0 label=main-audio accepted",
                "video mid=5 label=applicationsharing-video REJECTED",
            ]
        );

        // The rule that keeps this loggable at all: the shape travels and the content does
        // not. A candidate is an address of the user's, a fingerprint is a key, and a port
        // is a relay's — so a zero port is stated as the fact it is and nothing else.
        let printed = sections.join(" | ");
        for secret in ["10.1.2.3", "51234", "AA:BB:CC", "3478", "candidate"] {
            assert!(!printed.contains(secret), "{secret} must never reach a log line");
        }

        assert!(media_sections("").is_empty());
    }

    /// The content-sharing session a screen share needs, field for field against the
    /// client's own `j2` — and never carrying a link that would overwrite the call's.
    #[test]
    fn a_content_sharing_modality_asks_to_present_and_names_its_own_callbacks() {
        let payload = content_sharing_payload(&local(), &callbacks(), "session-guid");
        assert_eq!(payload.pointer("/contentSharing/identifier").unwrap(), "session-guid");
        // The client's builder passes `i || null` / `t || null`, and this app has neither: a
        // screen has no subject, and the state is the service's to decide.
        assert_eq!(payload.pointer("/contentSharing/subject").unwrap(), &Value::Null);
        assert_eq!(payload.pointer("/contentSharing/sessionState").unwrap(), &Value::Null);
        // The literal the client sends on a start.
        assert_eq!(payload.pointer("/contentSharing/sequenceNumber").unwrap(), 1);
        // It reaches nobody: a session is asked of the SERVICE, not offered to a person.
        assert_eq!(payload.pointer("/participants/to").unwrap(), &json!([]));
        // Two callbacks for the session's own changes, and two for the modality itself.
        for pointer in [
            "/contentSharing/links/sessionUpdate",
            "/contentSharing/links/sessionEnd",
            "/links/addModalitySuccess",
            "/links/addModalityFailure",
        ] {
            let link = payload.pointer(pointer).and_then(Value::as_str).expect(pointer);
            assert!(link.starts_with("https://"), "{pointer} must be a callback of ours");
        }
        // And no envelope. A wrapped body is refused `400` with `{}` and names nothing —
        // the failure § Joining a meeting cost days to.
        assert!(payload.get("payload").is_none());
    }

    /// The session's links are read APART from the call's, because it carries a `leave` of its
    /// own and `Links::collect` takes the deepest of a name. Merged in, giving a SHARE up
    /// would have hung the call up instead.
    #[test]
    fn a_sharing_sessions_leave_never_becomes_the_calls_own() {
        let answer = json!({
            "contentSharing": {
                "sessionId": "cs-1",
                "links": { "leave": "https://x/content-sharing-leave", "takeControl": "https://x/tc" }
            },
            // What the call already holds, in the same answer.
            "links": { "leave": "https://x/hang-up" }
        });
        let session = ContentSharing::from_answer("corr-1", &answer);
        assert_eq!(session.correlation_id, "corr-1");
        assert_eq!(session.session_id.as_deref(), Some("cs-1"));
        assert_eq!(session.leave.as_deref(), Some("https://x/content-sharing-leave"));
        // The one that must never be confused for it.
        assert_ne!(session.leave.as_deref(), Some("https://x/hang-up"));

        // An answer that names no way out is read as one: a session this app could not give
        // back is reported rather than remembered.
        let bare = ContentSharing::from_answer("corr-2", &json!({ "contentSharing": {} }));
        assert!(bare.leave.is_none());
    }

    /// The GRANT arrives on a frame, and its shape is not the one a pointer would guess.
    ///
    /// Measured 2026-08-06: the `addModality` POST answers `{}`, and the service POSTs
    /// `addModalitySuccess` with the session's six links. A first reading looked for `/links`
    /// at the top and found nothing, so the app offered its section with no presenter and the
    /// service rejected it — which is why this reads at every depth instead.
    #[test]
    fn the_grant_is_read_out_of_its_frame_at_whatever_depth_it_arrives() {
        // Named after its type, the way `mediaAnswer` is.
        let named = json!({
            "addModalitySuccess": {
                "contentSharingSessionId": "cs-42",
                "links": { "leave": "https://x/cs-leave", "takeControl": "https://x/tc" }
            }
        });
        let session = ContentSharing::from_frame("corr", &named).expect("the grant");
        assert_eq!(session.leave.as_deref(), Some("https://x/cs-leave"));
        assert_eq!(session.session_id.as_deref(), Some("cs-42"));

        // And at the top, which is the shape `contentSharingEnd` really has.
        let flat = json!({ "links": { "leave": "https://x/flat" } });
        assert_eq!(
            ContentSharing::from_frame("corr", &flat).and_then(|s| s.leave).as_deref(),
            Some("https://x/flat")
        );

        // A frame that names no way out is not the grant: this app never holds a session it
        // could not give back.
        assert!(ContentSharing::from_frame("corr", &json!({ "links": {} })).is_none());
        assert!(ContentSharing::from_frame("corr", &json!({})).is_none());
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
        let invitation = payload.pointer("/callInvitation").expect("an invitation");
        assert_eq!(invitation["callModalities"], json!(["audio"]));
        assert_eq!(invitation["mediaContent"]["blob"], "v=0 offer");
        assert_eq!(invitation["mediaContent"]["contentType"], SDP_CONTENT_TYPE);
        assert!(invitation["links"]["mediaAnswer"]
            .as_str()
            .unwrap()
            .ends_with("/call/mediaAnswer/"));
        assert_eq!(payload.pointer("/participants/to/0/id").unwrap(), "8:orgid:her");
        // A call carries the same capability masks a JOIN is known to be accepted with:
        // same endpoint, same silent refusal, and the 1:1 path has never been rung.
        assert_eq!(payload.pointer("/endpointCapabilities").unwrap(), 73463);
        assert_eq!(payload.pointer("/clientEndpointCapabilities").unwrap(), 63928042);
        assert_eq!(payload.pointer("/capabilities").unwrap(), &Value::Null);
        assert!(payload.pointer("/endpointState").is_some());
        assert!(payload.pointer("/endpointMetadata").is_some());
        assert_eq!(payload.pointer("/participants/from/id").unwrap(), "8:orgid:me");
        assert_eq!(
            payload.pointer("/groupChat/threadId").unwrap(),
            "19:thread@thread.v2"
        );
    }

    /// A GROUP call is the same POST with more people in it: every mri is rung, they share
    /// one thread, and the group-call event messages that put the call line in that thread
    /// are on. Nothing about the body is per-person.
    #[test]
    fn an_invitation_rings_every_person_it_names() {
        let payload = invitation_payload(
            &local(),
            &["8:orgid:her".to_string(), "8:orgid:him".to_string(), "8:orgid:them".to_string()],
            Some("19:group@thread.v2"),
            &MediaContent::sdp("v=0 offer"),
            &callbacks(),
        );
        let to = payload.pointer("/participants/to").unwrap().as_array().unwrap();
        assert_eq!(to.len(), 3);
        assert_eq!(to[2]["id"], "8:orgid:them");
        assert_eq!(payload.pointer("/groupChat/threadId").unwrap(), "19:group@thread.v2");
        // What posts the call line into the thread everybody in it reads.
        assert_eq!(
            payload.pointer("/conversationRequest/properties/enableGroupCallEventMessages").unwrap(),
            &json!(true)
        );
        // And the roster subscription, which is the only way "who is in this call" is ever
        // answered once there is more than one person to answer it for.
        assert!(payload
            .pointer("/conversationRequest/roster/rosterUpdate")
            .unwrap()
            .as_str()
            .unwrap()
            .ends_with("/conversation/rosterUpdate/"));
    }

    /// Audio only, everywhere, in every direction. A video m-line would be
    /// negotiated for a camera this app never opens.
    #[test]
    fn every_payload_offers_audio_and_only_audio() {
        let offer = MediaContent::sdp("v=0");
        let invitation =
            invitation_payload(&local(), &["8:orgid:her".into()], None, &offer, &callbacks());
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
        )
        .unwrap();
        let joined_audio = join_payload(&local(), &meeting, &callbacks(), Some(&offer));
        assert_eq!(
            joined_audio.pointer("/callInvitation/callModalities").unwrap(),
            &json!(["audio"])
        );
        let acceptance = acceptance_payload(&local(), &offer, &callbacks());
        let answer = media_answer_payload(&local(), &offer, &callbacks(), &[MODALITY_AUDIO]);
        assert_eq!(invitation.pointer("/callInvitation/callModalities").unwrap(), &json!(["audio"]));
        assert_eq!(
            acceptance.pointer("/callAcceptance/acceptedCallModalities").unwrap(),
            &json!(["audio"])
        );
        assert_eq!(answer.pointer("/mediaAnswer/callModalities").unwrap(), &json!(["audio"]));
        let whole = format!("{invitation}{acceptance}{answer}");
        assert!(!whole.contains("video"), "no payload may ever offer video: {whole}");
    }

    #[test]
    fn a_hangup_and_a_rejection_name_who_sent_them() {
        let hangup = hangup_payload(&local());
        assert_eq!(hangup.pointer("/participants/from/id").unwrap(), "8:orgid:me");
        // Both endings, the way the client's own `leaveConversation` sends them. A body
        // that names nobody is refused with a 400, and then Teams still has the user in
        // the meeting while this app does not.
        assert_eq!(hangup.pointer("/conversationTransactionEnd/reason").unwrap(), "noError");
        assert!(hangup.pointer("/callTransactionEnd/code").is_some());
        assert_eq!(
            rejection_payload(&local()).pointer("/callRejection/sender/id").unwrap(),
            "8:orgid:me"
        );
        assert_eq!(mute_payload(&local(), true).pointer("/muteUnmute/muted").unwrap(), true);
    }

    // ---- joining a meeting -------------------------------------------------

    /// The link the calendar already holds carries everything a join needs. This is
    /// the real shape Graph hands back for a meeting on the calendar.
    #[test]
    fn a_calendar_meeting_link_yields_its_thread_and_its_meeting_info() {
        let url = "https://teams.microsoft.com/l/meetup-join/\
                   19%3ameeting_NTk4YzY0MTQt%40thread.v2/0\
                   ?context=%7b%22Tid%22%3a%22af1bbf3d-1111-2222-3333-444455556666%22%2c\
                   %22Oid%22%3a%2299887766-5544-3322-1100-aabbccddeeff%22%7d";
        let join = MeetingJoin::from_join_url(url).expect("a join link");
        assert_eq!(join.thread_id.as_deref(), Some("19:meeting_NTk4YzY0MTQt@thread.v2"));
        // A calendar meeting hangs off no message.
        assert_eq!(join.message_id, "0");
        assert!(!join.is_channel_meeting());
        assert_eq!(join.tenant_id.as_deref(), Some("af1bbf3d-1111-2222-3333-444455556666"));
        // A BARE object id, which is what the captured `meetingInfo.organizerId` is.
        assert_eq!(
            join.organizer_mri.as_deref(),
            Some("99887766-5544-3322-1100-aabbccddeeff")
        );
    }

    /// A meeting inside a CHANNEL is the other shape: the channel's own thread, and the
    /// post the meeting hangs off. Both have to survive the parse, or the join
    /// addresses the channel instead of the meeting in it.
    #[test]
    fn a_channel_meeting_link_keeps_the_message_it_hangs_off() {
        let url = "https://teams.microsoft.com/l/meetup-join/\
                   19%3aabc123%40thread.tacv2/1719400000000?context=%7b%22Tid%22%3a%22t%22%7d";
        let join = MeetingJoin::from_join_url(url).expect("a join link");
        assert_eq!(join.thread_id.as_deref(), Some("19:abc123@thread.tacv2"));
        assert_eq!(join.message_id, "1719400000000");
        assert!(join.is_channel_meeting());
        // A context with no organizer names no `meetingInfo` rather than half of one.
        assert_eq!(join.meeting_info(), None);
    }

    /// A link that is not a meeting join must read as one thing: not a meeting. The
    /// UI decides whether to offer a Join button from exactly this answer.
    #[test]
    fn a_link_that_is_not_a_meeting_join_is_refused() {
        for url in [
            "",
            "https://teams.microsoft.com/l/channel/19%3aabc%40thread.tacv2/General",
            "https://zoom.us/j/123456",
            // The path is right but the thread is not a thread.
            "https://teams.microsoft.com/l/meetup-join/not-a-thread/0",
            "https://teams.microsoft.com/l/meetup-join/",
        ] {
            assert_eq!(MeetingJoin::from_join_url(url), None, "url: {url}");
        }
    }

    /// A join link with no context at all still joins: the thread is what addresses the
    /// meeting, and `meetingInfo` is the service's preference rather than its key.
    #[test]
    fn a_join_link_without_a_context_still_names_the_meeting() {
        let join =
            MeetingJoin::from_join_url("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0")
                .expect("a join link");
        assert_eq!(join.thread_id.as_deref(), Some("19:meeting_x@thread.v2"));
        assert_eq!(join.tenant_id, None);
        assert_eq!(join.meeting_info(), None);
    }

    /// A meeting reached from its own CHAT: the thread is the whole address, and the body
    /// is the one a context-free long link builds — the same `groupChat` and the same
    /// `"0"`, with nothing invented beside it.
    #[test]
    fn a_meeting_thread_is_a_join_address_on_its_own() {
        let join = MeetingJoin::from_thread_id("19:meeting_abc@thread.v2").expect("a meeting");
        assert_eq!(join.thread_id.as_deref(), Some("19:meeting_abc@thread.v2"));
        assert_eq!(join.message_id, "0");
        assert!(!join.is_channel_meeting());
        // No link was involved, so neither of the two things a link carries is claimed.
        assert_eq!(join.meeting_info(), None);
        assert_eq!(join.meeting_data(), None);
        assert_eq!(join.join_url, "");

        let payload = join_payload(&local(), &join, &callbacks(), None);
        assert_eq!(
            payload.pointer("/groupChat/threadId").unwrap(),
            "19:meeting_abc@thread.v2"
        );
        assert_eq!(payload.pointer("/groupChat/messageId").unwrap(), "0");
        assert!(payload.pointer("/meetingData").is_none());
        assert!(payload.pointer("/meetingInfo").is_none());
        // A join rings nobody, whichever way it was addressed.
        assert!(payload.pointer("/participants/to").is_none());
    }

    /// Only a MEETING thread is a join address. A plain group chat is called instead, and
    /// a channel's thread would address the channel rather than the meeting inside it —
    /// so both read as "nothing to join" rather than as a join to the wrong place.
    #[test]
    fn a_thread_that_is_not_a_meeting_is_no_join_address() {
        for thread in [
            "",
            // An ordinary group chat: 32 hex digits, no `meeting_`.
            "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2",
            // A channel.
            "19:abc@thread.tacv2",
            // A one-to-one chat.
            "19:oid1_oid2@unq.gbl.spaces",
            "48:notes",
        ] {
            assert_eq!(MeetingJoin::from_thread_id(thread), None, "thread: {thread}");
        }
    }

    /// The shape the user's OWN meetings have: a meeting code and a passcode, and no
    /// thread at all. The service resolves the thread from the code, so the link is
    /// handed back to it as `meetingData` instead of `groupChat`.
    #[test]
    fn a_short_meeting_link_yields_its_code_and_passcode() {
        let url = "https://teams.microsoft.com/meet/35017215452446?p=4QyEW2wHMvAevXsCVU";
        let join = MeetingJoin::from_join_url(url).expect("a join link");
        assert_eq!(join.thread_id, None);
        assert_eq!(join.meeting_code.as_deref(), Some("35017215452446"));
        assert_eq!(join.passcode.as_deref(), Some("4QyEW2wHMvAevXsCVU"));
        assert_eq!(join.join_url, url);
        assert!(!join.is_channel_meeting());

        let payload = join_payload(&local(), &join, &callbacks(), None);
        // No thread to name, so none is invented.
        assert!(payload.pointer("/groupChat").is_none());
        assert_eq!(payload.pointer("/meetingData/meetingCode").unwrap(), "35017215452446");
        assert_eq!(payload.pointer("/meetingData/passcode").unwrap(), "4QyEW2wHMvAevXsCVU");
        assert_eq!(payload.pointer("/meetingData/meetingUrl").unwrap(), url);
    }

    /// A short link with no passcode still names the meeting, and a code that is not one
    /// is refused rather than sent.
    #[test]
    fn a_short_link_is_checked_before_it_is_trusted() {
        let join = MeetingJoin::from_join_url("https://teams.microsoft.com/meet/12345")
            .expect("a join link");
        assert_eq!(join.meeting_code.as_deref(), Some("12345"));
        assert_eq!(join.passcode, None);
        assert!(join.meeting_data().unwrap().get("passcode").is_none());
        for url in [
            "https://teams.microsoft.com/meet/",
            "https://teams.microsoft.com/meet/not a code",
        ] {
            assert_eq!(MeetingJoin::from_join_url(url), None, "url: {url}");
        }
    }

    /// `conversationType` is NULL for an ordinary join. The client only ever names one
    /// for an emergency call, a cast, a huddle or a consult-and-add — and an invented
    /// value earned a `400 {}` from the conversation service with no explanation.
    #[test]
    fn a_join_names_no_conversation_type_and_carries_the_captured_fields() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
        )
        .unwrap();
        let payload = join_payload(&local(), &meeting, &callbacks(), None);
        // The captured request names NO conversationType at all, so neither does this.
        assert!(payload.pointer("/conversationRequest/conversationType").is_none());
        // And the fields it does always carry, each of which a strict service may demand.
        assert_eq!(payload.pointer("/capabilities").unwrap(), &Value::Null);
        assert!(payload.pointer("/endpointCapabilities").is_some());
        assert!(payload.pointer("/endpointState").is_some());
        assert!(payload.pointer("/endpointMetadata").is_some());
    }

    #[test]
    fn a_join_rings_nobody_and_names_the_meeting() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0\
             ?context=%7b%22Tid%22%3a%22tenant%22%2c%22Oid%22%3a%22organizer%22%7d",
        )
        .expect("a join link");
        let payload = join_payload(&local(), &meeting, &callbacks(), None);

        // A join has no `to`: the meeting is already there, and nobody is rung.
        assert!(payload.pointer("/participants/to").is_none());
        assert_eq!(payload.pointer("/participants/from/id").unwrap(), "8:orgid:me");
        assert_eq!(
            payload.pointer("/groupChat/threadId").unwrap(),
            "19:meeting_x@thread.v2"
        );
        // The STRING "0", exactly as the captured request sends it — not null.
        assert_eq!(payload.pointer("/groupChat/messageId").unwrap(), "0");
        assert_eq!(payload.pointer("/meetingInfo/tenantId").unwrap(), "tenant");
        assert_eq!(payload.pointer("/meetingInfo/organizerId").unwrap(), "organizer");
        // And NO media: the join joins the conversation, and audio is a second request
        // (see `add_audio_payload`). A `callInvitation` here is a 400 with no body.
        assert!(payload.pointer("/callInvitation").is_none());
        assert!(!payload.to_string().contains("mediaContent"));
        // The roster is asked to be kept up to date, because that is what "who" means.
        assert!(payload
            .pointer("/conversationRequest/roster/rosterUpdate")
            .unwrap()
            .as_str()
            .unwrap()
            .ends_with("/conversation/rosterUpdate/"));
    }

    /// The credentials a calling request carries, and the ones it must NOT. The captured
    /// request authenticates with the ic3 bearer ALONE — sending a skypetoken beside it is
    /// a shape the real client never produces, and it cost three rounds of a `400` that
    /// named nothing.
    #[test]
    fn a_calling_request_carries_one_credential_and_no_api_version() {
        let source = include_str!("calling.rs");
        // `post_signal` alone. The relay-token GET below it legitimately sends a
        // skypetoken and an api-version — that is a different service, and the web
        // client's own legacy token fetcher sends exactly those two.
        let start = source.find("pub async fn post_signal").expect("post_signal");
        let end = source[start..].find("\n/// ").map(|at| start + at).unwrap_or(source.len());
        let post_signal = &source[start..end];
        assert!(
            !post_signal.contains(".header(\"X-Skypetoken\""),
            "the calling service takes the ic3 bearer alone; a second credential is refused"
        );
        assert!(
            !post_signal.contains(".header(\"api-version\""),
            "the conversation service is not versioned by that header"
        );
        assert!(post_signal.contains("ms-teams-region"), "the service routes on the region");
        assert!(post_signal.contains("ms-teams-ring"), "and on the ring");
    }

    /// The journal names the address a call publishes its links on, because a refusal
    /// that says nothing makes that address the first thing to compare. It names the
    /// HOST and the flavour and never the allocation id, which routes frames to us.
    #[test]
    fn a_logged_surl_keeps_its_host_and_drops_its_id() {
        let surl = "https://pub-ent-plce-03-f.trouter.teams.microsoft.com:3443/v4/f/SBjmODent0m1dNwsgcTbeQ/";
        let shape = surl_shape(surl);
        assert_eq!(
            shape,
            "https://pub-ent-plce-03-f.trouter.teams.microsoft.com:3443/v4/f/…/"
        );
        assert!(!shape.contains("SBjmODent0m1dNwsgcTbeQ"), "the id is a key: {shape}");
        // An allocate endpoint carries no id at all, and stays whole.
        assert_eq!(
            surl_shape("https://go-eu.trouter.teams.microsoft.com/v4/a"),
            "https://go-eu.trouter.teams.microsoft.com/v4/a"
        );
        // Anything that is not a trouter address is printed as it is.
        assert_eq!(surl_shape("https://example.test/x"), "https://example.test/x");
    }

    /// NO body carries a `payload` envelope, and this is the test that keeps it that way.
    ///
    /// The web client's own builders DO produce `{payload: {…}}`, so a reader of that
    /// bundle copies the envelope in good faith — this app did, in every one of its eight
    /// bodies. But the envelope belongs to the SDK's request OBJECT, not to the protocol:
    /// its transport serialises `s.payload`, so what reaches the wire is the contents. A
    /// wrapped body is refused with `400` and an empty response, which cost several
    /// rounds of guessing to find.
    #[test]
    fn no_body_carries_the_sdk_request_envelope() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
        )
        .unwrap();
        let offer = MediaContent::sdp("v=0\r\n");
        let bodies = [
            (
                "invitation",
                invitation_payload(&local(), &["8:orgid:her".into()], None, &offer, &callbacks()),
            ),
            ("join", join_payload(&local(), &meeting, &callbacks(), None)),
            ("join with audio", join_payload(&local(), &meeting, &callbacks(), Some(&offer))),
            ("acceptance", acceptance_payload(&local(), &offer, &callbacks())),
            ("media answer", media_answer_payload(&local(), &offer, &callbacks(), &[MODALITY_AUDIO])),
            ("hangup", hangup_payload(&local())),
            ("rejection", rejection_payload(&local())),
            ("mute", mute_payload(&local(), true)),
        ];
        for (what, body) in bodies {
            assert!(
                body.get("payload").is_none(),
                "the {what} body wraps itself in the SDK's envelope"
            );
            // And it is a real body, not an empty object that trivially passes.
            assert!(
                body.as_object().is_some_and(|o| !o.is_empty()),
                "the {what} body is empty"
            );
        }
    }

    /// A `callAcceptance` carries the answer, and for a meeting join it is the ONLY frame
    /// that does — the service accepts and answers in one. Reading only `mediaAnswer` left
    /// the page holding an offer nothing replied to.
    #[test]
    fn an_acceptance_carries_the_answer_too() {
        let frame = json!({
            "callAcceptance": {
                "acceptedBy": { "id": "8:orgid:her" },
                "mediaContent": { "blob": "v=0 answer", "contentType": SDP_CONTENT_TYPE },
            }
        });
        let answer = media_answer_from_frame(&frame).expect("the answer in the acceptance");
        assert_eq!(answer.blob, "v=0 answer");
        // And the older shape still reads, wrapped or not.
        let wrapped = json!({ "_decoded": { "mediaAnswer": {
            "mediaContent": { "blob": "v=0 plain", "contentType": SDP_CONTENT_TYPE } } } });
        assert_eq!(media_answer_from_frame(&wrapped).unwrap().blob, "v=0 plain");
    }

    /// The service ends a call it accepted when nobody acknowledges the acceptance —
    /// `Call Controller timed out while waiting for acknowledgement`, 30 s after a join
    /// that looked perfect. So the link is read from the acceptance's OWN links, and the
    /// body publishes the seven the real client publishes.
    #[test]
    fn an_acceptance_is_acknowledged_on_its_own_link() {
        let frame = json!({
            "callAcceptance": {
                "links": {
                    "acknowledgement": "https://cc/ack",
                    "mediaRenegotiation": "https://cc/reneg",
                }
            }
        });
        assert_eq!(acceptance_acknowledgement_link(&frame), Some("https://cc/ack"));
        // A frame that names none is not an error: nothing is owed to a service that
        // asked for nothing.
        assert_eq!(acceptance_acknowledgement_link(&json!({ "callAcceptance": {} })), None);

        let body = acceptance_acknowledgement_payload(&callbacks());
        let links = body.pointer("/callAcceptanceAcknowledgement/links").expect("the links");
        for name in [
            "mediaRenegotiation",
            "transfer",
            "replacement",
            "balanceUpdate",
            "retargetCompletion",
            "controlVideoStreaming",
            "updateMediaDescriptions",
        ] {
            let link = links.get(name).and_then(Value::as_str).unwrap_or_default();
            assert!(link.contains("callAgent"), "{name} is not one of our callbacks: {link}");
        }
        // It carries no media and claims nothing about the answer.
        assert!(!body.to_string().contains("mediaContent"));
        assert!(body.get("payload").is_none(), "no SDK envelope on the wire");
    }

    #[test]
    fn a_region_names_its_partition() {
        // The one observation this is built from: region `fr` lives in partition `fr01`.
        assert_eq!(teams_partition("fr"), "fr01");
    }

    /// The capability masks are COPIED from a request the service accepted, not computed.
    /// A reader who replaces them with a clean 0 gets a `400` with an empty body and no
    /// way to tell why — which is exactly the round this cost.
    #[test]
    fn the_join_repeats_the_capability_masks_a_working_client_sent() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
        )
        .unwrap();
        let payload = join_payload(&local(), &meeting, &callbacks(), None);
        assert_eq!(payload.pointer("/endpointCapabilities").unwrap(), 73463);
        assert_eq!(payload.pointer("/clientEndpointCapabilities").unwrap(), 63928042);
        assert_eq!(
            payload.pointer("/endpointMetadata/holographicCapabilities").unwrap(),
            3
        );
    }

    /// The microphone travels WITH the join, in one POST, and it rings nobody.
    ///
    /// Reading `addModality` as the second half of a join is what earned
    /// `subCode 5021 — no modality blob in the request`: that link grows a GROUP modality
    /// on a 1:1 call and its body carries no media at all. The client's own builder puts
    /// the offer in a `callInvitation` beside the conversation request, and posts once.
    #[test]
    fn a_join_carries_the_offer_and_rings_nobody() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
        )
        .unwrap();
        let offer = MediaContent::sdp("v=0 offer");
        let payload = join_payload(&local(), &meeting, &callbacks(), Some(&offer));
        let invitation = payload.pointer("/callInvitation").expect("an invitation");
        assert_eq!(invitation["callModalities"], json!(["audio"]));
        assert_eq!(invitation["mediaContent"]["blob"], "v=0 offer");
        assert_eq!(invitation["mediaContent"]["contentType"], SDP_CONTENT_TYPE);
        // The conversation request travels in the SAME body, which is the whole point.
        assert!(payload.pointer("/conversationRequest/roster").is_some());
        assert!(payload.pointer("/groupChat/threadId").is_some());
        // Nobody to ring: a meeting's roster already exists.
        assert!(payload.pointer("/participants/to").is_none());
        assert!(!payload.to_string().contains("video"));
        // And a join for the roster alone carries no media at all — that is the shape
        // the pre-join capture pins.
        let roster_only = join_payload(&local(), &meeting, &callbacks(), None);
        assert!(roster_only.pointer("/callInvitation").is_none());
    }

    #[test]
    fn a_channel_meeting_join_carries_the_message_id() {
        let meeting = MeetingJoin::from_join_url(
            "https://teams.microsoft.com/l/meetup-join/19%3aabc%40thread.tacv2/1719400000000",
        )
        .expect("a join link");
        let payload = join_payload(&local(), &meeting, &callbacks(), None);
        assert_eq!(payload.pointer("/groupChat/messageId").unwrap(), "1719400000000");
    }

    /// The lobby is a state of its own, not a failure and not a connection: the user is
    /// waiting to be let in, and the same call continues when somebody admits them.
    #[test]
    fn the_lobby_is_read_from_either_spelling() {
        assert_eq!(
            lobby_state_in_frame(&json!({ "callState": "ConnectedForRosterOnly" })),
            Some(LobbyState::Waiting)
        );
        assert_eq!(
            lobby_state_in_frame(&json!({ "_decoded": { "rosterUpdate": { "participants": [
                { "id": "8:orgid:me", "state": "Lobby" }
            ] } } })),
            Some(LobbyState::Waiting)
        );
        assert_eq!(
            lobby_state_in_frame(&json!({ "callState": "Connected" })),
            Some(LobbyState::Admitted)
        );
        // A frame that says nothing about it must not be read as either.
        assert_eq!(lobby_state_in_frame(&json!({ "callEnd": { "code": 0 } })), None);
    }

    /// The shape the TENANT sends, measured (NATIVE-CALLING.md § 10.2): the body is the
    /// roster, `participants` is keyed by mri, the name is under `details`, and the state is
    /// `active` / `inactive`.
    ///
    /// This test used to assert an invented shape — an array of people under a
    /// `rosterUpdate` key, each carrying `id` and `displayName` — and it passed for weeks
    /// while `roster_in_frame` returned `None` on every real frame. A fixture nobody
    /// measured is a test of the fixture.
    #[test]
    fn a_roster_frame_is_read_in_the_shape_the_tenant_really_sends() {
        let roster = roster_in_frame(&json!({
            "type": "Delta",
            "sequenceNumber": 26,
            "participantCounts": { "active": 2 },
            "participants": {
                "8:orgid:her": {
                    "details": { "displayName": "Her" },
                    "state": "active",
                    "endpoints": { "guid-1": { "call": { "mediaStreams": [
                        { "type": "audio", "label": "main-audio", "sourceId": 2677,
                          "direction": "sendrecv" }
                    ] } } },
                },
                "8:orgid:him": { "details": { "displayName": "Him" }, "state": "inactive" },
                // A resource that is not a person keeps out of the list.
                "19:meeting_x@thread.v2": { "details": { "displayName": "the meeting" } },
            }
        }))
        .expect("a roster");
        assert!(roster.delta, "the frame said Delta, and that decides whether it merges");
        assert_eq!(roster.members.len(), 2);
        assert_eq!(roster.members[0].display_name, "Her");
        assert!(roster.members[0].present);
        assert!(!roster.members[1].present, "an inactive person has left the meeting");
        // Not a roster frame at all.
        assert_eq!(roster_in_frame(&json!({ "callEnd": {} })), None);
    }

    /// A participant's published streams, in the nesting the tenant really sends: an
    /// `endpoints` OBJECT keyed by endpoint id, and the streams under that endpoint's
    /// `call`. The values are one real frame's, taken while the user shared their screen.
    #[test]
    fn a_roster_carries_the_source_ids_a_subscription_is_addressed_by() {
        let roster = roster_in_frame(&json!({
            "type": "Delta",
            "participants": { "8:orgid:her": {
                "details": { "displayName": "Her" },
                "state": "active",
                "endpoints": {
                    "guid-phone": { "call": { "mediaStreams": [
                        { "type": "audio", "label": "main-audio", "sourceId": 2677,
                          "direction": "sendrecv", "serverMuted": false }
                    ] } },
                    "guid-laptop": { "call": { "mediaStreams": [
                        { "type": "audio", "label": "main-audio", "sourceId": 2462,
                          "direction": "sendrecv", "serverMuted": false },
                        // Their camera is OFF: the section exists and points the other way.
                        { "type": "video", "label": "main-video", "sourceId": 2463,
                          "direction": "recvonly" },
                        // And their screen is on. `type` follows the LABEL here, not the
                        // m-line kind — it is not "video".
                        { "type": "applicationsharing-video",
                          "label": "applicationsharing-video", "sourceId": 2473,
                          "direction": "sendonly", "ordinal": 1 },
                        { "type": "data", "label": "data", "sourceId": 2474,
                          "direction": "sendrecv" },
                    ] } },
                },
            } }
        }))
        .expect("a roster");
        let her = &roster.members[0];
        // Every endpoint's streams, flattened: a subscription names a source id and nothing
        // else, so which endpoint published it is not information this app keeps. The order
        // is by endpoint id (the frame keys them, and a JSON object is read in key order),
        // which is stable frame to frame without being meaningful — hence the sort.
        let mut ids: Vec<i64> = her.streams.iter().map(|s| s.source_id).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![2462, 2463, 2473, 2474, 2677]);
        let sharing: Vec<i64> =
            her.streams.iter().filter(|s| s.is_shared_screen()).map(|s| s.source_id).collect();
        assert_eq!(sharing, vec![2473], "the shared screen is the sendonly sharing label");
        assert!(
            !her.streams.iter().any(RosterStream::is_camera),
            "a camera nobody turned on is recvonly, and must not be offered as a tile"
        );
        // A stream with no source id cannot be asked for, so it is not kept.
        let none = roster_in_frame(&json!({
            "participants": { "8:orgid:him": { "endpoints": { "g": { "call": {
                "mediaStreams": [{ "type": "video", "label": "main-video" }]
            } } } } }
        }))
        .expect("a roster");
        assert!(none.members[0].streams.is_empty());
    }

    /// The renegotiation the service makes ON ITS OWN, which is how a shared screen
    /// arrives (NATIVE-CALLING.md § 10.3a). It is told from an answer by carrying a link to
    /// answer ON, and reading it as an answer is what made a shared screen invisible.
    #[test]
    fn a_media_renegotiation_is_read_as_an_offer_and_never_as_an_answer() {
        let frame = json!({
            "mediaNegotiation": {
                "callModalities": ["audio", "ScreenViewer"],
                "mediaContent": { "blob": "v=0\r\nm=video 3481 RTP/SAVP 107\r\n",
                                  "contentType": SDP_CONTENT_TYPE },
                "links": { "mediaAnswer": "https://x/answer", "rejection": "https://x/no" },
            },
            "debugContent": {},
        });
        let offered = media_renegotiation_from_frame(&frame).expect("a renegotiation");
        assert_eq!(offered.answer_link, "https://x/answer");
        assert_eq!(offered.reject_link.as_deref(), Some("https://x/no"));
        assert!(offered.offer.blob.contains("m=video"));
        assert_eq!(offered.modalities, vec!["audio", "ScreenViewer"]);
        // An ANSWER to something we offered names no link to answer on, so it is not one.
        let answer = json!({
            "mediaAnswer": { "mediaContent": { "blob": "v=0\r\n",
                                               "contentType": SDP_CONTENT_TYPE } }
        });
        assert_eq!(media_renegotiation_from_frame(&answer), None);
        assert!(media_answer_from_frame(&answer).is_some());
    }

    /// Both spellings of a source request. The newer one addresses the section by mid and
    /// carries its parameter as a JSON STRING inside the JSON, which is the service's own
    /// shape (`JSON.stringify` in the client's message generator) and not a mistake here.
    #[test]
    fn a_source_request_is_built_in_both_spellings() {
        let request = SourceRequest {
            mid: "3".into(),
            source_id: 2473,
            stream_msid: "stream-id".into(),
            fmt_params: DEFAULT_VIDEO_FMTP.into(),
        };
        let modern = source_request_payload(&request, 7, true);
        assert_eq!(modern.pointer("/applyChannelParameters/multiChannelParameter/mids"), Some(&json!(["3"])));
        let parameter = modern
            .pointer("/applyChannelParameters/multiChannelParameter/mediaParameter")
            .and_then(Value::as_str)
            .expect("a string, not an object");
        let inner: Value = serde_json::from_str(parameter).expect("valid JSON inside the string");
        assert_eq!(inner.pointer("/controlVideoStreaming/sequenceNumber"), Some(&json!(7)));
        assert_eq!(inner.pointer("/controlVideoStreaming/controlInfo/sourceId"), Some(&json!(2473)));
        assert_eq!(
            inner.pointer("/controlVideoStreaming/controlInfo/streamMsid"),
            Some(&json!("stream-id"))
        );

        let legacy = source_request_payload(&request, 7, false);
        // The older shape's controlInfo is an ARRAY, and it names the control itself.
        assert_eq!(
            legacy.pointer("/controlVideoStreaming/controlInfo/0/control"),
            Some(&json!("start"))
        );
        assert_eq!(
            legacy.pointer("/controlVideoStreaming/controlInfo/0/sourceId"),
            Some(&json!(2473))
        );
        // The fmtp is mandatory: the client's own builder throws without one, so neither
        // spelling may go out empty.
        for payload in [modern.to_string(), legacy.to_string()] {
            assert!(payload.contains("profile-level-id"), "a source request needs an fmtp");
        }
    }

    /// The older spelling still reads, because it costs one pointer lookup and this tenant
    /// is one tenant.
    #[test]
    fn a_wrapped_roster_of_an_array_still_reads() {
        let roster = roster_in_frame(&json!({
            "_decoded": { "rosterUpdate": { "participants": [
                { "id": "8:orgid:her", "displayName": "Her", "state": "Connected" },
                { "id": "8:orgid:him", "displayName": "Him", "state": "Lobby" },
            ] } }
        }))
        .expect("a roster");
        assert!(!roster.delta, "no `type` means the frame is the whole roster");
        assert_eq!(roster.members.len(), 2);
        assert_eq!(roster.members[0].display_name, "Her");
        assert!(!roster.members[0].in_lobby);
        assert!(roster.members[1].in_lobby);
        assert!(roster.members[1].present, "the lobby is not an absence");
    }

    /// A delta is FOLDED in. Every one of these three moves was seen in one 40-second
    /// meeting, and replacing the list on each frame showed it emptying between them.
    #[test]
    fn a_delta_roster_merges_and_a_departure_removes_its_person() {
        let mut held = Vec::new();
        let arrives = |mri: &str, state: &str| RosterUpdate {
            delta: true,
            members: vec![RosterMember {
                mri: mri.to_string(),
                display_name: mri.to_string(),
                in_lobby: false,
                present: state == "active",
                streams: Vec::new(),
            }],
        };
        assert!(apply_roster_update(&mut held, arrives("8:orgid:her", "active")));
        assert!(apply_roster_update(&mut held, arrives("8:orgid:him", "active")));
        assert_eq!(held.len(), 2, "a delta adds to the list rather than replacing it");
        // The same frame twice changes nothing, so no state is emitted for it.
        assert!(!apply_roster_update(&mut held, arrives("8:orgid:him", "active")));
        assert!(apply_roster_update(&mut held, arrives("8:orgid:him", "inactive")));
        assert_eq!(held.len(), 1, "somebody who left is dropped, not kept as a name");
        assert_eq!(held[0].mri, "8:orgid:her");
        // A FULL frame replaces the list, which is the other half of the same function.
        let full = RosterUpdate {
            delta: false,
            members: vec![RosterMember {
                mri: "8:orgid:third".into(),
                display_name: "Third".into(),
                in_lobby: false,
                present: true,
                streams: Vec::new(),
            }],
        };
        assert!(apply_roster_update(&mut held, full));
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].mri, "8:orgid:third");
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
