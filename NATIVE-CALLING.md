# Native calling — audio only, the way the Teams web client does it

Status: **implemented, and not yet exercised against the tenant.** One-to-one audio
calling is built end to end — `src/calling.rs` signals, `web/src/lib/call-media.ts`
carries the audio, and the whole flow is driven by the mock in `web/e2e/calling.spec.ts`.
What has NOT happened is a real call: § 8 lists exactly what only a live ring can answer,
and § 7 says why nothing here places one on its own.

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

`startOrJoinCall` sends **one POST to `conversationServiceUrl`**, and the payload is:

```
{ payload: {
    conversationRequest: { conversationType, subject, suppressDialout, applicationType,
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
      clientContentForMediaController, ... } } }
```

Headers (the `HEADERS` table plus `buildHeaders`): `X-Skypetoken` **or**
`Authorization: Bearer …`, `X-Microsoft-Skype-Chain-ID` (the correlation id),
`X-MS-Migration: True`, `api-version: 2`, `Content-Type`, and the
`MS-Teams-Ring` / `MS-Teams-Region` / `MS-Teams-Partition` trio. Which token the
service wants is not guessed: it answers `www-authenticate` with
`token_types="skype aad cae"`, and the client picks from that list. teams-lite already
mints both halves.

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

Seven RPCs, and the split between them IS the consent design (see § 7):

| Method | Gate | What it does |
| --- | --- | --- |
| `call_status` | open | The state the UI draws. No SDP, no links, no credentials. |
| `set_calling` | `MACHINE_METHODS` | Registers (or unregisters) this machine as a device the user's calls ring on. |
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
`call-media.ts` (the microphone, one `RTCPeerConnection`, the remote audio element). The
UI is `call-bar.tsx` (ringing and in-call, one component), `call-button.tsx` (a 1:1
header) and the Settings switch.

A meeting is joined rather than placed, and it is the same plane: the join link carries
the thread and the `{Tid, Oid}` the service wants as `meetingInfo`
(`calling::MeetingJoin`), the lobby is a state of its own, and the roster arrives as
`rosterUpdate` frames. The one media difference is that a meeting sends several voices as
several streams, so the page keeps one audio element per stream.

What is deliberately NOT built: video, screen sharing, a group call the user assembles
themselves, transfer, hold, DTMF, admitting somebody from a lobby, and any call this app
places without a click. Each is a product decision with its own surface, and audio has to
be solid first.

## 7. Consent — a call is at least as outward as a send

A ring reaches a person, on every device they own, and interrupts them. So the rules
that hold `send` hold here, and one is stricter:

- **Placing a call needs the user's explicit consent for that call**, per call. There is
  no standing licence, and a call is never placed by anything automatic.
- **`call` / `answer` / `hangup` are `OUTWARD_METHODS` entries**: the write token,
  refused on a read-only backend, and named in the automation hook.
- **Registering the calling endpoint changes where Teams routes the user's real calls.**
  That is a side effect on their account even when this app never rings anybody, so the
  registration stays behind a setting that is off by default.
- **The live target is the sandbox chat and its one consenting counterpart**, exactly as
  § Sending messages says. A test call goes there and nowhere else.
- Answering a call the user was already being offered is the one action that starts
  from their own click and nothing else — but it publishes their microphone, so it is
  never automatic either.

## 8. Still unknown — what only a live ring can answer

Everything below is written, and none of it has met the tenant. A live call is the user's
own click (§ 7), so these are the questions that first call answers:

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

## 9. Reproducing this recon

The tenant half, read-only, one authz call:

    . bin/broker-env.sh && teams_lite_export_broker_bus && \
      cargo run --example calling_endpoint_recon

The client half needs no account at all — the bundles are public:

    curl -sL https://teams.microsoft.com/v2/ -o shell.html
    # the asset list and the chunk map are inside; the calling stack is
    # calling-pluginless-<hash>.js under
    # https://teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/

Hashes move with every Teams release, so read the shell for the current ones rather
than pinning the names in this file.

And the surface itself, with no tenant, no registration and no microphone:

    cd web && bun run preview -- --out /tmp/call --call     # the switch, the ring, the bar
    cd web && bun run test                                  # the state model
    cd web && bun run test:e2e -- calling.spec.ts           # the whole flow, through the mock
    cargo test                                              # the payloads, the frames, the gates
