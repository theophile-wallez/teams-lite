# Signing in again — the identity broker's interactive flow, measured

The map every line of `src/signin.rs`, `src/xwindow.rs` and the interactive half of
`src/auth.rs` was written from. It is the sign-in counterpart of NATIVE-CALLING.md: what
the Microsoft Identity Broker really does on Linux, measured against this tenant, with the
dates and the exact strings.

Everything below was measured on **2026-08-18**, on the machine teams-lite runs on, against
broker **3.0.2** / MSAL **10.0.0** (`getLinuxBrokerVersion`), containerized Intune.

## 1. What breaks, and what it looks like

The broker mints tokens from the machine's Primary Refresh Token. Per resource it also
holds a refresh token, and that one dies — Entra revokes it, its lifetime runs out, a
Conditional Access policy re-evaluates. `acquireTokenSilently` then refuses, per scope,
with the broker's own words:

```json
{"context":"Recieved an error from AAD. Code: 'interaction_required' description: '(pii)'
            correlation id: '9e01b0ab-…' suberror: 'token_expired'",
 "diagnostics":null,"errorCode":0,"status":2,"subStatus":0,"tag":593819521}
```

Three things about it, each of which shaped the design:

- **It comes from AAD, not from a cache.** "Recieved an error from AAD" (the broker's own
  spelling) — so the broker did reach the network and was told no.
- **It is per RESOURCE.** Measured during this outage: Graph minted fine while
  `https://api.spaces.skype.com/.default` refused. So "sign-in is broken" is really "this
  one resource's refresh token is dead", and a repair that does not name the resource can
  appear to work while the app stays dark.
- **The correlation id does not move between retries**, which reads as a cached failure and
  sent an earlier debugging session down that path for an hour. It is not: the broker asks
  AAD each time and AAD keeps answering the same way.

Before this change the app's only answer was `BrokerFailure::Refused` → "it needs you to
sign in to Intune again", which in practice meant SSH to the machine, an `Xvfb`, `x11vnc`,
`websockify`, noVNC, `openbox` (without a window manager a click does not focus, so the
password could not be typed at all) and `xdotool`. Measured cost of doing it by hand once:
about forty minutes, and it did not finish.

## 2. The fix that needs no human at all

**`acquireTokenInteractively` succeeds where `acquireTokenSilently` refuses, with the same
request, no window, and nobody typing anything.** Measured, twice, on the live outage:

| call | request | outcome |
| --- | --- | --- |
| `acquireTokenSilently` | `authorizationType: 1`, skype scope | refused, `interaction_required` / `token_expired` (1716 log lines over hours) |
| `acquireTokenInteractively` | **byte-identical params** | **access token**, in under a second, no window shown |
| `acquireTokenSilently` | same as the first row, immediately after | **access token** — and for `ic3.teams.office.com` too |

And the live backend, which had been retrying every 30 s since the token expired, stopped
failing at 22:02:08 and reconnected to Teams on its own. Nothing was signed in by hand.

Why: "interactive" on this broker means *may* show UI, not *will*. With a valid PRT the
broker runs a PRT redemption for the resource (`RunPrtRefresh` in its own symbols) and
answers from that; the silent path only refreshes the resource's own refresh token, which
is the thing that died. So the resource token is recoverable from the PRT, and the silent
path is simply not allowed to do it.

That is why `auth::acquire_token` now retries interactively, automatically, on exactly the
refusal codes that mean "a human may be needed" — and why most of the time the user sees
nothing at all.

**`authorizationType` stays `1`.** The broker refuses a non-interactive type on this method
("Called AcquireTokenInteractively with non-interactive authorization type: %d" is in its
binary), and `1` is not refused: it is what returned the token above. `1` is
`CachedRefreshToken` — the PRT — which is what makes the whole mechanism work.

## 3. When a human really is needed, the broker shows a WINDOW

There is no way around the window, and it is not for want of looking:

- **Device code is refused on Linux.** The broker's own binary carries
  "AcquireTokenWithDeviceCodeFlow is not implemented on Linux platform" (9 occurrences).
  So the "open microsoft.com/devicelogin and type ABCD-EFGH" shape cannot be had from the
  broker, however much nicer it would be on a phone.
- **The broker renders the sign-in itself**, in an embedded WebKitGTK view on an X display
  (`Msai::EmbeddedBrowserImpl`, `EmbeddedBrowserFactoryImpl.cpp`, `XOpenDisplay`). No API
  parameter redirects it to a URL the app could open elsewhere.
- **An ordinary browser cannot stand in for it.** Measured on 2026-08-11 and again on
  2026-08-18: signing in to the Teams resource from a plain browser on this machine is
  refused by Conditional Access — "Your sign-in was successful but does not meet the
  criteria to access this resource". The broker's window is the one that carries the
  device's PRT, and therefore the one the tenant accepts.
- **The Company Portal is not it either.** `intune-container login --web` drives
  `intune-portal`, which on an already-enrolled device answers "Something went wrong
  [4rfhk] — The operation attempted is invalid."

So teams-lite does the only remaining thing: it brings the broker's own window to the
browser the app is already being read in.

### The window, identified

Forced with `additionalQueryParametersForAuthorization: {"prompt":"login"}` (which is how
this was measured without an expired PRT, and nothing was typed into it):

```
name    'Microsoft Authentication'
WM_CLASS "microsoft-identity-broker", "Microsoft-identity-broker"
geometry 550x675 at +365+62
display  the BROKER's own, read from /proc/<broker pid>/environ  →  DISPLAY=:77
```

It appeared **within 2 s** of the call. Four facts follow, and each is a rule in the code:

- **The window is found by `WM_CLASS`, never by position or by "the newest window".** That
  display carried six other windows at the time — two leftover `intune-portal` frames and
  four 1x1 helpers — and on `:99` there were forty, from the container's compliance agent.
  Capturing "the screen" would put whatever else is on that display in front of the reader,
  and inject their password into whatever happens to hold focus.
- **The display is the BROKER's, and it is read rather than chosen.** `/proc/<pid>/environ`
  answers it (measured: `DISPLAY=:77`), because the container's own provisioning publishes
  one into the D-Bus activation environment and the broker's environment is frozen at
  activation. teams-lite never moves it: that would need `setns` into the container, and
  pointing the broker at a display that later disappears is a known way to break every
  token call (`intune-container`'s own `BROKER_DISPLAY_SCRIPT` exists for that bug).
  **This process's own `DISPLAY` is not a fallback**, and it was one for a while: on a desktop
  session it answers `:0`, whose socket exists — so the app offered a sign-in, started one, and
  then looked for the window on a display the broker never draws on. Ten minutes at `starting`,
  ending in "not finished in time", with the broker's real window left standing on `:77` because
  the take-back looks at the same wrong display. A display that cannot be read is a display we
  do not know, and saying so is the only honest answer.
- **A display the broker names but nothing serves is a diagnosable state**, not a mystery:
  the socket at `/tmp/.X11-unix/X<n>` is either there or it is not, and teams-lite says which,
  naming the display and the remedy. It does NOT start one: an `Xvfb` on the number the broker
  already expects is the one display change that could not strand it, but a display this app
  spawns and then outlives is exactly the bug `intune-container`'s `BROKER_DISPLAY_SCRIPT` exists
  for, and getting the ownership right is a feature of its own rather than a line here.
- **The container shares `/tmp/.X11-unix` with the host** (measured: `X77` and `X99` are
  the same sockets inside and out), so a host-side X server is reachable by the
  in-container broker, and a host-side capture sees the in-container window.

### The pending call, and how to end it

- **The D-Bus call blocks for as long as the flow lasts.** Measured: still pending at 18 s,
  then killed at ~25 s by **busctl's own** `--timeout` default. zbus imposes no client-side
  timeout (`Connection::method_timeout` defaults to `None`), so teams-lite bounds it with
  `tokio::time::timeout` — short for the automatic attempt, long for the one a human is
  watching. The number is ours, not the bus's.
- **`cancelInteractiveFlow` with an empty body took the broker OFF THE BUS**: `Message
  recipient disconnected from message bus without replying` — which is
  `BrokerFailure::Disconnected`, the signature whose automatic remedy is *restarting the
  user's Intune container*. So teams-lite does not call it. **A flow is ended by closing
  its window** (`WM_DELETE_WINDOW`), which is what a person closing it would do and what
  the broker's own flow is built to handle. Measured: the window was gone afterwards and
  the broker re-activated cleanly on the next call (`getLinuxBrokerVersion` → 3.0.2).
- **Closing the window is how a flow the broker is SHOWING is ended — and it is not the whole
  of Cancel.** During `starting` there is no window yet, and a Cancel that only closed one was a
  silent no-op in the phase most sign-ins live in: the phase stayed `starting`, nothing was said,
  and the session stayed live for the whole deadline, so no new sign-in could be started for ten
  minutes. So the run is also TOLD to stop, which drops the D-Bus call — the way `agent_stop`
  drops an agent run.
- **A closed window ends the pending call as a NAMED cancellation**, which is what lets the
  app tell "the reader gave up" from "the sign-in failed":

  ```json
  {"brokerTokenResponse":{"error":{"context":"The InteractiveRequest was canceled by the user",
                                   "errorCode":0,"status":7,"subStatus":0,"tag":557155398}}}
  ```

  `status: 7` and that context, measured; the broker stayed on the bus and minted a silent
  token immediately afterwards.

### The window, driven — measured end to end through this crate's own code

`examples/signin_window_recon.rs` is the read-only re-measurement of all of it, and on
2026-08-18 every step of the served flow was proven against the real page with it:

| step | measured |
| --- | --- |
| resolve the display | `Ready { display: ":77" }` from `/proc/<broker pid>/environ` |
| find the window | by `WM_CLASS`, **and by map state** — see below |
| capture a frame | 550x675, **33.9 KB of PNG**, the tenant's own branded "Enter password" page, colours correct |
| focus and type | six characters (three of them shifted) → six dots in the password field |
| close | window gone, call cancelled as above, broker healthy |

**The map state is part of the window's identity, and only the real thing showed it.** After
a flow ends the broker leaves an **unmapped 10x10 window behind, carrying the very same
`WM_CLASS`**. Matched on the class alone this app found that one, and `GetImage` on an
unmapped window is a `BadMatch` — so a frame read failed with an X error code where the
honest answer was "no sign-in window is open". `is_signin_window` therefore requires
`MapState::VIEWABLE`.

What is NOT measured here is a sign-in carried through to a token: that needs the real
password. Everything up to it is.

**The pixels follow the SERVER's byte order**, asked for rather than assumed
(`image_byte_order`, read off the connection this code already holds). A little-endian server
hands over B,G,R,X and a big-endian one X,R,G,B, and picking wrong draws Microsoft's blue page
orange — with the number a reader has to match in the wrong ink, which is the kind of wrong that
looks almost right.

**The recon example is observational, and the guard keeps it that way.** It had `--type` and
`--close` while the input path was being measured; those acted on the user's live sign-in window
from a command line, past the write token, past `TEAMS_LITE_READ_ONLY` and past the hook that
gates the four `signin_*` RPCs. They are gone, and `.claude/hooks/guard-live-automation.sh` now
blocks any example that calls the driving half of `xwindow` at all — so putting them back is a
deliberate act with a guard entry rather than a flag.
- **The broker is D-Bus activated**, so it respawns on the next call and a crash costs one
  call rather than the sign-in.

## 4. What is still unverified against the tenant

Said plainly, because the parts that are measured are measured hard:

- **A sign-in that a human really has to complete has not been completed through this app.**
  Section 2 is measured end to end; section 3's window, its identity, its display, its
  timing and its teardown are all measured — but nobody has typed a password into a
  teams-lite frame and come out the other side with a token, because that needs a PRT this
  side cannot expire on purpose. What that leaves untested is the pairing: the keystrokes
  landing in the real page, and the token the broker answers with afterwards.
- **Number matching has not been seen through the served window.** The number is drawn by
  the page, so serving the page is what surfaces it; that it is legible at the window's own
  550x675 is an inference from the pixels being sent unscaled, not a measurement.
- **The long deadline has not been hit in anger.** `SIGNIN_DEADLINE` is ours and generous;
  whether the bus daemon cuts a pending reply before it is a question about the daemon's
  `reply_timeout`, whose default this machine's `session.conf` does not state.
