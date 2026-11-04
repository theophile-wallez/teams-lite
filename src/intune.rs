//! The Intune container, through the `intune-container` crate — never through a host command.
//!
//! On a containerized-Intune host the identity broker runs inside a rootless container that
//! the user's own `intune-container` project manages, and this module is the ONE place
//! teams-lite talks to it. Three questions, and each is now answered in process:
//!
//! - **Where is the broker's bus?** [`broker_bus`], read from the container's own runtime
//!   state on EVERY connection. It used to be resolved once by a shell wrapper and frozen into
//!   `DBUS_SESSION_BUS_ADDRESS` at exec — and that one fact is what an entire tier of machinery
//!   existed for: a `.path` unit restarting every backend when `rootless.json` changed, a
//!   health check comparing each backend's frozen address with the live one, a restart unit,
//!   and a wait loop in four places so the FIRST start would not freeze the wrong bus for good.
//!   A backend that asks per connection follows a container restart with no restart of its
//!   own, so all of that is gone.
//! - **Is the container's login keyring locked?** [`container_keyring`], one D-Bus
//!   get-property over that same bus — the cause itself, rather than a failed token call that
//!   a killed broker or a slow reply also looks like. It replaced `busctl`.
//! - **Repair it.** A locked keyring is unlocked by the container's own once-per-boot session
//!   setup, so the repair is a stop and a start — done by THIS binary calling the crate
//!   ([`restart_container`]), inside a transient systemd unit this backend asks the user's
//!   manager for over D-Bus ([`start_repair_unit`]). It replaced `systemctl` starting an
//!   installed unit whose `ExecStart=` was the `intune-container` binary.
//!
//! TWO MODES, and this module is still the ONE place that decides
//! ([`crate::intune_embedded::Mode`], declared by `TEAMS_LITE_INTUNE_MODE`). In `host` mode —
//! unset, and every install outside teams-lite's own image — the container is the USER'S and
//! everything above holds as written. In `embedded` mode the container is THIS POD'S: the image
//! boots its own, and every lifecycle act (the boot, the stop, the repair, the enrollment's
//! portal) is a HELPER — this binary re-executed in a session of its own, spawned by
//! `intune_embedded::spawn_helper` — because there is no systemd manager to ask for a unit, and
//! the reasons a repair was a unit (it must outlive the backend, and its environment must not be
//! the backend's) hold for a helper just the same. [`start_repair`] is the one entry point the
//! backend calls for either. The spawn lives in that module, so this one keeps its promise —
//! pinned by its own test — that it never starts a process.
//!
//! WHAT THE CRATE IS AND IS NOT ASKED. It is asked for its runtime state
//! (`runtime::load_runtime_state`, a pure read), for whether that state is still live
//! (`runtime::state_is_live`, as pure — the leader is a container init, and the very process the
//! state recorded), and — inside the repair (and, in embedded mode, the boot helper) only — for
//! `backend::stop` and `backend::start`. Three things it offers are refused on purpose, and
//! each would break something real:
//!
//! - **`runtime::running_leader()`** DELETES a stale `rootless.json` as a side effect. This
//!   module reads on every token call, from read-only backends included, and a read that
//!   writes another tool's state is not a read.
//! - **`ops::start()`** rewrites the browser's native-messaging wrapper so it runs
//!   `exe::stable_exe()` — which, called from here, is THIS binary. Every browser SSO request
//!   would then start a teams-lite backend under the browser's pipes. `backend::start` is the
//!   boot without that half; the wrapper `intune-container start` wrote stays as it was.
//! - **crates.io 0.2.3.** It re-pulls the rootfs on every start and does not persist the
//!   device registration across one, so a repair through it would unenroll the machine. The
//!   dependency is pinned to the commit that fixed both (see Cargo.toml).
//!
//! IN TEAMS-LITE'S OWN CONTAINER IMAGE, in HOST mode, the first two answers hold unchanged and
//! the third does not ([`CONTAINER_IMAGE_ENV`]). With the host's pid namespace and a read-only
//! view of the intune-container state (packaging/docker/compose.host-broker.yaml),
//! [`broker_bus`] reads the same file and opens the same `/proc/<leader>/root/…` socket —
//! measured from an image: `AUTH EXTERNAL` as uid 0 answered OK. The repair is the host systemd
//! running THIS binary, and its path is the image's, so that image offers none and says why
//! ([`repair_blocker`]). In EMBEDDED mode — the image's default — all three answers hold again:
//! the container, its state and this binary are all inside the pod, so the bus is followed the
//! same way and the repair is this pod's own helper.
//!
//! WHY THIS BINARY MUST ROUTE THE CRATE'S OWN SUBCOMMANDS. `backend::start` boots the
//! container from a detached supervisor it spawns by re-executing `exe::stable_exe()` with a
//! hidden `__rootless-supervise` argument — the crate's own binary routes that in its `main`.
//! Called from here, the executable is THIS binary, so `server`'s `main` must hand those
//! arguments to the crate before it does anything else ([`dispatch_reexec`]): unrouted, the
//! supervisor would start a second teams-lite backend, which dies on the port, and no
//! container boots. And it must do so before any tokio runtime exists, because the crate
//! unshares a user namespace in a forked child and builds runtimes of its own.

use std::ffi::OsString;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt;
use zbus::zvariant::{OwnedObjectPath, Value};

/// The broker's bus inside the container, relative to the container's root. The crate keeps
/// the same path in a private constant (`backend::BROKER_BUS`) for its in-container bridges;
/// from the host it is reached through `/proc/<leader>/root/`, which needs no `setns`: the
/// container's root is a directory of the host user's own, and its dbus-daemon accepts the
/// uid-0 handshake our user namespace mapping gives us (see `auth::connect_bus`).
const CONTAINER_BUS: &str = "run/user/0/bus";

/// An operator override for a topology this module does not know — the one escape hatch
/// `bin/broker-env.sh` offered, kept under the same name so a setup that relied on it keeps
/// working. A full D-Bus address (`unix:path=…`).
pub const BROKER_BUS_ENV: &str = "TEAMS_LITE_BROKER_BUS";

/// The transient unit a repair runs in. One name for the whole machine, which is what makes a
/// repair single-flight across every backend on it: a second `StartTransientUnit` while one
/// runs is refused by systemd itself (`UnitExists`).
///
/// DELIBERATELY NOT `teams-lite-broker-repair.service`, the installed unit this replaced. A
/// machine that has not re-staged since still has that file, and a transient unit cannot take
/// the name of a loaded one — the start would be refused with `UnitExists`, which this module
/// reads as "a repair is already running", for ever. A name of its own cannot collide.
pub const REPAIR_UNIT: &str = "teams-lite-intune-repair.service";

/// The INSTALLED repair unit this replaced, which a machine staged before the change still has
/// — and may be running, since the migration deliberately never stops a repair in progress.
/// A second repair started beside it would wait on the container's lifecycle lock and then
/// restart a container the first one had just repaired, so it counts as one running.
pub const LEGACY_REPAIR_UNIT: &str = "teams-lite-broker-repair.service";

/// The hidden argument that makes `server` the repair rather than a backend. Spelled like the
/// crate's own re-exec targets: double-underscored, so nobody types it by accident, and named
/// for what it does, so the automation guard can refuse it by name.
///
/// IT IS ALSO THE MARKER three shell gates read out of a binary (`grep -qa`): the service
/// script refuses to write a wrapper-less unit in front of a staged backend without it, and the
/// launcher wrapper and install.sh refuse to run one — a build that predates the in-process
/// broker lookup cannot find the broker with no wrapper exporting its bus. Renaming it breaks
/// them; `update::tests::every_shell_gate_reads_the_backends_own_hidden_argument` says so.
pub const REPAIR_SUBCOMMAND: &str = "__teams-lite-repair-broker";

/// The crate's own re-exec targets (`intune-container`'s `src/main.rs`). Their spelling is
/// the crate's contract with whatever binary `exe::stable_exe()` names, so it is not ours to
/// choose — only to route.
pub const SUPERVISE_SUBCOMMAND: &str = "__rootless-supervise";
pub const EXEC_SUBCOMMAND: &str = "__rootless-exec";

/// Set by teams-lite's own container image (`ENV` in packaging/docker/Dockerfile), and by
/// nothing a person is meant to type. DECLARED rather than detected — the shape
/// `TEAMS_LITE_LAUNCHER` and `TEAMS_LITE_RESTART_ON_EXIT` already have — because what it
/// decides is a fact about the PACKAGING that no file inside the process can prove: whether
/// the path of this binary exists on the host whose systemd a repair would ask to run it.
///
/// In the image it does not. [`start_repair_unit`] hands the user's manager `own_executable()`,
/// which inside the image is the backend the launcher extracted into the IMAGE's own cache — a
/// path the host has never held — so the unit would fail at exec, or run whatever else the host
/// keeps under that name.
/// The image therefore offers no repair and SAYS so ([`repair_blocker`]); the host's own
/// intune-container, or a teams-lite installed on the host, is what restarts the container.
pub const CONTAINER_IMAGE_ENV: &str = "TEAMS_LITE_CONTAINER_IMAGE";

/// What a reader is told when a restart WOULD repair sign-in and this backend may not make one
/// because it runs in the image. Two remedies, because both are real: the user's own CLI on the
/// host, and a host install's health check, which repairs a locked keyring with nobody asking —
/// the keyring is the container's, so one repair on the machine mends every install on it.
pub const IMAGE_REPAIR_BLOCKER: &str = "teams-lite is running in its container image, which \
     cannot restart the Intune container on the host. Restart it there (`intune-container stop \
     && intune-container start`), or keep a teams-lite installed on the host: it repairs a locked \
     keyring on its own.";

/// The store setting holding when this MACHINE last started a repair (epoch ms). Shared by
/// every backend on one store, so the automatic floor counts every trigger on the machine —
/// the in-process floor it replaced was reset by every backend restart, and every repair
/// caused one.
pub const SETTING_REPAIR_STARTED_MS: &str = "broker_repair_started_ms";

/// How long a repair's own WORK may run. A stop waits up to 20 s for the container's systemd to
/// power off, a start up to 20 s for the supervisor to publish its leader, and the in-container
/// session setup that unlocks the keyring then waits on its own (boot, the user bus, the
/// keyring, the display) — about two and a half minutes at its worst. Five minutes is the
/// bound the installed unit carried, and a repair that needs more is one a person should
/// look at.
///
/// That arithmetic holds because a repair never UPDATES the image ([`restart_container`] boots
/// with `auto_update` off). With it on — the crate's default, and this machine's setting — a
/// start whose registry tag has moved deletes the rootfs and pulls the whole image again, over
/// a registry call with no timeout, AFTER the stop; a repair killed by this bound in the middle
/// of that would leave no container at all, and a half-extracted tree the next start adopts.
pub(crate) const REPAIR_WORK: Duration = Duration::from_secs(300);

/// How long a repair may run: its work ([`REPAIR_WORK`]) plus the wait for the container it
/// stopped to have finished powering off ([`crate::intune_embedded::POWEROFF_WAIT`]) — which the
/// crate's own twenty-second stop does not wait out, and which [`restart_container`] does before
/// it starts anything. It is the embedded repair helper's watchdog, the host unit's
/// `TimeoutStartUSec`, and what every follower of a repair is bounded by; a bound that left the
/// poweroff wait out would kill a repair in the middle of the one step that keeps it honest.
pub const REPAIR_TIMEOUT: Duration =
    Duration::from_secs(REPAIR_WORK.as_secs() + crate::intune_embedded::POWEROFF_WAIT.as_secs());

/// The journal identifier a repair logs under, which is what `journalctl --user -t` finds it
/// by. The installed unit used the same one.
const REPAIR_LOG_ID: &str = "teams-lite-broker-repair";

/// Where a repair's own account of itself can be read, in the words a journal line names it.
/// A host repair is a unit of the user's manager and logs to their journal; an embedded one is a
/// helper whose stderr IS the container's log — there is no journal in a pod, and naming
/// `journalctl` there sends the reader to a command that answers nothing.
pub fn repair_log_hint() -> &'static str {
    if crate::intune_embedded::embedded() {
        "this container's own log (docker logs / kubectl logs)"
    } else {
        "journalctl --user -t teams-lite-broker-repair"
    }
}

const SECRETS_NAME: &str = "org.freedesktop.secrets";
const SECRETS_PATH: &str = "/org/freedesktop/secrets/collection/login";
const SECRETS_IFACE: &str = "org.freedesktop.Secret.Collection";

const SYSTEMD_NAME: &str = "org.freedesktop.systemd1";
const SYSTEMD_PATH: &str = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER: &str = "org.freedesktop.systemd1.Manager";

// ---- where the broker's bus is ------------------------------------------------------------

/// Where the identity broker's D-Bus is, decided at the moment it is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerBus {
    /// [`BROKER_BUS_ENV`]: an operator named it.
    Override(String),
    /// The `intune-container` container is running and its bus socket is there.
    Container { leader: i32, socket: PathBuf },
    /// No container: the bus this process inherited, which is where a classic Intune install
    /// puts the broker.
    Session,
}

impl BrokerBus {
    /// The address to dial.
    pub fn address(&self) -> Result<zbus::Address> {
        match self {
            Self::Override(address) => zbus::Address::try_from(address.as_str())
                .with_context(|| format!("parse {BROKER_BUS_ENV}={address}")),
            Self::Container { socket, .. } => {
                zbus::Address::try_from(format!("unix:path={}", socket.display()).as_str())
                    .context("build the container bus address")
            }
            Self::Session => zbus::Address::session().context("resolve the session bus address"),
        }
    }

    /// Is this the containerized topology — the one a keyring check and a repair are about?
    /// An override counts: the operator named the broker's bus, and the keyring is beside it.
    pub fn has_container_keyring(&self) -> bool {
        !matches!(self, Self::Session)
    }

    /// One line for the journal.
    pub fn describe(&self) -> String {
        match self {
            Self::Override(address) => format!("{address} (from {BROKER_BUS_ENV})"),
            Self::Container { leader, socket } => {
                format!("the Intune container's bus, {} (leader {leader})", socket.display())
            }
            Self::Session => "this process's own session bus (no Intune container)".to_string(),
        }
    }
}

/// Where the broker's bus is NOW.
///
/// Read on every connection, and that is the whole point: the answer moves every time the
/// container restarts (its leader pid is in the path), and a backend that asked once kept
/// dialling a socket that no longer existed — up, healthy-looking, and permanently signed out.
///
/// The order: an operator override, then a running `intune-container` container, then the
/// inherited session bus. The container wins over the inherited bus on purpose — an older
/// launcher wrapper still exports a FROZEN container address into the environment, and that
/// is exactly the address that goes stale. A classic-Intune host has no container state, so
/// it falls through to the session bus it always used.
pub fn broker_bus() -> BrokerBus {
    let bus = choose_broker_bus(
        std::env::var(BROKER_BUS_ENV).ok(),
        running_container(),
    );
    note_choice(&bus);
    bus
}

/// The choice itself, with its two inputs handed in so the precedence is tested without a
/// container to read.
fn choose_broker_bus(override_address: Option<String>, container: Option<(i32, PathBuf)>) -> BrokerBus {
    if let Some(address) = override_address.filter(|a| !a.trim().is_empty()) {
        return BrokerBus::Override(address);
    }
    match container {
        Some((leader, socket)) => BrokerBus::Container { leader, socket },
        None => BrokerBus::Session,
    }
}

/// The running container's leader and the bus socket inside it, or `None`.
///
/// Three checks, each against a way the answer has been wrong:
/// - **the state is READ, never cleaned** — `load_runtime_state`, not `running_leader`, which
///   deletes a stale file (see the module header);
/// - **the state is LIVE and its leader is a container init** — `runtime::state_is_live` (pure:
///   the leader is PID 1 of a nested pid namespace, and, where the state recorded one, the very
///   process that was started), plus this module's own check that its pid namespace is not
///   ours. The second is kept beside the first rather than dropped: it was the rule before the
///   crate had one, and in a pod the pid namespace starts again at 1 on every restart while the
///   saved state survives on a volume, which is exactly the recycled pid both exist to refuse;
/// - **the socket is there** — a container that is booting has a leader before its user bus.
///
/// A state file torn mid-write (the crate writes it in place) reads as an error and therefore
/// as "no container" for this one call, which costs one unreachable broker call and is retried
/// by whoever asked.
fn running_container() -> Option<(i32, PathBuf)> {
    let leader = container_leader()?;
    let socket = container_bus_socket(leader);
    is_socket(&socket).then_some((leader, socket))
}

/// The running container's LEADER — the first two checks of [`running_container`], without the
/// third: a live leader whose broker's bus may not be there (yet, or ever). A pure read, like
/// everything here.
///
/// Told apart from [`container_is_up`] because the two halves of "up" fail differently: a leader
/// with no bus is a container that booted and never set its session up — booting it again is a
/// no-op on it, and only a stop and a start mends it (`intune_embedded::boot_main`) — while no
/// leader at all is a container to start. It is also what says a container is OURS: a leader live
/// in this namespace is one no other container or pod on the volume could have
/// (`intune_embedded::refuse_a_container_running_elsewhere`).
pub fn container_leader() -> Option<i32> {
    let state = intune_container::runtime::load_runtime_state().ok().flatten()?;
    leader_is_live_here(&state).then_some(state.leader)
}

/// Does `state` name a leader that is live, and a container init, in THIS namespace? The two
/// checks [`container_leader`] makes, on a state the caller already holds — so a caller that
/// has to tell "no state at all" from "a state naming a leader that is not ours" reads the file
/// once (`intune_embedded::runs_elsewhere`), and one that recorded a state before a stop can
/// ask afterwards whether THAT process has gone (`intune_embedded::leader_exited_within`) — the
/// crate's stop clears the file whether or not it did, so it cannot be read again to say. Pure.
pub fn leader_is_live_here(state: &intune_container::runtime::RuntimeState) -> bool {
    intune_container::runtime::state_is_live(state) && is_container_init(state.leader)
}

/// Is the Intune container up — a live leader AND its broker's bus? A pure read, for a status
/// built on every greeting (`intune_embedded::status`): no state is cleaned, nothing is asked.
pub fn container_is_up() -> bool {
    running_container().is_some()
}

/// The host-side path of the broker's bus inside the container led by `leader`.
fn container_bus_socket(leader: i32) -> PathBuf {
    Path::new("/proc").join(leader.to_string()).join("root").join(CONTAINER_BUS)
}

/// Is `pid` in a different pid namespace from this process — that is, a container's init
/// rather than a process of our own that happens to carry a recycled pid?
fn is_container_init(pid: i32) -> bool {
    let ours = std::fs::read_link("/proc/self/ns/pid").ok();
    let theirs = std::fs::read_link(format!("/proc/{pid}/ns/pid")).ok();
    match (ours, theirs) {
        (Some(ours), Some(theirs)) => ours != theirs,
        // Unreadable means "not ours to read", which a container init of our own uid never is.
        _ => false,
    }
}

fn is_socket(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket())
}

/// Say where the broker's bus is, once per CHANGE. A line per token call would be thousands a
/// day; a line per move is the one fact a reader of the journal needs when sign-in breaks.
fn note_choice(bus: &BrokerBus) {
    static LAST: std::sync::Mutex<Option<BrokerBus>> = std::sync::Mutex::new(None);
    let Ok(mut last) = LAST.lock() else { return };
    if choice_changed(last.as_ref(), bus) {
        eprintln!("[broker] identity broker bus: {}", bus.describe());
        *last = Some(bus.clone());
    }
}

/// Is `next` news against what was said last? Split out so "once per CHANGE" is tested.
fn choice_changed(last: Option<&BrokerBus>, next: &BrokerBus) -> bool {
    last != Some(next)
}

// ---- the keyring ---------------------------------------------------------------------------

/// What the container's login keyring says, or why it could not be asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringCheck {
    Locked,
    Unlocked,
    /// intune-container is not set up here — a classic-Intune host, or none at all. There is no
    /// container keyring, and the host's own keyring is nothing a container restart could change.
    NoContainer,
    /// intune-container IS set up, but no running container was found: it is stopped, still
    /// booting, or in the middle of a repair. Told apart from [`Self::NoContainer`] because the
    /// sentence differs and so does the next move — and a repair's own stop produces exactly
    /// this state in every broker call that lands during it.
    NotRunning,
    /// The bus or the secret service did not answer. NOT "locked": a repair must never fire
    /// on a guess.
    Unknown(String),
}

impl KeyringCheck {
    pub fn describe(&self) -> String {
        match self {
            Self::Locked => "the container's login keyring is locked".to_string(),
            Self::Unlocked => "the container's login keyring is unlocked".to_string(),
            Self::NoContainer => "intune-container is not set up on this machine".to_string(),
            Self::NotRunning => {
                "the Intune container is not running (stopped, starting up, or being repaired)"
                    .to_string()
            }
            Self::Unknown(why) => format!("the container's keyring could not be read ({why})"),
        }
    }
}

/// Is the login keyring locked, on an open connection to the broker's bus?
///
/// `Some(true)`/`Some(false)` when the secret service answers, `None` when it cannot be told —
/// no service, an older interface, a property that would not decode. `None` is never "locked".
pub async fn keyring_locked(conn: &zbus::Connection) -> Option<bool> {
    let proxy = zbus::Proxy::new(conn, SECRETS_NAME, SECRETS_PATH, SECRETS_IFACE)
        .await
        .ok()?;
    proxy.get_property::<bool>("Locked").await.ok()
}

/// Ask the running container's keyring whether it is locked.
pub async fn container_keyring() -> KeyringCheck {
    let bus = broker_bus();
    if !bus.has_container_keyring() {
        return if intune_container::ops::is_initialized() {
            KeyringCheck::NotRunning
        } else {
            KeyringCheck::NoContainer
        };
    }
    let conn = match crate::auth::connect_bus(&bus).await {
        Ok(conn) => conn,
        Err(e) => return KeyringCheck::Unknown(format!("{e:#}")),
    };
    match keyring_locked(&conn).await {
        Some(true) => KeyringCheck::Locked,
        Some(false) => KeyringCheck::Unlocked,
        None => KeyringCheck::Unknown("the secret service did not answer".to_string()),
    }
}

// ---- may this machine repair at all --------------------------------------------------------

/// Can this backend restart an Intune container?
///
/// Never from a read-only backend: a screenshot backend must not take the user's sign-in down.
/// And only where `intune-container` has been set up: a classic-Intune host has nothing to
/// restart, and offering the button there would report a failure the reader can do nothing
/// about. The installed unit answered the second half with `ConditionFileIsExecutable=` on the
/// binary; the crate's own "is it initialized" is the same question asked of the real thing.
///
/// And never from teams-lite's container image in HOST mode ([`CONTAINER_IMAGE_ENV`]): the
/// repair is THIS binary run by the host's systemd, and this binary's path exists only inside
/// the image. That image still sees the intune-container state — it is mounted there so the
/// broker's bus can be followed live — which is exactly why "is it initialized" alone would
/// offer the button.
///
/// In EMBEDDED mode the container is this pod's own and the repair is this pod's own helper, so
/// the image is no reason to refuse: a send-capable backend whose container has been set up may
/// repair it. Before the first boot has set it up there is nothing to restart, and the boot is
/// what comes next.
pub fn repair_available() -> bool {
    repair_may_run(
        crate::intune_embedded::embedded(),
        crate::read_only(),
        in_container_image(),
        intune_container::ops::is_initialized(),
    )
}

/// Why a repair is not offered where one WOULD be the cure, or `None` when there is nothing
/// worth saying. Only the host-mode image has a sentence: a read-only backend refuses by design
/// and says so where it is pressed, a host with no intune-container has no container to
/// restart, and an embedded container is this pod's to repair.
pub fn repair_blocker() -> Option<&'static str> {
    repair_is_blocked(
        crate::intune_embedded::embedded(),
        crate::read_only(),
        in_container_image(),
        intune_container::ops::is_initialized(),
    )
    .then_some(IMAGE_REPAIR_BLOCKER)
}

/// Is this process running from teams-lite's own container image?
pub fn in_container_image() -> bool {
    std::env::var_os(CONTAINER_IMAGE_ENV).is_some_and(|v| v == "1")
}

/// The decision of [`repair_available`], with its inputs handed in so it is tested without a
/// container, an image, a mode or a read-only process.
fn repair_may_run(embedded: bool, read_only: bool, in_image: bool, initialized: bool) -> bool {
    if embedded {
        !read_only && initialized
    } else {
        !read_only && !in_image && initialized
    }
}

/// The decision of [`repair_blocker`]: the host-mode image, which sees a container it may not
/// restart.
fn repair_is_blocked(embedded: bool, read_only: bool, in_image: bool, initialized: bool) -> bool {
    !embedded && !read_only && in_image && initialized
}

// ---- asking systemd for the repair ---------------------------------------------------------

/// What asking for a repair did.
pub enum RepairStart {
    /// The repair was started; [`RepairJob::finished`] says how it ended.
    Started(RepairJob),
    /// A repair is already running on this machine (the unit exists) — or, in embedded mode,
    /// something already holds the helper slot, which `intune_embedded::slot_holder` names: a
    /// repair, or other work (a boot, a portal, the stop) a request is answered as busy beside.
    AlreadyRunning,
}

/// A repair this process started, and what will say when it ends: systemd's own job signal for
/// a host repair, the helper's exit for an embedded one.
pub struct RepairJob(Job);

enum Job {
    // Boxed: a signal stream and a proxy are some hundreds of bytes, a helper's handle a few
    // words, and every `RepairStart` and follower carries whichever it is.
    Unit(Box<UnitJob>),
    Helper(crate::intune_embedded::HelperChild),
}

/// A repair systemd is running, and the signal stream that will say when it ends.
struct UnitJob {
    job: OwnedObjectPath,
    stream: zbus::proxy::SignalStream<'static>,
    // Held so the subscription — and the connection the stream reads from — outlives the job.
    _manager: zbus::Proxy<'static>,
}

impl RepairJob {
    /// Wait for the repair to end, and answer one word for how: `done` when the repair exited 0,
    /// and otherwise systemd's own word (`failed`, `timeout`, `canceled`) for a unit, or
    /// `failed (exit N)` for a helper — whose codes are `repair_main`'s.
    pub async fn finished(self) -> Result<String> {
        let bound = REPAIR_TIMEOUT + Duration::from_secs(30);
        let ended = match self.0 {
            Job::Unit(unit) => {
                // `_manager` is bound for the length of this arm, so the subscription and its
                // connection outlive the wait below.
                let UnitJob { job, mut stream, _manager } = *unit;
                tokio::time::timeout(bound, async move {
                    while let Some(signal) = stream.next().await {
                        let (_id, removed, _unit, result): (u32, OwnedObjectPath, String, String) =
                            signal.body().deserialize().context("read a JobRemoved signal")?;
                        if removed == job {
                            return Ok(result);
                        }
                    }
                    bail!("systemd's signal stream closed before the repair finished")
                })
                .await
            }
            Job::Helper(child) => {
                tokio::time::timeout(bound, async move {
                    Ok(match child.finished().await? {
                        0 => "done".to_string(),
                        code => format!("failed (exit {code})"),
                    })
                })
                .await
            }
        };
        ended.map_err(|_| anyhow!("the repair did not finish within {} s", bound.as_secs()))?
    }
}

/// Start the broker repair, in whichever shape this process's mode takes — the ONE entry point
/// the backend calls. Embedded: a repair HELPER (`intune_embedded::spawn_helper`), because there
/// is no manager in a pod to ask for a unit. Host: the transient unit ([`start_repair_unit`]).
pub async fn start_repair() -> Result<RepairStart> {
    use crate::intune_embedded::{self, Helper, HelperStart, Mode};
    match intune_embedded::mode()? {
        Mode::Embedded => Ok(match intune_embedded::spawn_helper(Helper::Repair)? {
            HelperStart::Started(child) => RepairStart::Started(RepairJob(Job::Helper(child))),
            HelperStart::AlreadyRunning => RepairStart::AlreadyRunning,
        }),
        Mode::Host => start_repair_unit().await,
    }
}

/// Start the repair as a transient unit of the user's systemd manager, over D-Bus.
///
/// A UNIT rather than a child of this process, for two reasons that are both about surviving:
/// the repair stops the container this backend is talking through, and a child in our cgroup
/// dies with us whenever this backend restarts (`KillMode=control-group`) — a repair cut
/// between its stop and its start leaves the user with no container at all. And its
/// environment is the manager's rather than ours, so neither the write token nor any address
/// this process inherited reaches the container's supervisor, whose environment its PID 1
/// inherits for the container's whole life.
///
/// TRANSIENT rather than installed, so every install shape gets the repair — the `teams`
/// command installs no unit files, and the installed unit was a second thing to keep in step
/// with this code. The two systemd gates that unit carried move with it: its `ExecCondition=`
/// is the repair's own first step (it refuses an unlocked keyring), and its rate limit is the
/// store claim the caller takes, which every backend on the machine shares.
///
/// The subscription is taken BEFORE the start, so a repair that ends quickly cannot end
/// between the job being created and anybody listening for it.
pub async fn start_repair_unit() -> Result<RepairStart> {
    let exe = own_executable()?;
    let host_bus = host_user_bus_address()?;
    let exe = exe.to_string_lossy().into_owned();
    let argv = [exe.as_str(), REPAIR_SUBCOMMAND];
    start_transient_oneshot(REPAIR_UNIT, &oneshot_properties(&argv, &host_bus), &host_bus).await
}

/// `StartTransientUnit` for a oneshot, subscribed to its end before it starts. Split from
/// [`start_repair_unit`] so the exact call the repair makes can be proved against the user's
/// real manager with a unit that runs `/bin/true` (see the ignored test below), which is the
/// only way to measure that systemd accepts these property types without restarting anybody's
/// container.
async fn start_transient_oneshot(
    name: &str,
    properties: &[(&'static str, Value<'static>)],
    host_bus: &str,
) -> Result<RepairStart> {
    let conn = zbus::connection::Builder::address(host_bus)?
        .build()
        .await
        .context("connect to the systemd user manager")?;
    let manager = zbus::Proxy::new(&conn, SYSTEMD_NAME, SYSTEMD_PATH, SYSTEMD_MANAGER)
        .await
        .context("reach the systemd user manager")?;
    let _: () = manager
        .call("Subscribe", &())
        .await
        .context("subscribe to the systemd user manager's job signals")?;
    let stream = manager
        .receive_signal("JobRemoved")
        .await
        .context("listen for the job ending")?;

    let aux: Vec<(&str, Vec<(&str, Value<'_>)>)> = Vec::new();
    let started: zbus::Result<OwnedObjectPath> = manager
        .call("StartTransientUnit", &(name, "fail", properties, aux))
        .await;
    match started {
        Ok(job) => Ok(RepairStart::Started(RepairJob(Job::Unit(Box::new(UnitJob { job, stream, _manager: manager }))))),
        Err(zbus::Error::MethodError(error, _, _))
            if error.as_str() == "org.freedesktop.systemd1.UnitExists" =>
        {
            Ok(RepairStart::AlreadyRunning)
        }
        Err(e) => Err(anyhow::Error::new(e)).context(format!("start {name}")),
    }
}

/// Is a broker repair running on this machine right now — ours, started by any backend here,
/// or the installed one an older build still runs?
///
/// Asked BEFORE anything else a repair checks, because everything else reads wrong while one
/// runs: the container is stopped or booting, so the keyring cannot be asked, and the floor
/// was claimed by whichever backend started it. Without this a press during a repair was told
/// "this machine runs no Intune container", and the other backend's pages never learnt a repair
/// was going on.
///
/// In embedded mode the question is wider, deliberately: ANYTHING holding the helper slot on this
/// pod's volume (a boot, a repair, an enrollment's portal, or the stop the pod runs on its way
/// out) has the container in hand, and a repair started beside one would wait on the lifecycle
/// lock and then restart a container somebody is booting, enrolling or powering off. The caller
/// asks `intune_embedded::slot_holder` for which one.
pub async fn repair_running() -> Result<bool> {
    if crate::intune_embedded::embedded() {
        return Ok(crate::intune_embedded::slot_held());
    }
    let manager = systemd_manager().await?;
    for unit in [REPAIR_UNIT, LEGACY_REPAIR_UNIT] {
        if unit_is_running(&manager, unit).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Wait until no repair is running on this machine — for one this process did NOT start
/// (another backend's, or one found running at boot), whose job signal it never subscribed
/// to. It cannot say how that repair ended; the backend that started it logs that.
pub async fn wait_for_repair_to_end() -> Result<()> {
    let bound = REPAIR_TIMEOUT + Duration::from_secs(30);
    if crate::intune_embedded::embedded() {
        return crate::intune_embedded::wait_for_helper_to_end(bound).await;
    }
    tokio::time::timeout(bound, async {
        while repair_running().await? {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        Ok(())
    })
    .await
    .map_err(|_| anyhow!("the repair did not end within {} s", bound.as_secs()))?
}

/// The user's systemd manager, on the user's own bus.
async fn systemd_manager() -> Result<zbus::Proxy<'static>> {
    let host_bus = host_user_bus_address()?;
    let conn = zbus::connection::Builder::address(host_bus.as_str())?
        .build()
        .await
        .context("connect to the systemd user manager")?;
    zbus::Proxy::new(&conn, SYSTEMD_NAME, SYSTEMD_PATH, SYSTEMD_MANAGER)
        .await
        .context("reach the systemd user manager")
}

/// Is `unit` loaded and doing something? A unit that is not loaded at all is the common answer
/// (a transient repair is unloaded the moment it ends), and a loaded one that is `inactive` or
/// `failed` is not running either — the legacy unit stays loaded on a machine whose target still
/// orders after it.
async fn unit_is_running(manager: &zbus::Proxy<'static>, unit: &str) -> Result<bool> {
    let path: zbus::Result<OwnedObjectPath> = manager.call("GetUnit", &(unit,)).await;
    let path = match path {
        Ok(path) => path,
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.freedesktop.systemd1.NoSuchUnit" =>
        {
            return Ok(false);
        }
        Err(e) => return Err(anyhow::Error::new(e).context(format!("look up {unit}"))),
    };
    let unit_proxy = zbus::Proxy::new(
        manager.connection(),
        SYSTEMD_NAME,
        path,
        "org.freedesktop.systemd1.Unit",
    )
    .await
    .with_context(|| format!("reach {unit}"))?;
    let state: String = unit_proxy
        .get_property("ActiveState")
        .await
        .with_context(|| format!("read {unit}'s state"))?;
    Ok(unit_state_is_running(&state))
}

/// The `ActiveState` values in which a repair is still under way.
fn unit_state_is_running(state: &str) -> bool {
    matches!(state, "active" | "activating" | "deactivating" | "reloading" | "refreshing")
}

/// The unit's properties, as `StartTransientUnit` takes them.
///
/// - **`Type=oneshot`**: the job ends when the repair does, which is what [`RepairJob`] waits on.
/// - **`ExecStart=<this binary> __teams-lite-repair-broker`** (the `argv` handed in): the crate
///   does the work, in a process of our own that is not a backend.
/// - **`Environment=DBUS_SESSION_BUS_ADDRESS=<the user bus>`**: the crate registers the
///   container's cgroup scope with `StartTransientUnit` on `Connection::session()`, and the
///   container's own bus ALSO owns `org.freedesktop.systemd1` — an inherited container address
///   would reach the container's inner systemd and fail in a way that reads like something
///   else. The installed unit pinned the same address for the same reason.
/// - **`TimeoutStartUSec`**: a oneshot has no start timeout by default, so a hung boot would
///   hold the unit — and with it every later repair, since the name is single-flight — for ever.
/// - **`CollectMode=inactive-or-failed`**: a failed repair is unloaded too, so it does not
///   keep the name and block the next one. The result is read off the job signal instead.
///
/// `KillMode=` is left at `control-group`, and that is a decision rather than a default. The
/// crate's supervisor is spawned into the repair's cgroup and outlives `backend::start`, so it
/// is killed when the repair ends — exactly what happened under the installed unit, whose
/// `intune-container start` left it in that unit's cgroup too. The container survives it: its
/// init runs in a scope of its own (`intune-<pid>.scope`), and the supervisor only waits on it.
/// Keeping the supervisor alive with `KillMode=process` would keep the unit loaded for the
/// container's whole life, and the single-flight name would then refuse every later repair as
/// one "already running".
fn oneshot_properties(argv: &[&str], host_bus: &str) -> Vec<(&'static str, Value<'static>)> {
    let program = argv.first().copied().unwrap_or_default().to_string();
    let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
    vec![
        (
            "Description",
            Value::from("Repair the Intune broker by restarting its container (teams-lite)".to_string()),
        ),
        ("Type", Value::from("oneshot".to_string())),
        ("ExecStart", Value::from(vec![(program, argv, false)])),
        (
            "Environment",
            Value::from(vec![format!("DBUS_SESSION_BUS_ADDRESS={host_bus}")]),
        ),
        ("TimeoutStartUSec", Value::from(REPAIR_TIMEOUT.as_micros() as u64)),
        ("CollectMode", Value::from("inactive-or-failed".to_string())),
        ("SyslogIdentifier", Value::from(REPAIR_LOG_ID.to_string())),
    ]
}

/// The user's own session bus — where their systemd manager is — whatever this process
/// inherited. Never `Address::session()`: an older launcher wrapper exports the CONTAINER's
/// bus into `DBUS_SESSION_BUS_ADDRESS`, and the container runs a systemd of its own.
fn host_user_bus_address() -> Result<String> {
    let runtime_dir = match std::env::var("XDG_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => {
            let uid = std::fs::metadata("/proc/self")
                .context("read this process's uid")?
                .uid();
            PathBuf::from(format!("/run/user/{uid}"))
        }
    };
    let socket = runtime_dir.join("bus");
    anyhow::ensure!(
        is_socket(&socket),
        "no systemd user session bus at {} — a repair runs as a unit of the user's systemd \
         manager, so it needs one",
        socket.display()
    );
    Ok(format!("unix:path={}", socket.display()))
}

/// The path of this binary as it is on disk now.
///
/// A re-stage and an update both replace the file by a RENAME while the old process keeps its
/// inode, and `/proc/self/exe` then reads `…/server (deleted)`. The replacement at the original
/// path is the build that should run the repair, so the marker is stripped — and refused if
/// nothing is there, rather than handing systemd a path that would fail with 203/EXEC.
pub fn own_executable() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("find this binary's own path")?;
    let path = match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(original) => PathBuf::from(original),
        None => exe,
    };
    anyhow::ensure!(
        path.is_file(),
        "this binary's path ({}) no longer holds a file, so it cannot run the repair",
        path.display()
    );
    Ok(path)
}

// ---- the hidden subcommands ----------------------------------------------------------------

/// A hidden subcommand this binary was started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reexec {
    /// The crate's container supervisor: boot systemd in a user namespace and reap it.
    Supervise { display: bool },
    /// The crate's in-container exec waiter.
    Exec { leader: i32, uid: u32, script: String, env: Vec<(String, String)> },
    /// The broker repair, run inside its transient unit (host) or as a helper (embedded).
    RepairBroker,
    /// The embedded container's boot helper (`intune_embedded::boot_main`).
    IntuneBoot,
    /// The embedded container's graceful stop (`intune_embedded::stop_main`).
    IntuneStop,
    /// The embedded container's portal, for an enrollment (`intune_embedded::portal_main`).
    IntunePortal,
}

/// The hidden arguments that take no arguments of their own, and what each one is. Every one of
/// them is teams-lite's (the crate's two have shapes of their own, parsed below).
const BARE_SUBCOMMANDS: &[(&str, Reexec)] = &[
    (REPAIR_SUBCOMMAND, Reexec::RepairBroker),
    (crate::intune_embedded::BOOT_SUBCOMMAND, Reexec::IntuneBoot),
    (crate::intune_embedded::STOP_SUBCOMMAND, Reexec::IntuneStop),
    (crate::intune_embedded::PORTAL_SUBCOMMAND, Reexec::IntunePortal),
];

/// Read the hidden subcommand out of `argv`, or `None` when this is an ordinary start.
///
/// Parsed by hand rather than with an argument parser, because these are the CRATE's argv
/// shapes (`backend.rs`: `<exe> __rootless-supervise [--display]` and
/// `<exe> __rootless-exec <leader> <uid> <script> -- K=V …`) and a parser would be a second
/// spelling of them; an argument this does not expect is refused rather than ignored.
pub fn parse_reexec(args: &[OsString]) -> Option<Result<Reexec, String>> {
    let first = args.get(1)?.to_str()?;
    let rest: Vec<&str> = match args[2..].iter().map(|a| a.to_str()).collect::<Option<Vec<_>>>() {
        Some(rest) => rest,
        None => {
            let ours = [SUPERVISE_SUBCOMMAND, EXEC_SUBCOMMAND].contains(&first)
                || BARE_SUBCOMMANDS.iter().any(|(name, _)| *name == first);
            return ours.then(|| Err(format!("{first}: an argument is not valid UTF-8")));
        }
    };
    if let Some((name, reexec)) = BARE_SUBCOMMANDS.iter().find(|(name, _)| *name == first) {
        return Some(if rest.is_empty() {
            Ok(reexec.clone())
        } else {
            Err(format!("{name} takes no arguments"))
        });
    }
    match first {
        SUPERVISE_SUBCOMMAND => Some(match rest.as_slice() {
            [] => Ok(Reexec::Supervise { display: false }),
            ["--display"] => Ok(Reexec::Supervise { display: true }),
            other => Err(format!("{SUPERVISE_SUBCOMMAND}: unexpected arguments {other:?}")),
        }),
        EXEC_SUBCOMMAND => Some(parse_exec(&rest)),
        _ => None,
    }
}

fn parse_exec(rest: &[&str]) -> Result<Reexec, String> {
    let [leader, uid, script, tail @ ..] = rest else {
        return Err(format!("{EXEC_SUBCOMMAND}: expected <leader> <uid> <script>"));
    };
    let leader = leader.parse().map_err(|_| format!("{EXEC_SUBCOMMAND}: bad leader {leader:?}"))?;
    let uid = uid.parse().map_err(|_| format!("{EXEC_SUBCOMMAND}: bad uid {uid:?}"))?;
    let tail = match tail {
        ["--", env @ ..] => env,
        env => env,
    };
    // The crate's own CLI drops a malformed pair silently; so does this, for the same input.
    let env = tail
        .iter()
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Ok(Reexec::Exec { leader, uid, script: script.to_string(), env })
}

/// Run the hidden subcommand this binary was started with, if any, and answer its exit code.
///
/// Called first thing in `server`'s `main`, before a runtime exists: the supervisor forks and
/// unshares a user namespace, which a multithreaded process cannot do safely, and it builds a
/// tokio runtime of its own that would panic inside ours.
pub fn dispatch_reexec(args: impl IntoIterator<Item = OsString>) -> Option<i32> {
    let args: Vec<OsString> = args.into_iter().collect();
    let parsed = parse_reexec(&args)?;
    Some(match parsed {
        Err(e) => {
            eprintln!("teams-lite: {e}");
            2
        }
        Ok(Reexec::Supervise { display }) => {
            init_tracing();
            intune_container::backend::supervise_main(display).unwrap_or_else(|e| {
                eprintln!("teams-lite: container supervisor: {e:#}");
                1
            })
        }
        Ok(Reexec::Exec { leader, uid, script, env }) => {
            init_tracing();
            intune_container::backend::exec_main(leader, uid, &script, &env).unwrap_or_else(|e| {
                eprintln!("teams-lite: container exec: {e:#}");
                1
            })
        }
        Ok(Reexec::RepairBroker) => repair_main(),
        Ok(Reexec::IntuneBoot) => crate::intune_embedded::boot_main(),
        Ok(Reexec::IntuneStop) => crate::intune_embedded::stop_main(),
        Ok(Reexec::IntunePortal) => crate::intune_embedded::portal_main(),
    })
}

/// The crate logs through `tracing`; without a subscriber every word it says is dropped, and a
/// failed boot would leave nothing to read. Its own `main` installs this same subscriber.
pub(crate) fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init();
}

// ---- the repair itself ---------------------------------------------------------------------

/// The repair, as its transient unit runs it, and its exit code — which systemd reports back to
/// the backend that asked as the job's result (`done` for 0, `failed` otherwise):
///
/// - **0** — the keyring is unlocked at the end: repaired, found unlocked before anything was
///   touched, or unlocked by somebody else's restart while this one waited for the lock;
/// - **1** — a restart was attempted and the keyring is not unlocked after it;
/// - **2** — nothing was restarted because nothing could be told: the container is not running
///   or not set up, or the keyring did not answer. The old unit's `ExecCondition=` skipped on
///   the same states; this says so in the job's result rather than reporting success.
///
/// IN EMBEDDED MODE it is a helper rather than a unit, and three things systemd did for the unit
/// are done here instead: it takes the helper SLOT first (one boot, repair or portal at a time on
/// this pod's volume — held by another is exit 2, nothing restarted), it makes the container's
/// cgroup this pod's own when nothing said otherwise, and it BOUNDS itself at
/// [`REPAIR_TIMEOUT`], the unit's own `TimeoutStartUSec`. And one thing a unit never needed: it
/// refuses (exit 2) a container running from this volume in ANOTHER container or pod, before the
/// restart's `backend::is_running` could delete that container's state as stale
/// (`intune_embedded::refuse_a_container_running_elsewhere`).
fn repair_main() -> i32 {
    init_tracing();
    let say = |line: &str| eprintln!("teams-lite(broker-repair): {line}");
    if crate::read_only() {
        say("refused: TEAMS_LITE_READ_ONLY=1 — a read-only process never restarts the container");
        return 2;
    }
    let embedded = match crate::intune_embedded::mode() {
        Ok(mode) => mode == crate::intune_embedded::Mode::Embedded,
        Err(e) => {
            say(&format!("refused: {e:#}"));
            return 2;
        }
    };
    // Held until this function returns: the slot is the helper's for its whole life.
    let _slot = if embedded {
        crate::intune_embedded::own_cgroup_by_default();
        match crate::intune_embedded::take_helper_slot(crate::intune_embedded::Helper::Repair) {
            Ok(Some(slot)) => {
                if let Some(code) = crate::intune_embedded::refuse_a_container_running_elsewhere(&say) {
                    return code;
                }
                crate::intune_embedded::arm_watchdog("broker-repair", "the repair", REPAIR_TIMEOUT);
                Some(slot)
            }
            Ok(None) => {
                say("another container helper is at work on this volume — not restarting beside it");
                return 2;
            }
            Err(e) => {
                say(&format!("could not take the helper slot: {e:#}"));
                return 2;
            }
        }
    } else {
        None
    };

    // The condition the installed unit carried as ExecCondition=, and the one no trigger can
    // skip: the backend checked before asking, but the keyring may have been unlocked since,
    // and restarting a healthy container takes the user's sign-in down for nothing.
    match keyring_now() {
        Ok(KeyringCheck::Locked) => {}
        Ok(KeyringCheck::Unlocked) => {
            say("the container's login keyring is unlocked — nothing to repair");
            return 0;
        }
        Ok(other) => {
            say(&format!("{} — not restarting on a guess", other.describe()));
            return 2;
        }
        Err(e) => {
            say(&format!("could not ask the keyring: {e:#}"));
            return 2;
        }
    }

    say("the container's login keyring is locked — restarting the container");
    match restart_container() {
        Ok(Restart::Done) => {}
        Ok(Restart::NotNeeded(KeyringCheck::Unlocked)) => {
            say("somebody else's restart unlocked the keyring while this one waited — nothing to do");
            return 0;
        }
        Ok(Restart::NotNeeded(other)) => {
            say(&format!("by the time the lock was free, {} — not restarting", other.describe()));
            return 2;
        }
        Err(e) => {
            say(&format!("the restart failed: {e:#}"));
            return 1;
        }
    }

    match keyring_now() {
        Ok(KeyringCheck::Unlocked) => {
            say("repaired — the keyring is unlocked");
            0
        }
        Ok(after) => {
            say(&format!("the container restarted, but {}", after.describe()));
            1
        }
        Err(e) => {
            say(&format!("the container restarted, but the keyring could not be asked: {e:#}"));
            1
        }
    }
}

/// Ask the keyring on a runtime of its own, dropped before the crate is called: the crate
/// builds runtimes of its own (`oci::block_on`), and one cannot be started inside another.
fn keyring_now() -> Result<KeyringCheck> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build a runtime for the keyring check")?;
    Ok(runtime.block_on(container_keyring()))
}

/// What [`restart_container`] did.
enum Restart {
    Done,
    /// The keyring was no longer locked once the lifecycle lock was ours, so nothing was
    /// restarted.
    NotNeeded(KeyringCheck),
}

/// Stop the container and boot it again, headless, through the crate.
///
/// It is the container half of `ops::start` without the browser half (see the module header),
/// under the same lifecycle lock every `intune-container` command takes — so it waits for the
/// user's own CLI or GUI rather than racing it.
///
/// THE KEYRING IS ASKED AGAIN ONCE THE LOCK IS OURS. Waiting for that lock is waiting for
/// somebody else's stop or start — the user's own `intune-container stop && start`, the GUI, an
/// older build's installed repair — and the start is exactly what unlocks the keyring. A repair
/// that did not look again would take sign-in down a second time, for a container somebody had
/// just repaired.
///
/// STOP THEN START, never a bare start: on a running container `backend::start` returns at once
/// ("container already running") and never re-runs the session setup that unlocks the keyring,
/// which is the whole repair.
///
/// AND THE POWEROFF IS WAITED FOR BETWEEN THE TWO, the rule the embedded boot's own restart holds
/// (`intune_embedded::POWEROFF_WAIT`). The crate's `backend::stop` waits twenty seconds for the
/// leader and then clears the runtime state WHETHER OR NOT it went — and a poweroff that takes
/// longer (a unit at systemd's own ninety-second stop timeout) leaves the old supervisor holding
/// its lock with no leader named. A start over that boots nothing: the crate's second supervisor
/// finds the lock held, logs "not booting a duplicate" and exits, the start gives up at twenty
/// seconds, and the old container then finishes powering off with nothing running — while the
/// repair floor this repair claimed keeps the automatic boot away for twenty minutes. So the
/// leader is recorded BEFORE the stop (afterwards nothing on the volume names it), the stop is
/// waited out, and a container still going down past the wait is said as what it is: a failure
/// that started nothing, rather than a start that boots nothing.
///
/// The boot itself is [`boot_headless`], which the embedded boot helper shares — so "a boot
/// never updates the image" is one rule, kept in one place.
fn restart_container() -> Result<Restart> {
    use crate::intune_embedded::{POWEROFF_WAIT, await_our_container_to_settle, live_leader_state};
    use intune_container::{backend, config::Config, lock::LifecycleLock};

    let _lock = LifecycleLock::acquire().context("take intune-container's lifecycle lock")?;
    match keyring_now()? {
        KeyringCheck::Locked => {}
        other => return Ok(Restart::NotNeeded(other)),
    }

    let mut config = Config::load().context("load intune-container's configuration")?;
    // The leader this repair asks to power off, recorded before the stop clears its state.
    let mut stopped = None;
    if backend::is_running(&config) {
        stopped = live_leader_state();
        backend::stop(&config).context("stop the container")?;
    }
    if !await_our_container_to_settle(stopped.as_ref(), POWEROFF_WAIT) {
        let what = if stopped.is_some() {
            format!("was asked to power off and was still powering off {} s later", POWEROFF_WAIT.as_secs())
        } else {
            format!(
                "was still going down after a wait of {} s — its supervisor holds the volume with \
                 no leader named",
                POWEROFF_WAIT.as_secs()
            )
        };
        bail!(
            "the Intune container {what}. Not starting another over it, which would boot nothing; \
             it can be started once it has gone"
        );
    }
    boot_headless(&mut config)?;
    Ok(Restart::Done)
}

/// Boot the container headless, through the crate, WITHOUT updating its image. The caller holds
/// the lifecycle lock; this is the container half of `ops::start` without the browser half (see
/// the module header), shared by the repair and the embedded boot helper.
///
/// THE BOOT NEVER UPDATES THE IMAGE. `backend::start` checks the registry and, when the tag has
/// moved, deletes the rootfs and pulls the whole image before it boots — with `auto_update` on,
/// which is the crate's default. In a repair that would happen with the container already
/// stopped, under [`REPAIR_TIMEOUT`], over a registry call with no deadline: a repair killed in
/// the middle leaves no container at all. In an embedded boot it would be a 1.7 GB pull on every
/// pod start the image tag had moved since, under the boot's own bound. So the boot is handed a
/// COPY of the configuration with updates off, and the user's own setting is never written back
/// changed; the next ordinary `intune-container start` updates as it always did.
///
/// The display is a fixed headless one rather than `DisplayInfo::detect()`: `backend::start`
/// does not read it, and detection would spawn `xauth` when the manager's environment carries
/// a `DISPLAY`. Headless is also what `ops::start` boots, so `display_forwarding` is cleared the
/// same way it does — on the original configuration, so the copy's `auto_update` never reaches
/// the disk.
pub(crate) fn boot_headless(config: &mut intune_container::config::Config) -> Result<()> {
    use intune_container::{backend, display::DisplayInfo};

    let headless = DisplayInfo {
        wayland_socket: None,
        x11_display: None,
        xauthority: None,
        has_abstract_x11: false,
    };
    let mut boot = config.clone();
    boot.auto_update = false;
    backend::start(&mut boot, &headless, false).context("start the container")?;
    if config.display_forwarding {
        config.display_forwarding = false;
        config.save().context("record the container as headless")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        std::iter::once("server").chain(list.iter().copied()).map(OsString::from).collect()
    }

    #[test]
    fn an_override_wins_then_the_container_then_the_session() {
        let socket = PathBuf::from("/proc/42/root/run/user/0/bus");
        assert_eq!(
            choose_broker_bus(Some("unix:path=/x".into()), Some((42, socket.clone()))),
            BrokerBus::Override("unix:path=/x".into()),
        );
        assert_eq!(
            choose_broker_bus(None, Some((42, socket.clone()))),
            BrokerBus::Container { leader: 42, socket },
        );
        assert_eq!(choose_broker_bus(None, None), BrokerBus::Session);
        // An empty override is no override: a unit's `Environment=` line left blank must not
        // point every token call at nothing.
        assert_eq!(choose_broker_bus(Some("  ".into()), None), BrokerBus::Session);
    }

    #[test]
    fn the_container_bus_is_reached_through_the_leaders_root() {
        assert_eq!(
            container_bus_socket(6415),
            PathBuf::from("/proc/6415/root/run/user/0/bus")
        );
        let bus = BrokerBus::Container { leader: 6415, socket: container_bus_socket(6415) };
        assert_eq!(
            bus.address().unwrap().to_string(),
            "unix:path=/proc/6415/root/run/user/0/bus"
        );
        assert!(bus.has_container_keyring());
        assert!(!BrokerBus::Session.has_container_keyring());
    }

    // This process is not a container init, so its own pid must never be read as one. That is
    // the recycled-pid hazard: a stale rootless.json naming a pid that now belongs to one of the
    // user's own processes.
    #[test]
    fn a_process_of_our_own_is_not_a_container_init() {
        assert!(!is_container_init(std::process::id() as i32));
        assert!(!is_container_init(i32::MAX));
    }

    #[test]
    fn the_crates_own_reexec_shapes_are_routed() {
        assert_eq!(parse_reexec(&args(&[])), None);
        assert_eq!(parse_reexec(&args(&["--help"])), None);
        assert_eq!(
            parse_reexec(&args(&["__rootless-supervise"])),
            Some(Ok(Reexec::Supervise { display: false }))
        );
        assert_eq!(
            parse_reexec(&args(&["__rootless-supervise", "--display"])),
            Some(Ok(Reexec::Supervise { display: true }))
        );
        // The exact argv `backend::spawn_exec_helper` builds.
        assert_eq!(
            parse_reexec(&args(&["__rootless-exec", "6415", "0", "echo hi", "--", "A=1", "B=x=y", "junk"])),
            Some(Ok(Reexec::Exec {
                leader: 6415,
                uid: 0,
                script: "echo hi".into(),
                env: vec![("A".into(), "1".into()), ("B".into(), "x=y".into())],
            }))
        );
        assert_eq!(
            parse_reexec(&args(&["__teams-lite-repair-broker"])),
            Some(Ok(Reexec::RepairBroker))
        );
        // The embedded container's own three, spelled as the image and the guard spell them.
        assert_eq!(parse_reexec(&args(&["__teams-lite-intune-boot"])), Some(Ok(Reexec::IntuneBoot)));
        assert_eq!(parse_reexec(&args(&["__teams-lite-intune-stop"])), Some(Ok(Reexec::IntuneStop)));
        assert_eq!(
            parse_reexec(&args(&["__teams-lite-intune-portal"])),
            Some(Ok(Reexec::IntunePortal))
        );
    }

    #[test]
    fn a_reexec_target_with_arguments_it_does_not_take_is_refused() {
        assert!(matches!(parse_reexec(&args(&["__rootless-supervise", "--wat"])), Some(Err(_))));
        assert!(matches!(parse_reexec(&args(&["__rootless-exec", "x", "0", "s"])), Some(Err(_))));
        assert!(matches!(parse_reexec(&args(&["__rootless-exec", "1"])), Some(Err(_))));
        assert!(matches!(
            parse_reexec(&args(&["__teams-lite-repair-broker", "--now"])),
            Some(Err(_))
        ));
        for bare in ["__teams-lite-intune-boot", "__teams-lite-intune-stop", "__teams-lite-intune-portal"] {
            assert!(matches!(parse_reexec(&args(&[bare, "--force"])), Some(Err(_))), "{bare}");
            assert!(matches!(parse_reexec(&args(&[bare, ""])), Some(Err(_))), "{bare} with an empty one");
        }
    }

    // A helper's argument that is not UTF-8 is a refusal of THAT helper, never an ordinary
    // start — which would boot a whole second backend.
    #[test]
    fn a_helper_with_an_argument_that_is_not_utf8_is_refused_not_started_as_a_backend() {
        use std::os::unix::ffi::OsStringExt;
        for bare in ["__teams-lite-intune-boot", "__teams-lite-intune-stop", "__teams-lite-intune-portal"] {
            let argv = vec![OsString::from("server"), OsString::from(bare), OsString::from_vec(vec![0xff])];
            assert!(matches!(parse_reexec(&argv), Some(Err(_))), "{bare}");
        }
    }

    // A refusal of an embedded helper body happens before it touches anything, and this test
    // process is in host mode (nothing here sets TEAMS_LITE_INTUNE_MODE), so each answers 2 —
    // the exit code that says "refused, nothing done" — without reaching the crate.
    #[test]
    fn the_embedded_helpers_refuse_to_act_outside_embedded_mode() {
        assert!(!crate::intune_embedded::embedded(), "the test process declares no mode");
        assert_eq!(crate::intune_embedded::boot_main(), 2);
        assert_eq!(crate::intune_embedded::stop_main(), 2);
        assert_eq!(crate::intune_embedded::portal_main(), 2);
    }

    // The boot and the portal act as the user's device; a read-only process never runs either.
    // Run in a child process with the mode and the read-only flag set, because both are read
    // once per process and a test that set them here would race every other test.
    #[test]
    fn the_boot_and_the_portal_refuse_a_read_only_process() {
        if std::env::var_os("TEAMS_LITE_HELPER_READ_ONLY_TEST").is_some() {
            assert!(crate::intune_embedded::embedded() && crate::read_only());
            assert_eq!(crate::intune_embedded::boot_main(), 2, "the boot refuses read-only");
            assert_eq!(crate::intune_embedded::portal_main(), 2, "the portal refuses read-only");
            return;
        }
        // A throwaway data dir, so that even a refusal that regressed could only ever reach an
        // empty one — never the user's own intune-container state.
        let dir = std::env::temp_dir().join(format!("teams-lite-ro-helper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "intune::tests::the_boot_and_the_portal_refuse_a_read_only_process", "--nocapture"])
            .env("TEAMS_LITE_HELPER_READ_ONLY_TEST", "1")
            .env("TEAMS_LITE_READ_ONLY", "1")
            .env(crate::intune_embedded::MODE_ENV, "embedded")
            .env("XDG_DATA_HOME", &dir)
            .status()
            .unwrap();
        let untouched = std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(true);
        std::fs::remove_dir_all(&dir).ok();
        assert!(status.success(), "the read-only refusals failed in their child process");
        assert!(untouched, "a refused helper wrote nothing to the data dir");
    }

    // The repair's unit must carry the user bus, never an inherited one, and run THIS binary's
    // repair subcommand — the two halves that replaced the installed unit's ExecStart= and its
    // Environment= pin.
    #[test]
    fn the_repair_unit_runs_this_binary_against_the_user_bus() {
        let props = oneshot_properties(
            &["/opt/teams/server", REPAIR_SUBCOMMAND],
            "unix:path=/run/user/1000/bus",
        );
        let get = |name: &str| {
            props
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| panic!("no {name} property"))
        };
        assert!(get("Type").contains("oneshot"));
        assert!(get("ExecStart").contains("/opt/teams/server"));
        assert!(get("ExecStart").contains(REPAIR_SUBCOMMAND));
        assert!(get("Environment").contains("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"));
        assert!(get("CollectMode").contains("inactive-or-failed"));
        assert!(get("TimeoutStartUSec").contains(&REPAIR_TIMEOUT.as_micros().to_string()));
    }

    // The two calls this module must never make, scanned for because each reads like the
    // obvious one: `running_leader` deletes a stale state file, and `ops::start` points the
    // browser's SSO wrapper at whatever binary calls it.
    #[test]
    fn the_crate_is_read_without_side_effects_and_never_rewires_browser_sso() {
        let source = include_str!("intune.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let code: String = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!code.contains("running_leader("), "reads must not clean another tool's state");
        assert!(!code.contains("ops::start("), "ops::start rewires browser SSO to this binary");
        assert!(!code.contains("ops::stop("), "the stop runs under the repair's one lock");
        assert!(
            !code.contains("std::process::Command") && !code.contains("tokio::process"),
            "this module answers in process: it never runs a host command"
        );
    }

    // The pre-check every repair makes, against the real manager: `GetUnit` for both names,
    // `NoSuchUnit` read as "not running", and an `ActiveState` read where a unit is loaded.
    // Read-only. Ignored because it needs a systemd user session:
    //
    //     cargo test --lib intune::tests::the_user_manager_answers_whether_a_repair_runs -- --ignored
    #[tokio::test]
    #[ignore]
    async fn the_user_manager_answers_whether_a_repair_runs() {
        repair_running().await.expect("the user manager answered");
    }

    // The one half of the repair no unit test can reach: does the user's REAL systemd manager
    // accept these property types? It makes the exact call the repair makes, against a unit that
    // runs `/bin/true` under a name of its own — so nothing about anybody's container is touched,
    // and the unit unloads itself when it ends (`CollectMode`). Ignored for the same reason:
    //
    //     cargo test --lib intune::tests::the_user_manager_accepts_the_repair_units_shape -- --ignored
    #[tokio::test]
    #[ignore]
    async fn the_user_manager_accepts_the_repair_units_shape() {
        let host_bus = host_user_bus_address().expect("a systemd user session bus");
        let name = format!("teams-lite-intune-selftest-{}.service", std::process::id());
        let started = start_transient_oneshot(&name, &oneshot_properties(&["/bin/true"], &host_bus), &host_bus)
            .await
            .expect("systemd accepted the unit");
        let RepairStart::Started(job) = started else { panic!("a fresh name cannot exist already") };
        assert_eq!(job.finished().await.expect("the job ended"), "done");
    }


    #[test]
    fn the_bus_is_announced_once_per_change() {
        let container = BrokerBus::Container { leader: 7, socket: container_bus_socket(7) };
        assert!(choice_changed(None, &BrokerBus::Session), "the first answer is news");
        assert!(!choice_changed(Some(&BrokerBus::Session), &BrokerBus::Session));
        assert!(choice_changed(Some(&BrokerBus::Session), &container), "the container came up");
        let moved = BrokerBus::Container { leader: 8, socket: container_bus_socket(8) };
        assert!(choice_changed(Some(&container), &moved), "the container restarted");
    }

    // A container that has a leader but no bus yet is booting, and dialling a path that is not
    // a socket costs a confusing error instead of the session fallback.
    #[test]
    fn only_a_socket_is_a_bus() {
        let dir = std::env::temp_dir().join(format!("teams-lite-intune-sock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file");
        std::fs::write(&file, b"").unwrap();
        let socket = dir.join("bus");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(is_socket(&socket));
        assert!(!is_socket(&file));
        assert!(!is_socket(&dir.join("absent")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_unit_on_its_way_up_or_down_is_a_repair_still_running() {
        for running in ["active", "activating", "deactivating", "reloading", "refreshing"] {
            assert!(unit_state_is_running(running), "{running}");
        }
        for stopped in ["inactive", "failed", "maintenance", ""] {
            assert!(!unit_state_is_running(stopped), "{stopped}");
        }
    }

    // The two halves of "a boot never pulls the image": the boot gets a copy with updates off,
    // and the copy is never what is saved — in ONE function, which the repair and the embedded
    // boot helper both call (the helper's own test checks it calls it rather than a copy).
    #[test]
    fn a_repair_boots_without_an_image_update_and_never_saves_that() {
        let source = include_str!("intune.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let fn_body = |signature: &str| {
            code.split(signature)
                .nth(1)
                .unwrap_or_else(|| panic!("{signature}"))
                .split("\n}\n")
                .next()
                .expect("the function ends")
                .to_string()
        };
        let repair = fn_body("fn restart_container() -> Result<Restart> {");
        let lock = repair.find("LifecycleLock::acquire()").expect("takes the lock");
        let recheck = repair.find("keyring_now()").expect("asks the keyring again");
        let stop = repair.find("backend::stop(").expect("stops");
        let boot = repair.find("boot_headless(&mut config)").expect("boots through the shared boot");
        assert!(
            lock < recheck && recheck < stop && stop < boot,
            "the keyring is asked again inside the lock, before the stop, and the boot comes last"
        );
        assert!(!repair.contains("backend::start("), "the boot is never re-spelled in the repair");

        let shared =
            fn_body("pub(crate) fn boot_headless(config: &mut intune_container::config::Config) -> Result<()> {");
        assert!(shared.contains("boot.auto_update = false;"));
        assert!(shared.contains("backend::start(&mut boot,"), "the boot runs from the copy");
        assert!(!shared.contains("boot.save("), "the copy with updates off is never saved");
        assert_eq!(code.matches("backend::start(").count(), 1, "one boot in this module");
    }

    // The crate's `backend::stop` answers Ok after twenty seconds whether or not the leader went,
    // and a start over a container still powering off boots nothing — the old supervisor holds its
    // lock, the new one refuses to boot a duplicate, the start gives up, and the old container then
    // goes down with nothing running behind it. The embedded boot's own restart waits that poweroff
    // out; the repair's identical stop-then-start must too, with the leader recorded BEFORE the
    // stop (the crate clears its state after), the wait between the stop and the boot, and a
    // container still going down said as a failure that started nothing. And the bound every
    // repair runs under has room for that wait.
    #[test]
    fn a_repair_waits_for_its_own_poweroff_before_it_starts() {
        let source = include_str!("intune.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let body = code
            .split("fn restart_container() -> Result<Restart> {")
            .nth(1)
            .expect("restart_container")
            .split("\n}\n")
            .next()
            .expect("the function ends");
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("missing `{needle}`"));
        let running = at("if backend::is_running(&config) {");
        let recorded = at("stopped = live_leader_state();");
        let stop = at("backend::stop(&config)");
        let settle = at("if !await_our_container_to_settle(stopped.as_ref(), POWEROFF_WAIT) {");
        let boot = at("boot_headless(&mut config)?");
        assert!(
            running < recorded && recorded < stop && stop < settle && settle < boot,
            "recorded before the stop, the stop waited out, and only then the boot"
        );
        let refused = &body[settle..boot];
        assert!(refused.contains("bail!("), "a container still going down ends the repair before the boot");
        assert!(refused.contains("still powering off") && refused.contains("still going down"), "and says what is true");
        assert_eq!(body.matches("boot_headless(").count(), 1, "one boot, after the wait");

        // The one settle, shared with the embedded boot rather than re-spelled here.
        assert!(!body.contains("std::thread::sleep"), "the wait is intune_embedded's own");
        assert_eq!(
            REPAIR_TIMEOUT,
            REPAIR_WORK + crate::intune_embedded::POWEROFF_WAIT,
            "the repair's bound holds its work and the poweroff wait"
        );
        let repair = code
            .split("fn repair_main() -> i32 {")
            .nth(1)
            .expect("repair_main")
            .split("\n}\n")
            .next()
            .expect("the function ends");
        assert!(
            repair.contains("arm_watchdog(\"broker-repair\", \"the repair\", REPAIR_TIMEOUT)"),
            "the embedded repair's watchdog is that bound"
        );
        let props = oneshot_properties(&["/opt/teams/server", REPAIR_SUBCOMMAND], "unix:path=/run/user/1000/bus");
        let timeout = props.iter().find(|(key, _)| *key == "TimeoutStartUSec").expect("a start timeout");
        assert!(
            timeout.1.to_string().contains(&REPAIR_TIMEOUT.as_micros().to_string()),
            "and so is the host unit's TimeoutStartUSec"
        );
    }

    // HOST mode in the image: it sees the intune-container state (it follows the bus from it)
    // and still must not offer a repair — the repair is the host's systemd running a path only
    // the image holds.
    #[test]
    fn the_host_mode_image_offers_no_repair_and_says_what_to_do_instead() {
        let host = false;
        assert!(repair_may_run(host, false, false, true), "a host install that may repair, does");
        assert!(!repair_may_run(host, false, true, true), "the image never does, though it sees the state");
        assert!(!repair_may_run(host, true, false, true), "nor does a read-only backend");
        assert!(!repair_may_run(host, false, false, false), "nor a host with nothing to restart");
        assert!(repair_is_blocked(host, false, true, true), "the image says why");
        assert!(!repair_is_blocked(host, false, false, true), "a host install has nothing to say");
        assert!(!repair_is_blocked(host, true, true, true), "a read-only backend refuses by design");
        // The sentence is the remedy, so it has to name both of the real ones.
        assert!(IMAGE_REPAIR_BLOCKER.contains("intune-container stop && intune-container start"));
        assert!(IMAGE_REPAIR_BLOCKER.contains("installed on the host"));
    }

    // EMBEDDED mode in the image: the container is the pod's own and so is the repair — the
    // image is no reason to refuse, and there is no blocker sentence to show.
    #[test]
    fn the_embedded_image_repairs_its_own_container() {
        let embedded = true;
        assert!(repair_may_run(embedded, false, true, true), "the image repairs its own container");
        assert!(repair_may_run(embedded, false, false, true), "and so would any embedded install");
        assert!(!repair_may_run(embedded, true, true, true), "never read-only");
        assert!(!repair_may_run(embedded, false, true, false), "nothing to restart before the first boot");
        for read_only in [false, true] {
            for in_image in [false, true] {
                for initialized in [false, true] {
                    assert!(!repair_is_blocked(embedded, read_only, in_image, initialized));
                }
            }
        }
    }

    #[test]
    fn a_repair_names_the_log_it_writes_to() {
        assert!(!crate::intune_embedded::embedded(), "the test process declares no mode");
        assert!(repair_log_hint().contains(REPAIR_LOG_ID), "the host journal identifier");
    }

    /// A packaging file, read at RUN time rather than with `include_str!`: these are written by
    /// another part of the tree, and a file that is missing or renamed must fail this one test
    /// with its name, not stop every test in the crate from compiling.
    fn packaging(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("packaging/docker").join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// The lines of a file that are not comments, trimmed.
    fn live(text: &str) -> Vec<&str> {
        text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect()
    }

    /// The compose list entry — its `- …` line and every line indented under it — that mentions
    /// `needle`, in the long syntax (`- type: volume` / `source:` / `target:`) or the short one
    /// (`- source:target[:ro]`). Comments are not entries.
    fn compose_entry(compose: &str, needle: &str) -> Option<String> {
        let lines: Vec<&str> = compose
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .collect();
        let indent = |l: &str| l.len() - l.trim_start().len();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("- ") {
                continue;
            }
            let base = indent(line);
            let entry: Vec<&str> = std::iter::once(*line)
                .chain(lines[i + 1..].iter().copied().take_while(|l| indent(l) > base))
                .collect();
            let entry = entry.join("\n");
            if entry.contains(needle) {
                return Some(entry);
            }
        }
        None
    }

    const INTUNE_STATE: &str = "/home/teams/.local/share/intune-container";

    // Everything the image needs is a line in a file nothing else reads, and each one fails
    // SILENTLY when it goes: in embedded mode a missing id mapper or an undelegated cgroup and
    // the inner container never boots, a host network and its `:99` collides with the user's
    // own; in host mode no pid namespace and the bus is not there, root and the handshake is
    // refused, a file mount and the leader goes stale — the app then shows no chats with nothing
    // to say why. So the files are held to the rules here, beside the code they serve.
    #[test]
    fn the_image_is_built_to_reach_the_broker_and_to_stay_its_own_install() {
        let dockerfile = packaging("Dockerfile");
        let entrypoint = packaging("entrypoint.sh");
        let docker = live(&dockerfile);
        let entry = live(&entrypoint);

        // THE IMAGE: embedded by default, declared under the names this crate reads.
        let mode = crate::intune_embedded::MODE_ENV;
        assert!(docker.iter().any(|l| l.contains(&format!("{mode}=embedded"))), "the Dockerfile sets {mode}=embedded");
        assert!(
            docker.iter().any(|l| l.contains(&format!("{CONTAINER_IMAGE_ENV}=1"))),
            "the Dockerfile sets {CONTAINER_IMAGE_ENV}=1"
        );
        // The rootless runtime's id range: the mappers, with FILE capabilities (setuid ones are
        // refused under Docker — measured), and a subordinate range for the runtime user.
        assert!(docker.iter().any(|l| l.contains("uidmap")), "the id mappers are installed");
        assert!(docker.iter().any(|l| l.contains("setcap cap_setuid=ep")), "newuidmap carries a file capability");
        assert!(docker.iter().any(|l| l.contains("/etc/subuid")), "the runtime user has a subordinate range");
        // The backend itself at a fixed path, for the entrypoint's stop and the self-test's boot.
        assert!(docker.iter().any(|l| l.contains("/usr/local/lib/teams-lite/server")));
        // Built for one host user's uid still (host mode needs it; embedded needs the volumes').
        assert!(docker.iter().any(|l| l.starts_with("ARG UID")), "the UID build argument stays");
        // The entrypoint starts as ROOT and drops: a `USER` the final stage ends on would stop
        // it from delegating the cgroup at all.
        let user = docker.iter().rfind(|l| l.starts_with("USER "));
        assert!(user.is_none_or(|u| *u == "USER root"), "the image must not end on {user:?}");

        // THE ENTRYPOINT: delegate as root, drop with setpriv — never with no-new-privs, which
        // would void the mappers' file capabilities — and stop the inner container on the way out.
        assert!(entry.iter().any(|l| l.contains("setpriv")), "the entrypoint drops with setpriv");
        assert!(!entry.iter().any(|l| l.contains("--no-new-privs")), "no-new-privs defeats the file capabilities");
        assert!(entry.iter().any(|l| l.contains("cgroup.procs")), "the cgroup is delegated");
        assert!(entry.iter().any(|l| l.contains("trap")), "TERM is trapped");
        assert!(
            entry.iter().any(|l| l.contains(crate::intune_embedded::STOP_SUBCOMMAND)),
            "the trap powers the inner container off"
        );
        // The intune volume holds a rootfs owned by SUBORDINATE ids: a recursive chown would
        // hand every file in it to one uid and the container would never boot again.
        assert!(!entry.iter().any(|l| l.contains("chown -R")), "never a recursive chown");
        // Ports of its own: the launcher would otherwise ATTACH to an install already listening,
        // and share its live feed's endpoint id on one store. A read-only run keeps 19430.
        assert!(entrypoint.contains("19423") && entrypoint.contains("19443"));
        for taken in ["19420", "19421", "19422", "19430", "19440", "19441", "19442"] {
            assert!(!entrypoint.contains(&format!(":-{taken}}}")), "{taken} belongs to another install");
        }
        assert!(entrypoint.contains("TEAMS_LITE_READ_ONLY"), "a read-only run keeps the read-only port");

        // EMBEDDED COMPOSE (the default): its own namespaces, unconfined enough to boot systemd.
        let compose = packaging("compose.yaml");
        let embedded = live(&compose);
        assert!(
            !embedded.iter().any(|l| (l.starts_with("pid:") || l.starts_with("network_mode:")) && l.contains("host")),
            "the embedded container runs in namespaces of its own — in the host's network its `:99` \
             collides with the user's own Intune container"
        );
        for option in ["seccomp=unconfined", "systempaths=unconfined"] {
            assert!(embedded.iter().any(|l| l.contains(option)), "compose.yaml carries {option}");
        }
        // A bridge network: the front binds 0.0.0.0 inside, and the published port's 127.0.0.1
        // prefix is what keeps the write token it serves off the LAN.
        assert!(embedded.iter().any(|l| l.contains("TEAMS_WEB_HOST")));
        assert!(embedded.iter().any(|l| l.contains("127.0.0.1:19443:19443")));
        assert!(
            !embedded.iter().any(|l| l.contains("19443:19443") && !l.contains("127.0.0.1:19443:19443")),
            "the web port is published on loopback only"
        );
        assert!(embedded.iter().any(|l| l.starts_with("stop_grace_period")), "time for the graceful stop");
        // The container's state is a READ-WRITE named volume of its own.
        let intune = compose_entry(&compose, INTUNE_STATE).expect("compose.yaml mounts the intune state");
        assert!(
            intune.contains("source: intune") || intune.trim_start().starts_with("- intune:"),
            "the intune state is the `intune` volume: {intune}"
        );
        assert!(
            !intune.contains("read_only: true") && !intune.trim_end().ends_with(":ro"),
            "the embedded container writes its own state: {intune}"
        );
        assert!(
            embedded.iter().any(|l| *l == "intune:" || l.starts_with("intune: ")),
            "the `intune` volume is declared"
        );

        // HOST-BROKER COMPOSE: today's shape, declared as host mode.
        let host = packaging("compose.host-broker.yaml");
        let host_lines = live(&host);
        assert!(host_lines.contains(&"pid: host"), "the bus is a /proc path of the host's");
        assert!(host_lines.contains(&"network_mode: host"), "loopback front, abstract display socket");
        assert!(
            host_lines.iter().any(|l| (l.starts_with(&format!("{mode}:")) || l.starts_with(&format!("- {mode}=")))
                && l.contains("host")),
            "compose.host-broker.yaml declares {mode}: host"
        );
        assert!(
            !host_lines.iter().any(|l| l.contains("TEAMS_WEB_HOST") || l.starts_with("ports:")),
            "in the host's network the front stays on 127.0.0.1 and is never published"
        );
        // The intune-container state is a READ-ONLY DIRECTORY that must already exist.
        let state = compose_entry(&host, INTUNE_STATE).expect("compose.host-broker.yaml mounts the state");
        assert!(state.contains("read_only: true"), "the user's state is read, never written: {state}");
        assert!(state.contains("create_host_path: false"), "a missing state is an error: {state}");
    }

    #[test]
    fn a_compose_entry_is_found_in_either_syntax() {
        let long = "volumes:\n  - type: volume\n    source: intune\n    target: /x\n  - type: bind\n    source: /y\n    target: /z\n";
        assert_eq!(
            compose_entry(long, "/x").as_deref(),
            Some("  - type: volume\n    source: intune\n    target: /x")
        );
        assert_eq!(compose_entry(long, "/z").as_deref(), Some("  - type: bind\n    source: /y\n    target: /z"));
        let short = "volumes:\n  # - nope:/x\n  - intune:/x:ro\n";
        assert_eq!(compose_entry(short, "/x").as_deref(), Some("  - intune:/x:ro"));
        assert_eq!(compose_entry(short, "/absent"), None);
    }
}
