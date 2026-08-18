//! Re-measure the facts SIGN-IN.md § 3 rests on, through this crate's own functions.
//!
//! READ-ONLY, and only read-only: it finds the display the broker draws on, looks for the
//! broker's sign-in window if one is up, and reports the shapes — the display, the window's
//! size, and the byte cost of one frame. It never starts a sign-in, never types, and never
//! closes anything.
//!
//!     cargo run --example signin_window_recon
//!     cargo run --example signin_window_recon -- --save /tmp/signin.png
//!
//! IT USED TO TYPE AND CLOSE, behind `--type` and `--close`, which is how the input path was
//! measured once (SIGN-IN.md § 3). Those are gone: they acted on the user's live sign-in window
//! from a command line, past the write token, past `TEAMS_LITE_READ_ONLY` and past the
//! automation hook that gates the four `signin_*` RPCs — a second door to the thing those gates
//! exist for. `.claude/hooks/guard-live-automation.sh` now blocks an example that calls the
//! driving half of `xwindow` at all, so putting them back is a deliberate act with a guard
//! entry rather than a flag.
//!
//! `--save` writes the frame to a path the operator names. That is a picture of whatever the
//! broker is showing, so it is theirs to ask for and never something this prints by default.
//!
//! A window only exists while the broker is waiting for a human, which is rare and cannot be
//! arranged from here — so "no sign-in window is open" is the ordinary answer, and the display
//! half of the report is the half that always says something.

use teams_lite::xwindow::{self, SigninWindow};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| -> Option<String> {
        args.iter().position(|a| a == name).and_then(|at| args.get(at + 1)).cloned()
    };

    let state = xwindow::broker_display();
    println!("broker display : {state:?}");
    if let Some(words) = state.refusal() {
        println!("refusal        : {words}");
    }
    let Some(display) = state.display() else { return Ok(()) };
    println!("display socket : {:?}", xwindow::display_socket(display));

    let Some(window) = SigninWindow::find(display)? else {
        println!("sign-in window : none open (the ordinary case — the broker only draws one");
        println!("                 when it needs a human)");
        return Ok(());
    };
    println!("sign-in window : found by WM_CLASS {:?}", xwindow::SIGNIN_WM_CLASS);

    let frame = window.capture()?;
    println!(
        "frame          : {}x{} px, {} bytes of PNG ({:.1} KB)",
        frame.width,
        frame.height,
        frame.png.len(),
        frame.png.len() as f64 / 1024.0
    );

    if let Some(path) = flag("--save") {
        std::fs::write(&path, &frame.png)?;
        println!("saved          : {path}");
    }

    Ok(())
}
