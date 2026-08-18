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

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::auth::{self, Interactive};
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

/// One interactive sign-in, and everything the app may ask about it.
pub struct Signin {
    /// The scope being acquired — the one the app is broken on, so the token that comes back
    /// is the token that was missing.
    scope: String,
    /// The display the broker draws on. Read from the broker, never chosen here.
    display: String,
    phase: Arc<Mutex<Phase>>,
    /// The window this session's own call put up, once its watcher has found it.
    ///
    /// Cached rather than found per operation: a `find` is an X connection, a recursive tree
    /// walk and a full keyboard-mapping read, and the page asks for a status and a frame every
    /// second. It is also what keeps this session away from anybody else's window.
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
    /// Flipped to end the flow: the run future is dropped, which is what stops the D-Bus call.
    stop: Arc<Notify>,
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

        let session = Self {
            scope: scope.to_string(),
            display: display.clone(),
            phase: Arc::new(Mutex::new(Phase::Starting)),
            window: Arc::new(Mutex::new(None)),
            stop: Arc::new(Notify::new()),
            started: Instant::now(),
            settled: Arc::new(Mutex::new(None)),
        };

        let run = Run {
            scope: scope.to_string(),
            display,
            phase: session.phase.clone(),
            window: session.window.clone(),
            stop: session.stop.clone(),
            settled: session.settled.clone(),
        };
        tokio::spawn(run.go(Box::new(on_change)));
        Ok(session)
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
    pub async fn cancel(&self) -> Result<bool> {
        let closed = match self.window() {
            None => false,
            Some(window) => {
                tokio::task::spawn_blocking(move || window.close())
                    .await
                    .context("close the sign-in window")??;
                true
            }
        };
        self.stop.notify_waiters();
        Ok(closed)
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
        json!({
            "phase": phase.tag(),
            "detail": match &phase {
                Phase::Failed(words) => words.clone(),
                _ => String::new(),
            },
            "scope": self.scope,
            "display": self.display,
            "waited_ms": self.started.elapsed().as_millis() as u64,
            "window": window,
        })
    }
}

/// The half of a session that runs on its own: the interactive call, the watcher that finds
/// its window, and the settling at the end.
struct Run {
    scope: String,
    display: String,
    phase: Arc<Mutex<Phase>>,
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
    stop: Arc<Notify>,
    settled: Arc<Mutex<Option<Instant>>>,
}

impl Run {
    async fn go(self, on_change: Box<dyn Fn(Phase) + Send + Sync>) {
        // Wait for the turn FIRST. Everything after this point knows that the window on the
        // broker's display, if one appears, is the one this call put there — which is what makes
        // it safe to show it to a reader and send their keystrokes to it.
        let turn = auth::interactive_turn().await;
        let watcher = tokio::spawn(watch_for_window(
            self.display.clone(),
            self.phase.clone(),
            self.window.clone(),
        ));

        let next = tokio::select! {
            // The reader gave up, or closed the window. Dropping the call is what ends it:
            // there is no D-Bus cancel that is safe to make (SIGN-IN.md § 3).
            _ = self.stop.notified() => Phase::Cancelled,
            outcome = auth::interactive_token(&turn, &self.scope, auth::SIGNIN_DEADLINE) => {
                match outcome {
                    Ok(Interactive::Token(_)) => {
                        // Ask for the token again through the ordinary funnel: that is what
                        // records the broker as healthy and tells every open page, and it must
                        // succeed now — the resource's refresh token is fresh. One spelling of
                        // "sign-in works again" rather than a second way to say it.
                        match auth::get_token(&self.scope).await {
                            Ok(_) => Phase::Done,
                            // Vanishingly unlikely and worth saying plainly rather than
                            // reporting a success the app then contradicts.
                            Err(e) => Phase::Failed(format!(
                                "The sign-in worked, but the token could not be read back: {e:#}"
                            )),
                        }
                    }
                    Ok(Interactive::Cancelled) => Phase::Cancelled,
                    Ok(Interactive::StillWaiting) => Phase::Failed(
                        "The sign-in was not finished in time. Start it again when you are \
                         ready."
                            .into(),
                    ),
                    Err(e) => Phase::Failed(format!("{e:#}")),
                }
            }
        };

        watcher.abort();
        // Whatever ended it, the window must not be left standing on a display nobody is
        // watching — the rule `auth::rescue` follows for its own abandoned attempt.
        if !matches!(next, Phase::Done) {
            let _ = tokio::task::spawn_blocking(xwindow::close_open_signin_window).await;
        }
        if let Ok(mut window) = self.window.lock() {
            *window = None;
        }
        if let Ok(mut held) = self.phase.lock() {
            *held = next.clone();
        }
        if let Ok(mut held) = self.settled.lock() {
            *held = Some(Instant::now());
        }
        eprintln!("[signin] {}", describe(&next));
        on_change(next);
    }
}

/// Look for the broker's window while this session's call is out, and promote the phase once
/// it is there.
///
/// The broker publishes no "I am asking a human" signal, so the window going up IS the signal.
/// Re-found on every pass rather than kept once: the broker REPLACES its window between steps,
/// so a handle held from the password page goes stale on the number-matching one.
async fn watch_for_window(
    display: String,
    phase: Arc<Mutex<Phase>>,
    window: Arc<Mutex<Option<Arc<SigninWindow>>>>,
) {
    loop {
        let found = {
            let display = display.clone();
            tokio::task::spawn_blocking(move || SigninWindow::find(&display).ok().flatten())
                .await
                .ok()
                .flatten()
                .map(Arc::new)
        };
        if let Some(found) = found {
            if let Ok(mut held) = window.lock() {
                *held = Some(found);
            }
            if let Ok(mut held) = phase.lock() {
                if *held == Phase::Starting {
                    *held = Phase::Waiting;
                }
            }
        }
        tokio::time::sleep(WINDOW_POLL).await;
    }
}

/// One journal line per outcome. The words are for whoever reads the unit's log after the
/// fact, so they name what happened rather than which enum arm it was.
fn describe(phase: &Phase) -> String {
    match phase {
        Phase::Done => "the sign-in worked — the broker minted a token".into(),
        Phase::Cancelled => "the sign-in was ended before it finished".into(),
        Phase::Failed(words) => format!("the sign-in did not finish: {words}"),
        Phase::Starting | Phase::Waiting => "the sign-in is still going".into(),
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

    #[test]
    fn a_window_is_only_looked_for_once_this_sessions_own_call_is_out() {
        // The turn is what says the window on the broker's display is OURS. Looked for before
        // it, a session promotes itself on the window the automatic rescue put up — and the
        // reader types their password into the flow whose token nobody reads, which is the
        // failure `auth::interactive_turn` exists to prevent.
        let whole = include_str!("signin.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let go = source.find("async fn go(").expect("Run::go");
        let body = &source[go..];
        let turn_at = body.find("auth::interactive_turn().await").expect("the turn");
        let watch_at = body.find("watch_for_window(").expect("the watcher");
        assert!(turn_at < watch_at, "the turn is taken before the window is looked for");
        // And the phase is promoted by that watcher alone, never by a read.
        let phase_fn = source.find("pub fn phase(&self)").expect("Signin::phase");
        let phase_body = &source[phase_fn..source[phase_fn..].find("\n    }").unwrap() + phase_fn];
        assert!(
            !phase_body.contains("Waiting"),
            "reading the phase must not promote it: `signin_status` is an OPEN method"
        );
    }

    #[test]
    fn cancelling_ends_the_flow_even_before_a_window_exists() {
        // Cancel used to be a silent no-op during `starting` — the phase most sign-ins live in.
        // Closing the window is still how a flow the broker is SHOWING is ended, but the run is
        // told to stop either way, or the session stays live for the full deadline and no new
        // sign-in can be started for ten minutes.
        let whole = include_str!("signin.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let cancel = source.find("pub async fn cancel(").expect("cancel");
        let body = &source[cancel..];
        let end = body.find("\n    }").unwrap_or(body.len());
        assert!(
            body[..end].contains("self.stop.notify_waiters()"),
            "cancel must stop the run, not only close a window that may not exist"
        );
        // And the run really selects on it, rather than only reading it at the end.
        let go = source.find("async fn go(").expect("Run::go");
        assert!(
            source[go..].contains("self.stop.notified()"),
            "the run must be waiting on the stop"
        );
    }
}
