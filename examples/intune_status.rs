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
//! Exit codes keep the shape the script had, so a habit or a one-liner built on it still reads
//! right: 0 = unlocked, 1 = LOCKED, 2 = cannot tell (no container, one not running, or no answer).

use teams_lite::intune::{self, KeyringCheck};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let bus = intune::broker_bus();
    println!("broker bus        : {}", bus.describe());
    match bus.address() {
        Ok(address) => println!("address           : {address}"),
        Err(e) => println!("address           : unresolved ({e:#})"),
    }
    println!(
        "repair available  : {}",
        if intune::repair_available() {
            "yes — intune-container is set up here"
        } else {
            "no — read-only, or intune-container is not set up on this machine"
        }
    );

    let keyring = intune::container_keyring().await;
    println!("keyring           : {}", keyring.describe());
    std::process::exit(match keyring {
        KeyringCheck::Unlocked => 0,
        KeyringCheck::Locked => 1,
        KeyringCheck::NoContainer | KeyringCheck::NotRunning | KeyringCheck::Unknown(_) => 2,
    });
}
