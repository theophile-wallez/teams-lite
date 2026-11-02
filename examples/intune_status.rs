//! Where is the identity broker, and is the Intune container's keyring locked? READ-ONLY.
//!
//! The diagnostic for the two questions `src/intune.rs` answers in process — the one to reach
//! for when sign-in breaks, before anybody restarts anything:
//!
//!     cargo run --example intune_status
//!
//! It replaced `bin/teams-lite-broker-check.sh` (with no arguments) and
//! `bin/teams-lite-broker-bus-check.sh`, which asked the same through `busctl`, `pgrep` and
//! `/proc`. It reads the container's runtime state through the `intune-container` crate, opens
//! one D-Bus connection to the bus it finds, reads one property and asks the broker nothing:
//! no token, no account, no repair. It prints addresses and states, never a credential.
//!
//! It also says where the broker draws its sign-in window, read the way the app reads it
//! (`xwindow::broker_display` — the broker's own environment, and whether anything serves that
//! display here), and whether this is teams-lite's container image, which follows the broker
//! and never restarts the container. Inside the image it is installed as
//! `teams-lite-intune-status`:
//!
//!     docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status
//!
//! Exit codes keep the shape the script had, so a habit or a one-liner built on it still reads
//! right: 0 = unlocked, 1 = LOCKED, 2 = cannot tell (no container, one not running, or no answer).

use teams_lite::intune::{self, KeyringCheck};
use teams_lite::xwindow::{self, DisplayState};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let bus = intune::broker_bus();
    println!("broker bus        : {}", bus.describe());
    match bus.address() {
        Ok(address) => println!("address           : {address}"),
        Err(e) => println!("address           : unresolved ({e:#})"),
    }
    println!(
        "container image   : {}",
        if intune::in_container_image() { "yes — teams-lite's own" } else { "no" }
    );
    let repair = if intune::repair_available() {
        "yes — intune-container is set up here".to_string()
    } else if let Some(blocker) = intune::repair_blocker() {
        format!("no — {blocker}")
    } else {
        "no — read-only, or intune-container is not set up on this machine".to_string()
    };
    println!("repair available  : {repair}");
    let display = match xwindow::broker_display() {
        DisplayState::Ready { display } => format!("{display}, served here"),
        DisplayState::Missing { display } => format!("{display}, which nothing serves here"),
        DisplayState::None => "unknown (the broker is not running, or names no display)".to_string(),
    };
    println!("sign-in display   : {display}");

    let keyring = intune::container_keyring().await;
    println!("keyring           : {}", keyring.describe());
    std::process::exit(match keyring {
        KeyringCheck::Unlocked => 0,
        KeyringCheck::Locked => 1,
        KeyringCheck::NoContainer | KeyringCheck::NotRunning | KeyringCheck::Unknown(_) => 2,
    });
}
