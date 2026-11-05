// The identity broker's own sign-in window, read and driven over X11.
//
// WHY THIS EXISTS. When the broker cannot mint a token from the Primary Refresh Token on
// its own, it asks a human — and it asks by drawing its own window, in an embedded
// WebKitGTK view, on an X display. There is no API that hands the app a URL instead: the
// broker refuses a device-code flow on Linux outright, and a plain browser is refused by
// this tenant's Conditional Access. SIGN-IN.md § 3 holds the measurements. So the only way
// to answer the broker from a phone is to bring THAT window to the browser: read its
// pixels, send keys and clicks back.
//
// WHAT IT IS DELIBERATELY NOT. Not a remote desktop. Every operation here is scoped to one
// window, found by its program's own `WM_CLASS`, and this module refuses to work at all when
// that window is absent. The display it lives on carried six other windows when this was
// measured — leftover `intune-portal` frames — and on the container's own display, forty.
// Serving "the screen" would put whatever else is there in front of the reader, and typing
// a password would send it wherever the focus happened to be.
//
// TWO PROGRAMS, AND NEVER A THIRD. A sign-in serves the broker's window alone
// ([`SIGNIN_WM_CLASS`]). An ENROLLMENT of the self-contained image's own Intune container
// (src/intune_embedded.rs) serves the Intune portal ([`PORTAL_WM_CLASS`]) AND the broker's
// sign-in dialog the portal asks for, which the broker draws OVER the portal on the same
// display — so a search may name both classes ([`ENROLL_WM_CLASSES`]) and answers the TOPMOST
// match, because that is the window the reader is being asked to look at.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask,
    GetGeometryReply, GetImageReply, ImageFormat, ImageOrder, InputFocus, MapState, Window,
};
use x11rb::protocol::ErrorKind;
use x11rb::rust_connection::RustConnection;
use x11rb::CURRENT_TIME;

use crate::png;

/// The `WM_CLASS` the broker gives its sign-in window. Measured on 2026-08-18:
/// `WM_CLASS(STRING) = "microsoft-identity-broker", "Microsoft-identity-broker"`, with the
/// title `Microsoft Authentication`. The CLASS and not the title: a title is what Entra
/// writes into the page's own frame and it changes between steps, while the class is the
/// program's.
pub const SIGNIN_WM_CLASS: &str = "microsoft-identity-broker";

/// The `WM_CLASS` of the Intune portal's own window (`intune-portal`, `Intune-portal`) — the
/// program an enrollment is done in. The class these leftover frames carried on the measured
/// display, which is why [`SIGNIN_WM_CLASS`] is matched segment by segment and never as a
/// substring: the two must never be mistaken for each other.
pub const PORTAL_WM_CLASS: &str = "intune-portal";

/// What an ENROLLMENT may serve: the portal, and the broker's sign-in dialog the portal opens on
/// top of it. Nothing else on that display — a leftover frame of another program, a terminal a
/// container image happened to start — is ever a match.
pub const ENROLL_WM_CLASSES: &[&str] = &[SIGNIN_WM_CLASS, PORTAL_WM_CLASS];

/// How deep to look for it under the root. The window was a direct child of root on the
/// measured display (no window manager runs there); one more level covers a display that
/// does have one, where the app's window sits inside the manager's frame.
const SEARCH_DEPTH: u32 = 3;

/// X event types, as XTEST names them. Spelled out because `2` and `3` at a call site are
/// the difference between typing a password and holding a key down for ever.
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;

/// Keysyms this app has to be able to send whatever the layout is.
const XK_BACKSPACE: u32 = 0xff08;
const XK_TAB: u32 = 0xff09;
const XK_RETURN: u32 = 0xff0d;
const XK_ESCAPE: u32 = 0xff1b;
const XK_DELETE: u32 = 0xffff;
const XK_LEFT: u32 = 0xff51;
const XK_UP: u32 = 0xff52;
const XK_RIGHT: u32 = 0xff53;
const XK_DOWN: u32 = 0xff54;
const XK_SHIFT_L: u32 = 0xffe1;

/// A key or a character the page should receive, as the wire carries it.
///
/// A character rather than a keycode, because the sender is a browser: what a phone's
/// keyboard reports is the text it inserted, and what a laptop reports for the special keys
/// is a name. Turning either into a keysym is this module's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// One character to type, shift and remapping handled here.
    Char(char),
    /// A named key: `Enter`, `Tab`, `Backspace`, `Escape`, `Delete`, `ArrowUp`… — the names
    /// a DOM `KeyboardEvent.key` uses, so the page passes its own event through untouched.
    Named(String),
}

impl Key {
    /// The keysym to press, or `None` for a name this app does not send.
    ///
    /// The allowlist is the point: a browser can name any key, including `F1`, `Super` and
    /// `PrintScreen`, and none of those belongs in a sign-in form. An unknown name is
    /// dropped rather than guessed at.
    fn keysym(&self) -> Option<u32> {
        match self {
            Self::Char(c) => Some(keysym_of(*c)),
            Self::Named(name) => Some(match name.as_str() {
                "Enter" => XK_RETURN,
                "Tab" => XK_TAB,
                "Backspace" => XK_BACKSPACE,
                "Escape" => XK_ESCAPE,
                "Delete" => XK_DELETE,
                "ArrowLeft" => XK_LEFT,
                "ArrowUp" => XK_UP,
                "ArrowRight" => XK_RIGHT,
                "ArrowDown" => XK_DOWN,
                _ => return None,
            }),
        }
    }
}

/// The X keysym for a character.
///
/// Latin-1 is its own code point (that is how X11 defines the range), and everything above
/// it takes the Unicode keysym form. Both then need a KEYCODE that produces them, which the
/// layout on a bare `Xvfb` mostly does not have — see [`SigninWindow::type_key`].
fn keysym_of(c: char) -> u32 {
    let point = c as u32;
    if point < 0x100 { point } else { 0x0100_0000 + point }
}

/// A pointer button, as X numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    ScrollUp,
    ScrollDown,
}

impl Button {
    fn detail(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::ScrollUp => 4,
            Self::ScrollDown => 5,
        }
    }
}

/// Where the broker draws, and whether anything is serving it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisplayState {
    /// The broker names a display and something serves it here — its file socket, or its
    /// abstract one (see `display_is_served`).
    Ready { display: String },
    /// The broker names a display that nothing is serving. Its own window cannot be drawn
    /// at all in this state — for any client, not only for us.
    Missing { display: String },
    /// The broker names no display: a classic install on a headless machine. Nothing here
    /// can invent one, because the broker reads it at activation and a display it is
    /// pointed at and then loses breaks every token call (`intune-container` carries a whole
    /// script for that bug).
    None,
}

impl DisplayState {
    pub fn display(&self) -> Option<&str> {
        match self {
            Self::Ready { display } | Self::Missing { display } => Some(display),
            Self::None => None,
        }
    }

    /// One sentence for the app, naming the remedy where there is one. Never "sign in
    /// again": that is precisely what cannot be done in these two states.
    pub fn refusal(&self) -> Option<String> {
        match self {
            Self::Ready { .. } => None,
            Self::Missing { display } => Some(format!(
                "The identity broker draws its sign-in window on display {display}, and \
                 nothing is serving that display, so the window cannot appear at all. \
                 Restarting Intune on this machine puts it back."
            )),
            // Deliberately not "the broker has no display": this state is also what a broker
            // that is not running right now leaves, and claiming to know more than was read is
            // how a reader ends up chasing the wrong thing.
            Self::None => Some(
                "This machine could not tell which display the identity broker draws its \
                 sign-in window on, so it cannot serve one here. Signing in has to be done on \
                 the machine itself."
                    .to_string(),
            ),
        }
    }
}

/// Which display the broker will draw on, read from the broker's OWN environment.
///
/// Read rather than chosen, and this is the load-bearing part: the broker is D-Bus
/// activated and its environment is frozen at activation, so `DISPLAY` is whatever was in
/// the activation environment then — `:99` from a container's provisioning, `:77` if
/// something left a private display in there. Measured on 2026-08-18: `DISPLAY=:77`.
/// Choosing a display here instead would either be ignored or, worse, strand the broker.
///
/// THIS PROCESS'S OWN `DISPLAY` IS NOT A FALLBACK, and it was one for a while. On a desktop
/// session that answers `:0`, whose socket exists — so the app offered a sign-in, started one,
/// and then looked for the window on a display the broker never draws on: ten minutes at
/// `starting`, ending in "not finished in time", with the broker's real window left open on
/// `:77` because the take-back looks at the same wrong display. A display we cannot read is a
/// display we do not know, and saying so is the only honest answer.
pub fn broker_display() -> DisplayState {
    let display = broker_pids()
        .into_iter()
        .find_map(|pid| environ_display(&format!("/proc/{pid}/environ")));
    match display {
        None => DisplayState::None,
        Some(display) => {
            if display_is_served(&display) {
                DisplayState::Ready { display }
            } else {
                DisplayState::Missing { display }
            }
        }
    }
}

/// The Intune container's OWN display (`ops::CONTAINER_DISPLAY`, `:99`), where an enrollment's
/// portal is drawn — and whether anything serves it here.
///
/// Named rather than read, and that is the one place this module does not follow
/// [`broker_display`]'s rule, for a reason that is the crate's: `ops::portal_open_headless`
/// launches the portal on exactly that display, and the session the container publishes to its
/// broker says the same one, so the broker's dialogs land beside it. There is nothing to read it
/// out of before the portal exists, and nothing else it could be. It is reached through its
/// ABSTRACT socket — the inner container's `/tmp` is not this process's — which is in this
/// process's network namespace only in EMBEDDED mode, where the Intune container is teams-lite's
/// own; a host-mode backend never asks this (an enrollment is refused there before it gets here).
/// Its Xvfb is `1280x800x24` at the pinned crate, the 32-bit-pixel visual [`SigninWindow::capture`]
/// needs; the 640x480x16 one before it would have been refused frame by frame.
pub fn container_display() -> DisplayState {
    let display = intune_container::ops::CONTAINER_DISPLAY.to_string();
    if display_is_served(&display) {
        DisplayState::Ready { display }
    } else {
        DisplayState::Missing { display }
    }
}

/// Is anything serving `display` where a connection from here would reach it?
///
/// TWO places, because the X server is in another container. On a containerized-Intune host the
/// broker's Xvfb runs inside the Intune container: its FILE socket is in that container's `/tmp`,
/// which this process does not see, and its ABSTRACT socket (`@/tmp/.X11-unix/X99`) is in the
/// network namespace the container shares with the host. Asking for the file alone reported a
/// display that was there as `Missing` — measured on 2026-11-02, the broker on `:99`, no
/// `/tmp/.X11-unix/X99` on the host, `@/tmp/.X11-unix/X99` in `/proc/net/unix` — and the served
/// sign-in was refused on the very machine it was built for. The connection itself never had
/// this problem: x11rb tries the abstract name first and the file second, which is the order
/// asked in here too. A teams-lite inside its container image in HOST mode sees the same
/// abstract socket because it runs in the host's network namespace
/// (packaging/docker/compose.host-broker.yaml); in EMBEDDED mode the Intune container is its own
/// and shares teams-lite's network namespace, so its display's abstract socket is in this
/// process's table from the start (see [`container_display`]).
fn display_is_served(display: &str) -> bool {
    let Some(path) = display_socket(display) else { return false };
    let abstract_socket = || {
        std::fs::read_to_string("/proc/net/unix")
            .is_ok_and(|table| unix_table_lists_abstract(&table, &path))
    };
    abstract_socket() || std::path::Path::new(&path).exists()
}

/// Does a `/proc/net/unix` table hold a LISTENING abstract socket named `path`? The kernel
/// prints an abstract name with a leading `@`, as the last column, and marks a listener with
/// `__SO_ACCEPTCON` (`00010000`) in the fourth — which matters, because every connection the
/// server ACCEPTED carries the listener's name too, and one of those outliving its server is
/// not a display anybody serves. The header line names no socket. Split out so the parse is
/// tested without a table to read.
fn unix_table_lists_abstract(table: &str, path: &str) -> bool {
    const LISTENING: &str = "00010000";
    let wanted = format!("@{path}");
    table.lines().skip(1).any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.get(3) == Some(&LISTENING) && fields.last() == Some(&wanted.as_str())
    })
}

/// The running broker's pids, most specific first. Empty when it is not resident, which is
/// its normal state: it is D-Bus activated, so any call starts it.
fn broker_pids() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        let cmdline = String::from_utf8_lossy(&cmdline);
        // The broker, never the DEVICE broker beside it: they are two services, and only
        // one of them draws a sign-in window.
        if cmdline.contains("identity-broker/bin/microsoft-identity-broker") {
            found.push(pid);
        }
    }
    found
}

/// `DISPLAY` out of a frozen process environment.
fn environ_display(path: &str) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    display_in_environ(&String::from_utf8_lossy(&raw))
}

/// The `DISPLAY` value in a NUL-separated environment block. Split out so the parse is
/// tested without a process to read.
fn display_in_environ(environ: &str) -> Option<String> {
    environ
        .split('\0')
        .filter_map(|kv| kv.strip_prefix("DISPLAY="))
        .find(|v| !v.is_empty())
        .map(str::to_string)
}

/// The unix socket a local display name resolves to, or `None` for a display this app will
/// not reach for. A TCP display (`host:0`) is deliberately not resolved: the broker's
/// sign-in page is on it, and nothing here should be reaching across a network for one.
pub fn display_socket(display: &str) -> Option<String> {
    let rest = display.strip_prefix(':')?;
    let number: u32 = rest.split('.').next()?.parse().ok()?;
    Some(format!("/tmp/.X11-unix/X{number}"))
}

/// Take back a sign-in window nobody is watching, if one is up. `true` when one was closed.
///
/// Blocking (X is a socket), so callers in async context hand it to `spawn_blocking`. Every
/// failure is swallowed on purpose: this is a tidy-up, and the caller it serves
/// (`auth::rescue`) has already decided the acquisition did not work.
pub fn close_open_signin_window() -> bool {
    let state = broker_display();
    let Some(display) = state.display() else { return false };
    match SigninWindow::find(display) {
        Ok(Some(window)) => window.close().is_ok(),
        _ => false,
    }
}

/// Ask EVERY viewable window of `classes` on `display` to close, topmost first, and say how
/// many were asked. Blocking, like everything here.
///
/// Every one rather than the topmost, and that is what an enrollment's Cancel needs: the
/// topmost window is often the broker's dialog, and closing that alone cancels one sign-in step
/// while the portal behind it — the program whose exit ends the enrollment — stays open. Closed
/// the way a person would ([`SigninWindow::close`]'s `WM_DELETE_WINDOW`), never killed. A window
/// that will not close is left to its program; a failure on one does not stop the others.
pub fn close_windows(display: &str, classes: &[&str]) -> Result<usize> {
    let (conn, screen) = RustConnection::connect(Some(display))
        .with_context(|| format!("open X display {display}"))?;
    let root = conn.setup().roots[screen].root;
    let _turn = x_turn();
    let mut found = Vec::new();
    collect_by_class(&conn, root, classes, SEARCH_DEPTH, &mut found)?;
    let mut asked = 0;
    for candidate in found {
        if close_window(&conn, candidate.window).is_ok() {
            asked += 1;
        }
    }
    Ok(asked)
}

/// The broker's sign-in window — or, during an enrollment, the Intune portal's — open for
/// reading and driving. One window, whichever program drew it: nothing here reaches past it.
pub struct SigninWindow {
    conn: RustConnection,
    root: Window,
    /// The root window's size: the screen a window has to be wholly on to be read at all.
    screen: (u16, u16),
    window: Window,
    /// keysym -> (keycode, needs shift), from the server's own mapping.
    layout: HashMap<u32, (u8, bool)>,
    /// A keycode with no keysyms of its own, borrowed for characters the layout cannot
    /// produce. `None` on a server whose every keycode is taken.
    spare: Option<u8>,
    /// True when the X server hands over pixels most-significant byte first.
    msb_first: bool,
}

/// Serializes every X operation in this process.
///
/// PROCESS-WIDE, not per connection, and that took a review to see: the borrowed spare keycode
/// (see [`SigninWindow::type_key`]) is a GLOBAL server resource, and two windows — two pages
/// typing at once, or a frame read racing a keystroke — would remap it under each other, so one
/// press produces the other's character or nothing at all. A lock per instance serializes
/// nothing between instances, which is exactly the case that matters.
fn x_turn() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    // A poisoned lock still serializes: `into_inner` takes the guard rather than dropping the
    // serialization the moment some other path panicked. Bound to a `Result` — which is what
    // this was — it protected nothing at all from then on.
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// One captured frame of the window.
pub struct Frame {
    pub width: u16,
    pub height: u16,
    /// PNG bytes, ready to be base64'd into a message.
    pub png: Vec<u8>,
}

impl SigninWindow {
    /// Find the broker's sign-in window on `display`, or say it is not there.
    ///
    /// Absent is the ordinary case, not an error state: the broker only draws when it needs
    /// a human, so this answers `None` every time a token was minted from the PRT.
    pub fn find(display: &str) -> Result<Option<Self>> {
        Self::find_any(display, &[SIGNIN_WM_CLASS])
    }

    /// Find the topmost viewable window of any of `classes` on `display` — the broker's sign-in
    /// dialog over the Intune portal it was opened for, during an enrollment
    /// ([`ENROLL_WM_CLASSES`]).
    ///
    /// TOPMOST, because the reader is shown ONE window and it has to be the one being asked for
    /// something: with no window manager on the display, a window mapped later is stacked
    /// higher, so the broker's dialog is above the portal while it is up and the portal is the
    /// answer again once the dialog goes. A window that is OVERRIDE-REDIRECT — a GTK menu, a
    /// tooltip, a completion popup, each carrying its program's class — is a match only when
    /// nothing else is: it is part of a page rather than a page, and serving a tooltip as the
    /// window would hand the reader a 200-pixel strip to type their password at. On a display
    /// that offers only such a window (nothing measured has) it is still served, so a broker
    /// that drew its dialog that way is never refused.
    pub fn find_any(display: &str, classes: &[&str]) -> Result<Option<Self>> {
        let (conn, screen) = RustConnection::connect(Some(display))
            .with_context(|| format!("open X display {display}"))?;
        let root_screen = &conn.setup().roots[screen];
        let (root, size) =
            (root_screen.root, (root_screen.width_in_pixels, root_screen.height_in_pixels));
        let mut found = Vec::new();
        collect_by_class(&conn, root, classes, SEARCH_DEPTH, &mut found)?;
        let Some(window) = pick_window(&found) else {
            return Ok(None);
        };
        // Under the X turn, because `type_key` LENDS a spare keycode a keysym for the length of a
        // press: read in that moment, the layout would record the borrowed keycode as the way to
        // type that character, and the next press of it — on a keycode already handed back —
        // would type nothing while answering that it had. The watcher runs a find every 300 ms
        // while the reader is typing, so the moment is not rare.
        let (layout, spare) = {
            let _turn = x_turn();
            read_layout(&conn)?
        };
        let msb_first = conn.setup().image_byte_order == ImageOrder::MSB_FIRST;
        Ok(Some(Self { conn, root, screen: size, window, layout, spare, msb_first }))
    }

    /// The window's size right now, without reading a single pixel.
    ///
    /// Its own method because the status the app polls carries the window's shape, and asking
    /// `capture` for it would read a megabyte of pixels and deflate them once a second to learn
    /// two numbers.
    pub fn size(&self) -> Result<(u16, u16)> {
        let _turn = x_turn();
        let geometry = self.conn.get_geometry(self.window)?.reply()?;
        Ok((geometry.width, geometry.height))
    }

    /// Read the window's pixels as a PNG, and never move it.
    ///
    /// The WINDOW's own drawable, never the root: the frame must carry that window and
    /// nothing else on the display. Nothing is scaled — the page is 550 px wide and the
    /// number a reader has to match is 13 px type in it.
    ///
    /// The whole window is asked for first, which is every read that ever worked here; a window
    /// X refuses to read whole (`BadMatch`, its answer for a window that is not wholly on its
    /// screen) is read as far as it IS on the screen, from its own origin. What a live session
    /// serves goes through [`SigninWindow::capture_or_place`] instead, which moves such a window
    /// onto its screen; this read is the one a diagnostic may make.
    pub fn capture(&self) -> Result<Frame> {
        self.read_frame(false)?
            .ok_or_else(|| anyhow!("the sign-in window was moved by a read that may not move it"))
    }

    /// Read the window's pixels as a PNG, first moving it onto its screen when X refused to read
    /// it whole — and `None` on the tick that moved it, when there is nothing worth reading yet.
    ///
    /// This is what a live session serves. A composited display can read a window part of which
    /// is off the screen, and that read is left exactly as it was: only a `BadMatch` places the
    /// window ([`SigninWindow::place_on_screen`]).
    ///
    /// A tick that MOVES the window reads nothing: the rows that were off the screen were never
    /// drawn, and the program repaints them only once it has handled the `Expose` the move sends —
    /// which it cannot do inside this call. Read at once, the bottom of the frame would be the
    /// background, or rows of the window repeated, or whatever else stood on that part of the
    /// screen, served as a fresh picture a press could land on. The next tick reads the window
    /// whole. A window that cannot be moved is read as far as it is on the screen, from its own
    /// origin, so a press on that frame still lands where it was aimed.
    pub fn capture_or_place(&self) -> Result<Option<Frame>> {
        self.read_frame(true)
    }

    /// The read behind [`SigninWindow::capture`] and [`SigninWindow::capture_or_place`]; `place`
    /// says whether a window X refused to read whole may be moved.
    fn read_frame(&self, place: bool) -> Result<Option<Frame>> {
        let _turn = x_turn();
        let geometry = self
            .conn
            .get_geometry(self.window)?
            .reply()
            .context("the sign-in window went away while it was being read")?;
        anyhow::ensure!(
            geometry.width > 0 && geometry.height > 0,
            "the sign-in window has no size yet"
        );
        let mut size = (geometry.width, geometry.height);
        let image = match self.read_pixels(size) {
            Err(x11rb::errors::ReplyError::X11Error(error))
                if error.error_kind == ErrorKind::Match =>
            {
                match self.place_on_screen(&geometry, place)? {
                    Placement::Moved => return Ok(None),
                    Placement::Read(part) => {
                        size = (part.width, part.height);
                        self.read_pixels(size)
                    }
                }
            }
            read => read,
        }
        .context("read the sign-in window's pixels")?;
        let (width, height) = size;
        let pixels = width as usize * height as usize;
        // Four bytes a pixel is what Z_PIXMAP gives for the 24- and 32-bit visuals every server
        // this runs on uses. Anything else is refused rather than unpacked on a guess: a wrong
        // stride draws a diagonal smear, which reads as a broken app rather than as a state.
        anyhow::ensure!(
            image.data.len() >= pixels * 4,
            "expected 32-bit pixels for a {width}x{height} window, got {} bytes",
            image.data.len()
        );
        let mut rgb = Vec::with_capacity(pixels * 3);
        png::pixels_to_rgb(&image.data[..pixels * 4], self.msb_first, &mut rgb);
        let png = png::encode_rgb(width as u32, height as u32, &rgb)?;
        Ok(Some(Frame { width, height, png }))
    }

    /// `GetImage` of the window's top-left `size`, with X's own error kept so the caller can
    /// tell a window off its screen (`BadMatch`) from every other failure. The caller holds the
    /// X turn.
    fn read_pixels(
        &self,
        (width, height): (u16, u16),
    ) -> std::result::Result<GetImageReply, x11rb::errors::ReplyError> {
        self.conn.get_image(ImageFormat::Z_PIXMAP, self.window, 0, 0, width, height, !0)?.reply()
    }

    /// Move a window X refused to read wholly onto its screen (when `may_move`), or say which part
    /// of it can be read where it stands.
    ///
    /// This is the one thing a window manager would do that nothing does here. Neither display
    /// this module reads has one, so a program maps its window where it likes — and the Intune
    /// portal maps its 478x628 window at 615,375 on the container's 1280x800 screen, with its
    /// bottom 203 rows past the edge (recorded in intune-container's own viewer, src/xscreen.rs,
    /// which moves it to the origin for the same reason). X refuses every read of such a window,
    /// so an enrollment showed nothing at all: the panel drew its placeholder for as long as the
    /// portal was open. So the window is moved the LEAST that puts it on the screen — the clamp a
    /// window manager applies.
    ///
    /// Only a TOP-LEVEL window is moved. Inside another program's window (a manager's frame,
    /// on a display that has one) the position is that program's to choose; what is read then
    /// is the part on the screen, and a window whose part on the screen does not start at its own
    /// origin is refused rather than read with an offset nothing else would know about.
    ///
    /// The caller holds the X turn.
    fn place_on_screen(&self, geometry: &GetGeometryReply, may_move: bool) -> Result<Placement> {
        let screen = (u32::from(self.screen.0), u32::from(self.screen.1));
        let border = i32::from(geometry.border_width);
        let size = (u32::from(geometry.width), u32::from(geometry.height));
        let parent = self
            .conn
            .query_tree(self.window)?
            .reply()
            .context("ask where the sign-in window stands")?
            .parent;
        if may_move && parent == self.root {
            let outer = (i32::from(geometry.x), i32::from(geometry.y));
            let outer_size = (size.0 + 2 * border as u32, size.1 + 2 * border as u32);
            if let Some((x, y)) = origin_on_screen(outer, outer_size, screen) {
                self.conn
                    .configure_window(self.window, &ConfigureWindowAux::new().x(x).y(y))?
                    .check()
                    .context("move the sign-in window onto its screen")?;
                // A client holding SubstructureRedirect on the root (a window manager this module
                // did not expect) turns the move into a request it may ignore. Answered `Moved`
                // anyway, every tick would move nothing and read nothing, for ever — so the move
                // counts only where it landed, and otherwise the window is read where it stands.
                let now = self
                    .conn
                    .get_geometry(self.window)?
                    .reply()
                    .context("the sign-in window went away while it was being placed")?;
                if (i32::from(now.x), i32::from(now.y)) == (x, y) {
                    return Ok(Placement::Moved);
                }
            }
        }
        let at = self
            .conn
            .translate_coordinates(self.window, self.root, 0, 0)?
            .reply()
            .context("ask where the sign-in window stands")?;
        let inner = (i32::from(at.dst_x), i32::from(at.dst_y));
        visible_part(inner, size, screen).map(Placement::Read).ok_or_else(|| {
            anyhow!(
                "the sign-in window ({}x{} at {},{}) is not wholly on its {}x{} screen and stands \
                 where this app cannot move it, so it cannot be read",
                size.0,
                size.1,
                inner.0,
                inner.1,
                screen.0,
                screen.1
            )
        })
    }

    /// Put the keyboard focus on the sign-in window.
    ///
    /// Load-bearing, and the reason doing this by hand needed a window manager: XTEST keys
    /// go to whatever holds the input focus, and on a display with no manager a click
    /// focuses nothing at all — which is exactly why an earlier attempt at this by hand
    /// could not type the password until `openbox` was started. Setting the focus directly
    /// needs no manager.
    pub fn focus(&self) -> Result<()> {
        let _turn = x_turn();
        self.conn.set_input_focus(InputFocus::PARENT, self.window, CURRENT_TIME)?.check()?;
        Ok(())
    }

    /// Click (or scroll) at a point inside the window.
    ///
    /// The coordinates are the window's own, and they are CLAMPED to it: a pointer event is
    /// delivered by position, so an unclamped one lands on whatever else is on that display.
    pub fn click(&self, x: i16, y: i16, button: Button) -> Result<()> {
        let _turn = x_turn();
        let geometry = self.conn.get_geometry(self.window)?.reply()?;
        let inside_x = x.clamp(0, geometry.width.saturating_sub(1) as i16);
        let inside_y = y.clamp(0, geometry.height.saturating_sub(1) as i16);
        let at = self
            .conn
            .translate_coordinates(self.window, self.root, inside_x, inside_y)?
            .reply()?;
        x11rb::protocol::xtest::fake_input(
            &self.conn,
            MOTION_NOTIFY,
            0, // absolute
            0,
            self.root,
            at.dst_x,
            at.dst_y,
            0,
        )?
        .check()?;
        for kind in [BUTTON_PRESS, BUTTON_RELEASE] {
            x11rb::protocol::xtest::fake_input(
                &self.conn,
                kind,
                button.detail(),
                0,
                self.root,
                at.dst_x,
                at.dst_y,
                0,
            )?
            .check()?;
        }
        Ok(())
    }

    /// Type one key into the window.
    ///
    /// A character the layout cannot produce is typed by lending a spare keycode the right
    /// keysym for the length of the press. A bare `Xvfb` carries a US layout, so without
    /// this every password with an accent in it would be untypable — and "your password
    /// cannot be entered here" is not an answer.
    pub fn type_key(&self, key: &Key) -> Result<()> {
        let Some(keysym) = key.keysym() else {
            return Err(anyhow!("{key:?} is not a key this app sends"));
        };
        let _turn = x_turn();
        if let Some(&(keycode, shifted)) = self.layout.get(&keysym) {
            return self.press(keycode, shifted);
        }
        let spare = self
            .spare
            .ok_or_else(|| anyhow!("this display's keyboard has no free keycode to type with"))?;
        self.conn.change_keyboard_mapping(1, spare, 1, &[keysym])?.check()?;
        // The window is a GTK program: it re-reads the mapping when X tells it to, and the
        // press has to arrive after that. Measured by nobody — it is a race, and a few
        // milliseconds is the cheapest way not to lose it.
        std::thread::sleep(Duration::from_millis(20));
        let pressed = self.press(spare, false);
        // Give the keycode back whatever happened: a borrowed one left mapped changes what
        // the next program on this display gets when that key is pressed.
        if let Ok(cookie) = self.conn.change_keyboard_mapping(1, spare, 1, &[0]) {
            let _ = cookie.check();
        }
        let _ = self.conn.flush();
        pressed
    }

    fn press(&self, keycode: u8, shifted: bool) -> Result<()> {
        let shift = shifted.then(|| self.layout.get(&XK_SHIFT_L).map(|(c, _)| *c)).flatten();
        if let Some(shift) = shift {
            x11rb::protocol::xtest::fake_input(
                &self.conn, KEY_PRESS, shift, 0, self.root, 0, 0, 0,
            )?
            .check()?;
        }
        for kind in [KEY_PRESS, KEY_RELEASE] {
            x11rb::protocol::xtest::fake_input(
                &self.conn, kind, keycode, 0, self.root, 0, 0, 0,
            )?
            .check()?;
        }
        if let Some(shift) = shift {
            x11rb::protocol::xtest::fake_input(
                &self.conn, KEY_RELEASE, shift, 0, self.root, 0, 0, 0,
            )?
            .check()?;
        }
        Ok(())
    }

    /// Ask the window to close, the way a person closing it would.
    ///
    /// `WM_DELETE_WINDOW`, and deliberately NOT `cancelInteractiveFlow`: measured on
    /// 2026-08-18, that D-Bus call with an empty body took the broker off the bus
    /// (`Message recipient disconnected from message bus without replying`) — which is the
    /// one failure signature whose automatic remedy is restarting the user's whole Intune
    /// container. Closing the window is what the broker's own flow is built to survive, and
    /// after it the broker re-activated cleanly. Not `kill_client` either: that drops the
    /// broker's X connection, which is a way to take the broker down rather than the flow.
    pub fn close(&self) -> Result<()> {
        let _turn = x_turn();
        close_window(&self.conn, self.window)
    }
}

/// Send `window` the `WM_DELETE_WINDOW` a person closing it would (see [`SigninWindow::close`]
/// for why this and nothing harsher). Takes no turn of its own: both callers already hold it,
/// and the lock is not reentrant.
fn close_window(conn: &RustConnection, window: Window) -> Result<()> {
    let intern = |name: &str| -> Result<Atom> {
        Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
    };
    let protocols = intern("WM_PROTOCOLS")?;
    let delete = intern("WM_DELETE_WINDOW")?;
    let event = ClientMessageEvent::new(32, window, protocols, [delete, CURRENT_TIME, 0, 0, 0]);
    conn.send_event(false, window, EventMask::NO_EVENT, event)?.check()?;
    conn.flush()?;
    Ok(())
}

/// One window a search matched, in the order the search met it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Candidate {
    window: Window,
    /// Set on a window the program placed itself (a menu, a tooltip): see
    /// [`SigninWindow::find_any`] for why that ranks it last.
    override_redirect: bool,
}

/// Walk down from `from` and record every viewable window whose `WM_CLASS` holds one of
/// `classes`, TOPMOST FIRST.
///
/// Every match rather than the first, because the ranking in [`pick_window`] needs them all and
/// a Cancel closes them all. On the displays measured (six windows on the broker's, forty on the
/// container's own) that is a few dozen round trips on a local socket per pass.
///
/// `QueryTree` answers children in stacking order, bottom to top, so they are walked in
/// reverse; and each child is checked before its own children, depth first, so a window
/// manager's frame — which sits above the program's window and carries no class of its own —
/// is descended into in the frame's own place in the stack. The order in `out` is therefore the
/// order a reader would see the windows in, which is what [`pick_window`] reads.
fn collect_by_class(
    conn: &RustConnection,
    from: Window,
    classes: &[&str],
    depth: u32,
    out: &mut Vec<Candidate>,
) -> Result<()> {
    if depth == 0 {
        return Ok(());
    }
    let class_atom = Atom::from(AtomEnum::WM_CLASS);
    let children = match conn.query_tree(from)?.reply() {
        Ok(tree) => tree.children,
        // The window went away between the walk that met it and this read (`BadWindow`): it has
        // no tree, and it is simply not there. Only an X error is read that way — a connection
        // that broke is a failure of the whole search, and says so.
        Err(x11rb::errors::ReplyError::X11Error(_)) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for &child in children.iter().rev() {
        if let Some(override_redirect) = matching_window(conn, child, class_atom, classes)? {
            out.push(Candidate { window: child, override_redirect });
        }
        collect_by_class(conn, child, classes, depth - 1, out)?;
    }
    Ok(())
}

/// The window a search answers with: the topmost one that is a real window, and an
/// override-redirect one only when there is nothing else. Pure, so the ranking is tested
/// without a display.
fn pick_window(found: &[Candidate]) -> Option<Window> {
    found
        .iter()
        .find(|c| !c.override_redirect)
        .or_else(|| found.first())
        .map(|c| c.window)
}

/// The part of a window that is on its screen, in the window's own coordinates: always from its
/// origin, so a frame of it is addressed exactly as the window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OnScreen {
    width: u16,
    height: u16,
}

/// What [`SigninWindow::place_on_screen`] did about a window X refused to read.
enum Placement {
    /// It was moved wholly onto its screen; read it on the next tick, once it has repainted.
    Moved,
    /// It stays where it is, and this much of it, from its origin, is on the screen.
    Read(OnScreen),
}

/// Where a top-level window whose outer corner is at `at`, `size` wide and tall, has to be moved
/// so it is wholly on a `screen`-sized screen — or `None` when it already is. The least move that
/// does it, the clamp a window manager applies: an axis that fits is left exactly where it was,
/// and a window larger than the screen goes to that edge's 0, so the corner a reader starts
/// reading from is the one on screen. Pure, so it is tested without a display.
fn origin_on_screen(at: (i32, i32), size: (u32, u32), screen: (u32, u32)) -> Option<(i32, i32)> {
    let clamp = |at: i32, size: u32, screen: u32| {
        let room = i64::from(screen) - i64::from(size);
        i64::from(at).clamp(0, room.max(0)) as i32
    };
    let placed = (clamp(at.0, size.0, screen.0), clamp(at.1, size.1, screen.1));
    (placed != at).then_some(placed)
}

/// The part of a window whose inner origin is at `at` (root coordinates), `size` wide and tall,
/// that lies on a `screen`-sized screen — `None` when none of it does, or when the part on screen
/// does not start at the window's own origin (the window hangs off the top or left edge), which a
/// frame could only carry with an offset the page that maps presses on it does not know about.
fn visible_part(at: (i32, i32), size: (u32, u32), screen: (u32, u32)) -> Option<OnScreen> {
    if at.0 < 0 || at.1 < 0 {
        return None;
    }
    let span = |at: i32, size: u32, screen: u32| {
        let room = i64::from(screen) - i64::from(at);
        u16::try_from(i64::from(size).min(room).max(0)).unwrap_or(u16::MAX)
    };
    let (width, height) = (span(at.0, size.0, screen.0), span(at.1, size.1, screen.1));
    (width > 0 && height > 0).then_some(OnScreen { width, height })
}

/// Is this window one of `classes`, drawn and readable right now? `Some(override_redirect)`
/// when it is, `None` when it is not.
///
/// The class is not enough, and that took the real thing to find out: the broker leaves an
/// UNMAPPED 10x10 window behind, carrying the very same `WM_CLASS`, after a flow ends.
/// Matched on the class alone, this module found that one — and `GetImage` on an unmapped
/// window is a `BadMatch`, so the frame read failed with an X error code where the honest
/// answer was "no sign-in window is open". So the map state is part of the identity: a
/// window that is not viewable cannot be read and cannot be typed into.
fn matching_window(
    conn: &RustConnection,
    window: Window,
    class_atom: Atom,
    classes: &[&str],
) -> Result<Option<bool>> {
    let Some(reply) = conn
        .get_property(false, window, class_atom, Atom::from(AtomEnum::STRING), 0, 256)
        .ok()
        .and_then(|c| c.reply().ok())
    else {
        // A window that went away between the tree walk and this read is simply not it.
        return Ok(None);
    };
    if !classes.iter().any(|class| wm_class_holds(&reply.value, class)) {
        return Ok(None);
    }
    let Some(attributes) =
        conn.get_window_attributes(window).ok().and_then(|c| c.reply().ok())
    else {
        return Ok(None);
    };
    Ok((attributes.map_state == MapState::VIEWABLE).then_some(attributes.override_redirect))
}

/// Does a raw `WM_CLASS` property hold `class`?
///
/// The property is two NUL-terminated strings — the instance name and the class name — so a
/// plain `contains` over the whole blob would match a window whose *title* happened to
/// carry the word. Compared segment by segment for that reason.
fn wm_class_holds(value: &[u8], class: &str) -> bool {
    String::from_utf8_lossy(value)
        .split('\0')
        .any(|part| part.eq_ignore_ascii_case(class))
}

/// The server's keysym -> (keycode, shift) map, and a keycode nobody is using.
fn read_layout(conn: &RustConnection) -> Result<(HashMap<u32, (u8, bool)>, Option<u8>)> {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let count = max - min + 1;
    let mapping = conn.get_keyboard_mapping(min, count)?.reply()?;
    let per = mapping.keysyms_per_keycode as usize;
    let mut layout: HashMap<u32, (u8, bool)> = HashMap::new();
    let mut spare = None;
    for index in 0..count as usize {
        let keycode = min + index as u8;
        let group = &mapping.keysyms[index * per..(index + 1) * per];
        if group.iter().all(|&sym| sym == 0) {
            // Keep the LAST free keycode: the low ones are where a layout puts modifiers it
            // may add later, and this one is borrowed for as long as the app runs.
            spare = Some(keycode);
            continue;
        }
        // Column 0 is unshifted, column 1 is shifted. Deeper columns are other groups
        // (AltGr and friends) and are deliberately not offered: reaching them needs a
        // modifier this app does not model, and the spare keycode covers those characters.
        for (column, &sym) in group.iter().take(2).enumerate() {
            if sym != 0 {
                layout.entry(sym).or_insert((keycode, column == 1));
            }
        }
    }
    Ok((layout, spare))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_display_is_read_out_of_the_brokers_own_environment() {
        // A real environ block: NUL-separated, DISPLAY not first. This exact shape was read
        // off the running broker on 2026-08-18.
        let environ = "LANG=C\0DISPLAY=:77\0XDG_RUNTIME_DIR=/run/user/0\0XAUTHORITY=/tmp/x\0";
        assert_eq!(display_in_environ(environ).as_deref(), Some(":77"));
        // An empty value is no display, not a display called "".
        assert_eq!(display_in_environ("DISPLAY=\0HOME=/root\0"), None);
        assert_eq!(display_in_environ("HOME=/root\0"), None);
    }

    #[test]
    fn only_a_local_display_resolves_to_a_socket() {
        assert_eq!(display_socket(":77").as_deref(), Some("/tmp/.X11-unix/X77"));
        assert_eq!(display_socket(":0.0").as_deref(), Some("/tmp/.X11-unix/X0"));
        // A display on another machine is never reached for: the sign-in page is on it.
        assert_eq!(display_socket("otherhost:0"), None);
        assert_eq!(display_socket("localhost:12.0"), None);
        assert_eq!(display_socket(""), None);
    }

    #[test]
    fn an_abstract_socket_is_a_display_being_served() {
        // The shape of /proc/net/unix as read on 2026-11-02, with the Intune container's Xvfb
        // listening on its abstract name and the host's own displays on both kinds.
        let table = "Num       RefCount Protocol Flags    Type St Inode Path\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 21512 @/tmp/.X11-unix/X99\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 19022 /tmp/.X11-unix/X0\n\
            0000000000000000: 00000003 00000000 00000000 0001 03 33571\n\
            0000000000000000: 00000003 00000000 00000000 0001 03 33572 @/tmp/.X11-unix/X98\n";
        assert!(unix_table_lists_abstract(table, "/tmp/.X11-unix/X99"));
        // A connection the server accepted carries its name and is no server: X98's listener
        // is gone, and what is left of it does not make a display.
        assert!(!unix_table_lists_abstract(table, "/tmp/.X11-unix/X98"));
        // The FILE socket is not an abstract one; the file is asked about separately.
        assert!(!unix_table_lists_abstract(table, "/tmp/.X11-unix/X0"));
        // A display number is matched whole, never as a prefix of a longer one.
        assert!(!unix_table_lists_abstract(table, "/tmp/.X11-unix/X9"));
        // A socket with no name names nothing, and the header is not a row.
        assert!(!unix_table_lists_abstract(table, "Path"));
    }

    #[test]
    fn a_display_that_cannot_draw_says_what_to_do_about_it() {
        let missing = DisplayState::Missing { display: ":77".into() };
        let words = missing.refusal().expect("a refusal");
        assert!(words.contains(":77"), "names the display: {words}");
        assert!(words.contains("Restarting Intune"), "names the remedy: {words}");
        // The one state whose remedy is NOT in this app must not claim otherwise.
        let none = DisplayState::None.refusal().expect("a refusal");
        assert!(none.contains("on the machine itself"), "{none}");
        assert!(DisplayState::Ready { display: ":77".into() }.refusal().is_none());
    }

    #[test]
    fn the_window_is_matched_on_a_whole_wm_class_segment() {
        // The property as X stores it: instance NUL class NUL. Measured on the real window.
        let real = b"microsoft-identity-broker\0Microsoft-identity-broker\0";
        assert!(wm_class_holds(real, SIGNIN_WM_CLASS));
        // Case is the class name's own business.
        assert!(wm_class_holds(b"Microsoft-Identity-Broker\0", SIGNIN_WM_CLASS));
        // The leftover portal windows that shared that display must never match.
        assert!(!wm_class_holds(b"intune-portal\0Intune-portal\0", SIGNIN_WM_CLASS));
        // And a window whose class merely CONTAINS the name is not it: a substring match
        // would accept a browser tab titled after the broker.
        assert!(!wm_class_holds(b"not-microsoft-identity-broker-either\0", SIGNIN_WM_CLASS));
        assert!(!wm_class_holds(b"", SIGNIN_WM_CLASS));
    }

    #[test]
    fn an_enrollment_serves_the_portal_and_the_broker_and_nothing_else() {
        let portal = b"intune-portal\0Intune-portal\0";
        let broker = b"microsoft-identity-broker\0Microsoft-identity-broker\0";
        let holds_any =
            |value: &[u8]| ENROLL_WM_CLASSES.iter().any(|class| wm_class_holds(value, class));
        assert!(holds_any(portal), "the portal is what an enrollment is done in");
        assert!(holds_any(broker), "and the broker's dialog it opens over the portal");
        // Anything else on that display is never served — a terminal, a leftover frame of a
        // program nobody asked for, a window that merely contains the name.
        assert!(!holds_any(b"xterm\0XTerm\0"));
        assert!(!holds_any(b"intune-portal-helper\0"));
        // And a SIGN-IN still serves the broker alone: the portal is not the broker.
        assert!(!wm_class_holds(portal, SIGNIN_WM_CLASS));
    }

    #[test]
    fn the_topmost_real_window_is_served_and_a_popup_only_when_nothing_else_is() {
        // In the order a search meets them: topmost first.
        let menu = Candidate { window: 4, override_redirect: true };
        let dialog = Candidate { window: 3, override_redirect: false };
        let portal = Candidate { window: 2, override_redirect: false };
        // The broker's dialog over the portal is the window the reader is being asked about —
        // and a GTK menu above both is part of a page, not a page.
        assert_eq!(pick_window(&[menu, dialog, portal]), Some(3));
        // Once the dialog goes, the portal is the answer again.
        assert_eq!(pick_window(&[portal]), Some(2));
        // A display offering only a popup still serves it, rather than refusing a broker that
        // drew its window that way.
        assert_eq!(pick_window(&[menu]), Some(4));
        assert_eq!(pick_window(&[]), None);
    }

    #[test]
    fn the_stack_is_walked_topmost_first() {
        // `QueryTree` answers bottom to top, so the search reads it backwards — the half of
        // "topmost" a unit test with no display can only pin on the code.
        let whole = include_str!("xwindow.rs");
        let source = &whole[..whole.find("\n#[cfg(test)]").unwrap_or(whole.len())];
        let walk = source.find("fn collect_by_class(").expect("collect_by_class");
        let body = &source[walk..walk + source[walk..].find("\n}\n").unwrap()];
        assert!(body.contains("children.iter().rev()"), "{body}");
        // And the broker's own search is the same one, narrowed to its class.
        let find = source.find("pub fn find(display: &str)").expect("find");
        let find_body = &source[find..find + source[find..].find("\n    }").unwrap()];
        assert!(find_body.contains("Self::find_any(display, &[SIGNIN_WM_CLASS])"), "{find_body}");
    }

    #[test]
    fn an_enrollment_is_drawn_on_the_containers_own_display() {
        // Named by the crate, never read out of a process: the portal does not exist yet when
        // the question is asked.
        assert_eq!(container_display().display(), Some(intune_container::ops::CONTAINER_DISPLAY));
        assert_eq!(
            display_socket(intune_container::ops::CONTAINER_DISPLAY).as_deref(),
            Some("/tmp/.X11-unix/X99")
        );
    }

    #[test]
    fn a_character_becomes_a_keysym_and_a_named_key_becomes_itself() {
        assert_eq!(Key::Char('a').keysym(), Some(0x61));
        assert_eq!(Key::Char('A').keysym(), Some(0x41));
        assert_eq!(Key::Char('@').keysym(), Some(0x40));
        // Latin-1 is its own code point; above it, the Unicode keysym form.
        assert_eq!(Key::Char('é').keysym(), Some(0xe9));
        assert_eq!(Key::Char('€').keysym(), Some(0x0100_20ac));
        assert_eq!(Key::Named("Enter".into()).keysym(), Some(XK_RETURN));
        assert_eq!(Key::Named("Backspace".into()).keysym(), Some(XK_BACKSPACE));
        // A key this app does not send is dropped rather than guessed at.
        assert_eq!(Key::Named("F1".into()).keysym(), None);
        assert_eq!(Key::Named("Meta".into()).keysym(), None);
        assert_eq!(Key::Named("".into()).keysym(), None);
    }

    #[test]
    fn the_buttons_are_the_three_a_sign_in_form_needs() {
        assert_eq!(Button::Left.detail(), 1);
        assert_eq!(Button::ScrollUp.detail(), 4);
        assert_eq!(Button::ScrollDown.detail(), 5);
    }

    #[test]
    fn a_window_hanging_off_its_screen_is_moved_the_least_that_puts_it_on() {
        let screen = (1280, 800);
        // The Intune portal as it really maps itself on the container's display: 203 rows past
        // the bottom edge. Only the axis that does not fit moves.
        assert_eq!(origin_on_screen((615, 375), (478, 628), screen), Some((615, 172)));
        // Wholly on the screen, edges included: left exactly where it is.
        assert_eq!(origin_on_screen((0, 0), (478, 628), screen), None);
        assert_eq!(origin_on_screen((802, 172), (478, 628), screen), None);
        // Off the right, the top and the left, each clamped back to its edge.
        assert_eq!(origin_on_screen((1000, 10), (478, 628), screen), Some((802, 10)));
        assert_eq!(origin_on_screen((10, -40), (478, 628), screen), Some((10, 0)));
        assert_eq!(origin_on_screen((-5, -5), (478, 628), screen), Some((0, 0)));
        // Larger than the screen: to that edge's 0, so the corner a reader starts from is on it.
        assert_eq!(origin_on_screen((100, 100), (478, 1000), screen), Some((100, 0)));
        assert_eq!(origin_on_screen((0, 0), (2000, 1000), screen), None);
    }

    #[test]
    fn only_the_part_on_the_screen_is_read_and_it_starts_at_the_windows_origin() {
        let screen = (1280, 800);
        let part = |width, height| Some(OnScreen { width, height });
        assert_eq!(visible_part((615, 172), (478, 628), screen), part(478, 628));
        // Off the bottom or the right: what is on the screen, from the window's own origin.
        assert_eq!(visible_part((615, 375), (478, 628), screen), part(478, 425));
        assert_eq!(visible_part((1000, 0), (478, 628), screen), part(280, 628));
        assert_eq!(visible_part((0, 0), (2000, 1000), screen), part(1280, 800));
        // Off the top or the left, the frame would need an offset nothing maps presses with.
        assert_eq!(visible_part((-1, 0), (478, 628), screen), None);
        assert_eq!(visible_part((0, -1), (478, 628), screen), None);
        // Nothing of it on the screen at all.
        assert_eq!(visible_part((1280, 0), (478, 628), screen), None);
        assert_eq!(visible_part((0, 900), (478, 628), screen), None);
    }

    #[test]
    fn a_window_is_placed_only_after_x_refused_to_read_it_whole() {
        let source = include_str!("xwindow.rs");
        let body = &source[source.find("    fn read_frame(&self, place: bool)").expect("read")..];
        let body = &body[..body.find("\n    }\n").expect("end of the read")];
        // The whole window first — every read that ever worked here stays exactly as it was.
        let whole = body.find("let image = match self.read_pixels(size) {").expect("whole read");
        let refused = body.find("if error.error_kind == ErrorKind::Match =>").expect("BadMatch");
        let placed = body.find("self.place_on_screen(&geometry, place)?").expect("placement");
        assert!(whole < refused && refused < placed, "read whole, then place on BadMatch:\n{body}");
        // A tick that moved the window reads nothing: the rows it brought on screen are not drawn.
        assert!(body.contains("Placement::Moved => return Ok(None),"), "{body}");
        // What a window that stays put yields is its part on the screen, never its whole geometry.
        assert!(body.contains("size = (part.width, part.height);"), "{body}");
    }

    /// MEASURED against a real X server, which is the only thing that can say what `GetImage`
    /// refuses: a window that hangs off its screen cannot be read at all, and once this module has
    /// placed it, it can. Needs a display with no window manager on it (an Xvfb, as both of the
    /// displays this module reads are); name it in `TEAMS_LITE_TEST_X_DISPLAY`, for example
    /// `docker run --rm -p 127.0.0.1:6099:6099 <an image with Xvfb> Xvfb :99 -screen 0
    /// 1280x800x24 -listen tcp -ac` and `TEAMS_LITE_TEST_X_DISPLAY=127.0.0.1:99`.
    #[test]
    #[ignore = "needs an X server without a window manager, named in TEAMS_LITE_TEST_X_DISPLAY"]
    fn a_portal_window_hanging_off_the_screen_is_placed_and_then_read() {
        use x11rb::protocol::xproto::{CreateWindowAux, PropMode, WindowClass};
        use x11rb::wrapper::ConnectionExt as _;

        let display = std::env::var("TEAMS_LITE_TEST_X_DISPLAY")
            .expect("TEAMS_LITE_TEST_X_DISPLAY names the X server to measure against");
        let (conn, screen) = RustConnection::connect(Some(&display)).expect("connect");
        let root = &conn.setup().roots[screen];
        assert_eq!((root.width_in_pixels, root.height_in_pixels), (1280, 800), "a 1280x800 screen");
        let window = conn.generate_id().expect("id");
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root.root,
            615,
            375,
            478,
            628,
            0,
            WindowClass::INPUT_OUTPUT,
            root.root_visual,
            &CreateWindowAux::new().background_pixel(root.white_pixel),
        )
        .expect("create")
        .check()
        .expect("created");
        conn.change_property8(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"intune-portal\0Intune-portal\0",
        )
        .expect("class")
        .check()
        .expect("classed");
        conn.map_window(window).expect("map").check().expect("mapped");

        // The cause, measured: X refuses to read a window that is not wholly on its screen, and
        // refuses it as BadMatch — the one refusal `capture` answers by placing the window.
        let refused = conn
            .get_image(ImageFormat::Z_PIXMAP, window, 0, 0, 478, 628, !0)
            .expect("ask")
            .reply();
        assert!(
            matches!(
                &refused,
                Err(x11rb::errors::ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Match
            ),
            "GetImage of a window off its screen must be refused as BadMatch: {refused:?}"
        );

        let found = SigninWindow::find_any(&display, ENROLL_WM_CLASSES)
            .expect("search")
            .expect("the portal window is found");
        // A read that may not move it reads what is on the screen, and leaves it where it is.
        let part = found.capture().expect("the part on the screen is read");
        assert_eq!((part.width, part.height), (478, 425));
        let unmoved = conn.get_geometry(window).expect("ask").reply().expect("geometry");
        assert_eq!((unmoved.x, unmoved.y), (615, 375), "a diagnostic's read moves nothing");
        // The session's read moves it, and reads nothing: its new rows are not drawn yet.
        assert!(found.capture_or_place().expect("placed").is_none(), "the moving tick serves none");
        let geometry = conn.get_geometry(window).expect("ask").reply().expect("geometry");
        assert_eq!((geometry.x, geometry.y), (615, 172), "moved the least that puts it on");
        // The next one reads it whole, and moves nothing.
        let frame = found.capture_or_place().expect("read").expect("a placed window is read");
        assert_eq!((frame.width, frame.height), (478, 628));
        assert!(!frame.png.is_empty());
        let again = conn.get_geometry(window).expect("ask").reply().expect("geometry");
        assert_eq!((again.x, again.y), (615, 172));

        conn.destroy_window(window).expect("destroy").check().expect("destroyed");
    }
}
