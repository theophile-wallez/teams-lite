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
//! WHAT THE CRATE IS AND IS NOT ASKED. It is asked for its runtime state
//! (`runtime::load_runtime_state`, a pure read), for whether that leader is alive
//! (`runtime::is_running`), and — inside the repair unit only — for `backend::stop` and
//! `backend::start`. Three things it offers are refused on purpose, and each would break
//! something real:
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

/// The store setting holding when this MACHINE last started a repair (epoch ms). Shared by
/// every backend on one store, so the automatic floor counts every trigger on the machine —
/// the in-process floor it replaced was reset by every backend restart, and every repair
/// caused one.
pub const SETTING_REPAIR_STARTED_MS: &str = "broker_repair_started_ms";

/// How long a repair may run. A stop waits up to 20 s for the container's systemd to power
/// off, a start up to 20 s for the supervisor to publish its leader, and the in-container
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
pub const REPAIR_TIMEOUT: Duration = Duration::from_secs(300);

/// The journal identifier a repair logs under, which is what `journalctl --user -t` finds it
/// by. The installed unit used the same one.
const REPAIR_LOG_ID: &str = "teams-lite-broker-repair";

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
/// - **the leader is a container init** — the crate's `is_running` only checks that
///   `/proc/<pid>/ns/pid` exists, which every live process satisfies, so a recycled pid would
///   pass it. A container's PID 1 lives in a pid namespace of its own; a recycled pid of ours
///   lives in ours;
/// - **the socket is there** — a container that is booting has a leader before its user bus.
///
/// A state file torn mid-write (the crate writes it in place) reads as an error and therefore
/// as "no container" for this one call, which costs one unreachable broker call and is retried
/// by whoever asked.
fn running_container() -> Option<(i32, PathBuf)> {
    let state = intune_container::runtime::load_runtime_state().ok().flatten()?;
    let leader = state.leader;
    if !intune_container::runtime::is_running(leader) || !is_container_init(leader) {
        return None;
    }
    let socket = container_bus_socket(leader);
    is_socket(&socket).then_some((leader, socket))
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
pub fn repair_available() -> bool {
    !crate::read_only() && intune_container::ops::is_initialized()
}

// ---- asking systemd for the repair ---------------------------------------------------------

/// What asking for a repair did.
pub enum RepairStart {
    /// systemd took the job; [`RepairJob::finished`] says how it ended.
    Started(RepairJob),
    /// A repair is already running on this machine (the unit exists).
    AlreadyRunning,
}

/// A repair systemd is running, and the signal stream that will say when it ends.
pub struct RepairJob {
    job: OwnedObjectPath,
    stream: zbus::proxy::SignalStream<'static>,
    // Held so the subscription — and the connection the stream reads from — outlives the job.
    _manager: zbus::Proxy<'static>,
}

impl RepairJob {
    /// Wait for the repair to end, and answer systemd's own word for how: `done` when the
    /// repair exited 0, `failed`, `timeout`, `canceled`.
    pub async fn finished(mut self) -> Result<String> {
        let bound = REPAIR_TIMEOUT + Duration::from_secs(30);
        tokio::time::timeout(bound, async {
            while let Some(signal) = self.stream.next().await {
                let (_id, job, _unit, result): (u32, OwnedObjectPath, String, String) =
                    signal.body().deserialize().context("read a JobRemoved signal")?;
                if job == self.job {
                    return Ok(result);
                }
            }
            bail!("systemd's signal stream closed before the repair finished")
        })
        .await
        .map_err(|_| anyhow!("the repair did not finish within {} s", bound.as_secs()))?
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
        Ok(job) => Ok(RepairStart::Started(RepairJob { job, stream, _manager: manager })),
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
pub async fn repair_running() -> Result<bool> {
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
    /// The broker repair, run inside its transient unit.
    RepairBroker,
}

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
            return [SUPERVISE_SUBCOMMAND, EXEC_SUBCOMMAND, REPAIR_SUBCOMMAND]
                .contains(&first)
                .then(|| Err(format!("{first}: an argument is not valid UTF-8")));
        }
    };
    match first {
        SUPERVISE_SUBCOMMAND => Some(match rest.as_slice() {
            [] => Ok(Reexec::Supervise { display: false }),
            ["--display"] => Ok(Reexec::Supervise { display: true }),
            other => Err(format!("{SUPERVISE_SUBCOMMAND}: unexpected arguments {other:?}")),
        }),
        EXEC_SUBCOMMAND => Some(parse_exec(&rest)),
        REPAIR_SUBCOMMAND => Some(if rest.is_empty() {
            Ok(Reexec::RepairBroker)
        } else {
            Err(format!("{REPAIR_SUBCOMMAND} takes no arguments"))
        }),
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
    })
}

/// The crate logs through `tracing`; without a subscriber every word it says is dropped, and a
/// failed boot would leave nothing to read. Its own `main` installs this same subscriber.
fn init_tracing() {
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
fn repair_main() -> i32 {
    init_tracing();
    let say = |line: &str| eprintln!("teams-lite(broker-repair): {line}");
    if crate::read_only() {
        say("refused: TEAMS_LITE_READ_ONLY=1 — a read-only process never restarts the container");
        return 2;
    }

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
/// THE BOOT NEVER UPDATES THE IMAGE. `backend::start` checks the registry and, when the tag has
/// moved, deletes the rootfs and pulls the whole image before it boots — with `auto_update` on,
/// which is the crate's default. Here that would happen with the container already stopped,
/// under [`REPAIR_TIMEOUT`], over a registry call with no deadline: a repair killed in the
/// middle leaves no container at all. So the boot is handed a COPY of the configuration with
/// updates off, and the user's own setting is never written back changed; the next ordinary
/// `intune-container start` updates as it always did.
///
/// The display is a fixed headless one rather than `DisplayInfo::detect()`: `backend::start`
/// does not read it, and detection would spawn `xauth` when the manager's environment carries
/// a `DISPLAY`. Headless is also what `ops::start` boots, so `display_forwarding` is cleared the
/// same way it does — on the original configuration, so the copy's `auto_update` never reaches
/// the disk.
fn restart_container() -> Result<Restart> {
    use intune_container::{backend, config::Config, display::DisplayInfo, lock::LifecycleLock};

    let _lock = LifecycleLock::acquire().context("take intune-container's lifecycle lock")?;
    match keyring_now()? {
        KeyringCheck::Locked => {}
        other => return Ok(Restart::NotNeeded(other)),
    }

    let mut config = Config::load().context("load intune-container's configuration")?;
    if backend::is_running(&config) {
        backend::stop(&config).context("stop the container")?;
    }
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
    Ok(Restart::Done)
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

    // The two halves of "a repair never pulls the image": the boot gets a copy with updates
    // off, and the copy is never what is saved.
    #[test]
    fn a_repair_boots_without_an_image_update_and_never_saves_that() {
        let source = include_str!("intune.rs");
        let body = source
            .split("fn restart_container() -> Result<Restart> {")
            .nth(1)
            .expect("restart_container")
            .split("\n}\n")
            .next()
            .expect("restart_container ends");
        let lock = body.find("LifecycleLock::acquire()").expect("takes the lock");
        let recheck = body.find("keyring_now()").expect("asks the keyring again");
        let stop = body.find("backend::stop(").expect("stops");
        assert!(lock < recheck && recheck < stop, "the keyring is asked again inside the lock, before the stop");
        assert!(body.contains("boot.auto_update = false;"));
        assert!(body.contains("backend::start(&mut boot,"), "the boot runs from the copy");
        assert!(!body.contains("boot.save("), "the copy with updates off is never saved");
    }

}
