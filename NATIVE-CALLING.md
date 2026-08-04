# Native calling — audio only, the way the Teams web client does it

Status: **investigation, nothing implemented.** This file is the protocol map that a
first implementation is written from. It records what the real Teams web client does,
what this tenant answers, what teams-lite already holds, and what is still unknown.

Nothing in here rings anybody. Every fact below came from two READ-ONLY sources: the
web client's own public JavaScript, and one authz call this app already makes on every
start.

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

## 4. What teams-lite already holds

- The two tokens the plane needs: the `ic3.teams.office.com` bearer and the skypetoken
  (`src/auth.rs`, `src/teams.rs`).
- The directory, including every key in § 3 (`Session::endpoint`).
- A live trouter connection with a stable `epid`, and the registrar call
  (`src/trouter.rs`).
- The push decoder for the calling envelope, including nested `cp` / `gp`
  (`src/trouter_events.rs`, `CallFrame`).
- A `calls` channel through the backend and a `call_signal` event to the web app
  (`src/bin/server.rs`), plus an incoming-call banner.

Three corrections to make before a live capture is worth running:

1. **`register_calling` copies the Windows desktop client, not the web one.** It
   registers `NextGenCalling` / `DesktopNgc_2.3:SkypeNgc` at `{surl}NGCallManagerWin`
   and `SkypeSpacesWeb` / `SkypeSpacesWeb_2.3` at `{surl}SkypeSpacesWeb`, both on the
   MESSAGING socket. The web client registers **one** endpoint, template
   `SkypeSpacesWeb_2.6`, TTL 3600, path = the bare surl, on a **calling** trouter
   connection of its own (`calling_trouterUrl`).
2. **`is_calling_url` matches those suffixes**, so a push shaped like the web client's
   would be read as a chat frame and dropped. It should key on the calling connection
   the frame arrived on, and on `callAgent` in the path.
3. **The calling connection is addressed as `/v3/c`** while this app's messaging client
   uses the `/v4/a` allocate plus socket.io flow. The client's own code converts a
   `/v4/c` websocket URL to the `/v4/a` allocate URL and back, so the two are forms of
   one service — but `/v3/c` against `/v4/a` is **not yet verified** and is the first
   thing a spike must answer.

## 5. How it should be built here

**The backend signals; the browser carries the audio.** Nothing else fits this app:

- The tokens live in the backend and must stay there. A browser holding a calling token
  could place a call around every gate.
- Media cannot live in the backend: the audio has to reach the user's microphone and
  speakers, and `RTCPeerConnection` is in the page.
- So the SDP crosses the local WebSocket — an offer out, an answer in — exactly like
  every other RPC. The browser never learns a Teams URL, and the backend never handles
  RTP.

That splits cleanly into `src/calling.rs` (the signaling client: the POSTs, the links,
the relay credentials), the calling half of `src/trouter.rs`, new RPCs, and a browser
media controller under `web/src/lib/`.

## 6. Audio-only plan, in the order it should be done

1. **Spike the second trouter connection.** Connect and register as the web client
   (`SkypeSpacesWeb_2.6`, bare surl, `calling_trouterUrl`, `calling_registrarUrl`).
   Prove a real incoming call arrives on it, and dump the frame. This answers § 4.3 and
   fixes the schema guesses with one real ring.
2. **Model the notification.** Turn the captured `callNotification` into a typed
   Rust struct and drive the existing banner from it, links included. No answer yet.
3. **Relay credentials.** Read `relayConfig` out of whatever the service sends, GET
   `Service.tokenUrl`, and hand the browser only what an `RTCPeerConnection` needs:
   `[{urls, username, credential}]`. The token itself never leaves the backend.
4. **Answer a call.** Browser: `getUserMedia({audio:true})` →
   `setRemoteDescription(offer)` → `createAnswer`. Backend: POST `accept`, then
   `mediaAnswer` with the blob, then `mediaAcknowledgement`. This is the first point
   where two people hear each other.
5. **Hang up, and survive.** `hangup` / `end`, `keepAlive` on the interval the service
   asks for, and the roster / `conversationEnd` pushes. A call that cannot be ended is
   worse than no call.
6. **Place a call.** The § 2.3 POST, audio modality only, with the `groupChat.threadId`
   of the conversation the user is in, so the call belongs to that thread.
7. **Mute, and the in-call surface.** `mute` / `unmute` are links like any other.

Video is deliberately out. It changes nothing structural — one more modality and one
more m-line — so it stays out until audio is solid.

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

## 8. Still unknown

- `/v3/c` against the `/v4/a` allocate flow (§ 4.3). First spike.
- The exact path an incoming call is pushed to on the calling connection, and the
  fields the notification really carries on this tenant. Only a live ring answers.
- Whether a 1:1 audio call to a colleague connects peer to peer or through a Microsoft
  media server. It changes latency, not the code: ICE decides.
- `applicationType`, `clientType` and `endpointCapabilities` values the service accepts
  from a client that is not the real one.
- What the service returns from the create-call POST (the conversation `Location` and
  the first link set) — read from the response of the first real placed call.

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
