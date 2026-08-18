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
// window, found by the broker's own `WM_CLASS`, and this module refuses to work at all when
// that window is absent. The display it lives on carried six other windows when this was
// measured — leftover `intune-portal` frames — and on the container's own display, forty.
// Serving "the screen" would put whatever else is there in front of the reader, and typing
// a password would send it wherever the focus happened to be.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, ImageFormat, ImageOrder,
    InputFocus, MapState, Window,
};
use x11rb::rust_connection::RustConnection;
use x11rb::CURRENT_TIME;

use crate::png;

/// The `WM_CLASS` the broker gives its sign-in window. Measured on 2026-08-18:
/// `WM_CLASS(STRING) = "microsoft-identity-broker", "Microsoft-identity-broker"`, with the
/// title `Microsoft Authentication`. The CLASS and not the title: a title is what Entra
/// writes into the page's own frame and it changes between steps, while the class is the
/// program's.
pub const SIGNIN_WM_CLASS: &str = "microsoft-identity-broker";

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
    /// The broker names a display and its socket is there.
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
            if display_socket(&display).is_some_and(|p| std::path::Path::new(&p).exists()) {
                DisplayState::Ready { display }
            } else {
                DisplayState::Missing { display }
            }
        }
    }
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

/// The broker's sign-in window, open for reading and driving.
pub struct SigninWindow {
    conn: RustConnection,
    root: Window,
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
        let (conn, screen) = RustConnection::connect(Some(display))
            .with_context(|| format!("open X display {display}"))?;
        let root = conn.setup().roots[screen].root;
        let class_atom = Atom::from(AtomEnum::WM_CLASS);
        let Some(window) = find_by_class(&conn, root, class_atom, SIGNIN_WM_CLASS, SEARCH_DEPTH)?
        else {
            return Ok(None);
        };
        let (layout, spare) = read_layout(&conn)?;
        let msb_first = conn.setup().image_byte_order == ImageOrder::MSB_FIRST;
        Ok(Some(Self { conn, root, window, layout, spare, msb_first }))
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

    /// Read the window's pixels as a PNG.
    ///
    /// The WINDOW's own drawable, never the root: the frame must carry that window and
    /// nothing else on the display. Nothing is scaled — the page is 550 px wide and the
    /// number a reader has to match is 13 px type in it.
    pub fn capture(&self) -> Result<Frame> {
        let _turn = x_turn();
        let geometry = self
            .conn
            .get_geometry(self.window)?
            .reply()
            .context("the sign-in window went away while it was being read")?;
        let (width, height) = (geometry.width, geometry.height);
        anyhow::ensure!(width > 0 && height > 0, "the sign-in window has no size yet");
        let image = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.window, 0, 0, width, height, !0)?
            .reply()
            .context("read the sign-in window's pixels")?;
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
        Ok(Frame { width, height, png: png::encode_rgb(width as u32, height as u32, &rgb)? })
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
        let protocols = self.intern("WM_PROTOCOLS")?;
        let delete = self.intern("WM_DELETE_WINDOW")?;
        let event = ClientMessageEvent::new(32, self.window, protocols, [delete, CURRENT_TIME, 0, 0, 0]);
        self.conn.send_event(false, self.window, EventMask::NO_EVENT, event)?.check()?;
        self.conn.flush()?;
        Ok(())
    }

    fn intern(&self, name: &str) -> Result<Atom> {
        Ok(self.conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
    }
}

/// Walk down from `root` for a window whose `WM_CLASS` holds `class`.
fn find_by_class(
    conn: &RustConnection,
    from: Window,
    class_atom: Atom,
    class: &str,
    depth: u32,
) -> Result<Option<Window>> {
    if depth == 0 {
        return Ok(None);
    }
    let children = conn.query_tree(from)?.reply()?.children;
    // The window's own class first, breadth-first: a manager's frame sits above it and
    // carries no class of its own.
    for &child in &children {
        if is_signin_window(conn, child, class_atom, class)? {
            return Ok(Some(child));
        }
    }
    for &child in &children {
        if let Some(found) = find_by_class(conn, child, class_atom, class, depth - 1)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// Is this window the broker's sign-in window, drawn and readable right now?
///
/// The class is not enough, and that took the real thing to find out: the broker leaves an
/// UNMAPPED 10x10 window behind, carrying the very same `WM_CLASS`, after a flow ends.
/// Matched on the class alone, this module found that one — and `GetImage` on an unmapped
/// window is a `BadMatch`, so the frame read failed with an X error code where the honest
/// answer was "no sign-in window is open". So the map state is part of the identity: a
/// window that is not viewable cannot be read and cannot be typed into.
fn is_signin_window(
    conn: &RustConnection,
    window: Window,
    class_atom: Atom,
    class: &str,
) -> Result<bool> {
    let Some(reply) = conn
        .get_property(false, window, class_atom, Atom::from(AtomEnum::STRING), 0, 256)
        .ok()
        .and_then(|c| c.reply().ok())
    else {
        // A window that went away between the tree walk and this read is simply not it.
        return Ok(false);
    };
    if !wm_class_holds(&reply.value, class) {
        return Ok(false);
    }
    let Some(attributes) =
        conn.get_window_attributes(window).ok().and_then(|c| c.reply().ok())
    else {
        return Ok(false);
    };
    Ok(attributes.map_state == MapState::VIEWABLE)
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
}
