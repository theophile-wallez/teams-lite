//! The SELF-CONTAINED Intune container: teams-lite owning one, inside its own image or pod.
//!
//! In `host` mode (the default outside the image, and what every install before this was) the
//! Intune container belongs to the user: their own `intune-container` boots it, and teams-lite
//! only follows its broker's bus and, on a host, asks the user's systemd manager to repair it
//! (src/intune.rs). In `embedded` mode ([`MODE_ENV`] = `embedded`, which the image declares by
//! default) THIS PROCESS owns the container: it boots it, stops it, repairs it and enrolls it,
//! inside the teams-lite container or pod, with no systemd anywhere — so the identity broker is
//! a process of this pod rather than something reached through the host's `/proc`.
//!
//! WHY HELPERS, AND WHY THEY LIVE HERE. Every lifecycle act is done by THIS binary re-executed
//! with a hidden argument ([`BOOT_SUBCOMMAND`], [`STOP_SUBCOMMAND`], [`PORTAL_SUBCOMMAND`], and
//! the existing `intune::REPAIR_SUBCOMMAND`), routed by `intune::dispatch_reexec` before any
//! tokio runtime exists. Four reasons, each about what the act must survive or must not see:
//!
//! - **It survives the backend.** A repair stops the container this backend talks through, and a
//!   boot can spend ten minutes pulling 1.7 GB; a backend restart in the middle of either (the
//!   launcher re-spawning one that crashed, an update) must not leave the pod with no container.
//!   On a host that is why the repair is a transient UNIT; here there is no manager to ask, so a
//!   helper is spawned in a SESSION of its own ([`spawn_helper`]), never killed with its parent,
//!   and reparented to the pod's init (tini) when the backend goes.
//! - **Its environment is built from scratch.** The crate's supervisor inherits the helper's
//!   environment, and the container's PID 1 inherits the supervisor's for the container's whole
//!   life — so the write token, a bus address or anything else the backend happens to hold must
//!   never reach it ([`helper_env`], pinned by a test).
//! - **The crate is called with no runtime alive.** It forks to unshare a user namespace, which a
//!   multithreaded process cannot do safely, and it builds tokio runtimes of its own.
//! - **`src/intune.rs` keeps its promise that it spawns no process.** It still decides
//!   everything; this module is where the one spawn is.
//!
//! SINGLE-FLIGHT. One helper at a time on the intune volume ([`HELPER_LOCK_FILE`], an exclusive
//! `flock` the helper takes FIRST and holds for its whole life) — and the STOP takes the same
//! slot before it looks at anything, so a boot spawned while the pod is going down finds the slot
//! held and leaves, instead of starting the container a moment before the runtime SIGKILLs it.
//! [`helper_running`] asks it with a non-blocking SHARED try-lock, which never creates the file
//! and never takes the slot from a helper — but a probe still holds the lock for a moment, so a
//! helper retries its own lock for a second before concluding another one is at work (the crate's
//! own supervisor does the same for its singleton). Which helper it is comes from
//! [`HELPER_STATE_FILE`], written by the holder once the lock is its own and checked against that
//! pid's own command line; a stale file under a free lock means nothing is running.
//!
//! THE VOLUME BELONGS TO ONE CONTAINER. The slot is a `flock` on a FILE of the volume, so it
//! serializes helpers across processes and across pid namespaces alike — but it cannot make two
//! containers mounting one volume safe. The crate keeps the running container's leader pid in the
//! volume's `rootless.json`, and in a SECOND container or pod that pid is not a container init at
//! all: the first `running_leader` reached there reads the state as stale and DELETES it, and the
//! first container's own backend is signed out for good. So every helper asks the crate's own
//! supervisor lock, read-only, before it reaches anything that calls `running_leader`, and
//! refuses — touching nothing — when a supervisor holds it and the state names a leader that is
//! not this namespace's ([`refuse_a_container_running_elsewhere`]). A held lock with NO state is a
//! container of ours mid-start or mid-poweroff, which is waited for, never refused.
//!
//! WHAT IS MEASURED, AND WHAT IS NOT. Measured (a spike, Docker 29.9, runc, cgroup v2): the real
//! Intune image's systemd boots inside a plain Docker container with seccomp and systempaths
//! unconfined, a delegated cgroup, file-capability `newuidmap`/`newgidmap` and a root entrypoint
//! that drops to the runtime user — and the broker came up `active`. Measured since, through this
//! module's own code in the real image (its self-test, on a throwaway volume): the boot helper set
//! the Intune image up (75 s), booted it with no user manager, its keyring read unlocked over
//! D-Bus and its broker bus appeared, and the stop helper powered it off gracefully in 1 s. NOT
//! measured: the boot under a running backend (the startup, the health check and a press), an
//! enrollment through the served portal, an import of a real backup, and Kubernetes at all. Two
//! live copies of one enrolled device (the backup imported here while the machine it came from
//! keeps running it) are unmeasured too, which is why the import says so every time it happens.

use std::ffi::{OsString, c_int};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

/// Which Intune container this process deals with: `embedded` or `host`. DECLARED, never
/// detected — the house rule `TEAMS_LITE_CONTAINER_IMAGE` and `TEAMS_LITE_LAUNCHER` already
/// follow — because what it decides is whether this process may stop and boot a container, and
/// no file inside the process can prove that the container is ours to stop. The image sets
/// `embedded`; unset is `host`, which is what every install outside the image has always been.
pub const MODE_ENV: &str = "TEAMS_LITE_INTUNE_MODE";

/// An enrollment backup to import ONCE, at boot, into a container that holds no device
/// registration yet: an absolute path to the `.tar.gz` that `intune-container backup -o FILE`
/// made on the machine that enrolled.
pub const IMPORT_ENV: &str = "TEAMS_LITE_INTUNE_IMPORT";

/// The hidden argument that makes `server` the BOOT helper: set the container up if it is not
/// (the ~1.7 GB pull), import an enrollment if one is given and none is here, and start it if it
/// is not running. Double-underscored and named for what it does, like every other one, so the
/// automation guard can refuse it by name.
pub const BOOT_SUBCOMMAND: &str = "__teams-lite-intune-boot";

/// The hidden argument that makes `server` the STOP helper: a graceful poweroff of the
/// container, for the image's entrypoint to run when the pod is told to stop. Without it the
/// inner systemd, the broker and the keyring are SIGKILLed mid-write with everything else.
pub const STOP_SUBCOMMAND: &str = "__teams-lite-intune-stop";

/// The hidden argument that makes `server` the PORTAL helper: the Intune portal opened on the
/// container's own display, held until it closes — the window an enrollment is served from.
pub const PORTAL_SUBCOMMAND: &str = "__teams-lite-intune-portal";

/// The `flock` every helper takes FIRST and holds for its whole life, in the intune data dir —
/// which in embedded mode is this pod's own volume, so the slot is per VOLUME rather than per
/// process: two backends of one pod (a launcher re-spawning one mid-boot) still start one helper.
/// It does NOT make a volume shared by two CONTAINERS safe — see the module header, and
/// [`refuse_a_container_running_elsewhere`].
pub const HELPER_LOCK_FILE: &str = "teams-lite-helper.lock";

/// Which helper holds [`HELPER_LOCK_FILE`], written by that helper once the lock is its own.
pub const HELPER_STATE_FILE: &str = "teams-lite-helper.json";

/// The crate's own singleton lock for its container SUPERVISOR (`lock::SingletonLock::try_acquire
/// ("supervisor")` in the crate's `backend::supervise_main`), held for the supervisor's whole life
/// — that is, for as long as a container runs from this volume, in whichever namespace it runs.
/// Read here, never taken (see [`supervisor_lock`]).
const SUPERVISOR_LOCK_FILE: &str = "supervisor.lock";

/// How long a held supervisor lock with no live leader in this namespace is watched before it is
/// read as a container running from ANOTHER namespace. The supervisor takes its lock before it
/// boots and publishes the leader a moment later, and clears the state a moment before it lets
/// the lock go: both windows are seconds, and a container of our own caught in one of them must
/// not be refused as somebody else's.
const SUPERVISOR_SETTLE: Duration = Duration::from_secs(10);

/// The marker the boot writes, fsynced, BEFORE an import and removes only once the import has
/// returned — so an import that failed or was killed half-way is retried, rather than read as a
/// registration and never touched again ([`import_step`] says why that matters).
pub const IMPORT_PENDING_FILE: &str = "teams-lite-import.pending";

/// How long the portal helper holds a window open before it closes it. An enrollment is a
/// sign-in plus a few screens of the portal; thirty minutes is generous for that and short
/// enough that a window nobody is looking at does not keep the slot every other helper needs.
pub const PORTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The portal helper's exit code when IT closed the portal at [`PORTAL_TIMEOUT`] — told apart
/// from 0 (the reader closed it, or the session asked it to) by the helper itself, because the
/// session's own clock starts before the portal appears and cannot tell the two apart near the
/// deadline.
pub const PORTAL_TIMED_OUT: i32 = 3;

/// The boot helper's exit code when ANOTHER holder had the slot, so this boot did nothing. Told
/// apart from 0 (the container is up) because a follower that read it as success would announce
/// a running container while the slot's real holder — another boot, a repair, an enrollment, a
/// stop — is still at work, and would spend the machine-wide floor on a boot that never ran.
pub const BOOT_SLOT_TAKEN: i32 = 3;

/// How long the portal helper, asked to stop before the portal's process exists, waits for it to
/// appear so it can close it. The portal is launched in the background and its process exists
/// within a second or two; a stop that found nothing and left would let it appear a moment later
/// with no session behind it, holding the slot for half an hour.
const PORTAL_STOP_SETTLE: Duration = Duration::from_secs(15);

/// How long the portal is waited for to APPEAR. `portal_open_headless` launches it in the
/// background and returns at once, and its window "can take up to ~30 s the first time" (the
/// crate's own words) — so a loop that asked "is it still running?" straight away would read a
/// portal that has not appeared yet as one the reader closed, and end the enrollment before it
/// began.
const PORTAL_APPEAR_WAIT: Duration = Duration::from_secs(90);

/// How long the stop helper waits for the helper slot AND then the crate's lifecycle lock, in
/// all, before giving up. A boot in the middle of the 1.7 GB pull holds both for minutes, and
/// the pod is being stopped: waiting for it would only make the runtime SIGKILL everything at
/// the end of its grace period. Twenty five seconds plus `backend::stop`'s own twenty is the
/// ~45 s the entrypoint budgets.
pub const STOP_LOCK_WAIT: Duration = Duration::from_secs(25);

/// The bound on a boot's SETUP step (`ops::init`, the ~1.7 GB pull and the provisioning).
///
/// The crate's registry client sets no read or connect timeout, and reqwest's TCP keepalive ends
/// a DEAD path in about a minute — but not a live peer that never sends: a transparent middlebox,
/// or a server that ACKs and never answers. Unbounded, such a pull would hold the helper slot and
/// the lifecycle lock for the life of the pod, with "Starting…" on every page and no repair,
/// enrollment or later boot able to run. Two hours is generous for 1.7 GB on any link that works.
///
/// Killing a setup is SAFE, which is what lets it be bounded at all: the pull downloads every
/// layer into memory before it extracts anything, `initialized` is written only once the
/// provisioning has finished, and a later extraction overwrites what an interrupted one left —
/// so a setup ended here is retried cleanly by the next boot.
pub const BOOT_SETUP_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

/// How long a container whose LEADER is up is given to show its broker's BUS — the second half of
/// "up" (`intune::container_is_up`): before the boot concludes the bus will never come and
/// restarts the container, and again after a start before the boot says it failed. A start holds
/// the lifecycle lock through its own session setup, so under that lock a missing bus is almost
/// never one still on its way; the grace covers the moment it takes to appear after the setup.
pub const BUS_GRACE: Duration = Duration::from_secs(90);

/// How long a boot waits, beyond the crate's own stop, for a container of OURS to have finished
/// powering off before it starts one — the container it stopped itself because its bus never
/// appeared, or one an earlier boot left going down.
///
/// The crate's `backend::stop` waits at most twenty seconds for the leader and then clears the
/// runtime state WHETHER OR NOT it went, so a poweroff that takes longer — a unit at systemd's
/// own ninety-second stop timeout, a `user@0` that hangs, which can be why the bus never appeared
/// in the first place — leaves our supervisor holding its lock, our Xvfb on `:99`, and no leader
/// named anywhere. A start over that is no start (the crate's second supervisor finds the lock
/// held and boots nothing), and the display check reads our own Xvfb as ANOTHER Intune
/// container's and refuses with a sentence about `--network host`. Two minutes covers systemd's
/// ninety-second default with room to spare; past it the boot says the container is still
/// powering off, which is the truth, and the next boot tries again.
pub const POWEROFF_WAIT: Duration = Duration::from_secs(120);

/// The bound on a boot AFTER its setup step. Everything after the setup — an import, a stop, the
/// wait for a container of ours to finish powering off ([`POWEROFF_WAIT`]), a start, the session
/// setup that unlocks the keyring — is the repair's own work and the repair's own wait, so it gets
/// the repair's own bound (`intune::REPAIR_TIMEOUT`, which already holds that one poweroff wait),
/// plus the two waits for the bus a boot can make ([`BUS_GRACE`]). Without one, a hung boot would
/// hold the helper slot for good, and no repair, enrollment or later boot could run.
pub const BOOT_START_TIMEOUT: Duration =
    Duration::from_secs(crate::intune::REPAIR_TIMEOUT.as_secs() + 2 * BUS_GRACE.as_secs());

/// How long a backend follows a boot (its own, or one found running), polling the slot: the
/// longest a boot helper can live — its setup's bound plus its start's — with a minute to spare.
/// A follower only frees a task when it gives up: the banner reads the slot live either way.
pub const BOOT_FOLLOW_BOUND: Duration =
    Duration::from_secs(BOOT_SETUP_TIMEOUT.as_secs() + BOOT_START_TIMEOUT.as_secs() + 60);

/// How long a display found served by somebody else is watched before a boot refuses to start
/// beside it: an Xvfb of a container of ours that has just been stopped is gone within a moment
/// of its leader, and a refusal on its account would be a false one.
const DISPLAY_SETTLE: Duration = Duration::from_secs(10);

/// The `PATH` a helper gets when the backend had none. The crate runs `newuidmap`, `newgidmap`
/// and `tar` by name, so an empty one would fail every boot on a lookup.
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The only variables a helper inherits from the backend, each only when it is set. Everything
/// else is dropped on purpose: see [`helper_env`].
const PASSED_THROUGH: &[&str] = &["HOME", "USER", "LOGNAME", "XDG_DATA_HOME", "LANG", "TZ", "RUST_LOG"];

// ---- the mode -------------------------------------------------------------------------------

/// Whose Intune container this process deals with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The user's own, managed by their `intune-container` (or a classic Intune install).
    Host,
    /// This pod's own, booted, stopped, repaired and enrolled by this binary.
    Embedded,
}

/// The declared mode, read once — the mode is a property of the process, and re-reading the
/// environment per call would let it drift. An unknown value is an ERROR with a sentence, never
/// a guess: read as `host` an image would follow a broker that is not there, and read as
/// `embedded` a host install would boot and stop the user's own container.
pub fn mode() -> Result<Mode> {
    static MODE: std::sync::OnceLock<std::result::Result<Mode, String>> = std::sync::OnceLock::new();
    MODE.get_or_init(|| parse_mode(std::env::var(MODE_ENV).ok().as_deref()))
        .clone()
        .map_err(|e| anyhow!(e))
}

/// Is this process in embedded mode? `false` for an unknown value too: a backend never gets that
/// far (`server` refuses to start), and a helper refuses on its own before it asks this.
pub fn embedded() -> bool {
    matches!(mode(), Ok(Mode::Embedded))
}

/// The parse itself, with its input handed in so it is tested without an environment. Empty is
/// unset: a compose `environment:` line left blank must not refuse to start the app.
fn parse_mode(value: Option<&str>) -> std::result::Result<Mode, String> {
    match value.map(str::trim) {
        None | Some("") | Some("host") => Ok(Mode::Host),
        Some("embedded") => Ok(Mode::Embedded),
        Some(other) => Err(format!(
            "{MODE_ENV}={other:?} is not a mode teams-lite knows: set it to `embedded` (this \
             container runs its own Intune container) or `host` (it follows the Intune container \
             of the machine it runs on), or leave it unset for `host`"
        )),
    }
}

// ---- the helpers ----------------------------------------------------------------------------

/// A lifecycle helper: this binary re-executed with one hidden argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Helper {
    Boot,
    Repair,
    Portal,
}

impl Helper {
    /// The hidden argument that runs it.
    pub fn subcommand(self) -> &'static str {
        match self {
            Self::Boot => BOOT_SUBCOMMAND,
            Self::Repair => crate::intune::REPAIR_SUBCOMMAND,
            Self::Portal => PORTAL_SUBCOMMAND,
        }
    }

    /// The word the page and the journal name it by (`"boot"`, `"repair"`, `"portal"`).
    pub fn tag(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Repair => "repair",
            Self::Portal => "portal",
        }
    }
}

/// Whoever holds the helper slot: one of the three [`Helper`]s, or the STOP.
///
/// The stop takes the slot so that no boot can start the container underneath it while the pod
/// goes down (see [`stop_main`]) — but it is not a HELPER: the backend never spawns one, and a
/// page has no state to draw for it (the pod is going away). So [`helper_running`] names the
/// three helpers only, and [`slot_holder`] / [`slot_held`] are what say the slot is taken at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotHolder {
    Boot,
    Repair,
    Portal,
    Stop,
}

impl SlotHolder {
    /// The helper this holder is, or `None` for the stop.
    pub fn helper(self) -> Option<Helper> {
        match self {
            Self::Boot => Some(Helper::Boot),
            Self::Repair => Some(Helper::Repair),
            Self::Portal => Some(Helper::Portal),
            Self::Stop => None,
        }
    }

    /// The hidden argument the holder runs as, which is what its own command line is checked
    /// against.
    fn subcommand(self) -> &'static str {
        self.helper().map_or(STOP_SUBCOMMAND, Helper::subcommand)
    }

    /// The word a journal line and an answer name it by (`"boot"`, …, `"stop"`).
    pub fn tag(self) -> &'static str {
        self.helper().map_or("stop", Helper::tag)
    }

    fn from_subcommand(arg: &str) -> Option<Self> {
        [Self::Boot, Self::Repair, Self::Portal, Self::Stop].into_iter().find(|h| h.subcommand() == arg)
    }
}

impl From<Helper> for SlotHolder {
    fn from(helper: Helper) -> Self {
        match helper {
            Helper::Boot => Self::Boot,
            Helper::Repair => Self::Repair,
            Helper::Portal => Self::Portal,
        }
    }
}

/// What asking for a helper did.
pub enum HelperStart {
    /// It was spawned; [`HelperChild::finished`] says how it ended.
    Started(HelperChild),
    /// A helper already holds the slot on this volume ([`helper_running`] says which).
    AlreadyRunning,
}

/// A helper this process spawned. It is REAPED by a task of its own whether or not anybody
/// awaits this handle, so dropping it never leaves a zombie behind.
pub struct HelperChild {
    helper: Helper,
    pid: Option<u32>,
    done: tokio::sync::oneshot::Receiver<std::io::Result<std::process::ExitStatus>>,
}

impl HelperChild {
    pub fn helper(&self) -> Helper {
        self.helper
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// What can ask this helper to end early, kept apart from the handle so it outlives the
    /// [`HelperChild::finished`] future that consumes the handle — an enrollment session awaits
    /// that future inside a `select!` and must still be able to stop the portal from another arm.
    pub fn terminator(&self) -> HelperTerminator {
        HelperTerminator { helper: self.helper, pid: self.pid }
    }

    /// Ask this helper to end early ([`HelperTerminator::terminate`]).
    pub fn terminate(&self) -> Result<bool> {
        self.terminator().terminate()
    }

    /// Wait for the helper to exit and answer its exit code. A helper killed by a signal is an
    /// error naming it, never a code: no code means it said nothing about how far it got.
    pub async fn finished(self) -> Result<i32> {
        use std::os::unix::process::ExitStatusExt;
        let status = self
            .done
            .await
            .context("the task reaping the helper went away")?
            .context("wait for the helper")?;
        match (status.code(), status.signal()) {
            (Some(code), _) => Ok(code),
            (None, Some(signal)) => bail!("the {} helper was killed by signal {signal}", self.helper.tag()),
            (None, None) => bail!("the {} helper ended with no exit status", self.helper.tag()),
        }
    }
}

/// What asks a spawned helper to end early: its pid, and which helper that pid must still be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelperTerminator {
    helper: Helper,
    pid: Option<u32>,
}

impl HelperTerminator {
    /// Send the helper SIGTERM, and say whether it was sent.
    ///
    /// ONLY THE PORTAL HELPER may be asked, and that is refused as an error for any other: the
    /// portal helper is the one that answers a SIGTERM (it closes the portal the way a person
    /// would — `ops::portal_stop`, a TERM the portal writes its account state on — frees the slot
    /// and exits 0, see [`portal_main`]). A boot or a repair has no handler, so the signal's
    /// default action would kill it mid-work — a repair between its stop and its start leaves no
    /// container at all.
    ///
    /// The pid is RE-CHECKED first ([`pid_runs`]): the helper is reaped by a task of its own the
    /// moment it exits, and its pid may by then belong to anybody. `Ok(false)` when it no longer
    /// runs the portal helper — it has already ended, which is what was asked for.
    pub fn terminate(&self) -> Result<bool> {
        anyhow::ensure!(
            self.helper == Helper::Portal,
            "only the portal helper can be asked to end early — the {} helper would die mid-work",
            self.helper.tag()
        );
        let Some(pid) = self.pid else { return Ok(false) };
        if !pid_runs(pid, SlotHolder::Portal) {
            return Ok(false);
        }
        let pid = c_int::try_from(pid).context("a pid out of range")?;
        if send_signal(pid, SIGTERM) != 0 {
            let error = std::io::Error::last_os_error();
            // Gone between the check and the signal: what was asked for.
            if error.raw_os_error() == Some(ESRCH) {
                return Ok(false);
            }
            return Err(anyhow::Error::new(error).context(format!("signal the portal helper (pid {pid})")));
        }
        Ok(true)
    }
}

/// The pid of the PORTAL helper holding the slot right now, checked against its own command line
/// — or `None` when the slot holds no portal helper. Read once and kept by whoever asks, so the
/// stop it may then ask for ([`ask_portal_helper_to_close`]) can never reach a LATER portal helper
/// that took the slot meanwhile under another pid.
pub fn portal_helper_pid() -> Option<u32> {
    let dir = intune_data_dir().ok()?;
    let state = read_state(&dir)?;
    (state.helper == SlotHolder::Portal && pid_runs(state.pid, SlotHolder::Portal)).then_some(state.pid)
}

/// Ask the portal helper running as `pid` to close the portal and exit — for a helper no session
/// of this process owns: one an earlier backend spawned, orphaned when it restarted (its session
/// died with it, so nothing here can serve that portal or cancel it from the app). The same
/// request the stop helper makes ([`stop_main`]), through the same pid re-check
/// ([`HelperTerminator::terminate`]): `Ok(false)` when `pid` no longer runs the portal helper.
pub fn ask_portal_helper_to_close(pid: u32) -> Result<bool> {
    HelperTerminator { helper: Helper::Portal, pid: Some(pid) }.terminate()
}

/// The environment a helper gets, built from scratch out of `get`.
///
/// ONLY the identity of the runtime user, the locale, the zone, the log filter and the three
/// variables that make it an embedded helper. NEVER the write token (`TEAMS_LITE_WRITE_TOKEN`),
/// never a bus address (`DBUS_SESSION_BUS_ADDRESS`, `TEAMS_LITE_BROKER_BUS`), never a display:
/// the crate's supervisor inherits this, and the container's PID 1 inherits the supervisor's for
/// the container's whole life — a token there is a token in every process of the Intune image,
/// and an inherited bus is the crate reaching for a manager that is not this pod's.
/// `INTUNE_CONTAINER_CGROUP=own` is the crate's own setting for an embedding application that
/// knows it runs inside a container (`intune_container::runtime::CGROUP_ENV`): the container's
/// cgroup is a child of this pod's, never a scope asked of a session manager it may have
/// inherited.
pub fn helper_env(get: impl Fn(&str) -> Option<OsString>) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    for name in PASSED_THROUGH {
        if let Some(value) = get(name).filter(|v| !v.is_empty()) {
            env.push((OsString::from(*name), value));
        }
    }
    let path = get("PATH").filter(|v| !v.is_empty()).unwrap_or_else(|| OsString::from(DEFAULT_PATH));
    env.push(("PATH".into(), path));
    env.push((MODE_ENV.into(), "embedded".into()));
    if let Some(import) = get(IMPORT_ENV).filter(|v| !v.is_empty()) {
        env.push((IMPORT_ENV.into(), import));
    }
    env.push((intune_container::runtime::CGROUP_ENV.into(), "own".into()));
    env
}

/// Spawn `helper` — this binary with its hidden argument — unless one already holds the slot.
///
/// - **program = `intune::own_executable()`, argv = `[subcommand]`**: this binary and nothing
///   else, so no client and no setting can make this start another program (a test scans this
///   module for every spawn).
/// - **`env_clear()`, then [`helper_env`]**.
/// - **a SESSION of its own** (`setsid` before exec — the crate's own `detach` shape),
///   **`kill_on_drop(false)`**: it outlives this backend, which a repair or a boot must.
/// - **stdin null, stdout and stderr INHERITED**: in the image they are the container's own log
///   (`docker logs`, `kubectl logs`), which is where a reader looks — there is no journal here.
/// - **reaped by a task** of this runtime, so it never lingers as a zombie of a backend that
///   lives for weeks; a backend that did not spawn it polls [`helper_running`] instead.
///
/// Refused read-only and outside embedded mode, here as well as in every helper body.
pub fn spawn_helper(helper: Helper) -> Result<HelperStart> {
    anyhow::ensure!(
        !crate::read_only(),
        "refused: TEAMS_LITE_READ_ONLY=1 — a read-only backend never starts a container helper"
    );
    anyhow::ensure!(
        mode()? == Mode::Embedded,
        "refused: {MODE_ENV} is not `embedded`, so this process does not own an Intune container"
    );
    if slot_held() {
        return Ok(HelperStart::AlreadyRunning);
    }
    let runtime = tokio::runtime::Handle::try_current()
        .context("a helper is spawned from the backend's runtime, which reaps it")?;

    let exe = crate::intune::own_executable()?;
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(helper.subcommand())
        .env_clear()
        .envs(helper_env(|name| std::env::var_os(name)))
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(false);
    // SAFETY: `setsid` is async-signal-safe and takes no arguments; a failure (already a
    // session leader) is tolerated exactly as the crate's own `detach` tolerates it.
    unsafe {
        cmd.pre_exec(|| {
            let _ = new_session();
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {} {}", exe.display(), helper.subcommand()))?;
    let pid = child.id();
    let (tx, done) = tokio::sync::oneshot::channel();
    runtime.spawn(async move {
        let _ = tx.send(child.wait().await);
    });
    Ok(HelperStart::Started(HelperChild { helper, pid, done }))
}

// The three libc calls this module needs: `setsid(2)` for a helper's own session, `kill(2)` to ask
// the portal helper to stop, and `signal(2)` for the portal helper to listen for that. Declared
// rather than taken from a crate: std links libc already, and std's own `CommandExt::setsid` is
// still unstable. `setsid` and `kill` have no memory preconditions, so they are declared safe;
// `signal` installs a function the kernel will jump to, so it stays unsafe at every call.
unsafe extern "C" {
    #[link_name = "setsid"]
    safe fn new_session() -> c_int;
    #[link_name = "kill"]
    safe fn send_signal(pid: c_int, signal: c_int) -> c_int;
    #[link_name = "signal"]
    fn install_signal_handler(signal: c_int, handler: usize) -> usize;
}

/// `SIGTERM`, `ESRCH` and `SIG_ERR` on Linux — the same numbers on every architecture it runs on,
/// and the crate this module drives is Linux-only.
const SIGTERM: c_int = 15;
const ESRCH: i32 = 3;
const SIG_ERR: usize = usize::MAX;

/// Which HELPER is at work on this volume right now, or `None` — also while the STOP holds the
/// slot, which is not a helper anybody spawns or a page draws ([`SlotHolder`]). Whether the slot
/// is taken at all is [`slot_held`].
pub fn helper_running() -> Option<Helper> {
    slot_holder().and_then(SlotHolder::helper)
}

/// Is the slot taken — by any helper, or by the stop? What every "may I act on the container
/// now?" asks: a boot, a repair or an enrollment beside a stop would race the poweroff.
pub fn slot_held() -> bool {
    slot_holder().is_some()
}

/// Who holds the slot on this volume right now, or `None`.
///
/// A non-blocking SHARED try-lock of [`HELPER_LOCK_FILE`]: held means a holder is at work. The
/// file is opened read-only and never created, so asking — which happens in every greeting a
/// page gets — writes nothing, and a volume no helper has ever touched answers `None`.
pub fn slot_holder() -> Option<SlotHolder> {
    let dir = intune_data_dir().ok()?;
    let file = File::open(dir.join(HELPER_LOCK_FILE)).ok()?;
    match file.try_lock_shared() {
        // Free: nothing is running. Dropping the file releases the probe's own shared lock.
        Ok(()) => None,
        Err(TryLockError::WouldBlock) => Some(which_holder(&dir)),
        // A filesystem that cannot lock cannot run a helper either — every helper fails on its
        // own lock and says so — so this is "nothing is running", not a guess at one.
        Err(TryLockError::Error(_)) => None,
    }
}

/// Which holder has the lock, read from [`HELPER_STATE_FILE`] and checked against the command
/// line of the pid it names. The holder writes the file the moment the lock is its own, so for a
/// few microseconds the file can still be the PREVIOUS holder's; a short bounded re-read covers
/// that, and the file's own word is the answer after it (a holder that could not write its state
/// exits rather than run unnamed, so that last answer is rarely reached).
fn which_holder(dir: &Path) -> SlotHolder {
    let mut last = None;
    for _ in 0..10 {
        if let Some(state) = read_state(dir) {
            if pid_runs(state.pid, state.helper) {
                return state.helper;
            }
            last = Some(state.helper);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    last.unwrap_or(SlotHolder::Boot)
}

/// What a holder writes once it holds the slot. The field keeps the name `helper` the file has
/// always had, so a state written by an older build still reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct HelperState {
    helper: SlotHolder,
    pid: u32,
    started_ms: u64,
}

fn read_state(dir: &Path) -> Option<HelperState> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(HELPER_STATE_FILE)).ok()?).ok()
}

/// Is `pid` alive and running `holder`'s subcommand? Its own `/proc/<pid>/cmdline` says, which
/// is what tells a live helper from a stale file naming a pid somebody else now holds.
fn pid_runs(pid: u32, holder: SlotHolder) -> bool {
    let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    cmdline
        .split(|b| *b == 0)
        .nth(1)
        .and_then(|arg| std::str::from_utf8(arg).ok())
        .and_then(SlotHolder::from_subcommand)
        == Some(holder)
}

/// The crate's own data directory (`$XDG_DATA_HOME|$HOME/.local/share/intune-container`), taken
/// from `Config::config_path` rather than spelled again here: a second spelling is how two
/// pieces of code end up locking two different files.
pub fn intune_data_dir() -> Result<PathBuf> {
    let config = intune_container::config::Config::config_path()
        .context("find intune-container's data directory")?;
    config
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("intune-container's configuration path has no parent: {}", config.display()))
}

/// Wait until nothing holds the slot — for a holder this process did NOT spawn, which it can only
/// watch. Polls the lock, which costs a file open every few seconds.
pub async fn wait_for_helper_to_end(bound: Duration) -> Result<()> {
    tokio::time::timeout(bound, async {
        while slot_held() {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    })
    .await
    .map_err(|_| anyhow!("the container helper did not end within {} s", bound.as_secs()))
}

/// The slot, held for the life of the holder that took it.
pub(crate) struct HelperSlot {
    _file: File,
}

/// How long a helper retries the slot before concluding another one is at work: long enough to
/// outlast a probe's own momentary shared lock, short enough that a helper refused for real says
/// so at once.
const SLOT_RETRY: Duration = Duration::from_secs(1);

/// Take the slot for `helper`: the exclusive lock, then the state file naming it. `Ok(None)` when
/// another holder has it.
///
/// It RETRIES for a second before saying so, because [`slot_holder`] holds a shared lock for a
/// moment on every greeting: a helper that gave up on the first refusal would exit "already
/// running" on a probe's account, and nothing would boot.
pub(crate) fn take_helper_slot(helper: Helper) -> Result<Option<HelperSlot>> {
    take_slot(helper.into(), SLOT_RETRY, &|_| {})
}

/// Take the slot for `holder`, retrying for at most `wait`; `on_held` is shown who holds it (and
/// its pid, checked against its own command line) on every refused pass — the stop uses it to
/// ask a portal to close.
///
/// Every attempt is a NON-blocking `try_lock` on a description of this call's own. A blocking
/// `flock` would be the one shape that deadlocks here: a lock taken twice in one process through
/// two open files waits on itself, and a bound is what the stop needs anyway.
fn take_slot(
    holder: SlotHolder,
    wait: Duration,
    on_held: &dyn Fn(Option<(SlotHolder, u32)>),
) -> Result<Option<HelperSlot>> {
    let dir = intune_data_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join(HELPER_LOCK_FILE);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    let give_up = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= give_up {
                    return Ok(None);
                }
                on_held(read_state(&dir).filter(|s| pid_runs(s.pid, s.helper)).map(|s| (s.helper, s.pid)));
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(TryLockError::Error(e)) => {
                return Err(anyhow::Error::new(e).context(format!("lock {}", path.display())));
            }
        }
    }
    let state = HelperState {
        helper: holder,
        pid: std::process::id(),
        started_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    };
    // Written beside and RENAMED into place, so a reader never sees half of it.
    let tmp = dir.join(format!("{HELPER_STATE_FILE}.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec(&state)?).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(HELPER_STATE_FILE))
        .with_context(|| format!("publish {}", dir.join(HELPER_STATE_FILE).display()))?;
    Ok(Some(HelperSlot { _file: file }))
}

// ---- what a page is told --------------------------------------------------------------------

/// The embedded container as `broker_status` states it. CHEAP READS ONLY: it is built in every
/// greeting a page gets, so nothing here asks the container anything — no `backend::is_running`
/// (which deletes stale state through `running_leader`), no D-Bus, no exec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmbeddedStatus {
    /// The helper at work right now, or `None` — also while the stop holds the slot, which a page
    /// has no words for (the pod is going away); `can_enroll` still says the slot is taken.
    pub helper: Option<Helper>,
    /// Whether the container has been set up (the rootfs pulled and provisioned).
    pub initialized: bool,
    /// Whether it holds a device registration (enrolled, or imported).
    pub registered: bool,
    /// Whether it is up: a live leader AND its broker's bus (`intune::container_is_up`).
    pub running: bool,
    /// Whether an enrollment may be offered right now ([`can_enroll`]).
    pub can_enroll: bool,
}

/// Read the embedded container's state. `boot_followed` is the backend's own knowledge that it
/// spawned a boot whose helper may not hold the slot yet — the moment between the spawn and the
/// lock, in which the page must already read "Starting…" rather than nothing.
pub fn status(boot_followed: bool) -> EmbeddedStatus {
    // One read of the slot, for both halves: the helper the page NAMES (never the stop, which it
    // has no words for) and whether the slot is free for an enrollment (a stop takes it too).
    let holder = slot_holder();
    let helper = holder.and_then(SlotHolder::helper).or(boot_followed.then_some(Helper::Boot));
    let slot_free = holder.is_none() && !boot_followed;
    let initialized = intune_container::ops::is_initialized();
    let registered = intune_container::backup::has_device_registration();
    let running = crate::intune::container_is_up();
    EmbeddedStatus {
        helper,
        initialized,
        registered,
        running,
        can_enroll: can_enroll(!crate::read_only(), running, slot_free, registered),
    }
}

/// Whether an enrollment may be offered: a send-capable backend (an enrollment acts as the user
/// on their tenant), a container that is up (the portal runs in it), a FREE slot (the portal
/// takes it, a boot or a repair has the container in hand, and the stop is powering it off), and
/// no device registration yet (enrolling an enrolled device would replace a registration that
/// works).
pub fn can_enroll(send_capable: bool, running: bool, no_helper: bool, registered: bool) -> bool {
    send_capable && running && no_helper && !registered
}

// ---- the helper bodies ----------------------------------------------------------------------
//
// Each is sync and single-threaded, with no tokio runtime alive while the crate is called (the
// shape `intune::repair_main` has), and answers an exit code.

/// The boot helper. Exit 0 when the container is UP at the end — its leader AND its broker's bus,
/// the one definition of "up" the rest of the app reads (`intune::container_is_up`) — 1 on a
/// failure (the reason on stderr), 2 when it refuses to act at all, and [`BOOT_SLOT_TAKEN`] when
/// another holder had the slot, so this boot did nothing.
///
/// The steps, in the order the crate needs them:
///
/// 1. **Set up** when not set up: `ops::init`, which pulls the ~1.7 GB rootfs and provisions it,
///    under a bound of its own ([`BOOT_SETUP_TIMEOUT`]). It takes the crate's lifecycle lock
///    ITSELF, so it is called with that lock NOT held: a `flock` taken twice in one process
///    through two open files deadlocks on itself.
/// 2. **Import** an enrollment ([`IMPORT_ENV`]) when one is given and the container holds NO
///    registration — never over one, which would replace an enrollment that works — or when an
///    earlier import did not finish ([`import_step`]). `ops::restore` stops a running container
///    first and takes no lock, so it runs under ours.
/// 3. **Start** when it is not up, through `intune::boot_headless` — the repair's own boot, with
///    the image update off and that never saved, so a boot never re-pulls under a timeout. A
///    container whose leader is up while its broker's bus never appears is RESTARTED (a stop,
///    then that start): read as running — the crate's `backend::is_running` looks at the leader
///    alone — it would be left signed out for good, every later boot a no-op on it.
pub fn boot_main() -> i32 {
    crate::intune::init_tracing();
    let say = |line: &str| eprintln!("teams-lite(intune-boot): {line}");
    if let Some(code) = refuse_unless_embedded(&say, true) {
        return code;
    }
    own_cgroup_by_default();
    let _slot = match take_helper_slot(Helper::Boot) {
        Ok(Some(slot)) => slot,
        Ok(None) => {
            say("another container helper is already at work on this volume — leaving it to it");
            return BOOT_SLOT_TAKEN;
        }
        Err(e) => {
            say(&format!("could not take the helper slot: {e:#}"));
            return 1;
        }
    };
    if let Some(code) = refuse_a_container_running_elsewhere(&say) {
        return code;
    }
    match boot(&say) {
        Ok(()) => 0,
        Err(BootEnd::Refused(why)) => {
            say(&format!("refused: {why}"));
            2
        }
        Err(BootEnd::Failed(e)) => {
            say(&format!("the container is not up: {e:#}"));
            1
        }
    }
}

/// How a boot ended when the container is not up at the end.
enum BootEnd {
    /// It refused to act, and touched nothing that is not its own: exit 2.
    Refused(String),
    /// It tried, and the container is not up: exit 1.
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for BootEnd {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

fn boot(say: &dyn Fn(&str)) -> std::result::Result<(), BootEnd> {
    use intune_container::{backend, config::Config, lock::LifecycleLock, ops};

    // Bounded from here to the end. The setup gets the longer bound, the rest the start's: one
    // watchdog whose deadline MOVES, because a setup that took ninety minutes must not leave the
    // start thirty, and a fixed second watchdog could not be told the first one is over.
    let watchdog = arm_watchdog("intune-boot", "the setup (the ~1.7 GB download)", BOOT_SETUP_TIMEOUT);
    if !ops::is_initialized() {
        say("setting up the Intune container — the first start downloads about 1.7 GB");
        ops::init(false, None, "").context("set up the Intune container")?;
        say("set up");
    }
    watchdog.rearm("the start", BOOT_START_TIMEOUT);
    let _lock = LifecycleLock::acquire().context("take intune-container's lifecycle lock")?;

    import_if_due(say)?;

    let mut config = Config::load().context("load intune-container's configuration")?;
    // The leader this boot asked to power off, recorded BEFORE the stop: the crate clears the
    // runtime state after its own wait whether or not the leader went, so afterwards nothing on
    // the volume names it any more.
    let mut stopped = None;
    let up = backend::is_running(&config)
        && match await_broker_bus(BUS_GRACE) {
            BusWait::Up => {
                say("the container is already running");
                true
            }
            BusWait::LeaderGone => {
                say("the container stopped while its broker's bus was awaited — starting it again");
                false
            }
            BusWait::Missing => {
                say(&format!(
                    "the container's leader is up, but its broker's bus did not appear within {} s \
                     — RESTARTING the container (a stop, then a start): left as it is, it stays \
                     signed out for good",
                    BUS_GRACE.as_secs()
                ));
                stopped = live_leader_state();
                backend::stop(&config).context("stop the container whose bus never appeared")?;
                false
            }
        };
    if !up {
        // Before the display is read and before anything is started: a container of OURS still
        // going down holds our supervisor lock and our Xvfb, and either one read as somebody
        // else's is a false refusal (see [`POWEROFF_WAIT`]).
        if !await_our_container_to_settle(stopped.as_ref(), POWEROFF_WAIT) {
            let what = if stopped.is_some() {
                format!(
                    "was asked to power off (its broker's bus never appeared) and was still \
                     powering off {} s later",
                    POWEROFF_WAIT.as_secs()
                )
            } else {
                format!(
                    "was still going down after a wait of {} s — its supervisor holds the volume \
                     with no leader named",
                    POWEROFF_WAIT.as_secs()
                )
            };
            return Err(BootEnd::Failed(anyhow!(
                "this container's own Intune container {what}. Not starting another over it, which \
                 would boot nothing; the next boot tries again once it has gone"
            )));
        }
        // A held lock with no state was not refused at the start of this boot, because it is the
        // ordinary shape of a container of ours in transit — and if what the wait above saw publish
        // a leader is ANOTHER namespace's, the start below would delete its state as stale.
        if let Some(why) = container_elsewhere() {
            return Err(BootEnd::Refused(why));
        }
        if let Some(why) = display_taken_by_another_container() {
            return Err(BootEnd::Refused(why));
        }
        say("starting the container");
        crate::intune::boot_headless(&mut config)?;
        match await_broker_bus(BUS_GRACE) {
            BusWait::Up => {}
            BusWait::LeaderGone => {
                return Err(BootEnd::Failed(anyhow!("the container stopped right after its start")));
            }
            BusWait::Missing => {
                return Err(BootEnd::Failed(anyhow!(
                    "the container started, but its broker's bus did not appear within {} s — the \
                     next boot restarts it",
                    BUS_GRACE.as_secs()
                )));
            }
        }
    }
    say("the container is running, and its broker's bus is up");
    Ok(())
}

/// What waiting for the broker's bus found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BusWait {
    /// The leader is up and its bus is there.
    Up,
    /// The leader is up and its bus did not appear in time.
    Missing,
    /// There is no live leader any more: nothing to wait for.
    LeaderGone,
}

/// Wait at most `grace` for the container to be UP in the app's own sense — its leader AND its
/// broker's bus (`intune::container_is_up`), pure reads that clean nothing.
fn await_broker_bus(grace: Duration) -> BusWait {
    let until = Instant::now() + grace;
    loop {
        if crate::intune::container_is_up() {
            return BusWait::Up;
        }
        if crate::intune::container_leader().is_none() {
            return BusWait::LeaderGone;
        }
        if Instant::now() >= until {
            return BusWait::Missing;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

// ---- the import, bracketed by a marker ------------------------------------------------------

/// What a boot does about [`IMPORT_ENV`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportStep {
    /// No backup is given and none was being imported.
    Nothing,
    /// Import the backup: given, a file, and nothing registered here yet.
    Import,
    /// Import it AGAIN, over a registration that is the earlier import's own partial write.
    Retry,
    /// Keep the registration this container holds, which a backup must never replace.
    KeepRegistration,
    /// The path names something that is not a file (a missing bind becomes a directory).
    NotAFile,
    /// An import did not finish, and no backup is given now to finish it with.
    PendingWithoutBackup,
}

/// The decision, with its three inputs handed in so it is tested without a container: whether a
/// backup is given and is a file (`None` = not given), whether the container holds a device
/// registration, and whether an earlier import left its marker ([`IMPORT_PENDING_FILE`]).
///
/// THE MARKER OUTRANKS THE REGISTRATION, and that is the whole point of it. The crate's restore
/// copies the archive's members in order — the device broker, Intune, then the Workplace Join keys
/// that `has_device_registration` tests, then the keyring and the broker's configuration — each
/// replaced in place, with no staging. An import that failed or was killed after the third member
/// leaves a container that READS as registered and holds no keyring: every later boot would keep
/// that registration as one that works, the app would offer no enrollment over it, and the device
/// would stay half-imported until somebody wiped the volume by hand.
fn import_step(backup_is_file: Option<bool>, registered: bool, pending: bool) -> ImportStep {
    match (backup_is_file, pending) {
        (None, false) => ImportStep::Nothing,
        (None, true) => ImportStep::PendingWithoutBackup,
        (Some(false), _) => ImportStep::NotAFile,
        (Some(true), true) => ImportStep::Retry,
        (Some(true), false) if registered => ImportStep::KeepRegistration,
        (Some(true), false) => ImportStep::Import,
    }
}

/// Import the enrollment backup when one is due ([`import_step`]), under the caller's lifecycle
/// lock, with the marker written — and fsynced — before the restore touches anything and removed
/// only once it has returned. A marker that cannot be removed fails the boot, so the next one
/// imports again rather than starting a container whose import nothing recorded as finished; the
/// restore is a copy of the same archive, so doing it twice changes nothing.
fn import_if_due(say: &dyn Fn(&str)) -> Result<()> {
    let dir = intune_data_dir()?;
    let backup = import_path()?;
    let pending = import_was_interrupted(&dir);
    let step = import_step(
        backup.as_deref().map(Path::is_file),
        intune_container::backup::has_device_registration(),
        pending,
    );
    let backup = match (step, backup) {
        (ImportStep::Nothing, _) => return Ok(()),
        (ImportStep::PendingWithoutBackup, _) => {
            say(&format!(
                "WARNING: an earlier import of an enrollment backup did not finish ({} is still \
                 here), and {IMPORT_ENV} names no backup now — this container may hold HALF an \
                 enrollment (its registration keys without its keyring). Give the same backup in \
                 {IMPORT_ENV} again to finish the import.",
                dir.join(IMPORT_PENDING_FILE).display()
            ));
            return Ok(());
        }
        (ImportStep::NotAFile, Some(backup)) => {
            say(&format!(
                "{IMPORT_ENV} names {}, which is not a file — nothing imported{}",
                backup.display(),
                if pending {
                    "; an earlier import did NOT finish, so this container may hold half an enrollment"
                } else {
                    ""
                }
            ));
            return Ok(());
        }
        (ImportStep::KeepRegistration, Some(backup)) => {
            say(&format!(
                "{IMPORT_ENV} names {}, but this container already holds a device registration — \
                 not importing over it",
                backup.display()
            ));
            return Ok(());
        }
        (ImportStep::Retry, Some(backup)) => {
            say(&format!(
                "WARNING: an earlier import of an enrollment backup did not finish — the device \
                 registration this container holds is that import's own partial write, so the \
                 backup {} is IMPORTED AGAIN over it",
                backup.display()
            ));
            backup
        }
        (ImportStep::Import, Some(backup)) => backup,
        // Every step but the two above is decided without a backup, and those two need one.
        (_, None) => return Ok(()),
    };

    say(&format!("IMPORTING the enrollment backup {} into this container", backup.display()));
    mark_import_pending(&dir, &backup)?;
    intune_container::ops::restore(Some(&backup)).context("import the enrollment backup")?;
    clear_import_pending(&dir).context("record the import as finished")?;
    say(
        "IMPORTED. This container now carries that machine's enrollment: the same enrollment must \
         NOT keep running on the machine it came from — move it, do not copy it. Two live copies \
         of one device are unmeasured, and Intune may revoke both.",
    );
    Ok(())
}

/// Did an import start and not finish? The marker's presence, and nothing else: its words are for
/// a person reading the volume.
fn import_was_interrupted(dir: &Path) -> bool {
    dir.join(IMPORT_PENDING_FILE).exists()
}

/// Is an import pending on this container's volume ([`import_was_interrupted`])? For a
/// diagnostic; a boot asks it of the directory it already holds.
pub fn import_pending() -> bool {
    intune_data_dir().is_ok_and(|dir| import_was_interrupted(&dir))
}

/// Write the marker, and make it durable before the restore starts: the file's own bytes and the
/// directory entry naming it. A marker the kernel still held in its cache when the pod was killed
/// would be lost with the import it was meant to record.
fn mark_import_pending(dir: &Path, backup: &Path) -> Result<()> {
    let path = dir.join(IMPORT_PENDING_FILE);
    let mut file = File::create(&path).with_context(|| format!("create {}", path.display()))?;
    writeln!(file, "an import of {} started and has not finished", backup.display())
        .and_then(|()| file.sync_all())
        .with_context(|| format!("write {}", path.display()))?;
    sync_dir(dir)
}

/// Remove the marker, durably: an import recorded as finished must stay recorded as finished.
fn clear_import_pending(dir: &Path) -> Result<()> {
    let path = dir.join(IMPORT_PENDING_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).context(format!("remove {}", path.display()))),
    }
    sync_dir(dir)
}

/// fsync a directory, which is what makes a file created or removed in it durable.
fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .with_context(|| format!("sync {}", dir.display()))
}

// ---- a display or a container that is somebody else's ---------------------------------------

/// The refusal a boot gives when another X server already serves the container's display in this
/// network namespace, or `None` when nothing does.
///
/// Asked only before starting a container that is NOT running, which is what makes the answer
/// mean something: with this container's own Intune container down, nothing of ours serves
/// `:99`, so a listener there belongs to ANOTHER Intune container sharing this network namespace
/// — the user's own host one, when the image runs with `--network host`. The inner container
/// keeps the parent's network namespace and its Xvfb binds the ABSTRACT socket
/// `@/tmp/.X11-unix/X99`, which is per namespace; starting it beside another takes the display,
/// and with it the broker, from whichever started second. The chart refuses `hostNetwork` in
/// embedded mode for this reason; this is the same refusal on the Docker path, made where the
/// collision would happen. A listener is watched for [`DISPLAY_SETTLE`] first, because a
/// container of ours stopped a moment ago (the bus-missing restart) can leave its Xvfb exiting.
fn display_taken_by_another_container() -> Option<String> {
    let display = intune_container::ops::CONTAINER_DISPLAY;
    let path = crate::xwindow::display_socket(display)?;
    let until = Instant::now() + DISPLAY_SETTLE;
    while abstract_socket_listening(&path) {
        if Instant::now() >= until {
            return Some(display_refusal(display, &path));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

/// The sentence a boot refuses with when the display is taken: what is true, why it matters, and
/// the two ways out.
fn display_refusal(display: &str, path: &str) -> String {
    format!(
        "this container's network namespace already holds a listener on the Intune display \
         {display} (the abstract socket @{path}) while this container's own Intune container is \
         not running — so it shares its network namespace with ANOTHER Intune container, most \
         likely because it runs with `--network host` (or `network_mode: host`). Not starting a \
         second one beside it: whichever starts second takes the display, and with it the other's \
         broker. Two ways out: run this container on a network of its own (the bridge network \
         packaging/docker/compose.yaml uses), or set {MODE_ENV}=host so this app follows that \
         Intune container instead of running its own (packaging/docker/compose.host-broker.yaml)"
    )
}

/// Does this network namespace hold a LISTENING abstract unix socket named `path`?
fn abstract_socket_listening(path: &str) -> bool {
    std::fs::read_to_string("/proc/net/unix").is_ok_and(|table| unix_table_lists_listener(&table, path))
}

/// The parse of a `/proc/net/unix` table, with the table handed in so it is tested without one.
/// An abstract name is printed with a leading `@` as the last column, and a LISTENER carries
/// `__SO_ACCEPTCON` (`00010000`) in the fourth: every connection the server accepted carries the
/// listener's name too, and one of those outliving its server is no display anybody serves. It is
/// the reading `xwindow`'s own served-display check makes, for this one question.
fn unix_table_lists_listener(table: &str, path: &str) -> bool {
    const LISTENING: &str = "00010000";
    let wanted = format!("@{path}");
    table.lines().skip(1).any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.get(3) == Some(&LISTENING) && fields.last() == Some(&wanted.as_str())
    })
}

/// What the crate's supervisor lock says, read without taking it from anybody.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupervisorLock {
    /// No supervisor has ever run from this volume.
    Absent,
    /// No supervisor is running.
    Free,
    /// A supervisor is running — in this namespace or in another.
    Held,
    /// The lock could not be asked: a filesystem that cannot `flock`, or a file this user may not
    /// open. The crate's own singleton cannot be taken there either, so no container can run.
    Unknown,
}

/// Ask [`SUPERVISOR_LOCK_FILE`] with a non-blocking SHARED try-lock on a READ-ONLY open: never
/// created, never truncated — the crate's `SingletonLock` opens it with `File::create`, which
/// would empty it — and never taken from the supervisor. A supervisor starting at this very
/// moment may find the probe's shared lock in its way; it retries for three seconds, which is the
/// same allowance [`slot_holder`]'s probes rely on.
fn supervisor_lock(dir: &Path) -> SupervisorLock {
    match File::open(dir.join(SUPERVISOR_LOCK_FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SupervisorLock::Absent,
        Err(_) => SupervisorLock::Unknown,
        Ok(file) => match file.try_lock_shared() {
            Ok(()) => SupervisorLock::Free,
            Err(TryLockError::WouldBlock) => SupervisorLock::Held,
            Err(TryLockError::Error(_)) => SupervisorLock::Unknown,
        },
    }
}

/// What the runtime state on this volume says about a leader, read once.
///
/// THREE answers, because "no live leader here" covered two different things and a refusal was
/// made on the wrong one: a state naming a leader that is NOT this namespace's is a container
/// running from this volume somewhere else, while NO state at all is the ordinary shape of a
/// container of OURS between its supervisor taking the lock and publishing its leader (a start),
/// and between the crate clearing the state and the leader going (a poweroff that outlasted the
/// crate's own twenty-second wait) — see [`POWEROFF_WAIT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaderRead {
    /// No leader is named: no state, or one this process could not read (a file torn mid-write
    /// reads as an error, and a guess is never a refusal).
    Unnamed,
    /// The state names a leader that is live, and a container init, in this namespace: ours.
    Here,
    /// The state names a leader that is not live in this namespace.
    NotHere,
}

/// [`LeaderRead`], from one read of the runtime state — `load_runtime_state`, never
/// `running_leader`, which would delete a state naming another namespace's leader as stale.
fn leader_read() -> LeaderRead {
    match intune_container::runtime::load_runtime_state() {
        Ok(Some(state)) if crate::intune::leader_is_live_here(&state) => LeaderRead::Here,
        Ok(Some(_)) => LeaderRead::NotHere,
        Ok(None) | Err(_) => LeaderRead::Unnamed,
    }
}

/// The decision, with its two inputs handed in: a container is running from this volume in
/// ANOTHER namespace when a supervisor holds its lock AND the state names a leader that is not
/// live here. A held lock with NO state is a container of ours in transit — mid-start or
/// mid-poweroff — and is waited for by whoever needs it gone ([`await_our_container_to_settle`]),
/// never refused as somebody else's: the advice that refusal gives (a volume of its own) costs a
/// fresh volume and a re-enrollment. Anything that cannot be told is not "elsewhere" either: a
/// refusal must never be made on a guess.
fn runs_elsewhere(lock: SupervisorLock, leader: LeaderRead) -> bool {
    lock == SupervisorLock::Held && leader == LeaderRead::NotHere
}

/// Is an Intune container running from this volume in another container or pod? One read, for a
/// diagnostic; a helper asks [`refuse_a_container_running_elsewhere`], which watches first.
pub fn container_runs_elsewhere() -> bool {
    intune_data_dir().is_ok_and(|dir| runs_elsewhere(supervisor_lock(&dir), leader_read()))
}

/// The runtime state, when it names a leader live here — recorded BEFORE a stop, so the stop can
/// be checked against that very process afterwards: the crate's `backend::stop` clears the state
/// after its own wait whether or not the leader went, so nothing on the volume names it then. A
/// pure read, like [`leader_read`].
pub(crate) fn live_leader_state() -> Option<intune_container::runtime::RuntimeState> {
    intune_container::runtime::load_runtime_state()
        .ok()
        .flatten()
        .filter(crate::intune::leader_is_live_here)
}

/// Is a container of OURS still in transit on this volume? Decided from what a read found, so it
/// is tested without one: the leader a stop was asked of (`stopped_leader_alive`) has not exited,
/// or a supervisor holds the lock with no leader named ([`LeaderRead::Unnamed`]) — the crate
/// cleared the state while the container was still powering off, or a start whose caller gave up
/// at the crate's own twenty seconds is still booting. Both are this volume's own whenever this is
/// asked, because the asker holds the lifecycle lock — and, in embedded mode, the helper slot: no
/// other helper of ours can be starting one, and a container elsewhere names its leader
/// ([`runs_elsewhere`]). In HOST mode the asker is the repair (`intune::restart_container`), the
/// volume is the user's own `intune-container` data directory, and a supervisor in transit there
/// is the user's own container's: there is no other namespace for one to be in.
fn our_container_in_transit(stopped_leader_alive: bool, lock: SupervisorLock, leader: LeaderRead) -> bool {
    stopped_leader_alive || (lock == SupervisorLock::Held && leader == LeaderRead::Unnamed)
}

/// Wait at most `bound` until no container of ours is in transit ([`our_container_in_transit`]);
/// true once none is. `stopped` is the leader this caller asked to power off, when it asked one.
/// A slow start that publishes its leader meanwhile ends the wait too: that container is up, and
/// the crate's start answers "already running" for it. Asked by the boot's restart here and by the
/// repair's (`intune::restart_container`), in either mode — one wait for one crate behaviour.
pub(crate) fn await_our_container_to_settle(
    stopped: Option<&intune_container::runtime::RuntimeState>,
    bound: Duration,
) -> bool {
    let dir = intune_data_dir().ok();
    let until = Instant::now() + bound;
    loop {
        let stopped_alive = stopped.is_some_and(crate::intune::leader_is_live_here);
        let lock = dir.as_deref().map_or(SupervisorLock::Unknown, supervisor_lock);
        if !our_container_in_transit(stopped_alive, lock, leader_read()) {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Refuse — exit 2, touching nothing — when the container running from this volume is another
/// namespace's. Every helper asks this right after the slot is its own and BEFORE anything it does
/// can reach the crate's `running_leader` (which `backend::is_running`, `ops::restore`, the stop
/// and the portal probes all call): there, the other container's state names a pid that is no
/// container init in this namespace, and the crate would delete it as stale — signing the other
/// container's app out for good, and then booting a second container onto a rootfs in use.
///
/// The slot makes once enough for a helper whose container is ours: a helper of ours holds it from
/// here to its end, so no other helper of ours can spawn a supervisor meanwhile, and a helper in the
/// other container cannot hold the same slot either (the `flock` is on a file of the shared volume).
/// The one exception is a held lock with NO state, which is not refused ([`runs_elsewhere`]) and
/// can still turn out to be another container mid-start: the boot, which waits on that state
/// anyway ([`await_our_container_to_settle`]), asks [`container_elsewhere`] again before it starts.
pub(crate) fn refuse_a_container_running_elsewhere(say: &dyn Fn(&str)) -> Option<i32> {
    let why = container_elsewhere()?;
    say(&format!("refused: {why}"));
    Some(2)
}

/// The sentence a helper refuses with when the container running from this volume is another
/// namespace's ([`runs_elsewhere`]), or `None`. A held lock whose state names a leader that is not
/// live here is watched for [`SUPERVISOR_SETTLE`] before it is read as somebody else's: a supervisor
/// of OURS whose leader has just exited still holds the lock, with the dead leader's state on the
/// volume, for the moment it takes to clear it and let go.
fn container_elsewhere() -> Option<String> {
    let dir = intune_data_dir().ok()?;
    let until = Instant::now() + SUPERVISOR_SETTLE;
    loop {
        if !runs_elsewhere(supervisor_lock(&dir), leader_read()) {
            return None;
        }
        if Instant::now() >= until {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Some(format!(
        "an Intune container supervisor holds {}, and the runtime state names a container leader \
         that does not live in this container's process namespace — so this volume is mounted by \
         ANOTHER container or pod, whose Intune container runs from it right now. Touching \
         nothing: its runtime state, its rootfs and its sign-in are that container's, and reading \
         them from here would delete them. The intune volume must belong to ONE teams-lite \
         container: stop the other one, or give this one a volume of its own.",
        dir.join(SUPERVISOR_LOCK_FILE).display()
    ))
}

// ---- the stop -------------------------------------------------------------------------------

/// The stop helper: a graceful poweroff, under the helper SLOT and then the crate's lifecycle
/// lock — both waited for at most [`STOP_LOCK_WAIT`] in all. Exit 0 when nothing is running at the
/// end (including when nothing was), 1 when the slot or the lock could not be had in time, the stop
/// failed, or the container's leader was still alive when the crate's own twenty-second wait for
/// its poweroff ended — the crate's stop answers Ok then too, so its Ok is checked against the
/// leader recorded before it — and 2 outside embedded mode or when the container is another
/// namespace's.
///
/// THE SLOT FIRST, and that is what makes the stop's answer true. At shutdown the launcher
/// SIGKILLs the backend, but a boot helper it spawned lives on in its own session — and a stop
/// that took the lifecycle lock alone would find "not running" in the moment before that boot
/// took the lock, exit 0, and let the boot start the container a moment before the runtime
/// SIGKILLed everything in it. Holding the slot, a boot spawned after the stop finds it taken and
/// leaves ([`BOOT_SLOT_TAKEN`]), and one already at work is waited out before the stop looks. An
/// enrollment's PORTAL helper holding it is asked to close (the pod is going, and so is the
/// portal) — a boot or a repair never is: it would die mid-work.
///
/// It refuses NOTHING else, read-only included: a read-only pod never booted a container, so
/// there is nothing a stop could take from it. Embedded mode alone is required, because in host
/// mode the container is the USER'S, and this binary never stops it.
///
/// `LifecycleLock` offers only a blocking acquire, so its wait is bounded by a THREAD that takes
/// it and a channel read with a deadline. On a timeout this process exits with the thread still
/// blocked, which the kernel ends with it; a lock the thread wins after the deadline goes down
/// with the process too, so a give-up never strands the lock. The slot is a `try_lock` loop and
/// needs no thread.
pub fn stop_main() -> i32 {
    use intune_container::{backend, config::Config};
    crate::intune::init_tracing();
    let say = |line: &str| eprintln!("teams-lite(intune-stop): {line}");
    if let Some(code) = refuse_unless_embedded(&say, false) {
        return code;
    }
    let give_up = Instant::now() + STOP_LOCK_WAIT;
    let portal_asked = std::cell::Cell::new(false);
    let ask_a_portal_to_close = |holder: Option<(SlotHolder, u32)>| {
        let Some((SlotHolder::Portal, pid)) = holder else { return };
        if portal_asked.replace(true) {
            return;
        }
        say("an enrollment's portal holds the helper slot — asking it to close");
        if let Err(e) = (HelperTerminator { helper: Helper::Portal, pid: Some(pid) }).terminate() {
            say(&format!("could not ask the portal helper to close: {e:#}"));
        }
    };
    let _slot = match take_slot(SlotHolder::Stop, STOP_LOCK_WAIT, &ask_a_portal_to_close) {
        Ok(Some(slot)) => slot,
        Ok(None) => {
            say(&format!(
                "a container helper (a setup, a start or a repair) still held the helper slot after \
                 {} s — not stopping; the container ends with the pod",
                STOP_LOCK_WAIT.as_secs()
            ));
            return 1;
        }
        Err(e) => {
            say(&format!("could not take the helper slot: {e:#}"));
            return 1;
        }
    };
    if let Some(code) = refuse_a_container_running_elsewhere(&say) {
        return code;
    }
    // What is left of the budget — and never nothing: holding the slot, the lifecycle lock is
    // normally free at once (every helper of ours lets it go before the slot), and a wait of zero
    // would read a lock that is free as one that is not.
    let left = give_up.saturating_duration_since(Instant::now()).max(Duration::from_secs(1));
    let lock = match lifecycle_lock_within(left) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            say(&format!(
                "the lifecycle lock was not free within {} s (a setup or a start holds it) — not \
                 stopping; the container ends with the pod",
                STOP_LOCK_WAIT.as_secs()
            ));
            return 1;
        }
        Err(e) => {
            say(&format!("could not take the lifecycle lock: {e:#}"));
            return 1;
        }
    };
    let Ok(config) = Config::load() else {
        say("the container was never set up — nothing to stop");
        return 0;
    };
    if !backend::is_running(&config) {
        say("the container is not running — nothing to stop");
        return 0;
    }
    // Recorded before the stop, because afterwards nothing names it: the crate's stop clears the
    // runtime state after its own wait whether or not the leader went.
    let leader = live_leader_state();
    say("stopping the container");
    let stopped = backend::stop(&config);
    drop(lock);
    if let Err(e) = stopped {
        say(&format!("the stop failed: {e:#}"));
        return 1;
    }
    // `backend::stop` answers Ok after its twenty-second wait WHETHER OR NOT the leader went, so
    // its Ok is not the answer: the leader it was asked to power off is, checked against the very
    // process recorded above (a recycled pid is never read as it).
    match leader {
        Some(state) if crate::intune::leader_is_live_here(&state) => {
            say(&format!(
                "the poweroff did not finish within the crate's twenty-second wait — the container \
                 (leader pid {}) is still powering off, and ends with this container rather than \
                 gracefully",
                state.leader
            ));
            1
        }
        _ => {
            say("stopped");
            0
        }
    }
}

// ---- the portal -----------------------------------------------------------------------------

/// The portal helper: the Intune portal on the container's own display, held until the reader
/// closes it, the session that opened it asks it to stop (SIGTERM), or [`PORTAL_TIMEOUT`] passes.
/// Exit 0 when the portal ran and ended — closed by the reader or on the session's request —
/// [`PORTAL_TIMED_OUT`] when THIS helper closed it at its deadline, 1 when it could not be opened
/// or never appeared, 2 when it refuses to act at all.
///
/// A STOP REQUEST IS ANSWERED, never ignored. The helper lives in a session of its own, so nothing
/// but a signal reaches it: a Cancel pressed while the portal was still on its way used to close
/// no window (there was none yet) and leave this helper to open the portal a moment later with no
/// session behind it, holding the slot — every enrollment, repair and boot refused — for half an
/// hour. So a SIGTERM sets a flag ([`listen_for_a_stop_request`]) that is read right after the
/// portal is launched and on every pass of both loops, and is answered with the portal closed the
/// way a person would close it (`ops::portal_stop`, a TERM it writes its account state on), even
/// when it has not appeared yet ([`close_a_portal_on_its_way`]).
pub fn portal_main() -> i32 {
    use intune_container::{backend, config::Config, ops};
    crate::intune::init_tracing();
    let say = |line: &str| eprintln!("teams-lite(intune-portal): {line}");
    if let Some(code) = refuse_unless_embedded(&say, true) {
        return code;
    }
    // Before anything else: from here on a SIGTERM is a request this helper answers, never the
    // default death that would leave the portal on the display with nobody behind it.
    if let Err(e) = listen_for_a_stop_request() {
        say(&format!("could not listen for a stop request ({e:#}) — a Cancel ends this helper without closing the portal"));
    }
    let _slot = match take_helper_slot(Helper::Portal) {
        Ok(Some(slot)) => slot,
        Ok(None) => {
            say("another container helper is at work on this volume — the portal cannot open now");
            return 1;
        }
        Err(e) => {
            say(&format!("could not take the helper slot: {e:#}"));
            return 1;
        }
    };
    if let Some(code) = refuse_a_container_running_elsewhere(&say) {
        return code;
    }
    let running = Config::load().map(|config| backend::is_running(&config)).unwrap_or(false);
    if !running {
        say("the container is not running — it is started before an enrollment, never by one");
        return 1;
    }
    if stop_requested() {
        say("asked to stop before the portal was opened — not opening it");
        return 0;
    }
    if let Err(e) = ops::portal_open_headless() {
        say(&format!("could not open the Intune portal: {e:#}"));
        return 1;
    }

    let appear_by = Instant::now() + PORTAL_APPEAR_WAIT;
    loop {
        if stop_requested() {
            say("asked to stop while the portal was opening — closing it as it appears");
            close_a_portal_on_its_way(&say);
            say_registration(&say);
            return 0;
        }
        if ops::portal_is_running() {
            break;
        }
        if Instant::now() >= appear_by {
            say(&format!("the Intune portal did not appear within {} s", PORTAL_APPEAR_WAIT.as_secs()));
            // It may still be on its way, and a portal appearing after this helper has gone would
            // sit on the display with no slot, no session and no deadline.
            close_portal(&say);
            return 1;
        }
        pause_unless_stopped(Duration::from_secs(1));
    }
    say("the Intune portal is open on the container's display");

    let close_by = Instant::now() + PORTAL_TIMEOUT;
    let mut code = 0;
    while ops::portal_is_running() {
        if stop_requested() {
            say("asked to stop — closing the portal");
            close_portal(&say);
            break;
        }
        if Instant::now() >= close_by {
            say(&format!("the portal was open for {} min — closing it", PORTAL_TIMEOUT.as_secs() / 60));
            close_portal(&say);
            code = PORTAL_TIMED_OUT;
            break;
        }
        pause_unless_stopped(Duration::from_secs(1));
    }
    say_registration(&say);
    code
}

/// Say whether the container holds a device registration now, which is how a reader of the log
/// tells an enrollment that worked from one that did not.
fn say_registration(say: &dyn Fn(&str)) {
    say(if intune_container::backup::has_device_registration() {
        "the portal closed; this container now holds a device registration"
    } else {
        "the portal closed; this container holds no device registration yet"
    });
}

/// Close the portal — a TERM, never a KILL, which is the crate's own rule — and say so when it
/// could not be asked.
fn close_portal(say: &dyn Fn(&str)) {
    if let Err(e) = intune_container::ops::portal_stop() {
        say(&format!("could not close the portal: {e:#}"));
    }
}

/// Close a portal that has been launched but may not exist yet: it is launched in the background,
/// so a stop landing first would find nothing to close and leave it to appear a moment later with
/// no session behind it. Watched for [`PORTAL_STOP_SETTLE`], and closed the moment it appears.
fn close_a_portal_on_its_way(say: &dyn Fn(&str)) {
    let until = Instant::now() + PORTAL_STOP_SETTLE;
    loop {
        if intune_container::ops::portal_is_running() {
            close_portal(say);
            return;
        }
        if Instant::now() >= until {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Set by the portal helper's SIGTERM handler, read by its loops.
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

/// The handler: one store to a lock-free atomic, which is all a signal handler may safely do.
extern "C" fn note_a_stop_request(_signal: c_int) {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

/// Answer SIGTERM with [`note_a_stop_request`] from now on. `signal(2)` with BSD semantics — the
/// handler stays installed and an interrupted wait for a child restarts — which is glibc's and
/// musl's, and what a helper that probes the container through child processes needs.
fn listen_for_a_stop_request() -> Result<()> {
    let handler = note_a_stop_request as extern "C" fn(c_int);
    // SAFETY: the handler is an `extern "C" fn(c_int)`, the shape the kernel calls a handler
    // with, and it only stores to a static lock-free atomic — async-signal-safe.
    let previous = unsafe { install_signal_handler(SIGTERM, handler as usize) };
    if previous == SIG_ERR {
        return Err(anyhow::Error::new(std::io::Error::last_os_error()).context("install a SIGTERM handler"));
    }
    Ok(())
}

/// Has a stop been asked for?
fn stop_requested() -> bool {
    STOP_REQUESTED.load(Ordering::SeqCst)
}

/// Sleep for `pause`, in short slices, ending at once when a stop is asked for.
fn pause_unless_stopped(pause: Duration) {
    let until = Instant::now() + pause;
    while !stop_requested() {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        std::thread::sleep(left.min(Duration::from_millis(100)));
    }
}

// ---- what every helper shares ---------------------------------------------------------------

/// The refusals every helper body shares, as an exit code (2) when it refuses: an unknown mode,
/// a mode that is not embedded, and — where `refuse_read_only` — a read-only process.
pub(crate) fn refuse_unless_embedded(say: &dyn Fn(&str), refuse_read_only: bool) -> Option<i32> {
    match mode() {
        Ok(Mode::Embedded) => {}
        Ok(Mode::Host) => {
            say(&format!(
                "refused: {MODE_ENV} is not `embedded` — in host mode the Intune container is the \
                 user's own, and this binary never boots, stops or enrolls it"
            ));
            return Some(2);
        }
        Err(e) => {
            say(&format!("refused: {e:#}"));
            return Some(2);
        }
    }
    if refuse_read_only && crate::read_only() {
        say("refused: TEAMS_LITE_READ_ONLY=1 — a read-only process never boots or enrolls the container");
        return Some(2);
    }
    None
}

/// Make the container's cgroup a child of this pod's when nothing said otherwise.
///
/// [`spawn_helper`] already hands every helper `INTUNE_CONTAINER_CGROUP=own`; this covers a
/// helper run DIRECTLY — the image's self-test, an operator in a shell — where the crate's `auto`
/// would ask whatever session manager the shell knows of first. The crate reads the variable in
/// the supervisor it spawns, which inherits this process's environment.
pub(crate) fn own_cgroup_by_default() {
    let name = intune_container::runtime::CGROUP_ENV;
    if std::env::var_os(name).is_none_or(|v| v.is_empty()) {
        // SAFETY: called first thing in a helper body, before this process has started any
        // thread (no runtime exists yet and the watchdog is armed later), so nothing can be
        // reading the environment concurrently.
        unsafe { std::env::set_var(name, "own") };
    }
}

/// A helper's own deadline: a helper with no systemd around it has no `TimeoutStartUSec`, and a
/// hung one would hold the slot every other helper needs for good.
///
/// Its deadline MOVES ([`Watchdog::rearm`]) — the boot runs a setup and then a start under two
/// different bounds, and a deadline fixed at arming could not tell the second one the first is
/// over. Dropping the handle does not disarm it: the deadline holds for the process's life.
pub(crate) struct Watchdog {
    deadline: Arc<(Mutex<Deadline>, Condvar)>,
}

/// When a watchdog ends its process, and what it says about the step that overran.
struct Deadline {
    at: Instant,
    what: &'static str,
    bound: Duration,
}

impl Watchdog {
    /// Move the deadline to `bound` from now, for the step named `what`. Earlier or later: the
    /// watchdog's thread is woken and waits for the new one.
    pub(crate) fn rearm(&self, what: &'static str, bound: Duration) {
        let (deadline, moved) = &*self.deadline;
        *deadline.lock().unwrap_or_else(PoisonError::into_inner) = Deadline { at: Instant::now() + bound, what, bound };
        moved.notify_all();
    }
}

/// End this process when `what` has not finished within `bound`, with a sentence naming it.
pub(crate) fn arm_watchdog(name: &'static str, what: &'static str, bound: Duration) -> Watchdog {
    let deadline = Arc::new((Mutex::new(Deadline { at: Instant::now() + bound, what, bound }), Condvar::new()));
    let watched = Arc::clone(&deadline);
    std::thread::spawn(move || {
        let (deadline, moved) = &*watched;
        let mut current = deadline.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            let now = Instant::now();
            if now >= current.at {
                eprintln!(
                    "teams-lite({name}): {} did not finish within {} s — this helper is ending \
                     itself; the next one tries again",
                    current.what,
                    current.bound.as_secs()
                );
                std::process::exit(1);
            }
            let wait = current.at - now;
            current = moved.wait_timeout(current, wait).unwrap_or_else(PoisonError::into_inner).0;
        }
    });
    Watchdog { deadline }
}

/// [`IMPORT_ENV`], when it is set: an ABSOLUTE path, or an error — a relative one would be
/// resolved against whatever directory the helper happened to start in.
fn import_path() -> Result<Option<PathBuf>> {
    let Some(value) = std::env::var_os(IMPORT_ENV).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    anyhow::ensure!(path.is_absolute(), "{IMPORT_ENV}={} is not an absolute path", path.display());
    Ok(Some(path))
}

/// The crate's lifecycle lock, waited for at most `wait` (see [`stop_main`] for why a thread).
fn lifecycle_lock_within(wait: Duration) -> Result<Option<intune_container::lock::LifecycleLock>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(intune_container::lock::LifecycleLock::acquire());
    });
    match rx.recv_timeout(wait) {
        Ok(Ok(lock)) => Ok(Some(lock)),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(source: &str) -> String {
        source
            .split("#[cfg(test)]")
            .next()
            .unwrap_or(source)
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_mode_is_declared_and_an_unknown_one_is_refused() {
        assert_eq!(parse_mode(None), Ok(Mode::Host));
        assert_eq!(parse_mode(Some("")), Ok(Mode::Host), "a blank compose line is no mode");
        assert_eq!(parse_mode(Some("host")), Ok(Mode::Host));
        assert_eq!(parse_mode(Some("embedded")), Ok(Mode::Embedded));
        assert_eq!(parse_mode(Some(" embedded ")), Ok(Mode::Embedded));
        for wrong in ["Embedded", "self", "own", "1", "true"] {
            let err = parse_mode(Some(wrong)).expect_err(wrong);
            assert!(err.contains(MODE_ENV) && err.contains("embedded") && err.contains("host"), "{err}");
        }
    }

    // The supervisor inherits the helper's environment, and the container's PID 1 inherits the
    // supervisor's for the container's whole life — so the write token and every bus address
    // the backend holds must stay out of it, however the backend was started.
    #[test]
    fn a_helper_gets_an_environment_built_from_scratch() {
        let parent: Vec<(&str, &str)> = vec![
            ("HOME", "/home/teams"),
            ("USER", "teams"),
            ("LOGNAME", "teams"),
            ("PATH", "/usr/bin:/bin"),
            ("LANG", "C.UTF-8"),
            ("TZ", "Europe/Paris"),
            ("TEAMS_LITE_WRITE_TOKEN", "secret-token"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("TEAMS_LITE_BROKER_BUS", "unix:path=/x"),
            ("DISPLAY", ":0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("TEAMS_LITE_INTUNE_MODE", "host"),
            ("INTUNE_CONTAINER_CGROUP", "user-manager"),
            ("TEAMS_LITE_INTUNE_IMPORT", "/run/teams-lite/intune-import/enrollment-backup.tar.gz"),
        ];
        let get = |name: &str| parent.iter().find(|(k, _)| *k == name).map(|(_, v)| OsString::from(*v));
        let env = helper_env(get);
        let value = |name: &str| {
            env.iter().find(|(k, _)| k == name).map(|(_, v)| v.to_string_lossy().into_owned())
        };
        for kept in ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TZ"] {
            assert!(value(kept).is_some(), "{kept} is passed through");
        }
        for dropped in [
            "TEAMS_LITE_WRITE_TOKEN",
            "DBUS_SESSION_BUS_ADDRESS",
            "TEAMS_LITE_BROKER_BUS",
            "DISPLAY",
            "XDG_RUNTIME_DIR",
        ] {
            assert_eq!(value(dropped), None, "{dropped} must never reach the container's PID 1");
        }
        assert!(
            env.iter().all(|(_, v)| !v.to_string_lossy().contains("secret-token")),
            "no value anywhere carries the write token"
        );
        // Set, never inherited: a backend in another mode cannot hand its mode down.
        assert_eq!(value(MODE_ENV).as_deref(), Some("embedded"));
        assert_eq!(value(intune_container::runtime::CGROUP_ENV).as_deref(), Some("own"));
        assert_eq!(
            value(IMPORT_ENV).as_deref(),
            Some("/run/teams-lite/intune-import/enrollment-backup.tar.gz")
        );
        // Nothing but the list, and each name once.
        let mut names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "no variable is set twice");
        for name in &names {
            assert!(
                PASSED_THROUGH.contains(&name.as_str())
                    || ["PATH", MODE_ENV, IMPORT_ENV, intune_container::runtime::CGROUP_ENV].contains(&name.as_str()),
                "{name} is not on the helper's list"
            );
        }
    }

    #[test]
    fn a_helper_with_no_path_still_finds_the_id_mappers() {
        let env = helper_env(|_| None);
        let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone());
        assert_eq!(path, Some(OsString::from(DEFAULT_PATH)));
        assert!(env.iter().all(|(k, _)| k != IMPORT_ENV), "no import unless one is given");
    }

    // The one spawn in this module, and what it is allowed to be: this binary, a clean
    // environment, a session of its own, and a child nobody kills with the backend.
    #[test]
    fn the_only_program_a_helper_spawn_runs_is_this_binary() {
        let code = code_of(include_str!("intune_embedded.rs"));
        assert_eq!(code.matches("Command::new(").count(), 1, "one spawn, in spawn_helper");
        let body = code
            .split("pub fn spawn_helper(helper: Helper) -> Result<HelperStart> {")
            .nth(1)
            .expect("spawn_helper")
            .split("\n}\n")
            .next()
            .unwrap();
        let exe = body.find("let exe = crate::intune::own_executable()?;").expect("own_executable");
        let spawn = body.find("tokio::process::Command::new(&exe)").expect("spawns that path");
        let clear = body.find(".env_clear()").expect("clears the environment");
        let envs = body.find(".envs(helper_env(").expect("then sets only the helper's list");
        assert!(exe < spawn && spawn < clear && clear < envs);
        assert!(body.contains(".kill_on_drop(false)"));
        assert!(body.contains("new_session()"), "a session of its own");
        assert!(body.contains(".stdout(Stdio::inherit())") && body.contains(".stderr(Stdio::inherit())"));
        assert!(!code.contains("std::process::Command"), "nothing else is spawned");
    }

    // The same two calls `intune.rs` must never make, and the read path's own promise.
    #[test]
    fn the_crate_is_read_without_side_effects_and_never_rewires_browser_sso() {
        let code = code_of(include_str!("intune_embedded.rs"));
        assert!(!code.contains("running_leader("), "reads must not clean another tool's state");
        assert!(!code.contains("ops::start("), "ops::start rewires browser SSO to this binary");
        let status = code
            .split("pub fn status(boot_followed: bool) -> EmbeddedStatus {")
            .nth(1)
            .expect("status")
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(
            !status.contains("is_running("),
            "the greeting's read must not go through backend::is_running, which cleans state"
        );
    }

    /// The body of the function whose signature line is `signature`, up to its closing brace at
    /// the start of a line — comments already stripped by [`code_of`].
    fn body_of<'a>(code: &'a str, signature: &str) -> &'a str {
        code.split(signature)
            .nth(1)
            .unwrap_or_else(|| panic!("{signature}"))
            .split("\n}\n")
            .next()
            .expect("the function ends")
    }

    /// Where `needle` is in `body`, or a failure naming it.
    fn at(body: &str, needle: &str) -> usize {
        body.find(needle).unwrap_or_else(|| panic!("missing `{needle}`"))
    }

    // The boot is the repair's boot: `intune::boot_headless`, never a copy of it; the setup (which
    // takes the lock itself) happens outside the lock and under a bound of its own, and the import
    // under the lock, before the start.
    #[test]
    fn the_boot_sets_up_outside_the_lock_and_starts_through_the_repairs_own_boot() {
        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "fn boot(say: &dyn Fn(&str)) -> std::result::Result<(), BootEnd> {");
        let setup_bound = at(body, "arm_watchdog(\"intune-boot\", \"the setup (the ~1.7 GB download)\", BOOT_SETUP_TIMEOUT)");
        let init = at(body, "ops::init(false, None, \"\")");
        let start_bound = at(body, "watchdog.rearm(\"the start\", BOOT_START_TIMEOUT)");
        let lock = at(body, "LifecycleLock::acquire()");
        let import = at(body, "import_if_due(say)?");
        let running = at(body, "backend::is_running(&config)");
        let start = at(body, "crate::intune::boot_headless(");
        assert!(
            setup_bound < init && init < start_bound && start_bound < lock && lock < import && import < running && running < start,
            "the setup is bounded and runs outside the lock; the start's bound, the lock, the import and the start follow"
        );
        assert!(!body.contains("backend::start("), "the boot is never re-spelled here");
        assert!(!body.contains("auto_update"), "the update rule lives in boot_headless alone");
        assert_eq!(BOOT_SETUP_TIMEOUT, Duration::from_secs(2 * 60 * 60), "a stalled pull ends at two hours");
        assert!(
            BOOT_FOLLOW_BOUND >= BOOT_SETUP_TIMEOUT + BOOT_START_TIMEOUT,
            "a follower outlasts the longest a boot can live"
        );
    }

    // A live leader with no broker's bus is NOT up: the crate's `is_running` looks at the leader
    // alone, and a boot that believed it would leave the container signed out for good. So the bus
    // is given its grace, then the container is stopped and started; and the boot's success is
    // the app's own definition of up, its bus included.
    #[test]
    fn the_boot_restarts_a_container_whose_bus_never_appeared() {
        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "fn boot(say: &dyn Fn(&str)) -> std::result::Result<(), BootEnd> {");
        let running = at(body, "backend::is_running(&config)");
        let grace = at(body, "await_broker_bus(BUS_GRACE)");
        let missing = at(body, "BusWait::Missing =>");
        let stop = at(body, "backend::stop(&config)");
        let start = at(body, "crate::intune::boot_headless(");
        let after = body[start..].find("await_broker_bus(BUS_GRACE)").map(|i| i + start).expect("the bus is awaited after the start");
        assert!(running < grace && grace < missing && missing < stop && stop < start && start < after);
        assert!(!body.contains("anyhow::ensure!(backend::is_running"), "a leader alone is never the boot's success");
        let wait = body_of(&code, "fn await_broker_bus(grace: Duration) -> BusWait {");
        assert!(wait.contains("crate::intune::container_is_up()"), "up is the app's own definition");
        assert!(wait.contains("crate::intune::container_leader()"), "a leader that went is not waited for");
        assert!(
            BOOT_START_TIMEOUT >= crate::intune::REPAIR_WORK + BUS_GRACE * 2 + POWEROFF_WAIT,
            "the start's bound holds the repair's work, both waits for the bus and the wait for a poweroff"
        );
        assert!(
            BOOT_START_TIMEOUT >= crate::intune::REPAIR_TIMEOUT + BUS_GRACE * 2,
            "and never less than the repair's own bound with the bus waits on top"
        );
    }

    // The bus-missing restart's stop can outlast the crate's own twenty-second wait (a unit at
    // systemd's ninety-second stop timeout), and the crate clears the state anyway — leaving our
    // supervisor holding its lock and our Xvfb on `:99`. Read then, the display check called our
    // own Xvfb ANOTHER Intune container's (`--network host`, exit 2), and every later helper called
    // the volume another container's. So the leader is recorded before the stop, and the boot waits
    // for it — and for our supervisor — before it reads the display or starts anything, and says the
    // container is still powering off (a failure, exit 1) when it has not gone.
    #[test]
    fn a_boot_waits_for_its_own_poweroff_before_it_reads_the_display() {
        use SupervisorLock::*;
        assert!(our_container_in_transit(true, Free, LeaderRead::Unnamed), "the leader it stopped is alive");
        assert!(our_container_in_transit(true, Absent, LeaderRead::Unnamed), "whatever the lock says");
        assert!(our_container_in_transit(false, Held, LeaderRead::Unnamed), "our supervisor, no leader named");
        assert!(!our_container_in_transit(false, Held, LeaderRead::Here), "a slow start that came up is up");
        assert!(!our_container_in_transit(false, Held, LeaderRead::NotHere), "elsewhere is another refusal");
        for lock in [Absent, Free, Unknown] {
            assert!(!our_container_in_transit(false, lock, LeaderRead::Unnamed), "{lock:?}: nothing in transit");
        }
        assert!(POWEROFF_WAIT > Duration::from_secs(90), "longer than systemd's own default stop timeout");

        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "fn boot(say: &dyn Fn(&str)) -> std::result::Result<(), BootEnd> {");
        let missing = at(body, "BusWait::Missing =>");
        let recorded = at(body, "stopped = live_leader_state();");
        let stop = at(body, "backend::stop(&config)");
        let settle = at(body, "await_our_container_to_settle(stopped.as_ref(), POWEROFF_WAIT)");
        let elsewhere = at(body, "container_elsewhere()");
        let display = at(body, "display_taken_by_another_container()");
        let start = at(body, "crate::intune::boot_headless(");
        assert!(
            missing < recorded && recorded < stop && stop < settle && settle < elsewhere && elsewhere < display && display < start,
            "recorded before the stop, waited for — and asked again whether it is ours — before the display is read and before the start"
        );
        assert!(
            body[elsewhere..display].contains("return Err(BootEnd::Refused(why));"),
            "a container that turned out to be elsewhere is refused before the start reaches running_leader"
        );
        let still = &body[settle..elsewhere];
        assert!(still.contains("BootEnd::Failed(") && !still.contains("BootEnd::Refused("), "a failure, never a refusal");
        assert!(still.contains("powering off") && still.contains("still going down"), "and it says what is true");
        let record = body_of(&code, "fn live_leader_state() -> Option<intune_container::runtime::RuntimeState> {");
        assert!(record.contains("load_runtime_state()") && !record.contains("running_leader"), "a pure read");

        // The wait itself, against a throwaway data dir in a child process (the crate reads
        // XDG_DATA_HOME, and this must never read the machine's own Intune container).
        if std::env::var_os("TEAMS_LITE_POWEROFF_TEST").is_some() {
            let dir = intune_data_dir().unwrap();
            std::fs::create_dir_all(&dir).unwrap();
            // Our supervisor, mid-poweroff: it holds its lock, and the crate cleared the state.
            let supervisor = File::create(dir.join(SUPERVISOR_LOCK_FILE)).unwrap();
            supervisor.lock().unwrap();
            assert_eq!(leader_read(), LeaderRead::Unnamed);
            assert!(!runs_elsewhere(supervisor_lock(&dir), leader_read()), "not refused as somebody else's");
            let waited = Instant::now();
            assert!(!await_our_container_to_settle(None, Duration::from_millis(400)), "still in transit");
            assert!(waited.elapsed() >= Duration::from_millis(400), "it waited its bound");
            supervisor.unlock().unwrap();
            assert!(await_our_container_to_settle(None, Duration::from_secs(5)), "the lock let go: settled");
            // A state naming a leader that is no container init here (this very test process): the
            // leader recorded before a stop is not read as alive, and with the lock held it is the
            // container ELSEWHERE — the refusal's business, never this wait's.
            let me = intune_container::runtime::RuntimeState {
                leader: std::process::id() as i32,
                scope: String::new(),
                start_time: None,
            };
            assert!(!crate::intune::leader_is_live_here(&me));
            assert!(await_our_container_to_settle(Some(&me), Duration::ZERO), "no live leader to wait for");
            intune_container::runtime::save_runtime_state(&me).unwrap();
            supervisor.lock().unwrap();
            assert_eq!(leader_read(), LeaderRead::NotHere);
            assert!(runs_elsewhere(supervisor_lock(&dir), leader_read()), "a named leader not here is elsewhere");
            assert!(await_our_container_to_settle(None, Duration::ZERO), "and not ours in transit");
            supervisor.unlock().unwrap();
            return;
        }
        let dir = std::env::temp_dir().join(format!("teams-lite-poweroff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "intune_embedded::tests::a_boot_waits_for_its_own_poweroff_before_it_reads_the_display", "--nocapture"])
            .env("TEAMS_LITE_POWEROFF_TEST", "1")
            .env("XDG_DATA_HOME", &dir)
            .status()
            .unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(status.success(), "the poweroff wait failed in its child process");
    }

    // The crate's `backend::stop` answers Ok after its twenty-second wait whether or not the leader
    // went, so the stop helper's exit 0 ("nothing running at the end") is decided by the leader
    // recorded before the stop, never by that Ok.
    #[test]
    fn the_stop_answers_by_the_leader_it_stopped_not_by_the_crates_ok() {
        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "pub fn stop_main() -> i32 {");
        let running = at(body, "backend::is_running(&config)");
        let recorded = at(body, "let leader = live_leader_state();");
        let stop = at(body, "backend::stop(&config)");
        let checked = at(body, "Some(state) if crate::intune::leader_is_live_here(&state) =>");
        assert!(running < recorded && recorded < stop && stop < checked);
        let alive = &body[checked..];
        let one = at(alive, "1\n");
        let stopped = at(alive, "say(\"stopped\");");
        assert!(one < stopped, "a leader still alive is exit 1, before anything says it stopped");
        assert!(!body.contains("Ok(()) => {\n            say(\"stopped\");"), "the crate's Ok alone is no answer");
    }

    // A container running from this volume in ANOTHER namespace is refused, and that refusal comes
    // before anything that could reach the crate's `running_leader` — which would delete the other
    // container's state as stale.
    #[test]
    fn a_container_running_from_another_namespace_is_never_touched() {
        use SupervisorLock::*;
        assert!(
            runs_elsewhere(Held, LeaderRead::NotHere),
            "a supervisor whose state names a leader not live here is another namespace's"
        );
        assert!(!runs_elsewhere(Held, LeaderRead::Here), "our own container");
        // A held lock with NO state is ours mid-start or mid-poweroff: the crate clears the state
        // after its own twenty-second wait whether or not the leader went. Refused, it told the
        // operator to give the container a volume of its own — a fresh volume and a re-enrollment.
        assert!(!runs_elsewhere(Held, LeaderRead::Unnamed), "ours in transit, never somebody else's");
        for lock in [Absent, Free, Unknown] {
            for leader in [LeaderRead::Unnamed, LeaderRead::Here, LeaderRead::NotHere] {
                assert!(!runs_elsewhere(lock, leader), "{lock:?}/{leader:?}: never refused on a guess");
            }
        }

        let code = code_of(include_str!("intune_embedded.rs"));
        assert!(!code.contains("SingletonLock"), "the supervisor's lock is read, never taken");
        let probe = body_of(&code, "fn supervisor_lock(dir: &Path) -> SupervisorLock {");
        assert!(probe.contains("File::open(") && probe.contains("try_lock_shared()"), "a read-only, shared probe");
        assert!(!probe.contains("File::create(") && !probe.contains("OpenOptions"), "never created or truncated");

        // In every helper body that reaches the crate, after the slot and before any crate call.
        let gate = "refuse_a_container_running_elsewhere(&say)";
        let boot = body_of(&code, "pub fn boot_main() -> i32 {");
        assert!(at(boot, "take_helper_slot(Helper::Boot)") < at(boot, gate) && at(boot, gate) < at(boot, "boot(&say)"));
        let stop = body_of(&code, "pub fn stop_main() -> i32 {");
        assert!(at(stop, "take_slot(SlotHolder::Stop") < at(stop, gate) && at(stop, gate) < at(stop, "backend::is_running("));
        let portal = body_of(&code, "pub fn portal_main() -> i32 {");
        assert!(at(portal, "take_helper_slot(Helper::Portal)") < at(portal, gate) && at(portal, gate) < at(portal, "backend::is_running("));
        let intune = include_str!("intune.rs");
        let intune = intune.split("#[cfg(test)]").next().unwrap();
        let repair = intune.split("fn repair_main() -> i32 {").nth(1).expect("repair_main");
        assert!(
            at(repair, "take_helper_slot(") < at(repair, "refuse_a_container_running_elsewhere(&say)")
                && at(repair, "refuse_a_container_running_elsewhere(&say)") < at(repair, "restart_container()"),
            "the repair helper refuses another namespace's container before its restart"
        );

        // The probe itself, on a throwaway directory: absent, free, then held by a lock of this
        // test's own (an exclusive flock on another open file, as the supervisor's is).
        let dir = std::env::temp_dir().join(format!("teams-lite-supervisor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(supervisor_lock(&dir), Absent);
        assert!(!dir.join(SUPERVISOR_LOCK_FILE).exists(), "asking creates nothing");
        let supervisor = File::create(dir.join(SUPERVISOR_LOCK_FILE)).unwrap();
        assert_eq!(supervisor_lock(&dir), Free);
        supervisor.lock().unwrap();
        assert_eq!(supervisor_lock(&dir), Held);
        supervisor.unlock().unwrap();
        assert_eq!(supervisor_lock(&dir), Free, "the probe took nothing from the holder");
        std::fs::remove_dir_all(&dir).ok();
    }

    // The import is bracketed by a durable marker, and the marker OUTRANKS a registration: the
    // registration the restore writes half-way through is not one that works.
    #[test]
    fn an_interrupted_import_is_retried_rather_than_kept_as_a_registration() {
        use ImportStep::*;
        assert_eq!(import_step(None, false, false), Nothing);
        assert_eq!(import_step(None, true, false), Nothing);
        assert_eq!(import_step(Some(true), false, false), Import);
        assert_eq!(import_step(Some(true), true, false), KeepRegistration, "never over one that works");
        assert_eq!(import_step(Some(true), true, true), Retry, "the import's own partial write is not one");
        assert_eq!(import_step(Some(true), false, true), Retry);
        assert_eq!(import_step(Some(false), false, false), NotAFile);
        assert_eq!(import_step(Some(false), true, true), NotAFile);
        assert_eq!(import_step(None, true, true), PendingWithoutBackup, "said loudly, never silently kept");

        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "fn import_if_due(say: &dyn Fn(&str)) -> Result<()> {");
        let mark = at(body, "mark_import_pending(&dir, &backup)?");
        let restore = at(body, "intune_container::ops::restore(Some(&backup))");
        let clear = at(body, "clear_import_pending(&dir)");
        assert!(mark < restore && restore < clear, "the marker is written before the restore and removed after it");
        let marker = body_of(&code, "fn mark_import_pending(dir: &Path, backup: &Path) -> Result<()> {");
        assert!(marker.contains("sync_all()") && marker.contains("sync_dir(dir)"), "the marker is fsynced, entry included");

        let dir = std::env::temp_dir().join(format!("teams-lite-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!import_was_interrupted(&dir));
        mark_import_pending(&dir, Path::new("/run/teams-lite/intune-import/enrollment-backup.tar.gz")).unwrap();
        assert!(import_was_interrupted(&dir), "a marker on disk is an import not finished");
        clear_import_pending(&dir).unwrap();
        assert!(!import_was_interrupted(&dir));
        clear_import_pending(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    // Before a container that is NOT running is started, a listener on its display in this
    // network namespace is somebody else's: refused, naming the shared namespace and both ways out.
    #[test]
    fn a_boot_beside_another_intune_display_is_refused() {
        // The shape of /proc/net/unix (the table xwindow's own test reads).
        let table = "Num       RefCount Protocol Flags    Type St Inode Path\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 21512 @/tmp/.X11-unix/X99\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 19022 /tmp/.X11-unix/X0\n\
            0000000000000000: 00000003 00000000 00000000 0001 03 33572 @/tmp/.X11-unix/X98\n";
        assert!(unix_table_lists_listener(table, "/tmp/.X11-unix/X99"));
        assert!(!unix_table_lists_listener(table, "/tmp/.X11-unix/X98"), "an accepted connection is no listener");
        assert!(!unix_table_lists_listener(table, "/tmp/.X11-unix/X0"), "a file socket is not this namespace's");
        assert!(!unix_table_lists_listener(table, "/tmp/.X11-unix/X9"));

        let why = display_refusal(":99", "/tmp/.X11-unix/X99");
        for needle in ["@/tmp/.X11-unix/X99", "--network host", "bridge", "TEAMS_LITE_INTUNE_MODE=host", "compose.host-broker.yaml"] {
            assert!(why.contains(needle), "the refusal names {needle}: {why}");
        }

        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "fn boot(say: &dyn Fn(&str)) -> std::result::Result<(), BootEnd> {");
        let check = at(body, "display_taken_by_another_container()");
        assert!(check < at(body, "crate::intune::boot_headless("), "asked before the start");
        assert!(body[check..].starts_with("display_taken_by_another_container() {\n            return Err(BootEnd::Refused(why));"));
        let main = body_of(&code, "pub fn boot_main() -> i32 {");
        assert!(main.contains("Err(BootEnd::Refused(why)) => {") && main.contains("2\n"), "a refusal is exit 2");
    }

    // The stop takes the helper SLOT before the lifecycle lock, within one budget, so a boot
    // queued behind it cannot start the container a moment before the pod's SIGKILL.
    #[test]
    fn the_stop_takes_the_slot_before_the_lifecycle_lock() {
        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "pub fn stop_main() -> i32 {");
        let slot = at(body, "take_slot(SlotHolder::Stop, STOP_LOCK_WAIT, &ask_a_portal_to_close)");
        let lock = at(body, "lifecycle_lock_within(left)");
        let running = at(body, "backend::is_running(&config)");
        assert!(slot < lock && lock < running);
        assert!(body.contains("return 1;"), "a slot not had in time is exit 1");
        // A portal is asked to close; a boot or a repair never is.
        assert!(body.contains("let Some((SlotHolder::Portal, pid)) = holder else { return };"));
        // The slot is a try-lock loop, never a blocking flock this process could take twice.
        let take = body_of(&code, "fn take_slot(\n    holder: SlotHolder,\n    wait: Duration,\n    on_held: &dyn Fn(Option<(SlotHolder, u32)>),\n) -> Result<Option<HelperSlot>> {");
        assert!(take.contains("file.try_lock()") && !take.contains("file.lock()"));
        // A boot that loses the slot says so in its exit code, not as success.
        let boot = body_of(&code, "pub fn boot_main() -> i32 {");
        assert!(boot.contains("return BOOT_SLOT_TAKEN;"));
        assert_ne!(BOOT_SLOT_TAKEN, 0);
    }

    #[test]
    fn holders_are_named_by_their_own_subcommands() {
        for helper in [Helper::Boot, Helper::Repair, Helper::Portal] {
            let holder = SlotHolder::from(helper);
            assert_eq!(SlotHolder::from_subcommand(helper.subcommand()), Some(holder));
            assert_eq!(holder.helper(), Some(helper));
            assert_eq!(holder.tag(), helper.tag());
            assert_eq!(serde_json::to_value(helper).unwrap(), serde_json::json!(helper.tag()));
            assert_eq!(serde_json::to_value(holder).unwrap(), serde_json::json!(helper.tag()));
        }
        assert_eq!(SlotHolder::from_subcommand("__rootless-supervise"), None);
        // The stop holds the slot, and is no HELPER: the backend never spawns one, and a page names
        // none.
        assert_eq!(SlotHolder::from_subcommand(STOP_SUBCOMMAND), Some(SlotHolder::Stop));
        assert_eq!(SlotHolder::Stop.helper(), None);
        assert_eq!(SlotHolder::Stop.tag(), "stop");
        // A state written by an older build (the field has always been `helper`) still reads.
        let old: HelperState = serde_json::from_str(r#"{"helper":"boot","pid":7,"started_ms":1}"#).unwrap();
        assert_eq!(old.helper, SlotHolder::Boot);
    }

    #[test]
    fn an_enrollment_is_offered_only_where_one_can_happen() {
        assert!(can_enroll(true, true, true, false));
        assert!(!can_enroll(false, true, true, false), "never from a read-only backend");
        assert!(!can_enroll(true, false, true, false), "the portal runs in the container");
        assert!(!can_enroll(true, true, false, false), "never while a helper has it in hand");
        assert!(!can_enroll(true, true, true, true), "never over a registration that works");
    }

    // The slot itself, on a throwaway data dir: free, then held by a helper, then free again, then
    // held by the STOP — which is no helper, and still the slot. Run in a child process, because
    // the crate reads XDG_DATA_HOME from the environment and a test that set it here would race
    // every other test in this binary.
    #[test]
    fn the_slot_is_held_for_a_helpers_life_and_read_without_creating_anything() {
        if std::env::var_os("TEAMS_LITE_SLOT_TEST").is_some() {
            assert_eq!(helper_running(), None, "a volume no helper touched has no slot file");
            assert!(!slot_held());
            assert!(!intune_data_dir().unwrap().join(HELPER_LOCK_FILE).exists(), "asking creates nothing");
            let slot = take_helper_slot(Helper::Boot).unwrap().expect("a free slot is taken");
            // The state names this process, whose own argv[1] is not a helper's, so the bounded
            // re-read falls back on the file's own word.
            assert_eq!(helper_running(), Some(Helper::Boot));
            assert!(take_helper_slot(Helper::Repair).unwrap().is_none(), "one helper at a time");
            // The stop's bounded wait gives up at its bound, never blocking on its own process.
            let asked = std::time::Instant::now();
            assert!(take_slot(SlotHolder::Stop, Duration::from_millis(300), &|_| {}).unwrap().is_none());
            assert!(asked.elapsed() >= Duration::from_millis(300), "it waited its bound");
            drop(slot);
            assert_eq!(helper_running(), None, "a stale file under a free lock is nothing running");

            let stop = take_slot(SlotHolder::Stop, Duration::from_millis(300), &|_| {}).unwrap().expect("a free slot");
            assert_eq!(slot_holder(), Some(SlotHolder::Stop));
            assert!(slot_held(), "the stop holds the slot");
            assert_eq!(helper_running(), None, "and is no helper a page would name");
            assert!(!status(false).can_enroll, "nothing is enrolled while the container is being stopped");
            assert!(take_helper_slot(Helper::Boot).unwrap().is_none(), "a boot queued behind the stop leaves");
            drop(stop);
            assert!(!slot_held());
            return;
        }
        let dir = std::env::temp_dir().join(format!("teams-lite-slot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "intune_embedded::tests::the_slot_is_held_for_a_helpers_life_and_read_without_creating_anything", "--nocapture"])
            .env("TEAMS_LITE_SLOT_TEST", "1")
            .env("XDG_DATA_HOME", &dir)
            .status()
            .unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(status.success(), "the slot test failed in its child process");
    }

    // The watchdog's deadline moves both ways — later for the start after a long setup, and
    // sooner — and ends the process naming the step that overran. In child processes, because a
    // watchdog that fires ends the whole test binary.
    #[test]
    fn a_watchdogs_deadline_moves_both_ways() {
        match std::env::var("TEAMS_LITE_WATCHDOG_TEST").as_deref() {
            Ok("later") => {
                let watchdog = arm_watchdog("test", "the first step", Duration::from_millis(300));
                watchdog.rearm("the second step", Duration::from_secs(60));
                std::thread::sleep(Duration::from_millis(900));
                return;
            }
            Ok("sooner") => {
                let watchdog = arm_watchdog("test", "the first step", Duration::from_secs(60));
                watchdog.rearm("the second step", Duration::from_millis(200));
                std::thread::sleep(Duration::from_secs(10));
                panic!("the watchdog did not fire at its moved deadline");
            }
            _ => {}
        }
        let run = |case: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "intune_embedded::tests::a_watchdogs_deadline_moves_both_ways", "--nocapture"])
                .env("TEAMS_LITE_WATCHDOG_TEST", case)
                .output()
                .unwrap()
        };
        let later = run("later");
        assert!(later.status.success(), "a deadline moved later does not fire at the first one");
        let sooner = run("sooner");
        assert_eq!(sooner.status.code(), Some(1), "a deadline moved sooner fires, and exits 1");
        let said = String::from_utf8_lossy(&sooner.stderr);
        assert!(said.contains("teams-lite(test): the second step did not finish"), "{said}");
    }

    // The portal helper ANSWERS a stop request: the signal sets a flag the loops read, and the
    // process lives on to close the portal. In a child process, because a test that went wrong
    // would deliver SIGTERM's default death to the whole test binary.
    #[test]
    fn the_portal_helper_answers_a_stop_request() {
        if std::env::var_os("TEAMS_LITE_SIGNAL_TEST").is_some() {
            listen_for_a_stop_request().expect("a handler is installed");
            assert!(!stop_requested());
            assert_eq!(send_signal(std::process::id() as c_int, SIGTERM), 0);
            let until = Instant::now() + Duration::from_secs(5);
            while !stop_requested() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(stop_requested(), "the handler noted the request");
            let paused = Instant::now();
            pause_unless_stopped(Duration::from_secs(10));
            assert!(paused.elapsed() < Duration::from_secs(1), "a pause ends at once once a stop is asked");
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "intune_embedded::tests::the_portal_helper_answers_a_stop_request", "--nocapture"])
            .env("TEAMS_LITE_SIGNAL_TEST", "1")
            .status()
            .unwrap();
        assert!(status.success(), "the stop request was not answered in its child process: {status:?}");

        // The request is read right after the launch and on every pass of both loops, and the
        // portal THIS helper closed at its deadline says so in its exit code.
        let code = code_of(include_str!("intune_embedded.rs"));
        let body = body_of(&code, "pub fn portal_main() -> i32 {");
        let listen = at(body, "listen_for_a_stop_request()");
        let slot = at(body, "take_helper_slot(Helper::Portal)");
        let open = at(body, "ops::portal_open_headless()");
        assert!(listen < slot && slot < open);
        let after_open = &body[open..];
        let appear = at(after_open, "let appear_by");
        let open_loop = at(after_open, "let close_by");
        let in_appear = &after_open[appear..open_loop];
        let in_open = &after_open[open_loop..];
        assert!(in_appear.contains("if stop_requested() {") && in_appear.contains("close_a_portal_on_its_way(&say)"));
        assert!(in_open.contains("if stop_requested() {") && in_open.contains("close_portal(&say)"));
        assert!(in_open.contains("code = PORTAL_TIMED_OUT;"));
        assert!(body[..open].contains("if stop_requested() {"), "a request before the launch opens nothing");
        assert_ne!(PORTAL_TIMED_OUT, 0, "the helper's own deadline is never read as the reader closing it");
    }

    // Only the portal helper may be asked to end early, and only while its pid still runs it.
    #[test]
    fn only_the_portal_helper_is_ever_signalled() {
        for helper in [Helper::Boot, Helper::Repair] {
            let err = HelperTerminator { helper, pid: Some(1) }.terminate().expect_err("refused");
            assert!(err.to_string().contains("only the portal helper"), "{err}");
        }
        // This test process is no portal helper: its pid is re-checked, and nothing is sent.
        let me = HelperTerminator { helper: Helper::Portal, pid: Some(std::process::id()) };
        assert!(!me.terminate().unwrap(), "a pid that does not run the portal helper is not signalled");
        assert!(!HelperTerminator { helper: Helper::Portal, pid: None }.terminate().unwrap());
        // A portal helper an earlier backend orphaned is asked through the very same re-check, by
        // the pid the slot named — and that pid is read only when it runs the portal helper.
        assert!(!ask_portal_helper_to_close(std::process::id()).unwrap(), "not signalled either");
        let code = code_of(include_str!("intune_embedded.rs"));
        let pid = body_of(&code, "pub fn portal_helper_pid() -> Option<u32> {");
        assert!(pid.contains("state.helper == SlotHolder::Portal && pid_runs(state.pid, SlotHolder::Portal)"));
        let ask = body_of(&code, "pub fn ask_portal_helper_to_close(pid: u32) -> Result<bool> {");
        assert!(ask.contains("HelperTerminator { helper: Helper::Portal, pid: Some(pid) }.terminate()"));
    }
}
