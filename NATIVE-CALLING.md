# Native calling — audio only, the way the Teams web client does it

Status: **a meeting join WORKS against the tenant, with audible audio both ways**
(verified 2026-08-05: joined, held, voices heard, left cleanly — see § 8). A one-to-one call is built on the same plane and
has never been rung: it has no sanctioned target, so the first one is the user's own click
to somebody who agreed beforehand (§ 7).

`src/calling.rs` signals, `web/src/lib/call-media.ts` carries the audio,
`web/src/lib/ms-sdp.ts` is the one place an SDP is rewritten, and the whole flow is driven
by the mock in `web/e2e/calling.spec.ts`. Against the real tenant there are two drivers and
they answer different halves: `examples/meeting_join_probe.rs` for the POSTs, and
`cd web && bun run join-live` for everything that arrives on the live socket afterwards.

This file stays the protocol map. It records what the real Teams web client does, what
this tenant answers, what the implementation does with it, and what is still unknown.

Every fact below came from two READ-ONLY sources: the web client's own public JavaScript,
and one authz call this app already makes on every start.

## 1. The short answer

An audio call is reachable, and the missing piece is smaller than it looked. The Teams
web client is not a special media citizen: it places a call with **one HTTPS POST** and
carries the media over **a stock browser `RTCPeerConnection`**, with **standard TURN
credentials** (username and password), over **Opus**. The proprietary part is the
signaling envelope, and that envelope is fully readable in the client's own bundle.

The plane teams-lite must add:

| Piece | Where it lives now |
| --- | --- |
| Calling service URL | The authz directory this app already reads — verified below |
| Call setup / accept / hangup | One POST per action, to URLs the service hands back |
| Push of an incoming call | A second trouter connection, registered as the web client |
| Relay (TURN) credentials | One GET, addressed by the service's own answer |
| Audio | The browser: `getUserMedia` + `RTCPeerConnection` |

## 2. What the web client does, step by step

Evidence: the app shell at `https://teams.microsoft.com/v2/` lists its bundles; the
chunk map in `runtime-<hash>.js` names every lazy chunk. The calling stack is
`calling-pluginless-<hash>.js` (~3.0 MB, logger prefix `JS.TsCalling`) under
`https://teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/`.
`calling-pluginless` is the browser stack; `slimcore` is the desktop one and is not
what this app should copy.

### 2.1 A second trouter connection, registered for calling

The calling stack builds its **own** trouter configuration
(`services-io-calling-<hash>.js`, `createTrouterConfig`): its own service URL, its own
registrar URL, and `notificationStack.incomingCalls = {pnhContext, pnhTemplate,
webRegistrarTtlInSeconds}`. From `config-prod-<hash>.js`:

- `pnhTemplate` = `SkypeSpacesWeb_2.6`
- `trouterServiceUrl` = `wss://go.trouter.teams.microsoft.com/v3/c`
- `registrarServiceUrl` = `https://teams.microsoft.com/registrar/prod/v2/registrations`
- `webRegistrarTtlInSeconds` = `3600`

The registration body is the shape this app already posts (`cmd-trouter-<hash>.js`,
`performRegistration`): `{clientDescription:{appId, aesKey:"", languageId, platform,
templateKey, platformUIVersion, productContext}, registrationId, nodeId:"",
transports:{TROUTER:[{context, path, ttl}]}}` — and `path` is the **bare surl** of that
connection. The web client adds **no worker suffix**.

`NGCallManagerWin` is the Windows desktop client: `trouterAuthUrlSuffix` is
`/NGCallManagerWin/auth` only for platforms 51 and 49, `/NGCallManagerOsx/auth` for
platform 50, and `/auth` everywhere else — the web included.

### 2.2 The client publishes its own callback URLs

Every action link the service may later call is a URL the client builds on its trouter
surl (`Et()` in the calling bundle):

    {surl}callAgent/{sessionId}/{correlationId8}{trailingPath}

`trailingPath` is one of a fixed list, and the list IS the protocol surface:

- call: `/call/acceptance/`, `/call/progress/`, `/call/mediaAnswer/`,
  `/call/mediaAcknowledgement/`, `/call/mediaRenegotiation/`, `/call/rejection/`,
  `/call/end/`, `/call/redirection/`, `/call/replacement/`, `/call/transfer/`,
  `/call/newMediaOffer/`, `/call/acknowledgement/`, `/call/holdCompletion/`, …
- conversation: `/conversation/rosterUpdate/`, `/conversation/conversationEnd/`,
  `/conversation/conversationUpdate/`, `/conversation/localParticipantUpdate/`,
  `/conversation/addParticipantSuccess/`, `/conversation/muteUnmuteAsync/`, …

The `LINKS` table names the same actions the other way round — the links the SERVICE
hands the client to post to: `mediaAnswer`, `mediaRejection`, `mediaAcknowledgement`,
`accept`, `reject`, `hangup`, `attach`, `redirect`, `replace`, `transfer`,
`conversationController`, `addParticipant`, `leave`, `keepAlive`, `mute`, `unmute`, …

So the whole call is a pair of link sets. Neither side needs a fixed API surface after
setup: each response names the URLs for the next step.

### 2.3 Placing a call: one POST

`startOrJoinCall` sends **one POST to `conversationServiceUrl`**, and the body is:

```
{ conversationRequest: { conversationType, subject, suppressDialout, applicationType,
                         roster: {type:"Delta", rosterUpdate:<link>},
                         properties: {...},
                         links: { conversationEnd, conversationUpdate,
                                  localParticipantUpdate, addParticipantSuccess,
                                  addParticipantFailure, addModalitySuccess,
                                  addModalityFailure, confirmUnmute, receiveMessage } },
  participants: { from: {id, displayName, endpointId, participantId, languageId},
                  to:   [ {id, displayName?, participantId?} ] },
  groupChat: { threadId, messageId },      // the chat the call belongs to
  endpointCapabilities, endpointMetadata, endpointState, meetingInfo,
  callInvitation: {
    callModalities: ["audio"],
    links: { progress, mediaAnswer, acceptance, redirection, end },
    mediaContent: { blob: "<SDP>", contentType: "application/sdp-ngc-1.0" },
    clientContentForMediaController, ... } }
```

#### There is NO `payload` envelope on the wire, and the bundle reads as if there were

Every builder in the client's own bundle returns `{payload: {…}}` — `HW` for a call, `FW`
for an attach-join, and the acceptance, hangup and mute builders beside them. That
envelope belongs to the SDK's request OBJECT, not to the protocol. Its own transport
strips it:

```js
const P = s?.payload ? JSON.stringify(s.payload) : null   // RequestBuilder
```

So the HTTP body is the CONTENTS of `payload`, which the captured request confirms field
for field. This app copied the envelope in good faith into all eight of its bodies and was
refused `400` with an empty response every time, for days. Nothing about the refusal named
it. `calling::tests::no_body_carries_the_sdk_request_envelope` is the guard.

The same function settles the credentials, in the same few lines: the token-type switch
sets `Authorization` and **deletes** `X-Skypetoken`, or sets the skypetoken and deletes the
authorization. Exactly one credential travels, never both — and `api-version` is not sent
to this service at all. The `MS-Teams-Ring` / `-Region` / `-Partition` trio comes off the
local participant, and `X-Microsoft-Skype-Client` takes the calling format
(`SkypeSpaces/{build}/{platform}/TsCallingVersion=…`), not the Skype-era one the messaging
services want.

### 2.3a Joining a meeting: ONE POST, in either of two shapes

Verified live against a real meeting (2026-08-05, this tenant, this user's own meeting —
`examples/meeting_join_probe.rs`, which leaves again after every accepted join). A join is
the SAME POST as a call, to `conversationServiceUrl`, and it carries:

`conversationRequest` (subject, `roster {type:"Delta", rosterUpdate}`, four `properties`,
six `links`), `groupChat {threadId, messageId:"0"}` — a STRING, not null —
`participants.from` alone, `capabilities:null`, `endpointCapabilities`,
`clientEndpointCapabilities`, `endpointMetadata`, `meetingInfo {tenantId, organizerId}`
with the organizer as a BARE oid, `endpointState`, and `debugContent {causeId}`. There is
no `conversationType` field at all, and no `participants.to` — a join rings nobody.

Then ONE of two things, which is the client's own branch
(`if (subscribe) payload.stream = {} else payload.callInvitation = {…}`):

- **`stream: {}`** — join for the ROSTER alone. This is the pre-join screen, and it is the
  shape the capture was taken in.
- **`callInvitation {callModalities:["audio"], links {progress, mediaAnswer, acceptance,
  redirection, end}, mediaContent}`** — join WITH a microphone. Identical to a call's own
  invitation, minus the people to ring.

The answer is the meeting either way: `conversationController`, `state
{conversationType:"scheduledMeeting", isHostless, isMultiParty, isMeetingActivated}`, and
~37 `links` — `leave`, `mute`, `unmute`, `admit`, `admitAll`, `subscribe`, `sendMessage`,
`addParticipant`, and the rest. **The media answer is NOT in that response**: it arrives on
the `mediaAnswer` callback link, over the calling trouter socket.

**`addModality` is not the second half of a join, and reading it as one cost a round.** It
is how a 1:1 call grows a group modality (`addModalityAsync`, whose body carries no media
at all), so a join posted to it is refused:

```
400 subCode 5021 — "Add modality operation failed as there was no modality blob in the request."
```

That is also the first refusal in this whole feature that named its own cause. The two
before it — a body carrying the SDK's `payload` envelope (§ 2.3), and one carrying two
credentials — answered `400` with `{}` and nothing else. `x-microsoft-skype-proxy-cluster-context`
naming the upstream (`cc/v1/calls`) was the only thing to go on.

**One correction that matters for reading the history of this file:** an earlier round here
recorded that "media in the first POST is refused, measured twice". That measurement was
taken while every request still carried the `payload` envelope, so it measured the envelope
and not the media. A conclusion drawn from a request that was failing for another reason is
worth nothing — check the *baseline* passes before believing a variant's refusal.

### 2.4 Taking a call

The incoming notification arrives as a trouter push whose body carries `gp` (base64
JSON) or `cp` (compressed), and inside is `{callNotification: …}`. The client reads
`from.id`, `to.participantId`, `callType`, `mediaContent`, `links` (including
`links.attach`), `transferor`, `onBehalfOf`, `fromMixer`, `customContext`,
`routingTimeout`. It answers by POSTing to the links the notification carried:
`accept`, then `mediaAnswer` with its own SDP, then `mediaAcknowledgement`.

`src/trouter_events.rs` already decodes that outer envelope and expands `cp` / `gp`,
which is the half this app got right from prior art.

### 2.5 The media is ordinary WebRTC

- The SDP is produced by a real `RTCPeerConnection` (`createOffer` /
  `createAnswer` / `setRemoteDescription`), then rewritten with `sdp-transform` for a
  handful of Microsoft details (simulcast envelope, `red` payload, header-extension
  clashes). The result is shipped as `mediaContent = {blob, contentType}`.
- `contentType` is `application/sdp-ngc-1.0`, and `0.5` is still accepted. **It is a
  label on a WebRTC SDP, not a different language** — the earlier fear of an "NGC to
  WebRTC translator" does not apply to the browser stack.
- **But the rewrite is not optional, and one line of it is mandatory.** Verified live: an
  offer that keeps a browser's own transport profile joins the meeting, negotiates nothing,
  and is ended a second later with `conversationEnd 410, InternalDiagCode:
  UnrecognizedTransportProfile`. The client's own `toMsSdp` sets EVERY media line's
  protocol to `RTP/SAVP` (`PROFILES.rtpSavp`), and its `fromMsSdp` restores
  `UDP/TLS/RTP/SAVPF` on the way back when the section carries a fingerprint — so both
  directions are needed, or `setRemoteDescription` refuses the answer and the call is
  silent with every signaling step looking fine. `web/src/lib/ms-sdp.ts` is that pair.
  What `toMsSdp` ALSO does, and this app does not: `a=label:main-audio` per section (this
  app sends it, it is one token), `x-ssrc-range` in place of `a=ssrc`, the session
  fingerprint copied onto each section, `a=rtcp:<port>` on an offer, `|2^31` appended to an
  SDES key, and MS-encoded URIs for `abs-send-time` and `transport-cc`. None of the rest is
  implemented, because the service has not refused what it would replace — and it explains
  itself when it does.

#### The real client's audio section, on the wire

Captured 2026-08-05 from Teams web itself, joining this tenant's own authorized meeting
(anonymous guest, which reaches the same calling stack). This is the `mediaContent.blob`
the service accepts, beside what Chrome had produced for the same call — so the whole
outbound transform is a diff rather than a reading of minified code. Keys elided.

```
v=0
o=- 3612792551793344528 2 IN IP4 127.0.0.1
s=-
b=CT:4000                                     <- ADDED
t=0 0
a=extmap-allow-mixed
a=msid-semantic: WMS *                        <- Chrome wrote `a=msid-semantic:  WMS` (no token)
a=group:BUNDLE 0 1 2 3 4 5 6 7 8 9 10 11 12
m=audio 1234 RTP/SAVP 105 111 97 9 0 8 13 110 126
      ^^^^ ^^^^^^^^ Chrome wrote `m=audio 9 UDP/TLS/RTP/SAVPF …`
c=IN IP4 10.10.10.10                          <- Chrome wrote `c=IN IP4 0.0.0.0`
a=x-signaling-fb:* x-message app recv:dsh     <- ADDED
a=x-ssrc-range:4195875351-4195875351          <- ADDED (the `a=ssrc:` line stays too)
a=rtpmap:105 CN/48000
a=rtpmap:111 opus/48000/2
a=rtpmap:97 RED/8000                          <- Chrome wrote `red/48000/2`
a=rtpmap:9 G722/8000 … 0 PCMU … 8 PCMA … 13 CN/8000 … 110/126 telephone-event
a=fmtp:111 minptime=10;useinbandfec=1
a=fmtp:97 111/111
a=rtcp:1234                                   <- Chrome wrote `a=rtcp:9 IN IP4 0.0.0.0`
a=rtcp-fb:105 rrtr                            <- ADDED (Chrome had no `rrtr` for 105)
a=rtcp-fb:111|97|9|0|8|13|110|126 rrtr
a=rtcp-fb:111 transport-cc
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http:\\www.webrtc.org\experiments\rtp-hdrext\abs-send-time
a=extmap:3 http:\\www.ietf.org\id\draft-holmer-rmcat-transport-wide-cc-extensions-01
      ^^ BACKSLASHES: the MS-encoded spelling of those two URIs
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid
a=setup:actpass
a=mid:0
a=recvonly
a=ice-ufrag:… / a=ice-pwd:… / a=fingerprint:sha-256 …    <- Chrome's own, untouched
a=candidate:1755259772 1 UDP 2122197247 10.10.10.10 1234 typ host
                            ^^^ uppercase; Chrome writes `udp`
a=ice-options:trickle
a=ssrc:4195875351 cname:…
a=rtcp-mux
a=label:main-audio                            <- ADDED
```

Two things this settles beyond the profile. **The m-line port and the `c=` line carry the
first host candidate's address and port** rather than the placeholder `9` / `0.0.0.0` a
bundled offer uses — so a service that cannot read candidates still has somewhere to send.
And **the answer comes back in the service's spelling**: the same capture shows Chrome
being handed `m=audio 3478 UDP/TLS/RTP/SAVPF …`, which is the client's inbound transform
having already run. Both are why `ms-sdp.ts` has two directions.

`examples/` cannot reproduce this: the capture needs a real browser inside the real client.
It was taken through the browser MCP tools against `teams.microsoft.com` — which is not one
of this app's own fronts, so `guard-prod-chat-target.sh` permits it — with the user's
explicit authorization for that one meeting, and it stayed in the lobby and left.
- Keying is **DTLS-SRTP** (`a=fingerprint`, `a=setup:actpass`, `RTP/SAVPF`). SDES is
  touched only when a legacy remote offers `a=crypto`, and then the client strips its
  own fingerprint — a compatibility path, not the normal one.
- Audio codecs: `audio/opus` 48 kHz stereo first, then `G722`, `PCMU`, `PCMA`, `CN`,
  `telephone-event`. Chrome speaks all of them.
- ICE servers are built from the service's own relay description into plain
  `turn:{host}:{port}?transport=udp`, `turn:…?transport=tcp`, `turns:{fqdn}:{tlsPort}`
  entries with `username` and `credential`. **A stock browser can use them.** The
  legacy `msturn` relay is a separate list, offered only to a Lync remote.

### 2.6 Where the relay credentials come from

The service hands the client a relay configuration in its account configuration
(`relayConfig`, with `Relay.Turn`, `Relay.Skype`, `Service.tokenUrl`, `Token`). The
client then does one GET on `Service.tokenUrl` with `X-Skypetoken` and
`api-version: 2`, and gets `{tokens:[{realm, username, password}], expires}` — the TURN
long-term credentials, refreshed before expiry. So the TRAP URL is never hard-coded:
the service names it.

## 3. What this tenant answers (verified, read-only)

`examples/calling_endpoint_recon.rs` prints the authz directory this app already
fetches for `chatService`. Run on 2026-08-04, region `fr`, 110 keys, calling plane
present in full:

    calling_conversationServiceUrl = https://api-emea.flightproxy.teams.microsoft.com/api/v2/epconv
    calling_trouterUrl            = https://go-eu.trouter.teams.microsoft.com/v3/c
    calling_registrarUrl          = https://teams.microsoft.com/registrar/prod/V2/registrations
    calling_udpTransportUrl       = udp://api-emea.flightproxy.teams.microsoft.com:3478
    calling_callControllerServiceUrl = https://emea.cc.skype.com
    calling_callStoreUrl          = https://api-emea.flightproxy.teams.microsoft.com/api/v2/ep/api.userstore.skype.com/
    calling_keyDistributionUrl    = https://api-emea.flightproxy.teams.microsoft.com/kd
    calling_uploadLogRequestUrl   = https://api-emea.flightproxy.teams.microsoft.com/api/v2/ep/emea.cc.skype.com/cc/v1/uploadlog/

**This closes the largest open risk.** The note this work carried said the outbound
create-call endpoint appears in no public prior art and had to be learned from live
traffic. It does not: the web client reads it from
`serviceUrls.calling_conversationServiceUrl`, and the directory this app already parses
carries it. `calling_registrarUrl` is the registrar teams-lite already posts to.

## 4. What teams-lite holds now

The plane this app already had, and still uses:

- The two tokens: the `ic3.teams.office.com` bearer and the skypetoken
  (`src/auth.rs`, `src/teams.rs`).
- The directory, including every key in § 3 (`Session::endpoint`).
- The messaging trouter connection, and the registrar call (`src/trouter.rs`).
- The push decoder for the calling envelope, `cp` / `gp` included
  (`src/trouter_events.rs`).

What was added, and the three corrections it carries:

1. **`src/calling.rs`** — the signaling plane: the endpoints, the callback-link builder,
   the payloads of § 2.3 and § 2.4, the frame readers (invite, acceptance, media answer,
   ending), and the relay credentials of § 2.6. It holds no state and starts nothing.
2. **A calling trouter connection of its own** (`trouter::Endpoint::calling` +
   `trouter::Role::Calling`), registered the way the WEB client registers:
   `SkypeSpacesWeb_2.6`, TTL 3600, path = the bare surl. The desktop client's
   `NGCallManagerWin` / `DesktopNgc_2.3` pair that an earlier capture branch sent is gone,
   and a test scans the module so it cannot come back.
3. **`is_calling_url` matches `callAgent`** — the path segment every link a call publishes
   is built under — as well as the two old worker suffixes, so a calling frame that lands
   on the MESSAGING socket is still read as one. On the calling connection nothing is
   filtered by URL at all: everything there is calling traffic.
4. **The `/v3/c` question is answered by `allocate_url_for`**, which keeps the directory's
   regional host and speaks the `/v4/a` allocate flow this client already had. That
   mapping is the one piece of § 2.1 a live call still has to confirm (§ 8).

The backend owns the live call (`CallSession` in `src/bin/server.rs`), which is what keeps
"who may place a call" one decision in one place, and it is the only holder of the links.

## 5. How it is built here

**The backend signals; the browser carries the audio.** Nothing else fits this app:

- The tokens live in the backend and must stay there. A browser holding a calling token
  could place a call around every gate.
- Media cannot live in the backend: the audio has to reach the user's microphone and
  speakers, and `RTCPeerConnection` is in the page.
- So the SDP crosses the local WebSocket — an offer out, an answer in — exactly like
  every other RPC. The browser never learns a Teams URL, and the backend never handles
  RTP.

That is exactly how it is split: `src/calling.rs` (the POSTs, the links, the relay
credentials), the calling half of `src/trouter.rs`, seven RPCs (§ 6), and one browser
media controller (`web/src/lib/call-media.ts`) that is the only place in the app touching
WebRTC or the microphone.

## 6. The surface, and what each part is for

Six RPCs, and the split between them IS the consent design (see § 7). There is no RPC
that turns calling on: the backend registers as a device the user's calls ring on at
startup, the way every Teams client they are signed in on does (`calling_available` in
`src/bin/server.rs`), so no client can ask for the registration and none can take it
away. A read-only backend is the only one that never registers.

| Method | Gate | What it does |
| --- | --- | --- |
| `call_status` | open | The state the UI draws. No SDP, no links, no credentials. |
| `call_prepare` | `MACHINE_METHODS` | Reserves the one call, and returns the ICE servers (plus the offer, when answering). |
| `call_place` | `OUTWARD_METHODS` | The § 2.3 POST, carrying our offer. Rings a person. |
| `call_join` | `OUTWARD_METHODS` | The same POST for a MEETING: no `to`, plus `meetingInfo`. Rings nobody. |
| `call_accept` | `OUTWARD_METHODS` | Answers with our SDP. Opens the microphone to them. |
| `call_hangup` | `OUTWARD_METHODS` | Ends the call, or declines it while it is still ringing. |
| `call_mute` | `OUTWARD_METHODS` | Publishes whether the user can be heard. |

Two events carry the rest: `call_state` (the whole state, every time — so a page that
reconnects mid-call learns what a live one knows, and so ONE frame releases the
microphone) and `call_media` (the far side's SDP, the only frame whose body a client is
given). `call_signal` still forwards every raw calling frame for capture.

Two things the backend does on its own, and neither is a decision about a call:

- **A keep-alive every 20 s** while a call is connected, on the `keepAlive` link the
  service gave us (`CALL_KEEPALIVE`). The interval the service asks for
  (`callKeepAliveInterval`) has not been seen on this tenant, so this is shorter than any
  plausible server timeout: too often costs one request, too late drops the call.
- **`ready` needs the registration AND a live socket.** They are tracked apart because a
  reconnect has to tell a surl that came back UNCHANGED from one that MOVED — a moved surl
  invalidates a live call's links, and only that ends the call.

The browser half is two files: `web/src/lib/call.ts` (pure state model) and
`call-media.ts` (the microphone, one `RTCPeerConnection`, the remote audio element). The UI
is `call-bar.tsx` (a RINGING call, and the notice a call leaves behind), `call-stage.tsx`
(the PAGE a live call takes over, and the window it folds into, over `lib/call-stage.ts`),
`call-video.tsx` (one picture) and `call-button.tsx` (a 1:1 header).

A meeting is joined rather than placed, and it is the same plane. The join link comes in
two shapes and `calling::MeetingJoin` reads both: the long
`…/l/meetup-join/{thread}/{message}?context={Tid,Oid}` (thread → `groupChat`, context →
`meetingInfo`) and the short `…/meet/{code}?p={passcode}` (→ `meetingData
{meetingCode, passcode, meetingUrl}`, with no thread — the service resolves it). This
tenant's meetings use the short one. `conversationType` is **null** for a join and for an
ordinary call; the client names one only for an emergency call, a cast, a huddle or a
consult-and-add, and an invented value is a `400 {}`. The lobby is a state of its own, and
the roster arrives as `rosterUpdate` frames. The one media difference is that a meeting sends several voices as
several streams, so the page keeps one audio element per stream.

**Video is received AND sent** (§ 10, and § Video in a meeting in AGENTS.md). Four RPCs carry
it: `call_answer_media` answers the renegotiation the service makes on its own,
`call_subscribe` asks for one person's stream, `call_offer_media` offers the user's own camera
or screen, and `call_state.publishing` carries the source ids that make a subscription
addressable.

What is deliberately NOT built: a group call the user assembles themselves, transfer, hold,
DTMF, admitting somebody from a lobby, and any call this app places without a click. Each is a
product decision with its own surface.

## 7. Consent — a call is at least as outward as a send

A ring reaches a person, on every device they own, and interrupts them. So the rules
that hold `send` hold here, and one is stricter:

- **Placing a call needs the user's explicit consent for that call**, per call. There is
  no standing licence, and a call is never placed by anything automatic.
- **`call` / `answer` / `hangup` are `OUTWARD_METHODS` entries**: the write token,
  refused on a read-only backend, and named in the automation hook.
- **Registering the calling endpoint changes where Teams routes the user's real calls**,
  and the app does it at startup, because that is what a Teams client is: their calls are
  offered here as well as on their other clients. It reaches nobody by itself — every
  action that does is gated one by one above — and it is taken back as the app shuts down.
  A read-only backend is the only one that never registers; a second install on the same
  machine DOES, as a device of its own, so every window the user opens can call.
- **The live target is the sandbox chat and its one consenting counterpart**, exactly as
  § Sending messages says. A test call goes there and nowhere else.
- Answering a call the user was already being offered is the one action that starts
  from their own click and nothing else — but it publishes their microphone, so it is
  never automatic either.

## 8. What the tenant has now answered, and what is still open

**A meeting join works end to end, verified 2026-08-05.** One join, held 42 seconds,
audio negotiated, left cleanly and the service confirmed with its own `callEnd`:

```
joined the meeting: audio=false lobby=false links=37
frame …/call/acceptance/          <- accepted, and acknowledged within the second
frame …/conversation/rosterUpdate/
connected — In the meeting · 0:42
the call is over: CallEndReasonHangup
frame …/call/end/                 <- the service agreeing, not a timeout
```

Five faults stood between the first attempt and that, and every one of them was named by
the thing that refused it rather than guessed:

1. the SDK's `payload` envelope, which the client's transport strips (§ 2.3);
2. two credentials where the client sends one, plus the three routing headers;
3. `addModality`, which is not the second half of a join (§ 2.3a);
4. the SDP: the transport profile, then the folded ICE-TCP transports, then the
   backslash-encoded header-extension URIs (§ 2.5) — each one refused the whole
   description, and each refusal named itself;
5. the leave body, which is not a `callEnd`.

`cd web && bun run join-live` is what closes that loop without the user: it drives the
live app against the one authorized meeting, reports what the app says about the call and
the page's own console, and hangs up on every path out. Everything BEFORE the browser is
still `examples/meeting_join_probe.rs`; everything after it needs that script.

**And the media really flows.** `bun run join-live` reports the peer connection's own
`getStats()`, because a "connected" phase only means the answer was applied — DTLS can
still fail and ICE can still find no path, and the page would look identical:

```
media: connected/connected via prflx/udp -> relay/udp
sent 63177B in 1025 packets, received 0B in 0
```

1025 RTP packets accepted by Teams' own relay over UDP. `received 0` is the correct
answer for an empty meeting — nobody is talking — and a fake capture device sends silence,
so those numbers stop one step short of "somebody heard it".

**That last step is confirmed too: the user joined a real meeting from this app and the
voices worked, in both directions (2026-08-05).** It could not be checked any other way —
a driver with a fake microphone can prove the path carries packets and nothing more. So
the feature is done rather than merely negotiated.

`activeModalities.call` being null in the join RESPONSE turned out to be nothing: the leg
is created after the answer, and the `conversationUpdate` frames a second later carry it as
an object (measured). The backend's journal line says `audio_leg_in_answer=` for that
reason — it is a record of the answer, not a verdict on the media.

### Still open

A ONE-TO-ONE call has never been rung. It shares the whole media path with the join — so
the five fixes above cover it — but it has its own POST, its own acceptance, and no
sanctioned target: ringing anybody is the user's own click, to somebody who agreed
beforehand (§ 7). `invitation_payload` now carries every field the join is known to be
accepted with (the capability masks, `endpointState`, `endpointMetadata`, `debugContent`),
because it goes to the same endpoint and that endpoint refuses what it does not recognise
without naming it. That is the difference between one debugging round and five.

The rest of this section is unchanged, and is what a 1:1 answers:

- **`/v3/c` against the `/v4/a` allocate flow.** `trouter::allocate_url_for` keeps the
  directory's regional host and speaks the allocate protocol this client already had. If
  the calling trouter refuses it, the journal says so in one line
  (`[calling] disconnected`), and the fix is that function alone.
- **The path the initial invite is pushed to**, and the field names the notification
  really carries on this tenant. `calling::incoming_call_from_frame` reads several
  spellings and every `links` object at any depth for exactly this reason, and
  `call_signal` still forwards the raw frame so one real ring corrects the shape.
- **Which token the conversation service wants.** Both travel on every request, and its
  `www-authenticate` answer is what a 401 would tell us.
- **`applicationType` / `endpointCapabilities`** — the values the service accepts from a
  client that is not the real one. Nothing sends them yet; a rejection would name them.
- **Whether a 1:1 call connects peer to peer or through a media server.** It changes
  latency, not the code: ICE decides, and the STUN server from `calling_udpTransportUrl`
  is what lets the browser offer a reachable candidate at all. A relayed path additionally
  needs the TURN credentials, and those only arrive if the service sends a `relayConfig`
  (`calling::relay_config_in_frame`) — if it never does, that is the next thing to find.
- **What the create-call POST returns.** `PlacedCall` keeps the whole response, and the
  links are collected from it wherever they sit.
- **Whether a short-link join needs anything more than `meetingData`.** The first live
  attempt was refused for an unrelated reason (an invented `conversationType`); the retry
  is what says whether the code and the passcode are enough. A refusal now names its own
  cause, because the error carries the service's headers and the request body is logged
  under `TEAMS_LITE_CALL_DEBUG=1`.

## 9. Reproducing this recon

The tenant half, read-only, one authz call:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example calling_endpoint_recon

The client half needs no account at all — the bundles are public:

    UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
    Chrome/150.0.0.0 Safari/537.36'
    curl -sL -H "User-Agent: $UA" https://teams.microsoft.com/v2/ -o shell.html
    # A request with curl's own agent is answered by the "Unsupported Browser" page
    # instead, which names no bundle at all — that is what a browser UA buys here.
    #
    # The shell lists the assets; runtime-<hash>.js holds the chunk map, in two halves:
    # `<id>:"<name>"` for every lazy chunk, and `<id>:"<hash>"` beside it. So the
    # calling stack is found by name rather than guessed:
    #   grep -o '[0-9]*:"calling-pluginless"' runtime-<hash>.js   -> the id
    #   grep -o '<id>:"[a-z0-9]*"'            runtime-<hash>.js   -> the hash
    # then calling-pluginless-<hash>.js (~3 MB) under
    # https://teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/

Hashes move with every Teams release, so read the shell for the current ones rather
than pinning the names in this file.

And the surface itself, with no tenant, no registration and no microphone:

    cd web && bun run preview -- --out /tmp/call --call     # the button, the ring, the page
    cd web && bun run test                                  # the state model
    cd web && bun run test:e2e -- calling.spec.ts           # the whole flow, through the mock
    cargo test                                              # the payloads, the frames, the gates

## 10. Video and screen sharing — the protocol, read but not implemented

Read 2026-08-05 out of `calling-pluginless-779e39a54b8bcd49.js` by the § 9 recipe, and then
MEASURED against the tenant the same day — four joins of one authorized meeting, with the
user sharing their screen for the last one (§ 10.7). Nothing here is implemented. Every
claim says which of the two it came from, because the two disagreed on the one thing that
mattered most: **the roster's shape is not what the client's own bundle reads**, and the
first draft of this section had it wrong (§ 10.2).

**The headline is that the media plane does not change.** Video and a shared screen are
ordinary WebRTC `m=video` sections on the SAME `RTCPeerConnection` this app already opens,
carrying H.264 that Chrome already encodes. What is new is not media — it is a
**subscription plane**: in a meeting the service does not simply send every camera, it
sends what the client ASKS for, one request per stream. That plane is the whole of the
work, and it does not exist here at all.

### 10.1 Four modalities, and the words for them

`I.MEDIA_TYPES` — the values that go in `callModalities` — is
`{AUDIO:"Audio", VIDEO:"Video", SCREEN_SHARER:"ScreenSharer", SCREEN_VIEWER:"ScreenViewer"}`.
Note the capitals, and note that SHARING IS TWO MODALITIES: sending a screen and watching
one are asked for separately. This app sends `"audio"` lowercase and the join was accepted,
which the bundle explains — its own comparison (`qm`) lowercases both sides — but the
canonical spelling is the one above, and `calling::MODALITY_AUDIO` should be read as one
member of a set rather than as the only string that exists.

Three more name tables come with it, and they are separate from the modality list on
purpose:

    MEDIA_LABEL: {audio:"main-audio", video:"main-video",
                  sharing:"applicationsharing-video", data:"data"}
    MEDIA_TYPE:  {audio:"audio", video:"video", sharing:"sharing",
                  data:"x-data", dataChannel:"application"}
    MODALITY:    {audio:"audio", video:"video", sharing:"sharing", data:"data"}

**`MEDIA_LABEL` is the one that reaches the wire, and it is why `ms-sdp.ts` is wrong for
sharing today.** An `a=label:` is per media SECTION, and a shared screen is an `m=video`
section — so `MEDIA_LABELS` in `web/src/lib/ms-sdp.ts`, which derives the label from the
m-line's KIND, would label a share `main-video`. The label is how the service tells a
camera from a screen (`N2` in the bundle is exactly
`direction === "sendonly" && label === "applicationsharing-video"`), so that mapping has to
become per-section state rather than a lookup on `m=`. It is a two-line change and it is the
one place the existing SDP transform is not merely incomplete but incorrect for video.

### 10.2 Receiving: a source request per stream, and the MSI comes from the roster

This is the mechanism that has no counterpart in the audio build, and it is the reason
"see others' cameras" is not just one more m-line.

Every publishing endpoint in the roster carries its own stream ids. **MEASURED** — this is
the frame as it really arrives on this tenant, and `endpoints.endpointDetails[]` (which the
first draft of this section repeated from the bundle) is the client's own NORMALIZED form,
not the wire:

```
// the frame BODY *is* the roster — there is no `rosterUpdate` key wrapping it,
// the url it was posted to is what names it
{ type: "Delta", sequenceNumber: 26, participantCounts: {…},
  participants: {                                  // an OBJECT keyed by mri, not an array
    "8:orgid:<oid>": {
      details: { displayName, … },                 // the NAME lives here, not at the top
      state: "active",                             // or "inactive" — not "Connected"
      role, meetingRole, meetingRoles: […], version, enforceConsentToJoin,
      endpoints: {                                 // an OBJECT keyed by endpoint id
        "<guid>": {
          participantId, clientVersion, languageId, modalityJoined, endpointJoinTime,
          endpointCapabilities, clientEndpointCapabilities,
          endpointMetadata: { holographicCapabilities },
          endpointState: { endpointStateSequenceNumber, state: { isMuted } },
          callLinks: { replacement },
          call: {                                  // and the streams are under `call`
            serverMuteVersion, negotiationTag, appliedInteractivityLevel,
            mediaStreams: [ { type, label, sourceId, direction,
                              serverMuted, subTypes: [], notInDefaultRoutingGroup,
                              mdRequestId?, ordinal? } ] } } } } } }
```

Four things about `mediaStreams`, each of them measured on the run where the user shared
their screen:

- **`sourceId` is the MSI** — the number a subscription is addressed by. Real values from
  one meeting: `2677`, `2260`, `2462` (three audio endpoints of one person), `2463`
  (`main-video`), `2473` (`applicationsharing-video`), `2474` (`data`). They are small
  integers, per meeting, and they MOVE between joins — so an MSI is never cached across
  calls.
- **`label` is the wire name and `type` follows it, not the m-line kind.** A shared screen
  is `{type: "applicationsharing-video", label: "applicationsharing-video"}` — `type` is NOT
  `"video"`. A camera is `{type: "video", label: "main-video"}`. So `Ff` in the bundle,
  which maps the label to 0/1/2/3, is the right reading and the one to port.
- **`direction` is that ENDPOINT's own direction**, which is what says who is doing what:
  the sharer's section was `sendonly`, and the same person's `main-video` was `recvonly`
  because their camera was off. So "somebody is sharing" is exactly the bundle's own test —
  `direction === "sendonly" && label === "applicationsharing-video"` — read off the roster
  rather than out of a `contentSharing` field. **No participant carried a `contentSharing`
  object at all**, sharing or not, so § 10.4's mention of one is the client's shape and not
  this tenant's.
- **`type: "Delta"` means it IS a delta.** Measured: consecutive frames carried one
  participant, then two, then one — never the whole meeting. So the list must be MERGED by
  mri and a participant whose `state` turns `"inactive"` dropped. Replacing it wholesale, as
  this app does today, makes the roster flicker between one person and another.

**`calling::roster_in_frame` reads none of this and returns `None` on every real frame.** It
looks for `/rosterUpdate/participants` as an ARRAY, and its test invented that shape — so a
joined meeting has never named anybody, and the app has always said "In the meeting" where
it should say who is in it. That is a shipped bug this recon found, it is fixed separately
from any video work, and it is also step one of every feature below: the MSI has nowhere
else to come from.

To see that stream, the client picks one of ITS OWN receive video sections and asks the
service to put that source on it. Two spellings, and the client sends both because the
newer one is behind a config flag (`useApplyChannelParametersForSourceRequests`, true in
this build):

    // POST to the `applyChannelParameters` link
    { applyChannelParameters: { multiChannelParameter: {
        mids: ["<our recv section's mid>"],
        mediaParameter: JSON.stringify({ controlVideoStreaming: {
          sequenceNumber: <increasing>,
          controlInfo: { sourceId: <their MSI>, streamMsid: "<our recv stream id>",
                         fmtParams: "<an H.264 fmtp>", subStreamIndex: <n|undefined> } } }) } } }

    // POST to the `controlVideoStreaming` link — the older shape, an ARRAY of controls
    { controlVideoStreaming: { sequenceNumber: <increasing>,
        globalTimeStamp: "<Date.toString()>",
        controlInfo: [ { control: "start", sourceId: <their MSI>,
                         streamMsid: "<our recv stream id>", fmtParams: "<fmtp>" } ] } }

**Both links exist on this tenant, and neither is in the join answer.** MEASURED: the join
answer names 41 links and not one of them is either — they arrive on the `callAcceptance`
FRAME, which is exactly what `saveMediaControllerLinksIfAny` in the bundle reads
(`links.controlVideoStreaming`, `links.applyChannelParameters`). The acceptance carries
thirteen links of its own:

    acknowledgement  applyChannelParameters  callControllerHttpTransport  callLeg
    controlVideoStreaming  hold  mediaRenegotiation  monitor  replacement
    startOutgoingNegotiation  transfer  updateCallState  updateMediaDescriptions

So a link set is not one answer's property: it is accumulated from every frame, which is
what `Links::merge` already does — the backend keeps them, and nothing has ever used these
two. A reader who checks only the join response concludes video is unreachable here, which
is what the first version of this section did.

Three constants make the plane usable:

- `MSI: {unsubscribe: -1, subscribeAny: -2}`. So `-2` says "give me whoever is worth
  showing" — the service picks, which is how a gallery works without the client tracking
  who is talking — and `-1` releases the section.
- `streamMsid` is OUR OWN receive stream's id, not theirs: `requestSource` passes
  `this.mediaStream.id`, the id of the `MediaStream` the `track` event handed the page. So
  it is knowable only after the answer is applied, which puts the whole subscription plane
  strictly AFTER `setRemoteDescription` — never in the offer.
- `fmtParams` is an H.264 fmtp line and is MANDATORY (`getSourceRequestMessage` throws
  without it). Its shape, from the client's own capability probe:
  `max-fs=240;max-mbps=3600;max-br=208;max-fps=1500;profile-level-id=42C02A;packetization-mode=1`
  — which is how a client asks for a small tile rather than a full-resolution stream.
  `multiviewResolutionLimits {1:1080, 2:720, 3:540, 4:360, more:360}` is the client's own
  table for that: the more tiles, the lower each one is asked for.

There is a SECOND transport for the same messages — a media control plane over an SCTP data
channel (`mediaControlPlaneConfig`, `sctpPort: 5000`, `{type:"sr", controlVideoStreaming:…}`)
— with the HTTP link as the fallback (`signalingDeprecation.disableFallbackToSignaling` is
false in this build). **Take the HTTP path.** It reuses `post_signal` and the links this app
already collects; the data channel would be a new transport, a new m-line and a handshake,
for a latency gain nobody in this app can perceive.

### 10.3 Sending: reinviteless, or a renegotiation

Two ways to turn a camera on, and the client does both depending on what the service allows.

**Reinviteless** is the one to want. `IS_REINVITELESS: "IsReinviteless"` is an endpoint
property, and `maxReinvitelessMediaForVideoForWeb` / `maxReinvitelessMediaForVBSSForWeb` cap
how many sections it applies to. The shape is: create every transceiver up front —
`createTransceiver` uses `{direction: "inactive"}` — negotiate them all in the FIRST offer,
and then turning the camera on is `replaceTrack` plus a direction change with no new SDP at
all (`removeSender` does `replaceTrack(null)` when the entity carries the `reinviteless`
extension, and `peerConnection.removeTrack` when it does not). It also explains the capture
in § 2.5: `a=group:BUNDLE 0 1 2 3 4 5 6 7 8 9 10 11 12` on an AUDIO-ONLY join is thirteen
sections, of which twelve carry no audio.

**A renegotiation** is the other way, and it is what screen sharing uses even in the
reinviteless build: `mediaNegotiation` (`{callModalities, sender, mediaContent, links}`)
POSTed to the `mediaRenegotiation` link, refused outright unless the call is established —
`"media renegotiation can only be performed on an established call"` — with
`ScreenSharer` in the modality list. The inbound direction is `newOffer` / `/call/newMediaOffer/`.

Chrome's own rules push the same way: changing `transceiver.direction` raises
`negotiationneeded`, so a build that pre-negotiates every section and only ever swaps tracks
avoids the whole glare problem (`RENEGOTIATION_ERROR: {local, localFatal, glare, signaling,
signalingFatal, media, escalation}` is the client's list of ways that goes wrong).

### 10.3a The service RENEGOTIATES on its own, and that is the way in

**This is the measurement that replaced the experiment**, and it makes receiving far cheaper
than § 10.5 first ordered it. This app joins with ONE audio section and answers nothing
afterwards — and the service still POSTs a `mediaRenegotiation` to us, unprompted, ~9 s in.
Its offer grows as the meeting does. Audio only, nobody sharing:

    audio port=3478 RTP/SAVP label:main-audio       mid:0
    x-data port=3480 RTP/SAVP label:data            mid:4 x-ssrc-range:9313-9412

and the same meeting one second after the user shared their screen:

    audio port=3478 RTP/SAVP label:main-audio            mid:0
    video  port=3481 RTP/SAVP label:applicationsharing-video mid:3 sendonly x-ssrc-range:8313-8412
    x-data port=3480 RTP/SAVP label:data                 mid:4 x-ssrc-range:9313-9412

Five things follow, and all five are measured rather than reasoned:

- **We never have to ask.** The section for a shared screen is OFFERED to us, labelled, at a
  fixed mid, with its SSRC range declared. There is no first-offer experiment to run and no
  guess about whether an inactive video section is accepted: the service adds the section
  when there is something to put on it.
- **But it is not unconditional, and an earlier draft of this section said it was.** Measured
  on five joins: four received a renegotiation ~9 s in, and every one of those had a SECOND
  endpoint in the meeting. The fifth joined a meeting that was empty apart from us and got
  none at all in 30 s. So the trigger is the meeting having something to offer, not the join —
  and a receive path that waited for one in an empty meeting would wait for ever, correctly.
  Nothing in this app depends on the difference (it answers what arrives and does nothing
  otherwise), but a test that joins alone and expects an offer would be testing a state the
  service does not produce.
- **The mids are a fixed layout**, and the gaps say what is missing: `0` audio, `3`
  application sharing, `4` data — so `1` and `2` are the `main-video` slots, which appear
  when a camera does. `maxReinvitelessMediaForVideoForWeb` is the cap on that count.
- **`sendonly` is from the SERVICE's side**: it sends, we receive. An answer to it is
  `recvonly`.
- **The frame carries its own two links and only those two — `mediaAnswer` and `rejection`.**
  So answering is one POST to a link that arrives with the offer, and refusing is the other.
  This app posts neither, which is why a shared screen is invisible here even though the
  section for it is being offered every time.
- **It is an `x-data` section, not `application`.** The media control plane's own transport
  is on offer too (§ 10.2), at mid 4, with an SSRC range — so the data-channel path is
  reachable on this tenant if the HTTP one ever disappoints.

The honest reading of this is that **receiving a screen is a renegotiation this app already
receives and drops**, plus one source request. That is a much smaller first step than
"implement video".

Two mercies in the config, both worth relying on:

- **Simulcast is off.** `specCompliantSimulcastMultiparty` has `enableLocally: false` for
  both `video` and `sharing`, so the simulcast envelope (`sendEncodings`, rids, `~` prefixes,
  `a=simulcast`) can be skipped entirely. It is the largest single piece of SDP surgery in
  the client and none of it is needed.
- **H.264 is the codec.** `requiredVideoCodecs: ["h264"]`, `primaryVideoCodecs:
  ["h264","vp8","vp9"]`. Chrome offers H.264 by default, so no codec munging is needed
  either.

### 10.4 A shared screen is a session, not a track

Sending a screen is not just a modality: `contentSharing` is its own object with its own
finite state machine and its own six links —
`contentSharingController`, `contentSharingTakeControl`, `contentSharingUpdateSessionState`,
`contentSharingUpdateParticipantState`, `contentSharingNotificationLinks`,
`contentSharingLeave` — plus two conversation callbacks this app does not publish
(`/conversation/contentSharingUpdate/`, `/conversation/contentSharingEnd/`). The `addModality`
body for it carries
`contentSharing {identifier, subject, sessionState, sequenceNumber, links {sessionUpdate, sessionEnd}}`.
It exists because a screen has ONE presenter: the session is what says whose screen the
meeting is looking at, and `takeControl` is how that changes hands.

**Watching a screen needs none of it.** A viewer subscribes to the sharer's
`applicationsharing-video` MSI through § 10.2 and draws it, and the roster's own
`contentSharing` field says who is sharing. So the two halves are very unequal in cost, and
they should ship apart.

### 10.5 What the four asks cost, cheapest first

The user's four asks, ordered by what each one really needs on top of the audio build:

1. **See somebody's screen** — and it is cheaper than the rest by a wide margin, now that
   § 10.3a is measured: answer the renegotiation the service already sends us (its offer
   holds the section), read the sharer's MSI out of the roster (§ 10.2), post one source
   request, draw the `<video>`. Nothing about our own offer changes, and no outward action is
   added: the user is already in the meeting and a subscription publishes nothing about them.
2. **See cameras** — § 10.2, plus the tile arithmetic: N sections, `fmtParams` scaled to the
   count, `-2` for the ones the service should fill itself, `-1` on release. This is where a
   gallery becomes a layout problem rather than a protocol one.
3. **Send the camera** — § 10.3. `getUserMedia({video})`, one send section, and a `sendonly`
   direction. Outward: everybody in the meeting sees the user's face, so it is an
   `OUTWARD_METHODS` entry of its own and never on by default (§ 7 applies unchanged — a
   camera is strictly MORE outward than a microphone, and `getDisplayMedia` more again).
4. **Share the screen** — § 10.3 *and* § 10.4. The session, the presenter, `takeControl`, and
   the label fix of § 10.1. It is the only one of the four with a control plane of its own,
   and the only one where a mistake shows a colleague something the user did not mean to
   show. It ships last.

### 10.6 What the app is missing, by file

- `src/calling.rs` — `MODALITY_AUDIO` becomes a set; `roster_in_frame` keeps
  `endpoints.endpointDetails[].mediaStreams[] {type, sourceId}` and `contentSharing`; a
  source-request payload builder (both spellings); `paths` grows
  `/call/newMediaOffer/`, `/call/dominantSpeakerInfo/`, `/call/csrcInfo/`,
  `/conversation/contentSharingUpdate/` and `/conversation/contentSharingEnd/`, since a link
  we do not publish is a frame the service has nowhere to deliver (§ 2.2).
- `src/bin/server.rs` — `CallSession` grows the subscription table and the video/sharing
  state; new RPCs for "subscribe to this source", "camera on/off", "share on/off", each
  gated as § 7 requires; `call_state` grows the per-participant video state the UI draws.
- `web/src/lib/ms-sdp.ts` — the label becomes per-section rather than per-kind (§ 10.1).
- `web/src/lib/call-media.ts` — today it is "the microphone, one peer connection, one audio
  element per stream". It becomes a media controller that also owns receive video sections,
  maps a `track` event's stream id to a subscription, and hands the UI a `MediaStream` per
  tile. `RemoteAudio` is the pattern to follow, and it is already the right shape.
- `web/src/lib/call.ts`, `call-bar.tsx` — a call bar becomes a call SURFACE: a tile grid, a
  shared-screen stage, and per-tile state. This is the largest piece of the work by volume,
  and it is entirely ours: no protocol in it. **Built** — `call-stage.tsx` over the pure
  `lib/call-stage.ts`: a full-screen page with the share on the stage and the faces as tiles,
  a draggable folded window it morphs into, and panels for the roster and the meeting's chat
  (AGENTS.md § A call is a page).
- `web/mock/server.ts` — a mock roster with MSIs, and synthesized video, so the whole
  surface stays reviewable with nothing leaving the machine. Without this half the UI can
  only be seen in a real meeting, which is the one place it must not be debugged.

### 10.7 The three measurements, and what the tenant answered

Taken 2026-08-05 against one meeting the user authorized out loud, over four joins — the
last one with their screen shared. `cd web && bun run join-live` is what took them: it is the
only sanctioned live driver for a join (§ 8), and none of this needed a line of UI. What it
grew for this is a **signal digest** (`SignalDigest` in `web/scripts/join-live.ts`): it wraps
the page's own WebSocket, reads the `call_signal` frames every client is already sent, and
prints link NAMES, m-lines and a participant's key TREE — never a url, a key or a candidate.
Instrumentation in the driver, so the app the user runs is unchanged.

1. **Does the join answer name `controlVideoStreaming` or `applyChannelParameters`?**
   **No — and both exist anyway.** They arrive on the `callAcceptance` frame (§ 10.2). The
   question was the wrong one: a link set is accumulated across frames, not read off one
   answer.
2. **Does the service accept a first offer carrying inactive video sections?** **Never asked,
   because it does the work itself.** It POSTs a `mediaRenegotiation` unprompted and its
   offer already holds the sections — labelled, at fixed mids, with SSRC ranges (§ 10.3a).
   The experiment this line called for is unnecessary.
3. **What does a real `rosterUpdate` carry for a participant with a camera on?** **Measured,
   and not where the bundle reads it** (§ 10.2): the frame body IS the roster, `participants`
   is an object keyed by mri, the name is under `details`, the streams are under
   `endpoints[<id>].call.mediaStreams`, and the frame is a DELTA. A shared screen is
   `{type: "applicationsharing-video", label: "applicationsharing-video", direction: "sendonly",
   sourceId: 2473}`.

**Two of the three answers were corrections rather than confirmations**, and the pattern is
§ 2.4's: the bundle says what the client BELIEVES after normalising, the tenant says what
travels. Read the frame.

One more thing the driver grew for this, and it is not a detail: **it captures SILENCE now.**
Chrome's fake device plays a repeating beep, and every run of this script puts it into a
real meeting with real people in it — the user asked for it to stop after the third join,
which is a fair thing to ask. `--tone` brings it back for the one question silence cannot
answer, because Opus sends comfort noise for a silent track and `packetsSent` then stops
proving the path carries audio. The offer is identical either way, which is what the script
is for.

### 10.7a What is BUILT, as of this section

The receiving half, and only that half. Read § Seeing video in AGENTS.md for the rules; the
files are `calling::media_renegotiation_from_frame` / `source_request_payload` /
`RosterStream`, the `call_answer_media` and `call_subscribe` RPCs, `web/src/lib/call-media.ts`
(`answerRemoteOffer`, `RemoteVideoTracks`), the label pair in `web/src/lib/ms-sdp.ts`, and
`web/src/components/call-video.tsx`. The mock renegotiates with the measured labels and mids,
so the whole path is reviewable with no tenant.

Sending is built too: `calling::media_offer_payload` and the `call_offer_media` RPC, over
`LocalSenders` in `web/src/lib/call-media.ts` (one reused transceiver per kind, the labels
restated on every offer) and the two toggles in the page's header (`call-stage.tsx`). It POSTs
a `mediaNegotiation` to the `mediaRenegotiation` link the acceptance named, declaring `Video`
for a camera and `ScreenSharer` for a screen.

**It HAS now been sent to the tenant, and the service rejected the section** (2026-08-06, a
real call, twice — § 10.8). The shapes above are still the client's own and the mock's
reproduction of them; what the one live attempt added is that the POST is accepted and the
video section is not, with no word about why. § 10.8 says what that leaves open, and what the
attempt cost.

### 10.8 What is still open

- **The roster fix is pinned but not SEEN.** The measured shape is in the tests and the
  driver reads a real frame with it, but the page still says "In the meeting" rather than a
  name — correctly, and for a reason worth writing down: the only other participant in the
  test meeting is the USER'S OWN second device. One person, two endpoints, one mri, so
  `CallSession::others` excludes them and an empty list is the honest answer.
  `participantCounts` says `totalParticipants: 2` beside it, which is the count of endpoints
  and not of people — never draw a "2 others" from it. Seeing a name needs a second person in
  the meeting.

- **A CAMERA has never been seen in a roster.** The measurement ran with a shared screen and
  a camera that stayed off, so `main-video` was only ever `recvonly` with nobody behind it.
  The two `main-video` mids of § 10.3a are inferred from the gap in the mid layout, not seen.
- **No source request has ever been posted.** Both links are in hand and the payloads are
  written out in § 10.2, but nothing has sent one, so the service has never had the chance to
  refuse the shape. That is the next thing to measure, and it is safe to try: a subscription
  asks for a stream, it publishes nothing about the user.
- **No renegotiation has ever been ANSWERED.** The `mediaAnswer` and `rejection` links arrive
  on every one of them and this app posts neither. Whether the service minds being ignored is
  known — it does not, the call runs for its whole length — but what it does with an answer is
  not.
- **Sending was TRIED against the tenant on 2026-08-06, and the service REFUSED the
  section.** Not a probe: the user shared their screen in a real one-to-one call, twice. This
  is what the journal holds, and it is all of it — which is the second finding.

      offered media: modalities=["audio", "ScreenSharer"] sending=["screen"]   09:21:21
      offered media: modalities=["audio"] sending=[]                           09:21:37
      the call is over: CallEndReasonHangup                                    09:21:42
      offered media: modalities=["audio", "ScreenSharer"] sending=["screen"]   09:22:00
      offered media: modalities=["audio"] sending=[]                           09:22:00
      the call is over: CallEndReasonHangup                                    09:22:11

  Four things read out of it, and they are separate:

  - **The offer is ACCEPTED as a request and the SECTION is rejected.** The service answers
    rather than refusing the POST — no `400`, no subCode — and its answer zeroes the video
    section's port, which the browser reads by stopping the transceiver. That is why the
    second line of each pair is this app taking the capture back down
    (`releaseDroppedSections`), and on the retry it happened in the SAME SECOND, so the
    answer came in the POST's own response.
  - **The refusal names NOTHING**, which is § 8's pattern exactly. So the three unknowns
    below are still unknowns: a rejected m-line does not say which of them it is, and a
    rewrite earns its place only when a refusal names what it wants (§ 10.3a's own rule, and
    how the transport profile was found). `calling::media_sections` now prints the answer's
    sections on every negotiation for that reason — the shape and never the content — because
    at the time this happened the journal said only that an offer had gone out.
  - **`CallEndReasonHangup` is THIS MACHINE hanging up** (`end_call_locally` is reached from
    `call_hangup`; a service ending carries the service's own prose). The app ended a working
    call because it could not read an answer to a renegotiation, so the user lost the person
    they were talking to seconds after sharing. That was a bug in the page and it is fixed —
    see AGENTS.md § Video in a meeting — and it is the reason the two rounds above are all
    the measurement there is: each attempt cost the user their call.
  - **The next attempt is worth making, and it is the user's own click.** What it needs is a
    live call, the journal open, and the `[calling] the offer was answered at once:` line —
    which now says which section came back REJECTED and whether the audio came back with it.
- **The CAUSE was then found in the client's own code, and it is the section LAYOUT.**
  `addModalities` in `calling-pluginless-779e39a54b8bcd49.js`, verbatim:

  ```js
  addModalities(e){const t=this.mediaManager.isEmpty();
    !this.isMultiparty && t && !this.isPstnCall &&
      (e.video = e.video || "inactive", e.sharing = e.sharing || "inactive"),
    …
    for (const i of sy) {
      if (this.mediaManager.getMediaEntitiesByModality(i)[0] || !e[i]) continue;
      let n; switch (i) {
        case D.MODALITY.video:   n = this.numVideoChannels; break;
        case D.MODALITY.sharing: n = this.numVbssChannels;  break;
        default:                 n = 1;                      break; }
      times(n, s => { const o = this.mediaManager.createMediaEntity(i);
        o.setExtension("reinviteless", t && this.reinvitelessContext.maxStreamsForModality[i] > s);
        this.createTransceiverForEntity(o) }) } }
  ```

  Read with `this.numVideoChannels = this.isMultiparty && config.numVideoChannelsGvc || 1`,
  `numVbssChannels = 1`, and `createTransceiver` → `{direction: "inactive"}`, it says four
  things — and every one of them was news:

  - **On a ONE-TO-ONE the sections exist before anybody shares.** `isMultiparty` is false and
    the media manager is empty, so `video` and `sharing` are forced to `inactive` and one
    transceiver of each is created — in the FIRST offer. Turning a share on is then an
    ACTIVATION of a section the service already answered, which is why `StartScreenSharing`
    is decorated `waitFor: "_UpdateMediaDescriptions"` and not `_RenegotiateOutgoing`:
    `executeNegotiation`'s own branch posts to the `updateMediaDescriptions` link when no new
    SDP is needed.
  - **This app did the opposite.** It offered one audio section and asked the service to
    accept a NEW `applicationsharing-video` on the `mediaRenegotiation` link. That is what
    was refused, and the refusal shape fits: the request is accepted and the SECTION is
    zeroed.
  - **A CONFERENCE really does add sections mid-call**, which is why receiving works and why
    the meeting path was never suspect: with `isMultiparty` true the two lines above do not
    run, `e.video` / `e.sharing` are absent on an audio join, and no video entity is created
    until somebody asks for one. So this app's existing behaviour is right for a meeting and
    wrong for a one-to-one — the two need different code, and `call_prepare` now says which
    kind it reserved (`one_to_one`).
  - **The 13-section BUNDLE of § 2.5 is a MEETING's**, not every call's:
    `numVideoChannelsGvc` is what makes it thirteen. A one-to-one is three — audio,
    `main-video`, `applicationsharing-video` — which is exactly what `LocalSenders.reserve`
    now offers.

  **What is built from that reading**: `reserve` on the offer path of a one-to-one, `adopt`
  on the answer path (an incoming offer from a real client already holds the layout, so the
  sections are claimed from it BY LABEL rather than added), and the activation is the
  renegotiation this app already had — the section is no longer new, which is the whole
  point. `updateMediaDescriptions` is NOT implemented: it is the client's optimisation for
  the same activation, and one thing at a time.

  **It is UNVERIFIED against the tenant**, and it changes the first offer of every
  one-to-one, which is the path that works today. `cd web && bun run call-live` is what
  proves it — the offer's own m-lines are in its digest, and the journal now names what the
  answer granted per section (`calling::media_sections`).
- **Two more of the client's own differences are now sent, and they are the CONFERENCE's
  candidates.** The only reachable test target is a group chat, which is multiparty — so the
  multiparty half of the client's config is what matters there, and it says two things this
  app was not doing:

  - **`allowedVideoCodecsMultiparty: [{video/H264},{video/AV1},{video/rtx}]` with
    `filterCodecsInSdpMultiparty: true`.** A real client's multiparty offer carries those
    three; Chrome's carries VP8, VP9, AV1, H.264, red and ulpfec, VP8 first. The service's own
    video sections are `H264/90000` alone. `setCodecPreferences` now applies the client's list
    on a conference and nothing on a one-to-one, which is where its own
    `allowedVideoCodecs: []` / `filterCodecsInSdp: false` leave Chrome's list alone.
  - **`a=x-ssrc-range` per section**, added beside `a=ssrc:` as § 2.5's capture shows. Audio is
    accepted without it, which is the control experiment that says it is not required in
    general — but the service declares one on every section it offers, and a SEND section it
    must allocate a channel for is where an omission would tell.

  Both are copies of the client rather than inventions, and neither is verified: the next
  share attempt is what says. The journal names the answer's sections
  (`calling::media_sections`), so the outcome is one line either way.
- **The section was still rejected with all of that, and the client's code names why: a screen
  is a SESSION.** Measured 2026-08-06, second attempt, in a meeting, with the section labelled
  `applicationsharing-video`, the conference codec list applied and `x-ssrc-range` stated:

      offered media: modalities=["audio", "ScreenSharer"] sending=["screen"]
      a media answer arrived: audio mid=0 label=main-audio accepted | video REJECTED

  Note what the rejected line does NOT carry: no `mid` and no `label`. The service did not echo
  the section at all — it refused to have one. And the call SURVIVED it, which is the earlier
  fix holding: audio was untouched and nothing hung up.

  The client's own path is `startScreenSharing` → `startContentSharingAsync` →
  `ContentSharingSession.start(addModalityUrl, content, …)`, which POSTs `j2(session, content)`:

  ```js
  { participants: { from: <local participant>, to: [] },
    contentSharing: { identifier, subject, sessionState, sequenceNumber,
                      links: { sessionUpdate, sessionEnd } },
    links: { addModalitySuccess, addModalityFailure } }
  ```

  with a `ContentSharingCorrelationId` header, and it sets `isPresenter = true` on the answer.
  `startContentSharingAsync` fills that body as `{contentIdentifier: e, subject: i || null,
  sessionState: t || null, sequenceNumber: 1}` — so two of the four fields are legitimately
  null and the sequence number is the literal `1`. The answer carries the session's own six
  links (`contentSharingController`, `takeControl`, `updateSessionState`, `sync`,
  `notificationLinks`, `leave`).

  **That is § 10.4's session, and it is now built**: `calling::content_sharing_payload` /
  `content_sharing_leave_payload` / `ContentSharing`, the `call_start_sharing` and
  `call_stop_sharing` RPCs, and the page asking for one before it offers the section. Read
  AGENTS.md § Video in a meeting for the five rules. Two things about it are worth keeping in
  mind next time:
  - **The session's `leave` must never be merged into the call's links.** `Links::collect`
    takes the deepest of a name and the call already has a `leave` — merged in, giving a share
    back would hang the call up. It is read into its own struct for that reason.
  - **`takeControl` and `updateSessionState` are deliberately not read.** A link nothing posts
    to goes stale in a struct, and this app has neither feature.

  **Still unverified**: the POST has never been accepted or refused by the tenant. If it is
  refused it will say so with a subCode, which is more than the section's silent rejection ever
  did.
- **The whole of the client's transform is now sent, and the service PARSES it — which is the
  first thing it ever explained.** Driven by `bun run join-live -- --share`, which grew the step
  that presses the stage's own control and the instrument that reads OUR OWN offer back
  (`readLocalOffer`, off `setLocalDescription` as it is applied — reading `localDescription`
  afterwards reads the last one, and a rejected section has been taken down by then).
  Implemented from § 2.5's own diff, in `web/src/lib/ms-sdp.ts`:

  - **`b=CT:4000`, and its POSITION is load-bearing.** After `t=` the service refuses the whole
    description by name: `SdpParsingError … Line 5: Unexpected field 'b' found. The field may be
    undefined or in the wrong order.` The grammar puts a session bandwidth before `t=`, and so
    does the capture. That refusal is the only one this service has ever spelled out, and it
    proves the SDP is parsed strictly and named precisely when it is wrong — so the next mistake
    will say what it is.
  - **The bundle's real transport, per section.** A browser writes the address on the section
    that carries candidates and `9` / `IN IP4 0.0.0.0` on every other; the client copies the real
    port and `c=` onto each (`transformBundle`).
  - **`a=rtcp:<port>` on an offer, deleted on an answer** (the client's `rtcpTransform`), the
    session **fingerprint copied onto every live section**, and **`a=msid-semantic: WMS *`**.

  And these, from the client's code rather than the capture: the conference codec list, the
  SSRC range (0-wide, because `getSsrcRangeForIndex` is `or(direction) && simulcast ? … : 0` and
  simulcast is off), the content-sharing session, and the section LAYOUT — cameras before the
  screen, so a conference's sharing section is the fourth m-line at the service's own mid 3.

  **Every video section is still rejected, and audio goes through the same transform and is
  accepted.** Measured across nine live joins, with each of these eliminated one at a time:
  mid 1 and mid 3; `inactive`, `recvonly` and `sendonly`; at the join and mid-call; with the
  presenter session granted (`role = "presenter"` in the roster, `can_stop=true`) and without.

  **What has NEVER been true in any of those runs: somebody else in the meeting.** Every one was
  joined alone — no other roster entry, and no `mediaRenegotiation` from the service, which is
  its own signal that it has something to negotiate. § 10.3a already measured that: of five
  joins, the four that got a renegotiation had a SECOND endpoint and the one that joined an empty
  meeting got none in 30 s. A conference SFU refusing to allocate a video channel with no
  receiver in the meeting fits every measurement above, and it is the one hypothesis this
  machine cannot test by itself — the second install (`--released`, the front this driver grew
  for exactly that) is refused writes by its own write lock, so it cannot join.

  **So the next measurement needs a second participant in the meeting, and nothing else.**
- Three specific unknowns remain, and the refusal above narrowed none of them:
  - **Whether a `contentSharing` session is needed at all.** § 10.4 says the client opens one,
    with six links and a presenter. But no participant in the measured roster carried a
    `contentSharing` object *even while sharing* — their share was a `mediaStreams` entry and
    nothing else. So this app offers the section and the `ScreenSharer` modality and opens no
    session, which is the smallest thing consistent with what was measured. If the meeting
    shows nothing, that session is the first thing to add.
  - **Whether an offer of ours is accepted on the `mediaRenegotiation` link.** That link is
    the service's own, handed to us on the acceptance, and the client's own builder posts this
    body to it — but `startOutgoingNegotiation` and `updateMediaDescriptions` arrive on the
    same frame and one of those may be the real target.
  - **Whether a bare H.264 send section is enough.** Simulcast is off in the client's config
    so none of its envelope is sent, and `max-br` / `x-mediabw` are not stated either. A
    refusal would name what it wants.
