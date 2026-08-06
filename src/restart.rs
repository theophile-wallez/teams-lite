// Restarting the BACKEND on the user's own ask, from Settings › This app.
//
// It exists for the state nothing else in the app can mend: the backend is up, every read
// answers, and something inside it is stuck — a live feed the tenant stopped pushing to, a
// session that went stale, a Rust-side bug that a fresh process clears. The user's answer
// to that used to be a terminal on the machine the app runs on, which on a phone is no
// answer at all. `restart_backend` is that terminal, as one gated button.
//
// **THE BACKEND CANNOT RESTART ITSELF, and this module is about who can.** A process that
// exits comes back only if something is watching for it, and the three install shapes this
// app has watch in three different ways:
//
//   * the STAGED service (`teams-lite-backend.service`) is the backend itself, under
//     systemd, with `Restart=always`. It exits, systemd starts it again — nothing else has
//     to happen, and nothing else could: the unit owns the process.
//   * the `teams` command and `teams-lite-app.service` run the LAUNCHER, which spawns the
//     backend as a child and holds a keepalive socket to it (see launcher/src/launch.ts).
//     An exit there is final — the launcher does not watch the child — so the restart is
//     asked FOR, on that socket, exactly as an in-app update asks for its own
//     (`backend_restart`, handled in launcher/src/backend-restart.ts). The launcher then
//     re-spawns the backend alone, on the same port and with the same pinned write token,
//     and its web server never goes down: the page keeps being served and only its socket
//     blinks.
//   * a backend started BY HAND from a shell (`bin/teams-dev-server.sh`) has neither. It
//     exits and the app is gone until somebody types the command again.
//
// **Neither watcher is guessed at: each one SAYS so, in the environment of the process it
// will restart.** That is the shape `update::LAUNCHER_BIN_ENV` already has, and it is here
// for the same reason — a backend cannot see its own supervisor. `INVOCATION_ID` proves
// only that systemd started *something* in this tree (the launcher unit's backend child
// inherits it), and `Restart=` is not visible from inside the process at all. So a
// supervisor that really will restart this process declares it, once, and a shape that
// will not stays silent and is told so rather than being restarted into nothing.
//
// The third state is the one worth having: a button that took the backend down where
// nothing would bring it back would be the app deleting itself on a click.

/// Environment variable the `teams` command sets on every backend it spawns
/// (`launcher/src/backend.ts`), meaning: a launcher owns this process, holds a socket to
/// it, and can re-spawn it.
///
/// Deliberately not [`crate::update::LAUNCHER_BIN_ENV`], which is set only for a COMPILED
/// launcher — it names the binary an update may replace, and a `bun run` launcher has no
/// such binary while still owning its backend child. Two facts, two variables.
pub const LAUNCHER_ENV: &str = "TEAMS_LITE_LAUNCHER";

/// Environment variable a SUPERVISOR sets to say it starts this process again when it
/// exits — `packaging/systemd/teams-lite-backend.service`, whose `Restart=always` is what
/// makes it true.
///
/// It is the unit's own claim rather than something detected here, because there is
/// nothing to detect: a process cannot read its unit's `Restart=` setting, and a stray
/// `INVOCATION_ID` inherited from a parent unit would make a hand-started backend look
/// supervised.
pub const SUPERVISED_ENV: &str = "TEAMS_LITE_RESTART_ON_EXIT";

/// What will bring this backend back, once it has gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restarter {
    /// The `teams` launcher, over the keepalive socket it already holds. It kills the
    /// backend child and spawns a new one; its web server stays up throughout.
    Launcher,
    /// A supervisor that starts this process again when it exits — systemd, in the staged
    /// service. The restart IS the exit.
    Supervisor,
    /// Nothing. The button is refused, and says why.
    Nothing,
}

/// Decide it from the two declarations, as a pure function of them.
///
/// The launcher wins when both are present, which is the released build's own shape
/// (`teams-lite-app.service` runs the launcher, so its backend child inherits the unit's
/// environment): an exit there restarts the WHOLE app — web server, browser page and all —
/// where asking the launcher restarts the one process the user asked about.
pub fn restarter_from(launcher: Option<&str>, supervised: Option<&str>) -> Restarter {
    if flag_enabled(launcher) {
        Restarter::Launcher
    } else if flag_enabled(supervised) {
        Restarter::Supervisor
    } else {
        Restarter::Nothing
    }
}

/// The same, read from this process's own environment.
pub fn restarter() -> Restarter {
    restarter_from(
        std::env::var(LAUNCHER_ENV).ok().as_deref(),
        std::env::var(SUPERVISED_ENV).ok().as_deref(),
    )
}

/// Why a restart is refused, when nothing would bring the backend back.
///
/// It names the shape the user is in and the one thing that works there, because the
/// refusal is the whole answer they get: a sentence that only said "no" would leave them
/// pressing it again.
pub const NOTHING_WOULD_RESTART_IT: &str = "refused: nothing here would start this backend \
     again — it was started by hand, so restart it the way it was started";

/// Any value counts as "on" except an explicit falsey token, matching how every other
/// environment flag in this app is read (`env_flag_enabled` in src/bin/server.rs): a
/// supervisor writing `=true` means the same as one writing `=1`.
fn flag_enabled(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no" | "off"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backend_nobody_watches_is_never_restarted() {
        // The state that must refuse: a hand-started backend. Taking it down would leave
        // the user with no app at all, which is the one outcome this button must not have.
        assert_eq!(restarter_from(None, None), Restarter::Nothing);
        assert_eq!(restarter_from(Some("0"), Some("off")), Restarter::Nothing);
        assert_eq!(restarter_from(Some(""), None), Restarter::Nothing);
    }

    #[test]
    fn each_watcher_is_taken_at_its_word() {
        assert_eq!(restarter_from(Some("1"), None), Restarter::Launcher);
        assert_eq!(restarter_from(None, Some("1")), Restarter::Supervisor);
        // Spelled either way, like every other flag this app reads.
        assert_eq!(restarter_from(None, Some("true")), Restarter::Supervisor);
    }

    #[test]
    fn the_launcher_wins_over_the_unit_it_runs_under() {
        // The released build: a launcher under systemd. Its backend child inherits the
        // unit's environment, so both are set — and asking the launcher restarts the one
        // process the user asked about, where an exit would take the web server and the
        // page down with it.
        assert_eq!(restarter_from(Some("1"), Some("1")), Restarter::Launcher);
    }

    #[test]
    fn the_two_declarations_are_never_one_variable() {
        // `LAUNCHER_ENV` says a launcher can re-spawn us; `update::LAUNCHER_BIN_ENV` names
        // the binary an update may replace. A `bun run` launcher has the first and not the
        // second, so folding them would refuse a restart in every source run.
        assert_ne!(LAUNCHER_ENV, crate::update::LAUNCHER_BIN_ENV);
        assert_ne!(LAUNCHER_ENV, SUPERVISED_ENV);
    }

    /// The staged backend unit's two halves only mean something together: the claim that
    /// this process is restarted on exit, and the `Restart=` that makes the claim true.
    ///
    /// A unit that declared the first without the second would offer the user a button that
    /// stops their app for good, which is exactly the outcome [`Restarter::Nothing`] exists
    /// to prevent — so they are pinned to each other rather than to a comment.
    #[test]
    fn the_staged_backend_unit_declares_the_restart_it_really_performs() {
        let unit = include_str!("../packaging/systemd/teams-lite-backend.service");
        let declares = unit
            .lines()
            .any(|line| line.trim() == format!("Environment={SUPERVISED_ENV}=1"));
        assert!(declares, "the staged backend unit must say it restarts this process on exit");
        assert!(
            unit.lines().any(|line| line.trim() == "Restart=always"),
            "and it must really restart it, or the declaration above is a lie"
        );
    }

    /// The LAUNCHER's unit says nothing of the kind, and must not.
    ///
    /// It runs the launcher, whose backend child inherits its environment — so a claim here
    /// would tell that child a supervisor restarts IT, when what systemd restarts is the
    /// launcher around it. The child is restarted by the launcher instead, which is the one
    /// path that leaves the web server up.
    #[test]
    fn the_launcher_unit_never_claims_to_restart_the_backend() {
        let unit = include_str!("../packaging/systemd/teams-lite-app.service");
        assert!(
            !unit.contains(SUPERVISED_ENV),
            "the app unit restarts the LAUNCHER; its backend child is the launcher's to \
             re-spawn"
        );
    }

    #[test]
    fn the_refusal_says_what_to_do_instead() {
        assert!(NOTHING_WOULD_RESTART_IT.starts_with("refused: "));
        assert!(NOTHING_WOULD_RESTART_IT.contains("by hand"));
    }
}
