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
  something serves `:<n>` here or it does not, and teams-lite says which, naming the display
  and the remedy. "Serves" is TWO sockets, asked in the order x11rb connects: the ABSTRACT
  `@/tmp/.X11-unix/X<n>` (a listener in `/proc/net/unix`, flag `00010000` — an accepted
  connection carries the same name and is no server), then the file `/tmp/.X11-unix/X<n>`.
  Asking for the file alone reported the broker's own `:99` as `Missing` on the machine this
  was built for (2026-11-02, below), and refused the served sign-in there. It does NOT start one: an `Xvfb` on the number the broker
  already expects is the one display change that could not strand it, but a display this app
  spawns and then outlives is exactly the bug `intune-container`'s `BROKER_DISPLAY_SCRIPT` exists
  for, and getting the ownership right is a feature of its own rather than a line here.
- **The container shares the host's NETWORK namespace, and that is what the window is reached
  through.** Measured 2026-08-18, `/tmp/.X11-unix` was shared too (`X77` and `X99` the same
  sockets inside and out). Measured 2026-11-02 it was NOT: the broker drew on `:99`, the
  container's `/tmp/.X11-unix` held `X99`, the host's held only `X0` and `X1` — and
  `/proc/net/unix` listed a listening `@/tmp/.X11-unix/X99`, because the container, its broker
  and the host all report one `net:[…]` namespace. So the abstract socket is the one both sides
  reach whatever the container's mount layout is this week, and it is also why teams-lite's
  container image runs in the host's network namespace in its HOST mode
  (packaging/docker/compose.host-broker.yaml): in a bridge network an abstract socket of the
  host's does not exist. The image's default EMBEDDED mode is the mirror image of the same fact
  (§ 5): there the Intune container is teams-lite's own and shares teams-lite's network
  namespace, so its `:99` is in that namespace from the start — and a bridge network is not a
  cost but a requirement, because in the host's the two `:99`s would collide. A check for a
  `:99` already bound cannot enforce that alone (at boot the container usually starts before the
  user's own `:99` is up), so the image's entrypoint refuses the host's network namespace ITSELF,
  by the kernel's fixed inode number for its INITIAL one — on a kernel that fixes one, as this
  machine's 7.3 does; under a microVM runtime that namespace is the guest's own, which
  `TEAMS_LITE_NETNS_IS_OWN=1` declares — and AGENTS.md § Running teams-lite in a container image
  has the rest.

### The pending call, and how to end it

- **The D-Bus call blocks for as long as the flow lasts.** Measured: still pending at 18 s,
  then killed at ~25 s by **busctl's own** `--timeout` default. zbus imposes no client-side
  timeout (`Connection::method_timeout` defaults to `None`), so teams-lite bounds it with
  `tokio::time::timeout` — short for the automatic attempt, long for the one a human is
  watching. The number is ours, not the bus's.
- **`cancelInteractiveFlow` with an empty body took the broker OFF THE BUS**: `Message
  recipient disconnected from message bus without replying` — which is
  `BrokerFailure::Disconnected`, a signature whose automatic remedy is *restarting the
  user's Intune container* (a remedy that now runs only once the container's keyring itself
  reads locked — AGENTS.md § The always-on service — but the call has cost the reader their
  broker either way). So teams-lite does not call it. **A flow is ended by closing
  its window** (`WM_DELETE_WINDOW`), which is what a person closing it would do and what
  the broker's own flow is built to handle. Measured: the window was gone afterwards and
  the broker re-activated cleanly on the next call (`getLinuxBrokerVersion` → 3.0.2).
- **Closing the window is how a flow the broker is SHOWING is ended — and it is not the whole
  of Cancel.** During `starting` there is no window yet, and a Cancel that only closed one was a
  silent no-op in the phase most sign-ins live in: the phase stayed `starting`, nothing was said,
  and the session stayed live for the whole deadline, so no new sign-in could be started for ten
  minutes. So the run is also TOLD to stop, which drops the D-Bus call — the way `agent_stop`
  drops an agent run.
- **The close is best effort; the stop is not.** The window a Cancel closes is the one the
  session last SAW, and the broker destroys and replaces its window between steps — so a Cancel
  pressed while the page was blank between the password and the number sent `WM_DELETE_WINDOW`
  to a window that no longer existed, and X answered `BadWindow`. That error used to return before
  the run was told, with the session already marked as closing: a spinner with no Cancel, nothing
  served, and no new sign-in for the full ten minutes. A failed close is now said and nothing more
  (`close_best_effort`), the run is told on every path, and its own take-back closes whichever
  window is current. `a_close_that_fails_never_keeps_the_stop_from_the_run` pins it.
- **A close that did not land is NOT free, and the take-back alone does not make it so.** It was
  written here that it was, because the run closes "whichever window is current" — which holds only
  if one IS current, and the failed close is exactly the case where none is: the broker has
  destroyed the password page and not yet drawn the number-matching one. The take-back runs once,
  finds nothing, and dropping the D-Bus call tells the broker nothing (there is no safe cancel,
  above, and its window was seen left standing when the call that asked for it went away). So the
  broker could go on to draw the number page — and send the Authenticator prompt — with nobody
  watching it and the turn already released, and the next "Sign in here" would serve that stale
  flow whose reply nobody awaits. The same holds for a Cancel during `starting`, call out and no
  window yet. So after a Cancel that DROPPED the call and closed nothing, the run KEEPS the turn
  and watches the broker's display for `CANCEL_SETTLE` (15 s — the first window appeared within
  2 s of the call, above, and it is the portal helper's own settle for a portal on its way),
  closes the first window that appears, and only then releases the turn. What is promised is that
  bound and no more: a page the broker draws later than that is left, and what the settle costs is
  a session that says it is closing for up to that long. How long the broker takes between two of
  its pages is NOT measured; the bound rests on the first window's 2 s.
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
- **Everything in § 5 is unverified against the tenant**, and that section says so item by item.

## 5. The same window ENROLLS the self-contained image's own Intune container

teams-lite's container image boots an Intune container of its OWN by default
(`TEAMS_LITE_INTUNE_MODE=embedded`, `src/intune_embedded.rs`; AGENTS.md § Running teams-lite in a
container image). A container nobody has enrolled holds no device registration, and then nothing
the broker does can sign anybody in on it: the sign-in above needs an account to name, and there
is none. What enrolls a device is the **Intune portal** (`intune-portal`), so the served sign-in
gained a second KIND of session (`signin::Kind::Enroll`), started by its own RPC
(`intune_enroll`, a `MACHINE_METHODS` entry) and served through the same four
(`signin_status` / `signin_frame` / `signin_input` / `signin_cancel`). Nothing in this section has
been run against the tenant; what it rests on is the crate's own portal launch and the facts of
§ 3, which carry over unchanged.

**The display is NAMED, not read — the one place the rule of § 3 does not hold, and why.** The
broker's display is read out of its environment because the broker chose it at activation. The
portal is launched BY US (`ops::portal_open_headless`, a crate call added for an embedding app: it
launches `intune-portal` on the container's own `:99` with no restart and no host display), on
`ops::CONTAINER_DISPLAY`, and the session the container publishes to its broker names that same
display — so the broker's dialogs land beside the portal, and there is nothing to read it out of
before the portal exists (`xwindow::container_display`). It is reached through its ABSTRACT socket,
which is in teams-lite's own network namespace because the inner container keeps the outer one's —
which is exactly why the image must never run in the host's (§ 3, last bullet).

**`:99` is `1280x800x24` at the crate teams-lite pins, and the capture is why.** The crate's
container display used to be `640x480x16`. `SigninWindow::capture` reads `Z_PIXMAP` at four bytes a
pixel — what every 24- and 32-bit visual hands over — and refuses anything else, so a 16-bit
display would have been refused frame by frame; and Entra keeps its desktop layout only from about
1280x800 (the crate commit's own words). Both moved in the same crate commit (`98f23b7`, on the
branch teams-lite pins — see Cargo.toml).

**TWO window classes, the topmost wins** (`xwindow::ENROLL_WM_CLASSES` = the broker's
`microsoft-identity-broker` and the portal's `intune-portal`, through `SigninWindow::find_any`).
The portal asks the broker for a sign-in, and the broker draws that dialog OVER the portal on the
same display. There is no window manager there, so a window mapped later is stacked higher, and the
reader is shown the topmost VIEWABLE match — the dialog while it is up, the portal again once it
goes. An override-redirect window (a menu, a tooltip, carrying its program's class) is a match only
when nothing else is. Every other rule of § 3 holds: one window, by class AND map state, never the
screen.

**A window that hangs off the screen is MOVED onto it before it is read.** Neither display this app
reads has a window manager, so nothing places a window — and the portal maps its 478x628 window at
615,375 on the 1280x800 `:99`, 203 rows past the bottom edge (recorded in intune-container's own
viewer, `src/xscreen.rs`, which moves the window to the origin for the same reason). X answers
`BadMatch` to a `GetImage` of any window that is not wholly on its screen. So the first real
enrollment (2026-11-04, a pod on a real cluster) found the portal's window — the panel's placeholder took
its 478:628 shape — and could read none of it: every frame failed, the page swallowed each failure
as it does between broker steps, and the panel drew its loading placeholder for as long as the
portal was open, with nothing in the log. The live session's read is now
`SigninWindow::capture_or_place`, and four rules hold it:

- **The whole window is asked for FIRST**, which is every read that ever worked here; only a
  `BadMatch` places it. A composited display reads a window part of which is off the screen, and
  that read is left as it was.
- **A TOP-LEVEL window is moved the least that puts it wholly on the screen** — the clamp a window
  manager applies — and the move counts only where it LANDED: a client holding SubstructureRedirect
  on the root may ignore it, and a window that did not move is read where it stands, as far as it
  is on the screen, from its own origin (so a press on that frame still lands where it was aimed).
- **The tick that moves the window reads NOTHING** (`{moved: true}` on the wire, and the page marks
  any picture it holds stale). The rows a move brings on screen are not drawn until the program
  has handled the `Expose` it sends, so a read in the same breath would serve the background, or
  rows of the window repeated, as a fresh picture a press could land on. The next tick reads it
  whole.
- **A diagnostic never moves anything.** `SigninWindow::capture` reads the part on the screen and
  leaves the window where it is, so `examples/signin_window_recon.rs` stays read-only; moving is
  the driving half, and the automation guard refuses an example that calls `capture_or_place`.

Measured against a real Xvfb at 1280x800x24 with no window manager
(`xwindow::tests::a_portal_window_hanging_off_the_screen_is_placed_and_then_read`, `#[ignore]`d
because it needs that server): the raw read of a window at 615,375 is refused as `BadMatch`; the
diagnostic read gets its 478x425 on-screen part and leaves it at 615,375; the session's read moves
it to 615,172 and answers nothing; and the next read gets it whole at 478x628. And a frame that
cannot be read now says why in the journal, once per reason — keyed on the X error's kind and the
request it refused, never on its text, which carries the request's sequence number and so changes
on every frame (`[signin] the window could not be read: …`).

**The interactive TURN is held for the session's whole life.** A sign-in takes it for one call; a
portal session takes it before it looks for any window and keeps it until the portal is gone, so the
automatic rescue (§ 2) stands down meanwhile and every broker dialog on that display is one the
portal asked for — never the rescue's own window about to be taken back.

**And that is why the account check is made under the turn, interactively.** After an account is
signed in through the portal, the silent call can still refuse: § 2's measured shape is that the
silent path only refreshes a resource's own refresh token, and a freshly added account holds none
for this client yet. That refusal is handed to the rescue, which only TRIES for the turn — and with
this session holding it, the rescue stood down, the panel said "sign-in is still broken", and
seconds later the enrollment's follow-up (the turn released by then) minted the token and took the
banner down under a panel that said the opposite. So the session makes the rescue's own call itself
— `acquireTokenInteractively`, which redeems the PRT with nobody in front of it, bounded at 30 s —
takes back any window that call raised, releases the turn, and only then asks the ordinary funnel,
which records the broker as healthy. Whether a fresh account really does refuse the silent call is
not measured; the order is right either way.

**A CANCEL IS CARRIED OUT BY THE PORTAL'S HELPER, and the session waits for it.** The portal
belongs to a helper process in a session of its own (`server __teams-lite-intune-portal`), so the
`WM_DELETE_WINDOW` of § 3 is not enough: during `starting` there is no window yet, and a Cancel that
only closed one left the helper to open the portal a moment later with nobody behind it, holding
the one helper slot — every enrollment, repair and boot refused — for half an hour. So:

- a Cancel marks the session as closing at once (nothing is served from then on, and the page says
  "Closing the Intune portal…"), and is delivered with `Notify::notify_one`, never
  `notify_waiters` — the run may still be waiting for the turn, and `notify_waiters` stores nothing
  for a waiter that does not exist yet;
- the run sends the helper SIGTERM (`HelperTerminator::terminate`, which re-checks the pid's own
  command line first and refuses any helper but the portal's — a boot or a repair has no handler,
  and would die mid-work), and the helper answers by closing the portal the crate's own way
  (`ops::portal_stop`, a TERM), watching for up to 15 s to close one that was still on its way;
- the session waits up to 45 s for the helper to EXIT, then — under the turn — closes whatever
  broker dialog is left, and only then settles. A helper still running after 45 s is said as what it
  is ("asked to close and has not finished closing yet"), and the backend follows it to its end;
- a helper whose SESSION is gone — the backend restarted under it, which the helper survives by
  design — can be served and cancelled by nobody, so a backend that finds one holding the slot with
  no enrollment session of its own asks it to close at once (by the pid it read, re-checked against
  that pid's own command line) and follows it to its end, rather than leaving every page on "the
  portal is still open" for half an hour.

**How it ended is the helper's word, then the purpose's.** The portal helper exits `0` when the
portal ran and ended (closed by the reader or on request), `3` when IT closed the portal at its own
30-minute deadline (`PORTAL_TIMED_OUT` — told apart by the helper, because the session's clock
starts before the portal appears), `1` when it could not be opened, `2` when it refused to act.
Then what the session was FOR decides over how the portal closed: an enrollment worked when the
container holds a registration (`backup::has_device_registration`), whatever button closed it. The
registration lands in the middle of the portal's steps, so the page is told as soon as it exists
and the control becomes "Close the portal" — the READER closes it, so the portal's later steps (a
compliance check, the policies) are never cut off.

**An enrolled container whose broker holds NO account is the other purpose**
(`signin::PortalPurpose::Account`). An imported backup whose account did not come along, or an
account removed in the portal, leaves a device that is registered and signs nobody in — the
host's remedy ("sign in to Intune again") names a tool the image does not have, and the banner used
to fall through to exactly that. The portal is how an account is added on an enrolled device, so
the same session opens it for that (`broker_status.intune.can_portal_sign_in`, decided by the
backend's `portal_purpose`), and the BROKER answering for the scope the app is broken on — asked
once the portal has closed, under the session's turn as above, bounded at 30 s — is what says it
worked.

What is UNVERIFIED, all of it: the portal has never been driven through these frames; nobody has
watched the broker's dialog land over it on `:99` inside a container; whether the portal QUITS when
asked to close (rather than staying resident) is unmeasured — the helper's own deadline is what
bounds it if not; an enrollment carried through to a registration, and an account signed in through
the portal, have never been done; and the 1280x800 layout claim is the crate commit's, not a
measurement here. The mock (`web/mock/server.ts`) draws the whole flow, and
`cd web && bun run preview -- --out /tmp/si --signin` captures it.
