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
//! display here), whether this is teams-lite's container image, and which Intune MODE this
//! process is in (`TEAMS_LITE_INTUNE_MODE`). In embedded mode — the image's default, where the
//! app runs its OWN Intune container — it adds whether that container has been set up, whether it
//! holds a device registration (and whether an import of one did not finish), whether it is up —
//! naming apart a leader that is up with no broker's bus, which only a restart mends — which
//! holder (boot, repair, portal, or the stop) has the helper slot, and whether the volume's
//! container runs in ANOTHER container or pod. All read without touching anything: the helper
//! slot and the crate's supervisor lock are asked with shared try-locks on files it never creates,
//! and no state is cleaned. Inside the image it is installed as `teams-lite-intune-status`:
//!
//!     docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status
//!
//! Exit codes keep the shape the script had, so a habit or a one-liner built on it still reads
//! right: 0 = unlocked, 1 = LOCKED, 2 = cannot tell (no container, one not running, or no answer).

use teams_lite::intune::{self, KeyringCheck};
use teams_lite::intune_embedded::{self, Mode};
use teams_lite::xwindow::{self, DisplayState};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mode = intune_embedded::mode();
    match &mode {
        Ok(Mode::Embedded) => println!("intune mode       : embedded — this process runs its own Intune container"),
        Ok(Mode::Host) => println!("intune mode       : host — the Intune container is the machine's own"),
        Err(e) => println!("intune mode       : REFUSED — {e:#}"),
    }
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
    if matches!(mode, Ok(Mode::Embedded)) {
        // `boot_followed` is the backend's own knowledge of a boot it spawned; this process
        // spawned none, so only the slot itself answers which helper is at work.
        let status = intune_embedded::status(false);
        println!(
            "set up            : {}",
            if status.initialized { "yes" } else { "no — the first start downloads about 1.7 GB" }
        );
        println!(
            "registered        : {}",
            match (status.registered, intune_embedded::import_pending()) {
                (_, true) => "an IMPORT DID NOT FINISH — the next boot imports the backup again",
                (true, false) => "yes",
                (false, false) => "no",
            }
        );
        let running = if status.running {
            "yes".to_string()
        } else if let Some(leader) = intune::container_leader() {
            format!("NO — its leader ({leader}) is up but its broker's bus is missing; the next boot restarts it")
        } else {
            "no".to_string()
        };
        println!("running           : {running}");
        println!(
            "slot held by      : {}",
            intune_embedded::slot_holder().map_or("nobody", intune_embedded::SlotHolder::tag)
        );
        if intune_embedded::container_runs_elsewhere() {
            println!(
                "volume            : SHARED — a container supervisor holds it and the runtime state \
                 names a leader that is not in this namespace: another container or pod runs its \
                 Intune container from this volume"
            );
        }
    }
    let repair = if intune::repair_available() {
        match mode {
            Ok(Mode::Embedded) => "yes — this container's own, as a helper".to_string(),
            _ => "yes — intune-container is set up here".to_string(),
        }
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
