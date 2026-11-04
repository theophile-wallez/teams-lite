// Signing in again from the app, when the broker cannot do it alone.
//
// WHAT THIS IS. One interactive acquisition at a time, plus the window it may put up, served
// to whichever browser the app is being read in — a phone over the tailnet, usually. The
// reader sees the real Microsoft page, types their password into it and reads the number
// their Authenticator asks them to match, and the broker mints the token at the end. Before
// this the same repair meant SSH to the machine, an `Xvfb`, `x11vnc`, `websockify`, noVNC and
// a window manager (without one a click focuses nothing, so the password could not be typed
// at all), and it took about forty minutes without finishing.
//
// WHAT IT IS NOT. Not a remote desktop, and the narrowness is deliberate:
//
//   * nothing is served unless THIS backend started a sign-in and it is still running, so
//     the app can never be asked for a picture of the machine's display;
//   * the window is found only while this session's OWN interactive call is the one out (see
//     [`auth::InteractiveTurn`]), so a reader can never be shown — or type into — the window
//     the automatic rescue put up and is about to close;
//   * every frame is one window, found by the broker's own `WM_CLASS`, never the screen; and
//   * the password is never held here. It travels as the key events the reader is typing,
//     goes into the broker's own page, and nothing in this process assembles, stores or logs
//     it. There is no password field in teams-lite, on purpose.
//
// Most of the time none of this happens: `auth::rescue` mints the token from the PRT with
// nobody in front of it (SIGN-IN.md § 2), and this module is what the rarer case falls back
// on. SIGN-IN.md § 3 is the measured map of the window, its display and its teardown.
//
// THE SAME SURFACE ENROLLS A DEVICE. In EMBEDDED mode (src/intune_embedded.rs) teams-lite's
// image runs its own Intune container, and a container nobody has enrolled holds no device
// registration: nothing the broker does can sign anybody in on it. So a session has a KIND
// ([`Kind`]). A `Signin` is the above. An `Enroll` starts the PORTAL helper, which opens the
// Intune portal on the container's own display (`:99`), and serves the portal's window — and the
// broker's sign-in dialog the portal opens over it — exactly as a sign-in serves the broker's:
// one window at a time, found by its class, frames and keys through the same four methods. The
// rules above all hold for it, and the turn rule holds in its strongest form: an enrollment
// takes the interactive turn for its whole life, so the automatic rescue cannot put a window of
// its own on that display while the reader is working there — every broker dialog on it is then
// one the PORTAL asked for. It ends when the portal helper does (the portal closed), on Cancel,
// or at the portal helper's own deadline.
//
// A CANCEL IS ANSWERED BY THE HELPER, AND THE SESSION WAITS FOR THE ANSWER. The helper lives in a
// session of its own, so closing a window was the only way this side had to end it — and during
// `starting` there is no window to close: a Cancel there settled the session at once while the
// helper went on to open the portal a moment later, with nobody behind it, holding the one helper
// slot (every enrollment, repair and boot refused) for half an hour. So a Cancel now SIGNALS the
// helper (`HelperTerminator::terminate`, which it answers by closing the portal the crate's own
// way) and the session stays live — saying it is closing, and serving nothing — until the helper
// has exited, bounded by [`PORTAL_STOP_WAIT`]. Settling only then is what makes the one
// `broker_status` the backend sends at the end true: the slot is free when it says so. A helper
// that outlives that bound is said as what it is, and the backend follows it to its end.
//
// THE SAME PORTAL SIGNS AN ACCOUNT IN AGAIN ([`PortalPurpose::Account`]). A container can hold a
// device registration while its broker holds no account — an imported backup whose account did
// not come along, an account removed in the portal — and then nothing in this image can sign
// anybody in: a served sign-in needs an account to name, and the host-mode remedy ("sign in to
// Intune again") names a tool the image does not have. The portal is how an account is added on
// an enrolled device, so the same session opens it for that, and the BROKER answering decides
// how it ended rather than the registration, which was there from the start.
//
// What is UNVERIFIED about the enrollment is all of it against the tenant: the portal has never
// been driven through these frames, nobody has watched the broker's dialog land over it on `:99`
// inside a pod, and whether the portal QUITS when its window is asked to close (rather than
// staying resident) is unmeasured — the portal helper's own thirty-minute deadline is what
// bounds it if not. The mock (web/mock/server.ts) draws the whole flow; the real one is the
// user's own press.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::futures::Notified;
use tokio::sync::Notify;

use crate::auth::{self, Interactive, InteractiveTurn};
use crate::intune_embedded::{self, Helper, HelperChild, HelperStart, HelperTerminator};
use crate::xwindow::{self, Button, DisplayState, Key, SigninWindow};

/// How long a finished session's outcome stays readable before it is forgotten.
///
/// The page has to be able to see how the sign-in ENDED — the socket may have blinked at the
/// moment it did — and a settled session must not block the next attempt for longer than that.
const OUTCOME_KEPT: Duration = Duration::from_secs(60);

/// How often this session looks for the window while its own call is out.
///
/// The broker put its window up within about two seconds when this was measured, and it
/// REPLACES it between steps — the password page and the number-matching page are not the same
/// window — so the look is a loop rather than a single check. It runs only while this session
/// holds the interactive turn, and each pass is one X connection on a local socket.
const WINDOW_POLL: Duration = Duration::from_millis(300);

/// How long a sign-in whose interactive call a Cancel DROPPED keeps the turn and watches the
/// broker's display for a window still on its way — when no close of ours landed on one.
///
/// Dropping the call tells the broker nothing: there is no D-Bus cancel that is safe to make
/// (SIGN-IN.md § 3), and the broker was seen to leave its window standing when the call that
/// asked for it went away. A close is what ends its flow, and a Cancel can have had nothing to
/// close — pressed during `starting`, or in the gap where the broker has destroyed the password
/// page and not yet drawn the number-matching one (`BadWindow`, the window the session last saw
/// gone). Released at once, the turn would leave the broker to draw that next page with nobody
/// watching it: the reader told "cancelled" and still sent an Authenticator prompt, and the next
/// sign-in served a stale flow whose reply nobody awaits. So the run keeps the turn and closes
/// the first window that appears within this bound — the shape the portal helper's own
/// `close_a_portal_on_its_way` takes, and its fifteen seconds, for the same reason. The broker
/// drew its window within about two seconds when that was measured; a page drawn later than this
/// is left, which is the one thing a Cancel cannot promise. What it costs is a session that says
/// it is closing for up to this long after such a Cancel.
const CANCEL_SETTLE: Duration = Duration::from_secs(15);

/// The longest an enrollment session waits for the portal helper to end.
///
/// The helper bounds itself — [`intune_embedded::PORTAL_TIMEOUT`] once the portal is up, after a
/// wait of its own for the portal to appear — and closes the portal at that deadline, so this
/// is only the backstop for a helper that never reports back at all: past it the session
/// asks the helper to stop, settles as failed and stops serving frames, whatever the helper is
/// doing. Public because it is also the longest a portal helper can outlive its session — what
/// the backend's follower of such a helper is bounded by.
pub const ENROLL_DEADLINE: Duration =
    Duration::from_secs(intune_embedded::PORTAL_TIMEOUT.as_secs() + 5 * 60);

/// How long a session that asked the portal helper to stop waits for it to exit before settling.
///
/// The helper answers a stop at once from either of its loops, and what it then does is bounded
/// by the crate and by itself: a portal still on its way is watched for fifteen seconds so it can
/// be closed the moment it appears, `portal_stop` waits up to ten seconds for the portal to exit
/// after its TERM, and each probe between them is an exec into the container. Forty five seconds
/// covers all of that with room to spare; a helper still running past it is reported as one that
/// is still closing (and followed by the backend), never as one that has gone. The one step it
/// cannot interrupt is the launch itself (`portal_open_headless`), which returns at once on the
/// running container an enrollment is only ever offered on.
const PORTAL_STOP_WAIT: Duration = Duration::from_secs(45);

/// How long an ACCOUNT sign-in through the portal ([`PortalPurpose::Account`]) gives the broker,
/// once the portal has closed, to answer for the scope the app is broken on — for each of the two
/// calls that ask ([`account_answers`]: the interactive one under the session's turn, then the
/// funnel's). The answer is what says the account came back — the same bound the backend puts on
/// its own settle probe, because a broker call has no deadline of its own.
const ACCOUNT_PROBE: Duration = Duration::from_secs(30);

/// What a session is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Signing in again: one interactive token acquisition, and the broker window it may put up.
    Signin,
    /// A session of the Intune PORTAL in this pod's own Intune container — the portal helper's
    /// window on the container's display, and the broker's dialogs over it — opened for the
    /// purpose it carries. The wire calls every portal session `enroll` (it is the one an older
    /// page knows), and `purpose` beside it says which.
    Enroll(PortalPurpose),
}

impl Kind {
    /// The stable machine-readable tag on the wire (`SigninState.kind` in
    /// web/src/lib/protocol.ts).
    pub fn tag(self) -> &'static str {
        match self {
            Self::Signin => "signin",
            Self::Enroll(_) => "enroll",
        }
    }

    /// The windows a session of this kind may serve, and nothing else.
    fn classes(self) -> &'static [&'static str] {
        match self {
            Self::Signin => &[xwindow::SIGNIN_WM_CLASS],
            Self::Enroll(_) => xwindow::ENROLL_WM_CLASSES,
        }
    }

    /// What a portal session is for, or `None` for a sign-in.
    pub fn purpose(self) -> Option<PortalPurpose> {
        match self {
            Self::Signin => None,
            Self::Enroll(purpose) => Some(purpose),
        }
    }
}

/// What the Intune portal is opened FOR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalPurpose {
    /// The container holds no device registration: the portal ENROLLS it, and the registration
    /// is what says it worked.
    Enroll,
    /// The container IS registered and its broker holds no account: the portal signs one in
    /// again, and the broker answering is what says it worked (see the module header).
    Account,
}

impl PortalPurpose {
    /// The stable machine-readable tag on the wire (`SigninState.purpose` in
    /// web/src/lib/protocol.ts).
    pub fn tag(self) -> &'static str {
        match self {
            Self::Enroll => "enroll",
            Self::Account => "account",
        }
    }
}

/// Where a sign-in has got to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// The call is out and the broker has not drawn anything: it may still answer from the
    /// PRT, in which case the reader never sees a page at all.
    Starting,
    /// The broker is asking for a human, and its window is up.
    Waiting,
    /// A token was minted. Sign-in works again.
    Done,
    /// The reader closed it — with the button here, or the window itself.
    Cancelled,
    /// It ended some other way. The sentence is for the reader.
    Failed(String),
}

impl Phase {
    /// The stable machine-readable tag on the wire (see `SigninPhase` in
    /// web/src/lib/protocol.ts).
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Failed(_) => "failed",
        }
    }

    /// Is the flow still going? Frames and keystrokes are served for exactly these two.
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Starting | Self::Waiting)
    }
}

/// One interactive sign-in — or one enrollment — and everything the app may ask about it.
pub struct Signin {
    kind: Kind,
    /// The scope being acquired — the one the app is broken on, so the token that comes back
    /// is the token that was missing. For an account sign-in through the portal, the scope the
    /// broker is asked for once the portal closes. Empty for an enrollment, which acquires
    /// nothing itself.
    scope: String,
    /// The display the window is drawn on. For a sign-in, read from the broker, never chosen
    /// here; for an enrollment, the container's own (`xwindow::container_display`).
    display: String,
    phase: Arc<Mutex<Phase>>,
    /// The window this session's own call put up, once its watcher has found it.
    ///
    /// Cached rather than found per operation: a `find` is an X connection, a recursive tree
    /// walk and a full keyboard-mapping read, and the page asks for a status and a frame every
    /// second. It is also what keeps this session away from anybody else's window.
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
    /// The reader's Cancel, delivered to the run. `notify_one`, never `notify_waiters`: the run
    /// may still be waiting for the interactive turn when it lands, and `notify_waiters` stores
    /// nothing for a waiter that does not exist yet — a Cancel pressed then was lost, and the
    /// session went on to show the window the reader had just cancelled. `notify_one` keeps a
    /// permit the run's one `Notified` takes whenever it is next polled.
    stop: Arc<Notify>,
    /// Set the moment a Cancel is pressed (or the run gives up at its deadline): from then on the
    /// session serves no frame and takes no key, and says it is closing, while it waits for what
    /// it asked to stop — a portal helper takes seconds to close the portal, and a reader typing
    /// into a portal being closed would be typing into nothing.
    stopping: Arc<AtomicBool>,
    /// Set by a Cancel whose close LANDED on the window this session was serving, before the run
    /// is told to stop. A delivered close is what ends the broker's flow (SIGN-IN.md § 3), so the
    /// run then has no late window to watch for ([`CANCEL_SETTLE`]). Stored before the notify, so
    /// the run, woken by it, reads it.
    cancel_closed: Arc<AtomicBool>,
    started: Instant,
    /// When the phase last settled, for {@link OUTCOME_KEPT}.
    settled: Arc<Mutex<Option<Instant>>>,
}

/// What the app is told when a sign-in cannot even be started.
pub struct Refusal(pub String);

impl Signin {
    /// Start one, or say why not.
    ///
    /// `on_change` is called whenever the phase settles, so every open page hears about the
    /// end of a sign-in it may not have started — the pattern `observe_broker` already uses.
    pub fn start(
        scope: &str,
        display: &DisplayState,
        on_change: impl Fn(Phase) + Send + Sync + 'static,
    ) -> std::result::Result<Self, Refusal> {
        if crate::read_only() {
            return Err(Refusal(
                "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never signs in as the \
                 user"
                    .into(),
            ));
        }
        let display = match display {
            DisplayState::Ready { display } => display.clone(),
            other => {
                return Err(Refusal(other.refusal().unwrap_or_else(|| {
                    "The identity broker has nowhere to draw its sign-in window.".into()
                })))
            }
        };
        let work = Work::Signin { scope: scope.to_string() };
        Ok(Self::launch(Kind::Signin, scope, display, work, on_change))
    }

    /// Open the Intune portal in this pod's own Intune container — to ENROLL it, or to sign an
    /// ACCOUNT in again on a container that is enrolled ([`PortalPurpose`]) — or say why not.
    ///
    /// The same gates as a sign-in, in the same order — read-only first, before anything is
    /// looked at — plus the two a portal session adds: this process must OWN the container
    /// (embedded mode; in host mode the container is the user's, enrolled with their own
    /// `intune-container`), and the container's display must be served here. The portal helper
    /// is spawned HERE rather than in the run, so a helper that cannot start — another one
    /// holds the slot, the binary cannot be found — is a refusal the press is answered with
    /// rather than a session that opens only to fail. Whether the portal is wanted at all, and for
    /// which purpose (`intune_embedded::can_enroll`, and the account offer beside it), is the
    /// caller's to ask: it needs the backend's own knowledge of a boot it is following and of the
    /// broker's failure. `scope` is what an ACCOUNT sign-in asks the broker for once the portal
    /// closes, and is ignored for an enrollment, which acquires nothing.
    pub fn enroll(
        purpose: PortalPurpose,
        scope: &str,
        display: &DisplayState,
        on_change: impl Fn(Phase) + Send + Sync + 'static,
    ) -> std::result::Result<Self, Refusal> {
        if crate::read_only() {
            return Err(Refusal(
                "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never enrolls a device as \
                 the user"
                    .into(),
            ));
        }
        if !intune_embedded::embedded() {
            return Err(Refusal(
                "refused: this backend is not in embedded mode, so the Intune container is the \
                 user's own — enroll it with `intune-container` on that machine"
                    .into(),
            ));
        }
        let display = match display {
            DisplayState::Ready { display } => display.clone(),
            other => {
                let named = other.display().unwrap_or(intune_container::ops::CONTAINER_DISPLAY);
                return Err(Refusal(format!(
                    "The Intune container draws its portal on display {named}, and nothing is \
                     serving that display here, so the portal cannot be shown. The container may \
                     still be starting — try again in a moment."
                )));
            }
        };
        let portal = match intune_embedded::spawn_helper(Helper::Portal) {
            Ok(HelperStart::Started(child)) => child,
            Ok(HelperStart::AlreadyRunning) => {
                let which = intune_embedded::helper_running()
                    .map_or("a container helper", |helper| match helper {
                        Helper::Boot => "the container's start",
                        Helper::Repair => "a repair of the container",
                        Helper::Portal => "another enrollment",
                    });
                return Err(Refusal(format!(
                    "The Intune container is busy — {which} is at work on it — so the portal \
                     cannot be opened now. Try again once it has finished."
                )));
            }
            Err(e) => return Err(Refusal(format!("The Intune portal could not be started: {e:#}"))),
        };
        eprintln!(
            "[enroll] the portal helper is opening the Intune portal on {display} (pid {}) {}",
            portal.pid().map_or_else(|| "?".to_string(), |p| p.to_string()),
            match purpose {
                PortalPurpose::Enroll => "to enroll this container",
                PortalPurpose::Account => "to sign an account in on this enrolled container",
            }
        );
        let scope = match purpose {
            PortalPurpose::Enroll => "",
            PortalPurpose::Account => scope,
        };
        let work = Work::Enroll { portal, purpose, scope: scope.to_string() };
        Ok(Self::launch(Kind::Enroll(purpose), scope, display, work, on_change))
    }

    /// The session, and the run that drives it, for an already-checked start.
    fn launch(
        kind: Kind,
        scope: &str,
        display: String,
        work: Work,
        on_change: impl Fn(Phase) + Send + Sync + 'static,
    ) -> Self {
        let session = Self {
            kind,
            scope: scope.to_string(),
            display: display.clone(),
            phase: Arc::new(Mutex::new(Phase::Starting)),
            window: Arc::new(Mutex::new(None)),
            stop: Arc::new(Notify::new()),
            stopping: Arc::new(AtomicBool::new(false)),
            cancel_closed: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
            settled: Arc::new(Mutex::new(None)),
        };

        let run = Run {
            kind,
            work,
            display,
            phase: session.phase.clone(),
            window: session.window.clone(),
            stop: session.stop.clone(),
            stopping: session.stopping.clone(),
            cancel_closed: session.cancel_closed.clone(),
            settled: session.settled.clone(),
        };
        tokio::spawn(run.go(Box::new(on_change)));
        session
    }

    /// What this session is for.
    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The phase right now.
    ///
    /// A pure read: no X, no mutation. It was neither, and both mattered — `signin_status` is
    /// an OPEN method, so a client that merely found the socket could flip the recorded phase
    /// and make the backend do X work on the broker's display, once per call, with no token.
    /// The promotion to `Waiting` belongs to this session's own watcher, which is the only
    /// thing that knows the window is OURS.
    pub fn phase(&self) -> Phase {
        self.phase.lock().map(|p| p.clone()).unwrap_or(Phase::Starting)
    }

    /// Has this session finished long enough ago to be replaced?
    pub fn is_spent(&self) -> bool {
        let settled = self.settled.lock().ok().and_then(|s| *s);
        settled.is_some_and(|at| at.elapsed() > OUTCOME_KEPT)
    }

    /// Is this session still running? Frames and input are served for these only.
    pub fn is_live(&self) -> bool {
        self.phase().is_live()
    }

    /// Has it been asked to stop, and not finished yet? Nothing is served meanwhile.
    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// The window this session's call put up, if it has one yet.
    fn window(&self) -> Option<Arc<SigninWindow>> {
        self.window.lock().ok().and_then(|w| w.clone())
    }

    /// The window this app may act on, or the reason there is none.
    fn open_window(&self) -> Result<Arc<SigninWindow>> {
        anyhow::ensure!(
            self.is_live(),
            "this sign-in has finished — start another one to sign in again"
        );
        // Closing is not finished, and it is not a window to work in either: a key typed now
        // would land in a portal (or a broker page) this session has already asked to close.
        anyhow::ensure!(!self.is_stopping(), "this sign-in is being closed");
        self.window()
            .context("the sign-in window is not open (the broker may have answered on its own)")
    }

    /// One frame of the sign-in window, as a PNG.
    pub async fn frame(&self) -> Result<Value> {
        let window = self.open_window()?;
        let frame = tokio::task::spawn_blocking(move || window.capture())
            .await
            .context("read the sign-in window")??;
        Ok(json!({
            "width": frame.width,
            "height": frame.height,
            "png": base64::engine::general_purpose::STANDARD.encode(&frame.png),
        }))
    }

    /// Type a key into the window.
    pub async fn type_key(&self, key: Key) -> Result<()> {
        let window = self.open_window()?;
        tokio::task::spawn_blocking(move || {
            // Focus every time, and never once at the start: XTEST keys go wherever the input
            // focus is, the broker replaces its window between steps, and there is no window
            // manager on that display to move the focus for us. This is the line that made
            // the same job need `openbox` when it was done by hand.
            window.focus()?;
            window.type_key(&key)
        })
        .await
        .context("type into the sign-in window")?
    }

    /// Click (or scroll) inside the window, in its own coordinates.
    pub async fn click(&self, x: i16, y: i16, button: Button) -> Result<()> {
        let window = self.open_window()?;
        tokio::task::spawn_blocking(move || window.click(x, y, button))
            .await
            .context("click in the sign-in window")?
    }

    /// End the flow, whatever phase it is in.
    ///
    /// TWO halves, and the second one is why this is not just "close the window". Closing it is
    /// the measured way to end a flow the broker is showing (SIGN-IN.md § 3, and never
    /// `cancelInteractiveFlow`, which took the broker off the bus) — but during `starting`
    /// there is no window yet, and that used to make Cancel a silent no-op: the phase stayed
    /// `starting`, no sentence appeared, and the session stayed live for the full
    /// `SIGNIN_DEADLINE`, so no new sign-in could be started for ten minutes. So the run is
    /// also TOLD to stop, which drops the D-Bus call the way `agent_stop` drops an agent run.
    ///
    /// A PORTAL session closes nothing HERE: the portal belongs to a helper in a session of its
    /// own, and closing its window from this side was the only way to end it — which during
    /// `starting`, with no window up yet, ended nothing at all. So the run, told to stop, asks the
    /// HELPER to close the portal (the crate's own `portal_stop`, a TERM the portal writes its
    /// account state on), waits for it to have, and only then closes whatever broker dialog is
    /// left — under the interactive turn, which is the one place this session may touch that
    /// display. The answer says whether a window was being served, which is what this Cancel ends.
    ///
    /// THE STOP IS DELIVERED ON EVERY PATH, and the close is best effort. The window is the one
    /// the watcher found last, and the broker destroys and replaces its window between steps: a
    /// Cancel pressed in the gap between the password page and the number-matching page aims at a
    /// window X no longer has, and X answers `BadWindow`. That failure used to RETURN before the
    /// run was told — with `stopping` already set, so the page drew "Closing…" with no Cancel,
    /// every frame and key was refused, and the session held the slot (and the broker's page) for
    /// the full `SIGNIN_DEADLINE`. The run, told to stop, takes back whichever window is current
    /// itself (`close_open_signin_window`) — and when no close landed, neither this one nor that
    /// one (the gap, or `starting`, with nothing up to close), it keeps the turn and closes the
    /// next window the broker draws within [`CANCEL_SETTLE`]: dropping the call tells the broker
    /// nothing, so its next page could otherwise go up with nobody watching it. What a close that
    /// did not land costs is that wait, with the session saying it is closing; a page the broker
    /// draws later than the settle is left, which is the one thing not promised.
    ///
    /// Asking twice is harmless: the second press finds the session already closing.
    pub async fn cancel(&self) -> bool {
        // First, so every read from here on — a frame, a keystroke, the page's next status — knows
        // the flow is ending, whatever the run is still waiting on.
        self.stopping.store(true, Ordering::SeqCst);
        let closed = match self.kind {
            Kind::Signin => match self.window() {
                None => false,
                Some(window) => {
                    let landed = close_best_effort(move || window.close()).await;
                    self.cancel_closed.store(landed, Ordering::SeqCst);
                    landed
                }
            },
            Kind::Enroll(_) => self.window().is_some(),
        };
        self.stop.notify_one();
        closed
    }

    /// What the app draws, for one session.
    pub async fn payload(&self) -> Value {
        let phase = self.phase();
        // The SHAPE of the window, never a frame: the page polls this while the reader works, and
        // capturing to learn two numbers would read a megabyte of pixels and deflate them once a
        // second for nothing.
        let window = match (&phase, self.window()) {
            (Phase::Waiting, Some(window)) => tokio::task::spawn_blocking(move || window.size())
                .await
                .ok()
                .and_then(Result::ok)
                .map(|(width, height)| json!({ "width": width, "height": height })),
            _ => None,
        };
        let mut payload = json!({
            "kind": self.kind.tag(),
            "phase": phase.tag(),
            "detail": match &phase {
                Phase::Failed(words) => words.clone(),
                _ => String::new(),
            },
            "scope": self.scope,
            "display": self.display,
            "waited_ms": self.started.elapsed().as_millis() as u64,
            "window": window,
            // A live flow that has been asked to stop and is waiting for what it asked — the
            // page says it is closing rather than going on offering the Cancel just pressed.
            "stopping": phase.is_live() && self.is_stopping(),
        });
        // A portal session says what the portal is open FOR, and whether the container holds a
        // registration YET, while the portal is still open: the registration lands in the middle
        // of the portal's steps, and the portal goes on (a compliance check, the policies) before
        // it is finished. Closing it at the first sign of a registration could cut those steps
        // off, so the page is told and the READER closes it. A few `stat`s of the persisted state,
        // on every poll.
        if let Some(purpose) = self.kind.purpose() {
            payload["purpose"] = json!(purpose.tag());
            payload["registered"] = json!(intune_container::backup::has_device_registration());
        }
        payload
    }
}

/// Ask a window to close, BEST EFFORT: true when the request was delivered, false — said in the
/// log, never returned as an error — when it was not. What it serves is [`Signin::cancel`], whose
/// stop must go out whatever this answers.
async fn close_best_effort(close: impl FnOnce() -> Result<()> + Send + 'static) -> bool {
    match tokio::task::spawn_blocking(close).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            eprintln!(
                "[signin] the sign-in window could not be asked to close ({e:#}) — the run, told to \
                 stop, takes back whichever window is up now, or the next one the broker draws"
            );
            false
        }
        Err(e) => {
            eprintln!("[signin] closing the sign-in window did not finish: {e}");
            false
        }
    }
}

/// What a session's run is waiting on.
enum Work {
    /// The interactive call for `scope`.
    Signin { scope: String },
    /// The portal helper this session spawned — its exit is the end of the portal session — what
    /// the portal was opened for, and the scope an account sign-in asks the broker for at the end.
    Enroll { portal: HelperChild, purpose: PortalPurpose, scope: String },
}

/// The half of a session that runs on its own: the interactive call (or the portal helper),
/// the watcher that finds its window, and the settling at the end.
struct Run {
    kind: Kind,
    work: Work,
    display: String,
    phase: Arc<Mutex<Phase>>,
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
    stop: Arc<Notify>,
    stopping: Arc<AtomicBool>,
    cancel_closed: Arc<AtomicBool>,
    settled: Arc<Mutex<Option<Instant>>>,
}

impl Run {
    async fn go(self, on_change: Box<dyn Fn(Phase) + Send + Sync>) {
        let Run { kind, work, display, phase, window, stop, stopping, cancel_closed, settled } = self;
        // The reader's Cancel, armed FIRST — before the turn is waited for — and polled again
        // wherever the run waits, so it is never lost between two waits. A Cancel that landed
        // while the run still waited for the turn used to wake nobody, and the session went on to
        // serve the very window the reader had cancelled.
        let cancelled = stop.notified();
        tokio::pin!(cancelled);
        // Wait for the turn first, RACED against that Cancel. Everything after the turn knows that
        // the window on the broker's display, if one appears, is the one this call put there —
        // which is what makes it safe to show it to a reader and send their keystrokes to it. A
        // PORTAL session holds the turn too, for its whole life, and for the same reason: with it
        // held the automatic rescue stands down, so every broker dialog on the container's display
        // is one the portal asked for, and never the rescue's own window about to be taken back.
        // BIASED to the Cancel, here and in every wait after it: a Cancel already pressed wins over
        // a turn (or a call) that is ready at the same moment, so a flow the reader ended never
        // starts a call, or shows a window, it was not going to keep.
        let turn = tokio::select! {
            biased;
            () = cancelled.as_mut() => None,
            turn = auth::interactive_turn() => Some(turn),
        };

        let next = match work {
            Work::Signin { scope } => {
                run_signin(turn, &scope, &display, &phase, &window, &cancel_closed, cancelled.as_mut())
                    .await
            }
            Work::Enroll { portal, purpose, scope } => {
                let session = PortalSession {
                    purpose,
                    scope: &scope,
                    display: &display,
                    phase: &phase,
                    window: &window,
                    stopping: &stopping,
                };
                run_portal(turn, portal, session, cancelled.as_mut()).await
            }
        };

        if let Ok(mut held) = window.lock() {
            *held = None;
        }
        if let Ok(mut held) = phase.lock() {
            *held = next.clone();
        }
        if let Ok(mut held) = settled.lock() {
            *held = Some(Instant::now());
        }
        eprintln!("[{}] {}", kind.tag(), describe(kind, &next));
        on_change(next);
    }
}

/// A SIGN-IN's run, from the race for the turn on: the interactive call, raced against the
/// Cancel, with the window watched for while the call is out, and taken back at the end — after
/// a Cancel that dropped the call with nothing closed, for [`CANCEL_SETTLE`] more.
async fn run_signin(
    turn: Option<InteractiveTurn>,
    scope: &str,
    display: &str,
    phase: &Arc<Mutex<Phase>>,
    window: &Arc<Mutex<Option<Arc<SigninWindow>>>>,
    cancel_closed: &AtomicBool,
    mut cancelled: Pin<&mut Notified<'_>>,
) -> Phase {
    // Cancelled while the turn was still somebody else's — the automatic rescue's, bounded in
    // seconds. No call of ours ever went out, so there is no window of ours to close, and the one
    // on the display, if there is one, is the rescue's own to take back.
    let Some(turn) = turn else { return Phase::Cancelled };
    let watcher = tokio::spawn(watch_for_window(
        display.to_string(),
        Kind::Signin.classes(),
        phase.clone(),
        window.clone(),
    ));
    // Whether the call was ever polled, so whether it can have reached the broker at all: the
    // race below is biased to the Cancel, and a Cancel already pressed wins it before the call's
    // first poll — dropping a call that never went out, with nothing on its way to watch for.
    let asked = AtomicBool::new(false);
    let (next, dropped) = tokio::select! {
        biased;
        // The reader gave up, or closed the window. Dropping the call is what ends it:
        // there is no D-Bus cancel that is safe to make (SIGN-IN.md § 3).
        () = cancelled.as_mut() => (Phase::Cancelled, asked.load(Ordering::SeqCst)),
        outcome = async {
            asked.store(true, Ordering::SeqCst);
            auth::interactive_token(&turn, scope, auth::SIGNIN_DEADLINE).await
        } => (signin_outcome(outcome, scope).await, false),
    };
    watcher.abort();
    // Whatever ended it, the window must not be left standing on a display nobody is
    // watching — the rule `auth::rescue` follows for its own abandoned attempt.
    if !matches!(next, Phase::Done) {
        let closed = tokio::task::spawn_blocking(xwindow::close_open_signin_window)
            .await
            .unwrap_or(false);
        // A call the Cancel DROPPED is one the broker was never told about, and a close is what
        // ends its flow. Where none landed — the Cancel's own failed (the gap between two of the
        // broker's pages) or had nothing to close (`starting`), and the take-back above found
        // nothing either — the broker may still be about to draw, so the turn is kept and its
        // display watched for that window, which is closed the moment it appears.
        if dropped && !closed && !cancel_closed.load(Ordering::SeqCst) {
            let display = display.to_string();
            let caught = tokio::task::spawn_blocking(move || {
                close_a_window_on_its_way(&display, Kind::Signin.classes(), CANCEL_SETTLE)
            })
            .await
            .unwrap_or(false);
            if caught {
                eprintln!("[signin] the broker drew its next page after the Cancel — taken back");
            }
        }
    }
    // Released only now: the window this session may have left is closed above, so the next
    // interactive call — the rescue's included — starts on a display with none of ours.
    drop(turn);
    next
}

/// Watch `display` for up to `bound` for a window of `classes` that a dropped call may still put
/// up, and ask the first one found to close — true once a close was delivered, false when none
/// was found to close in time. Blocking (X is a socket), so the run hands it to `spawn_blocking`.
///
/// A look that finds nothing is not the end of the wait — only the bound is — because what this
/// watches for is a window NOT up yet: the shape the portal helper's `close_a_portal_on_its_way`
/// takes for a portal launched in the background. One delivered close is enough, because it ends
/// the broker's flow (SIGN-IN.md § 3); a close X refuses — the window replaced again under it —
/// is not, and the watch goes on.
fn close_a_window_on_its_way(display: &str, classes: &[&str], bound: Duration) -> bool {
    let until = Instant::now() + bound;
    loop {
        if let Ok(Some(window)) = SigninWindow::find_any(display, classes)
            && window.close().is_ok()
        {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(WINDOW_POLL);
    }
}

/// How a sign-in's interactive call ended, in the phase it settles.
async fn signin_outcome(outcome: Result<Interactive>, scope: &str) -> Phase {
    match outcome {
        Ok(Interactive::Token(_)) => {
            // Ask for the token again through the ordinary funnel: that is what records the
            // broker as healthy and tells every open page, and it must succeed now — the
            // resource's refresh token is fresh. One spelling of "sign-in works again" rather
            // than a second way to say it.
            match auth::get_token(scope).await {
                Ok(_) => Phase::Done,
                // Vanishingly unlikely and worth saying plainly rather than reporting a success
                // the app then contradicts.
                Err(e) => Phase::Failed(format!(
                    "The sign-in worked, but the token could not be read back: {e:#}"
                )),
            }
        }
        Ok(Interactive::Cancelled) => Phase::Cancelled,
        Ok(Interactive::StillWaiting) => Phase::Failed(
            "The sign-in was not finished in time. Start it again when you are ready.".into(),
        ),
        Err(e) => Phase::Failed(format!("{e:#}")),
    }
}

/// What a portal session's run reads besides its helper, its turn and the Cancel.
struct PortalSession<'a> {
    purpose: PortalPurpose,
    scope: &'a str,
    display: &'a str,
    phase: &'a Arc<Mutex<Phase>>,
    window: &'a Arc<Mutex<Option<Arc<SigninWindow>>>>,
    stopping: &'a AtomicBool,
}

/// How a portal session's wait for its helper ended.
enum PortalEnding {
    /// The helper exited on its own — the portal closed, or never opened — with this result.
    Exited(Result<i32>),
    /// The reader pressed Cancel.
    Cancelled,
    /// [`ENROLL_DEADLINE`] passed with the helper still running.
    Deadline,
}

/// The sentence a portal session settles with when the helper it asked to stop has not exited
/// within [`PORTAL_STOP_WAIT`]: the slot is still the helper's, and saying the session simply
/// ended would offer a press the backend refuses.
const PORTAL_STILL_CLOSING: &str = "The Intune portal was asked to close and has not finished \
     closing yet, so nothing else can be started on the Intune container until it has — it \
     closes on its own within half an hour at the latest. This container's log says what it is \
     doing, in lines starting teams-lite(intune-portal).";

/// A PORTAL session's run, from the race for the turn on: wait for the helper — or for the
/// Cancel, or the deadline, in which case the helper is ASKED to stop and waited for — then take
/// back whatever broker dialog is left, and let the purpose decide how it ended.
///
/// THE SESSION OUTLIVES ITS HELPER, NEVER THE OTHER WAY ROUND. The portal belongs to a helper in
/// a session of its own that holds the one helper slot; a session that settled while the helper
/// was still at work told every page the slot was free while the backend refused every press of
/// it, and left a portal nobody would ever serve on the display. So the helper's end is pinned
/// before the wait and still awaited after a Cancel wins it.
async fn run_portal(
    turn: Option<InteractiveTurn>,
    portal: HelperChild,
    session: PortalSession<'_>,
    mut cancelled: Pin<&mut Notified<'_>>,
) -> Phase {
    let terminator = portal.terminator();
    let exited = portal.finished();
    tokio::pin!(exited);

    let ending = match &turn {
        // Cancelled before the turn: nothing has been looked at, and the helper is stopped below.
        None => PortalEnding::Cancelled,
        Some(_) => {
            let watcher = tokio::spawn(watch_for_window(
                session.display.to_string(),
                Kind::Enroll(session.purpose).classes(),
                session.phase.clone(),
                session.window.clone(),
            ));
            let ending = tokio::select! {
                biased;
                () = cancelled.as_mut() => PortalEnding::Cancelled,
                ended = tokio::time::timeout(ENROLL_DEADLINE, exited.as_mut()) => match ended {
                    Ok(result) => PortalEnding::Exited(result),
                    Err(_) => PortalEnding::Deadline,
                },
            };
            watcher.abort();
            ending
        }
    };

    let mut next = match ending {
        PortalEnding::Exited(result) => portal_outcome(result),
        asked => {
            // Said on the session before the wait, whichever way it was asked: from here nothing
            // is served, and the page says the portal is closing.
            session.stopping.store(true, Ordering::SeqCst);
            if !stop_portal(&terminator, exited.as_mut()).await {
                Phase::Failed(PORTAL_STILL_CLOSING.into())
            } else if matches!(asked, PortalEnding::Deadline) {
                Phase::Failed(
                    "The Intune portal's helper did not end in time, so it was asked to close the \
                     portal. Start it again when you are ready; this container's log says what it \
                     was doing, in lines starting teams-lite(intune-portal)."
                        .into(),
                )
            } else {
                Phase::Cancelled
            }
        }
    };

    // The take-back, always, and under the turn — taken now if the Cancel won the race for it,
    // because the turn is what says the windows on that display are this session's to close. A
    // broker dialog the portal asked for outlives the portal (it is the broker's window, not the
    // portal's), and left standing it is a pending call nobody will ever answer; nothing is open
    // when the helper closed the portal and the portal opened nothing, so this then closes nothing.
    let turn = match turn {
        Some(turn) => turn,
        None => auth::interactive_turn().await,
    };
    let display = session.display.to_string();
    let classes = Kind::Enroll(session.purpose).classes();
    let _ = tokio::task::spawn_blocking(move || xwindow::close_windows(&display, classes)).await;

    // What the session is FOR decides last, over how the portal happened to close: a reader who
    // did what the portal was opened for and then closed it — or pressed Cancel once it was done —
    // has done it, and calling that "cancelled" would send them to do it again. Each arm RELEASES
    // the turn — only once the windows this session may have left are closed above, so the next
    // interactive call, the rescue's included, starts on a display with none of ours.
    let worked = match session.purpose {
        // An enrollment worked when the container holds a registration.
        PortalPurpose::Enroll => {
            let registered =
                tokio::task::spawn_blocking(intune_container::backup::has_device_registration)
                    .await
                    .unwrap_or(false);
            drop(turn);
            registered
        }
        // An account sign-in worked when the broker answers for the scope the app is broken on.
        // The registration says nothing here: it was there from the start.
        PortalPurpose::Account => {
            // Nothing is served from here on — the portal has closed — and the page says the app is
            // asking the broker whether the account is back, which can take [`ACCOUNT_PROBE`].
            session.stopping.store(true, Ordering::SeqCst);
            account_answers(turn, session.scope, session.display, classes).await
        }
    };
    if worked {
        next = Phase::Done;
    }
    next
}

/// Does the broker answer for `scope` again, once an ACCOUNT sign-in's portal has closed? Takes
/// the turn the session holds, and releases it.
///
/// ASKED UNDER THAT TURN, and that is the whole of why this is its own function. Right after a
/// fresh account sign-in the SILENT call refuses — no refresh token exists yet for this client and
/// resource, and the silent path never redeems the PRT (SIGN-IN.md § 2) — and the ordinary funnel
/// hands that refusal to `auth::rescue`, which only TRIES for the turn. This session holds it, so
/// the rescue stood down, the session settled "sign-in is still broken", and seconds later the
/// enrollment's own follow-up call — the turn released by then — minted the token and took the
/// banner down under a panel saying the opposite. So the interactive acquisition the rescue would
/// have made is made HERE, under the held turn: it mints from the PRT with nobody in front of it,
/// or puts a window up that nobody is shown any more, which is taken back. Then the turn is
/// released, and only then is the token asked for through the funnel — which records the broker as
/// healthy and tells every open page, and finds the fresh refresh token the mint left.
async fn account_answers(
    turn: InteractiveTurn,
    scope: &str,
    display: &str,
    classes: &'static [&'static str],
) -> bool {
    // Bounded as a whole, the account lookup included: a broker call has no deadline of its own.
    let minted = matches!(
        tokio::time::timeout(ACCOUNT_PROBE, auth::interactive_token(&turn, scope, ACCOUNT_PROBE)).await,
        Ok(Ok(Interactive::Token(_)))
    );
    if !minted {
        // A window the call put up, with nobody watching it: taken back while the turn still says
        // it is this session's to close.
        let display = display.to_string();
        let _ = tokio::task::spawn_blocking(move || xwindow::close_windows(&display, classes)).await;
    }
    drop(turn);
    minted && matches!(tokio::time::timeout(ACCOUNT_PROBE, auth::get_token(scope)).await, Ok(Ok(_)))
}

/// Ask the portal helper to close the portal and exit, and wait — bounded by
/// [`PORTAL_STOP_WAIT`] — for it to have. True once it has exited, however it exited: a helper
/// signalled before it could listen for the request dies of it, which is what was asked too.
async fn stop_portal(
    terminator: &HelperTerminator,
    exited: Pin<&mut impl Future<Output = Result<i32>>>,
) -> bool {
    match terminator.terminate() {
        Ok(true) => eprintln!("[enroll] asked the portal helper to close the Intune portal"),
        // It had already ended: its exit is on its way to the handle below.
        Ok(false) => {}
        Err(e) => eprintln!("[enroll] could not ask the portal helper to stop: {e:#}"),
    }
    if tokio::time::timeout(PORTAL_STOP_WAIT, exited).await.is_ok() {
        return true;
    }
    eprintln!(
        "[enroll] the portal helper had not exited {} s after it was asked to — the backend \
         follows it to its end",
        PORTAL_STOP_WAIT.as_secs()
    );
    false
}

/// How a portal session ended, read off the portal helper's own exit
/// (`intune_embedded::portal_main`'s codes) — the helper's word, never a guess from this side's
/// clock, which starts before the portal appears and cannot tell the helper's own deadline from a
/// reader closing it just before it. What the session was FOR is checked after this and wins over
/// it — this only names the ending when that did not happen.
fn portal_outcome(exited: Result<i32>) -> Phase {
    match exited {
        // The reader closed it (or the session asked the helper to).
        Ok(0) => Phase::Cancelled,
        Ok(intune_embedded::PORTAL_TIMED_OUT) => Phase::Failed(format!(
            "The Intune portal was open for {} minutes without being finished, so it was closed. \
             Start it again when you are ready.",
            intune_embedded::PORTAL_TIMEOUT.as_secs() / 60
        )),
        Ok(2) => Phase::Failed(
            "The portal helper refused to open the portal (read-only, or not in embedded mode) — \
             this container's log says which, in lines starting teams-lite(intune-portal)."
                .into(),
        ),
        Ok(code) => Phase::Failed(format!(
            "The Intune portal could not be opened (its helper ended with exit {code}). This \
             container's log says why, in lines starting teams-lite(intune-portal)."
        )),
        Err(e) => Phase::Failed(format!("Lost track of the Intune portal: {e:#}")),
    }
}

/// Look for the session's window while its call (or its portal) is out, and promote the phase
/// once it is there.
///
/// The broker publishes no "I am asking a human" signal, so the window going up IS the signal.
/// Re-found on every pass rather than kept once: the broker REPLACES its window between steps,
/// so a handle held from the password page goes stale on the number-matching one — and during
/// an enrollment the topmost window moves between the portal and the broker's dialog over it.
async fn watch_for_window(
    display: String,
    classes: &'static [&'static str],
    phase: Arc<Mutex<Phase>>,
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
) {
    loop {
        let found = {
            let display = display.clone();
            tokio::task::spawn_blocking(move || {
                SigninWindow::find_any(&display, classes).ok().flatten()
            })
                .await
                .ok()
                .flatten()
                .map(Arc::new)
        };
        if let Some(found) = found {
            if let Ok(mut held) = window.lock() {
                *held = Some(found);
            }
            if let Ok(mut held) = phase.lock()
                && *held == Phase::Starting
            {
                *held = Phase::Waiting;
            }
        }
        tokio::time::sleep(WINDOW_POLL).await;
    }
}

/// One journal line per outcome. The words are for whoever reads the unit's log after the
/// fact, so they name what happened rather than which enum arm it was.
fn describe(kind: Kind, phase: &Phase) -> String {
    use PortalPurpose::{Account, Enroll};
    match (kind, phase) {
        (Kind::Signin, Phase::Done) => "the sign-in worked — the broker minted a token".into(),
        (Kind::Signin, Phase::Cancelled) => "the sign-in was ended before it finished".into(),
        (Kind::Signin, Phase::Failed(words)) => format!("the sign-in did not finish: {words}"),
        (Kind::Enroll(Enroll), Phase::Done) => {
            "the enrollment worked — the Intune container holds a device registration".into()
        }
        (Kind::Enroll(Enroll), Phase::Cancelled) => {
            "the Intune portal was closed before the device was enrolled".into()
        }
        (Kind::Enroll(Enroll), Phase::Failed(words)) => {
            format!("the enrollment did not finish: {words}")
        }
        (Kind::Enroll(Account), Phase::Done) => {
            "the account sign-in through the Intune portal worked — the broker answers again".into()
        }
        (Kind::Enroll(Account), Phase::Cancelled) => {
            "the Intune portal was closed before an account was signed in".into()
        }
        (Kind::Enroll(Account), Phase::Failed(words)) => {
            format!("the account sign-in through the Intune portal did not finish: {words}")
        }
        (_, Phase::Starting | Phase::Waiting) => format!("the {} is still going", kind.tag()),
    }
}

/// Read the key or the click a client sent.
///
/// ONE parse for both shapes, and it refuses a request that names both: deciding on the
/// presence of `x` used to mean `{"char":"a","x":5,"y":5}` clicked at (5,5), dropped the
/// character and answered `{"sent": true}`, so the caller believed the key had landed. This is
/// the one RPC whose side effect is a key going into somebody's password field.
#[derive(Debug)]
pub enum Input {
    Key(Key),
    Click(i16, i16, Button),
}

pub fn parse_input(params: &Value) -> Result<Input> {
    let names_a_key = params.get("char").is_some() || params.get("key").is_some();
    let names_a_click = params.get("x").is_some() || params.get("y").is_some();
    anyhow::ensure!(
        !(names_a_key && names_a_click),
        "send a key or a click, never both in one request"
    );
    if names_a_click {
        let (x, y, button) = parse_click(params)?;
        return Ok(Input::Click(x, y, button));
    }
    Ok(Input::Key(parse_key(params)?))
}

/// Read the key a client sent. One of a character or a named key, never both.
///
/// The parse is narrow because it is a trust boundary: a client hands this a string, and what
/// comes out the other end is a keystroke into somebody's sign-in page. A `char` is one
/// character or nothing — a "character" of ten letters would be a whole password in one field
/// nobody could see — and a name is checked against the allowlist by
/// `Key::keysym` before anything is pressed.
fn parse_key(params: &Value) -> Result<Key> {
    if let Some(text) = params.get("char").and_then(Value::as_str) {
        let mut chars = text.chars();
        let (Some(c), None) = (chars.next(), chars.next()) else {
            anyhow::bail!("`char` must be exactly one character");
        };
        return Ok(Key::Char(c));
    }
    if let Some(name) = params.get("key").and_then(Value::as_str) {
        anyhow::ensure!(name.len() <= 32, "`key` is not a key name");
        return Ok(Key::Named(name.to_string()));
    }
    anyhow::bail!("send either `char` (one character) or `key` (a key name)")
}

/// Read the pointer action a client sent.
fn parse_click(params: &Value) -> Result<(i16, i16, Button)> {
    let coord = |name: &str| -> Result<i16> {
        let value = params
            .get(name)
            .and_then(Value::as_i64)
            .with_context(|| format!("`{name}` must be a number"))?;
        // Clamped again in `SigninWindow::click` against the window's real size; bounded here
        // so a client cannot hand X an out-of-range coordinate at all.
        Ok(value.clamp(0, i16::MAX as i64) as i16)
    };
    let button = match params.get("button").and_then(Value::as_str).unwrap_or("left") {
        "left" => Button::Left,
        "scroll_up" => Button::ScrollUp,
        "scroll_down" => Button::ScrollDown,
        other => anyhow::bail!("`{other}` is not a button this app sends"),
    };
    Ok((coord("x")?, coord("y")?, button))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_live_phase_is_served_frames_and_keys() {
        assert!(Phase::Starting.is_live());
        assert!(Phase::Waiting.is_live());
        // A finished sign-in must not keep a window readable: the whole narrowness of this
        // module is that nothing is served unless a sign-in is really going.
        assert!(!Phase::Done.is_live());
        assert!(!Phase::Cancelled.is_live());
        assert!(!Phase::Failed("whatever".into()).is_live());
    }

    #[test]
    fn every_phase_has_its_own_wire_tag() {
        let all = [
            Phase::Starting,
            Phase::Waiting,
            Phase::Done,
            Phase::Cancelled,
            Phase::Failed("x".into()),
        ];
        let mut tags: Vec<&str> = all.iter().map(Phase::tag).collect();
        let count = tags.len();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(tags.len(), count, "two phases share a wire tag");
    }

    #[test]
    fn a_key_is_one_character_or_a_name_and_never_a_password() {
        assert_eq!(parse_key(&json!({"char": "a"})).unwrap(), Key::Char('a'));
        assert_eq!(parse_key(&json!({"char": "é"})).unwrap(), Key::Char('é'));
        assert_eq!(
            parse_key(&json!({"key": "Enter"})).unwrap(),
            Key::Named("Enter".into())
        );
        // The one that matters: a whole string is not a character. Accepting it would type a
        // password out of one field with no way for the reader to see what went in.
        assert!(parse_key(&json!({"char": "hunter2"})).is_err());
        assert!(parse_key(&json!({"char": ""})).is_err());
        assert!(parse_key(&json!({})).is_err());
        assert!(parse_key(&json!({"key": "x".repeat(64)})).is_err());
    }

    #[test]
    fn a_click_is_bounded_before_it_reaches_x() {
        let (x, y, button) = parse_click(&json!({"x": 10, "y": 20})).unwrap();
        assert_eq!((x, y), (10, 20));
        assert_eq!(button, Button::Left, "left is the default");
        // Out of range on either side is brought back rather than wrapped: a negative
        // coordinate cast to i16 would land the pointer somewhere else entirely.
        assert_eq!(parse_click(&json!({"x": -5, "y": 3})).unwrap().0, 0);
        assert_eq!(parse_click(&json!({"x": 999_999, "y": 3})).unwrap().0, i16::MAX);
        assert!(parse_click(&json!({"x": 1})).is_err(), "y is required");
        assert!(parse_click(&json!({"x": 1, "y": 1, "button": "middle"})).is_err());
        assert_eq!(
            parse_click(&json!({"x": 1, "y": 1, "button": "scroll_down"})).unwrap().2,
            Button::ScrollDown
        );
    }

    #[test]
    fn a_request_naming_both_a_key_and_a_click_is_refused() {
        // It used to click and silently drop the character, answering `{"sent": true}` — so the
        // caller believed a key had gone into the password field.
        assert!(parse_input(&json!({"char": "a", "x": 5, "y": 5})).is_err());
        assert!(parse_input(&json!({"key": "Enter", "x": 5, "y": 5})).is_err());
        // Either alone is fine.
        assert!(matches!(parse_input(&json!({"char": "a"})).unwrap(), Input::Key(_)));
        assert!(matches!(parse_input(&json!({"x": 1, "y": 2})).unwrap(), Input::Click(1, 2, _)));
        // A half-named click is a bad click rather than a key with no name.
        let err = parse_input(&json!({"x": 1})).unwrap_err().to_string();
        assert!(err.contains("`y`"), "{err}");
    }

    #[test]
    fn a_read_only_backend_never_signs_in_as_the_user() {
        // The env is process-wide and `read_only()` caches it, so this asserts the ORDER of
        // the checks instead: the read-only refusal is decided before the display is looked
        // at, so a screenshot backend cannot sign in even on a machine where it would work.
        let whole = include_str!("signin.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let start = source.find("pub fn start(").expect("Signin::start");
        let body = &source[start..];
        let read_only_at = body.find("crate::read_only()").expect("the read-only gate");
        let display_at = body.find("DisplayState::Ready").expect("the display check");
        assert!(
            read_only_at < display_at,
            "the read-only refusal must come before anything else"
        );
    }

    /// This file's source above its tests, and one function's body in it.
    fn source() -> &'static str {
        let whole = include_str!("signin.rs");
        &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())]
    }

    /// The body of the item `start` opens — a free function ends at the first unindented brace,
    /// a method (`start` indented) at the first brace indented as it is.
    fn body_of(start: &str) -> &'static str {
        let source = source();
        let at = source.find(start).unwrap_or_else(|| panic!("{start}"));
        let rest = &source[at..];
        let end = if start.starts_with("    ") { "\n    }\n" } else { "\n}\n" };
        &rest[..rest.find(end).unwrap_or(rest.len())]
    }

    #[test]
    fn a_window_is_only_looked_for_once_this_sessions_own_call_is_out() {
        // The turn is what says the window on the broker's display is OURS. Looked for before
        // it, a session promotes itself on the window the automatic rescue put up — and the
        // reader types their password into the flow whose token nobody reads, which is the
        // failure `auth::interactive_turn` exists to prevent.
        let go = body_of("    async fn go(");
        let turn_at = go.find("turn = auth::interactive_turn() => Some(turn)").expect("the turn");
        let work_at = go.find("match work {").expect("the work");
        assert!(turn_at < work_at, "the turn is raced for before any work starts");
        assert!(!go.contains("watch_for_window("), "nothing is looked for before the turn");
        // Each run looks only once it HOLDS the turn: a Cancel that won the race leaves it with
        // `None`, and then nothing is watched at all.
        let signin = body_of("async fn run_signin(");
        let held = signin.find("let Some(turn) = turn else").expect("the sign-in needs the turn");
        assert!(held < signin.find("watch_for_window(").expect("its watcher"));
        let portal = body_of("async fn run_portal(");
        let held = portal.find("Some(_) => {").expect("the portal session needs the turn");
        assert!(held < portal.find("watch_for_window(").expect("its watcher"));
        // And the phase is promoted by that watcher alone, never by a read.
        let phase = body_of("    pub fn phase(&self)");
        assert!(
            !phase.contains("Waiting"),
            "reading the phase must not promote it: `signin_status` is an OPEN method"
        );
    }

    #[test]
    fn cancelling_ends_the_flow_even_before_a_window_exists() {
        // Cancel used to be a silent no-op during `starting` — the phase most sign-ins live in.
        // Closing the window is still how a flow the broker is SHOWING is ended, but the run is
        // told to stop either way, or the session stays live for the full deadline and no new
        // sign-in can be started for ten minutes.
        //
        // And it is told with a PERMIT: `notify_waiters` stores nothing for a waiter that does not
        // exist yet, so a Cancel pressed while the run still waited for the turn woke nobody and
        // the session went on to serve the window the reader had cancelled.
        let cancel = body_of("    pub async fn cancel(");
        assert!(cancel.contains("self.stop.notify_one()"), "cancel must leave a permit");
        assert!(!cancel.contains("notify_waiters"), "a Cancel with no waiter yet is lost");
        assert!(
            cancel.find("self.stopping.store(true").expect("said first")
                < cancel.find("self.stop.notify_one()").unwrap(),
            "the session says it is closing before the run is woken"
        );
        // The run arms its one `Notified` before anything is awaited, races the turn against it,
        // and waits on it again in BOTH kinds of session.
        let go = body_of("    async fn go(");
        let armed = go.find("let cancelled = stop.notified();").expect("armed");
        let raced = go.find("() = cancelled.as_mut() => None,").expect("the turn is raced");
        assert!(armed < raced && armed < go.find("auth::interactive_turn()").unwrap());
        assert!(body_of("async fn run_signin(").contains("() = cancelled.as_mut() => (Phase::Cancelled,"));
        assert!(
            body_of("async fn run_portal(").contains("() = cancelled.as_mut() => PortalEnding::Cancelled")
        );
    }

    // A Cancel whose close fails — the cached window destroyed between two of the broker's steps,
    // answered `BadWindow` — used to return before the run was told, with `stopping` already set:
    // "Closing…" with no Cancel, nothing served, and the slot held for the full deadline. The close
    // is best effort now, and the stop goes out on every path.
    #[tokio::test(flavor = "current_thread")]
    async fn a_close_that_fails_never_keeps_the_stop_from_the_run() {
        assert!(!close_best_effort(|| Err(anyhow::anyhow!("X11 error: BadWindow"))).await, "said, not raised");
        assert!(close_best_effort(|| Ok(())).await);
        let cancel = body_of("    pub async fn cancel(");
        assert!(cancel.starts_with("    pub async fn cancel(&self) -> bool {"), "a Cancel cannot fail");
        let close = cancel.find("close_best_effort(move || window.close()).await").expect("best effort");
        let notify = cancel.find("self.stop.notify_one()").expect("the stop");
        assert!(close < notify, "the stop follows the close");
        assert!(!cancel.contains(")?"), "nothing in a Cancel returns before the run is told to stop");
        assert!(!cancel.contains("return"), "nor leaves early any other way");
    }

    // That best-effort close is half of a Cancel and the run's take-back the other half — and the
    // take-back alone ran ONCE, at once: a Cancel landing in the gap between two of the broker's
    // pages (its close answered `BadWindow`) or during `starting` (nothing up to close) found
    // nothing, released the turn, and left the broker — which dropping the call tells nothing — to
    // draw its next page a moment later with nobody watching it: an Authenticator prompt after
    // "cancelled", and a stale flow the next sign-in would serve. So a Cancel that dropped a call
    // which was out, with no close landed, keeps the turn and closes the next window that appears
    // within a bound — and releases the turn only after.
    #[test]
    fn a_cancel_that_dropped_the_call_watches_for_a_late_window_before_the_turn_goes() {
        let cancel = body_of("    pub async fn cancel(");
        let landed = cancel.find("self.cancel_closed.store(landed, Ordering::SeqCst);").expect("a landed close is recorded");
        assert!(landed < cancel.find("self.stop.notify_one()").unwrap(), "recorded before the run is woken");

        let signin = body_of("async fn run_signin(");
        let asked = signin.find("asked.store(true, Ordering::SeqCst);").expect("the call says it went out");
        let call = signin.find("auth::interactive_token(&turn, scope, auth::SIGNIN_DEADLINE)").expect("the call");
        assert!(asked < call, "said as the call is first polled, never after it answers");
        let dropped = signin
            .find("() = cancelled.as_mut() => (Phase::Cancelled, asked.load(Ordering::SeqCst)),")
            .expect("only the Cancel's own arm drops a call");
        assert!(dropped < asked, "the Cancel's arm comes first in the biased race");
        assert!(signin.contains("(signin_outcome(outcome, scope).await, false)"), "an answered call was not dropped");
        let take_back = signin.find("xwindow::close_open_signin_window").expect("the take-back");
        let gate = signin.find("if dropped && !closed && !cancel_closed.load(Ordering::SeqCst) {").expect("the gate");
        let settle = signin.find("close_a_window_on_its_way(&display, Kind::Signin.classes(), CANCEL_SETTLE)").expect("the settle");
        let released = signin.find("drop(turn);").expect("the turn is released");
        assert!(
            take_back < gate && gate < settle && settle < released,
            "the take-back, then — when nothing landed — the watch for a late window, and only then the turn goes"
        );
        assert!(
            CANCEL_SETTLE >= Duration::from_secs(10) && CANCEL_SETTLE <= Duration::from_secs(20),
            "long enough for the broker's next page, short enough that a Cancel still ends"
        );
    }

    // The watch itself: a look that finds nothing is not the end of it — what it waits for is a
    // window not drawn yet — and its bound is. An address that is no display fails every look
    // without reaching any X server.
    #[test]
    fn a_late_window_is_watched_for_until_the_bound_and_no_longer() {
        let started = Instant::now();
        assert!(!close_a_window_on_its_way("not a display", Kind::Signin.classes(), Duration::from_millis(400)));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(400), "it waited its bound: {waited:?}");
        assert!(waited < Duration::from_secs(3), "and ended at it: {waited:?}");
    }

    /// A session parked on the turn: the turn is held by the test (as the rescue would hold it), so
    /// the run can never take it — and never reach the interactive call, which is D-Bus.
    fn parked_signin() -> (Signin, tokio::sync::mpsc::UnboundedReceiver<Phase>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let work = Work::Signin { scope: "scope".into() };
        let session = Signin::launch(Kind::Signin, "scope", ":0".into(), work, move |phase| {
            let _ = tx.send(phase);
        });
        (session, rx)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_cancel_while_the_turn_is_somebody_elses_settles_without_it() {
        let held = auth::interactive_turn().await;
        let (session, mut rx) = parked_signin();
        // Let the run reach its wait for the turn, which is where a Cancel used to be lost.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(session.phase(), Phase::Starting);
        assert!(!session.cancel().await, "no window was up, so none was closed");
        // Closing, and serving nothing meanwhile.
        assert_eq!(session.payload().await["stopping"], true);
        let refused = session.open_window().err().expect("nothing is served while closing");
        assert!(refused.to_string().contains("being closed"), "{refused}");
        let settled = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("the session settles while the turn is still somebody else's")
            .expect("it says how it ended");
        assert_eq!(settled, Phase::Cancelled);
        assert_eq!(session.phase(), Phase::Cancelled);
        drop(held);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_cancel_before_the_run_has_started_is_kept() {
        let held = auth::interactive_turn().await;
        let (session, mut rx) = parked_signin();
        // On this runtime the run has not been polled yet: no `Notified` exists to be woken, and
        // only a permit can carry the Cancel to it.
        session.cancel().await;
        let settled = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("kept");
        assert_eq!(settled, Some(Phase::Cancelled));
        drop(held);
    }

    #[test]
    fn every_kind_has_its_own_wire_tag_and_serves_only_its_own_windows() {
        use PortalPurpose::{Account, Enroll};
        assert_eq!(Kind::Signin.tag(), "signin");
        // Every portal session is `enroll` on the wire — the kind an older page knows — and its
        // purpose says which, in a field of its own.
        assert_eq!(Kind::Enroll(Enroll).tag(), "enroll");
        assert_eq!(Kind::Enroll(Account).tag(), "enroll");
        assert_ne!(Enroll.tag(), Account.tag());
        assert_eq!(Kind::Signin.purpose(), None);
        assert_eq!(Kind::Enroll(Account).purpose(), Some(Account));
        // A sign-in serves the broker's window and nothing else — the portal is not it.
        assert_eq!(Kind::Signin.classes(), &[xwindow::SIGNIN_WM_CLASS]);
        // A portal session serves the portal and the broker's dialog over it, whatever it is for.
        for purpose in [Enroll, Account] {
            let classes = Kind::Enroll(purpose).classes();
            assert!(classes.contains(&xwindow::PORTAL_WM_CLASS));
            assert!(classes.contains(&xwindow::SIGNIN_WM_CLASS));
            assert_eq!(classes.len(), 2, "and never a third program");
        }
    }

    #[test]
    fn an_enrollment_is_refused_before_anything_is_started() {
        // Read-only first, then whose container it is, then the display — and the portal helper
        // only after all three. A helper spawned on a backend that should have refused would
        // open the portal in a container that is not ours to enroll, or in a screenshot run.
        let source = source();
        let enroll = source.find("pub fn enroll(").expect("Signin::enroll");
        let body = &source[enroll..enroll + source[enroll..].find("\n    }\n").unwrap()];
        let read_only = body.find("crate::read_only()").expect("the read-only gate");
        let embedded = body.find("intune_embedded::embedded()").expect("the mode gate");
        let display = body.find("DisplayState::Ready").expect("the display gate");
        let spawn = body.find("spawn_helper(Helper::Portal)").expect("the portal helper");
        assert!(read_only < embedded && embedded < display && display < spawn);
    }

    #[test]
    fn a_portal_session_settles_only_once_its_helper_has_gone() {
        // A Cancel used to settle the session at once and drop the helper's handle, while the
        // helper — in a session of its own, told nothing — went on to open the portal with nobody
        // behind it, holding the one helper slot for half an hour. The helper's end is now pinned
        // BEFORE the wait, the helper is SIGNALLED on a Cancel and at the deadline, and its exit
        // is awaited (bounded) before anything is taken back or settled.
        let portal = body_of("async fn run_portal(");
        let pinned = portal.find("let exited = portal.finished();").expect("the end, pinned");
        let wait = portal.find("ENROLL_DEADLINE, exited.as_mut()").expect("awaited by reference");
        assert!(pinned < wait, "pinned before the wait, so a Cancel does not drop it");
        let asked = portal.find("asked => {").expect("the Cancel and the deadline");
        let closing = portal.find("session.stopping.store(true").expect("says it is closing");
        let stopped = portal.find("stop_portal(&terminator, exited.as_mut())").expect("stops it");
        let taken_back = portal.find("xwindow::close_windows(").expect("the take-back");
        let decided = portal.find("has_device_registration").expect("the registration");
        let released = portal.find("drop(turn);").expect("the release");
        assert!(asked < closing && closing < stopped, "the helper is asked once nothing is served");
        assert!(stopped < taken_back && taken_back < decided && decided < released);
        // The take-back is made under the turn, taken now if the Cancel won the race for it.
        let retaken = portal.find("None => auth::interactive_turn().await").expect("retaken");
        assert!(retaken < taken_back);
        // And the stop is a SIGNAL the helper answers, then a bounded wait for it to exit.
        let stop = body_of("async fn stop_portal(");
        assert!(stop.find("terminator.terminate()").unwrap() < stop.find("PORTAL_STOP_WAIT").unwrap());
        // Nothing on THIS side closes the portal's window on a Cancel any more: that is the
        // helper's to do, the crate's own way, and the run's take-back mops up after it.
        let cancel = body_of("    pub async fn cancel(");
        assert!(!cancel.contains("close_windows"), "a Cancel signals; the run closes");
    }

    #[test]
    fn what_the_portal_was_opened_for_decides_how_it_ended() {
        // An enrollment worked when there is a registration; an account sign-in when the broker
        // answers — the registration was there from the start and says nothing about it.
        let portal = body_of("async fn run_portal(");
        let decide = &portal[portal.find("let worked = match session.purpose {").expect("decided")..];
        let enroll = decide.find("PortalPurpose::Enroll =>").expect("the enrollment's rule");
        let account = decide.find("PortalPurpose::Account =>").expect("the account's rule");
        assert!(decide[enroll..account].contains("has_device_registration"));
        assert!(decide[account..].contains("account_answers(turn, session.scope,"), "the turn goes with it");
        // The account is asked UNDER the turn this session holds, interactively — the acquisition
        // the rescue would make, which cannot take a turn that is held — and the funnel is asked
        // only once the turn is released. Asked the other way round, the rescue stood down, the
        // panel said "still broken", and the enrollment's own follow-up minted the token seconds
        // later and took the banner down under it.
        let probe = body_of("async fn account_answers(");
        let interactive = probe.find("auth::interactive_token(&turn, scope, ACCOUNT_PROBE)").expect("under the turn");
        let taken_back = probe.find("xwindow::close_windows(").expect("a window it raised is taken back");
        let released = probe.find("drop(turn);").expect("released");
        let funnel = probe.find("auth::get_token(scope)").expect("recorded through the funnel");
        assert!(interactive < taken_back && taken_back < released && released < funnel);
        assert_eq!(probe.matches("ACCOUNT_PROBE").count(), 3, "a broker call has no deadline of its own");
        assert!(!portal.contains("auth::get_token("), "the funnel is never asked while the turn is held");
        // The scope is the one the app is broken on, and an enrollment carries none.
        let enroll_fn = body_of("    pub fn enroll(");
        assert!(enroll_fn.contains("PortalPurpose::Enroll => \"\""));
    }

    #[test]
    fn a_portal_that_closed_is_named_by_how_it_closed() {
        assert_eq!(portal_outcome(Ok(0)), Phase::Cancelled, "the reader closed it");
        // The helper's OWN deadline is its own exit code, never this side's clock: the session's
        // clock starts before the portal appears, so near the deadline it could not tell a reader
        // closing the portal from the helper closing it — and called the reader's own close a
        // timeout.
        assert!(![0, 1, 2].contains(&intune_embedded::PORTAL_TIMED_OUT));
        let Phase::Failed(words) = portal_outcome(Ok(intune_embedded::PORTAL_TIMED_OUT)) else {
            panic!("a portal closed at its deadline is not one the reader closed");
        };
        assert!(words.contains("30 minutes"), "{words}");
        assert!(!body_of("fn portal_outcome(").contains("elapsed"), "no clock decides it");
        for code in [1, 2, 9] {
            let Phase::Failed(words) = portal_outcome(Ok(code)) else {
                panic!("exit {code} is a failure");
            };
            assert!(words.contains("teams-lite(intune-portal)"), "names where to look: {words}");
        }
        assert!(matches!(portal_outcome(Err(anyhow::anyhow!("gone"))), Phase::Failed(_)));
    }

    #[test]
    fn a_portal_still_closing_is_said_as_what_it_is() {
        // A helper that had not exited when the session stopped waiting still holds the slot:
        // "closed, start it again" would offer a press the backend refuses.
        assert!(PORTAL_STILL_CLOSING.contains("not finished closing"));
        assert!(PORTAL_STILL_CLOSING.contains("teams-lite(intune-portal)"));
        let portal = body_of("async fn run_portal(");
        assert!(portal.contains("Phase::Failed(PORTAL_STILL_CLOSING.into())"));
    }
}
