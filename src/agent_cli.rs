//! Installing an agent CLI from the app, and keeping it up to date (Settings › AI providers).
//!
//! The local agent (see [`crate::agent`]) runs `claude` or `opencode`, found by name. On a
//! workstation those are the user's own installs; in teams-lite's container image there are none,
//! and there cannot be: Claude Code is "© Anthropic PBC. All rights reserved", so a published image
//! carrying it would be redistributing it — the objection that kept chess.com's sounds out of the
//! release asset. So the app FETCHES a CLI per machine, from where its vendor publishes it, on the
//! user's own press, and verifies it before anything runs it.
//!
//! **EVERY VERSION HAS A DIRECTORY OF ITS OWN, AND `current` IS A SYMLINK** —
//! `<store>/tools/<cli>/<version>/<binary>`, with `<store>/tools/bin/<binary>` pointing at
//! `../<cli>/current/<binary>`. The store is `$XDG_DATA_HOME/teams-lite` (the data volume, in the
//! image and under the chart), so a CLI survives every restart and every image upgrade. An update
//! is a rename of a new symlink over the old one, never a write into a binary: a run in flight
//! keeps the inode it started from, and the next run starts the new version.
//!
//! **WHERE EACH COMES FROM, AND WHAT VOUCHES FOR IT:**
//!
//!   - **Claude Code follows Anthropic's `stable` channel.** A plain-text file names a version;
//!     that version's `manifest.json` names the SHA-256 and size of the binary per platform, and
//!     `manifest.json.sig` is Anthropic's detached signature over it, checked against the release
//!     key committed beside this module and pinned by its fingerprint (see [`crate::openpgp`]).
//!     Linux builds are not signed one by one, so the signed manifest IS the chain: the channel
//!     file is unsigned, but all it can do is name a version, and the manifest that version
//!     publishes must say the same version. The binary travels as its zstd stream (about a third
//!     of its size), and the DECOMPRESSED bytes are what is checked against the signed digest.
//!   - **opencode follows its version 1 line.** npm's `opencode-ai@latest` is that line's newest
//!     release — OpenCode 2 is a different package — and it breaks the way this app runs it
//!     (`run` has no `--dir`, and it starts a background service that outlives the run), so a
//!     version whose major is not [`OPENCODE_MAJOR`] is refused rather than installed. The
//!     tarball comes from GitHub's release, which publishes no checksum file; GitHub's own API
//!     states the asset's SHA-256 (the release is immutable), and the download must match it.
//!     That is weaker than a signature, and it is the strongest statement upstream makes.
//!
//! **AN INSTALL ONLY EVER MOVES FORWARD.** A version that is not newer than the one on disk is a
//! no-op, so a channel pointed at an older release — the one thing an unsigned channel file can do
//! — never downgrades a working CLI.
//!
//! **ONE INSTALL OF A CLI AT A TIME, PER MACHINE.** This machine runs several backends against one
//! store, and two of them updating the same CLI would race over one directory. Each holds an
//! exclusive lock on `<store>/tools/<cli>/.lock` for the whole install; a second waits, then finds
//! the version already there and does nothing.
//!
//! **ITS FILES LIVE ON THE STORE VOLUME TOO** ([`AGENT_HOME_ENV`]). Claude Code keeps its login
//! and every session under `~/.claude`, opencode under `~/.config`, `~/.local/share` and
//! `~/.cache` — and in the image `HOME` is on a read-only root, where `--resume` silently finds no
//! session and a login can be neither saved nor refreshed. So the image declares an agent home on
//! the data volume, and every CLI this app starts runs with that as its `HOME` (see
//! [`prepare_child`]). Nothing image-wide moves: `XDG_DATA_HOME` would move the store itself.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::openpgp;

/// The declared home every agent CLI runs with, when set to an absolute path. The container image
/// sets it to a directory on the data volume (`packaging/docker/Dockerfile`).
pub const AGENT_HOME_ENV: &str = "TEAMS_LITE_AGENT_HOME";

/// Where Anthropic publishes Claude Code's native builds.
pub const CLAUDE_RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";
/// The channel followed. `latest` is a week ahead and moves daily; `stable` is what Anthropic
/// recommends for anything that is not a developer's own terminal.
pub const CLAUDE_CHANNEL: &str = "stable";
/// Anthropic's Claude Code release signing key, as `downloads.claude.ai/keys/claude-code.asc`
/// served it on 2026-11-04 (RSA 4096, created 2026-03-30, never expires).
const CLAUDE_KEY: &str = include_str!("keys/claude-code.asc");
/// That key's fingerprint, as Anthropic's own setup documentation prints it.
pub const CLAUDE_KEY_FINGERPRINT: &str = "31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE";

/// npm's record of opencode's version 1 line. `@opencode/cli` is OpenCode 2, a different package.
pub const OPENCODE_NPM_LATEST: &str = "https://registry.npmjs.org/opencode-ai/latest";
/// GitHub's API for one tagged opencode release — the only place its asset digests are stated.
pub const OPENCODE_RELEASE_API: &str = "https://api.github.com/repos/anomalyco/opencode/releases/tags";
/// Where opencode's release assets are downloaded from.
pub const OPENCODE_DOWNLOADS: &str = "https://github.com/anomalyco/opencode/releases/download";
/// The only opencode major this app knows how to run (see the module header).
pub const OPENCODE_MAJOR: u64 = 1;

/// The most a small document (a channel file, a manifest, an API answer) may weigh.
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
/// The most a binary may weigh, compressed or not. Claude Code is about 340 MB and growing.
const MAX_BINARY_BYTES: u64 = 1024 * 1024 * 1024;
/// A transfer that receives nothing for this long has stopped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// How long one install waits for another process's install of the same CLI to finish.
const LOCK_WAIT: Duration = Duration::from_secs(20 * 60);

/// Whether a newer release of a CLI this app installed is taken on its own. The store holds `"0"`
/// once the user switched it off; anything else — an absent row included — is on, because keeping
/// what this app installed current is what installing it from here promised.
pub const SETTING_AUTO_UPDATE: &str = "agent_cli_auto_update";

/// Read [`SETTING_AUTO_UPDATE`].
pub fn auto_update_from_setting(stored: Option<&str>) -> bool {
    stored.map(str::trim) != Some("0")
}

/// One agent CLI this app can install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    Claude,
    Opencode,
}

impl Tool {
    pub const ALL: [Tool; 2] = [Tool::Claude, Tool::Opencode];

    /// The tool behind a backend's name (`agent_policy::BACKENDS`), which is also its program.
    pub fn named(name: &str) -> Option<Tool> {
        match name {
            "claude" => Some(Tool::Claude),
            "opencode" => Some(Tool::Opencode),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Opencode => "opencode",
        }
    }

    /// The executable's name — what the backend looks up, and what the tarball holds.
    pub fn program(self) -> &'static str {
        self.name()
    }

    /// Roughly what one install downloads, for the sentence beside the button. A STATEMENT OF
    /// SIZE, never a bound: measured on 2026-11-04 (Claude Code 2.1.318's zstd stream was 123 MB,
    /// opencode 1.19.5's tarball 80 MB), and Claude Code grew 15% in the eight days before that.
    pub fn download_estimate_bytes(self) -> u64 {
        match self {
            Tool::Claude => 125_000_000,
            Tool::Opencode => 80_000_000,
        }
    }

    /// Who publishes it, for a sentence a reader reads.
    pub fn publisher(self) -> &'static str {
        match self {
            Tool::Claude => "Anthropic",
            Tool::Opencode => "the opencode project",
        }
    }
}

// ---- versions -----------------------------------------------------------------------------------

/// A release version, `MAJOR.MINOR.PATCH` — the only shape either vendor uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    /// Strict: three dot-separated runs of at most six digits, nothing else. A version becomes a
    /// directory name and part of a URL, so nothing that could be a path is ever read as one.
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let mut next = || -> Option<u64> {
            let part = parts.next()?;
            if part.is_empty() || part.len() > 6 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        let version = Version(next()?, next()?, next()?);
        parts.next().is_none().then_some(version)
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Is `latest` an update over `installed`? Only a strictly newer version is.
pub fn is_update(installed: Option<&str>, latest: Option<&str>) -> bool {
    match (installed.and_then(Version::parse), latest.and_then(Version::parse)) {
        (Some(installed), Some(latest)) => latest > installed,
        _ => false,
    }
}

// ---- platforms ----------------------------------------------------------------------------------

/// The platform names each vendor publishes for THIS build's target, or `None` where it publishes
/// none. Decided by how teams-lite itself was compiled, which is exactly the machine it runs on: a
/// glibc build is not a musl one, and the image is glibc.
fn platform(tool: Tool, os: &str, arch: &str, musl: bool) -> Option<&'static str> {
    if os != "linux" {
        return None;
    }
    Some(match (tool, arch, musl) {
        (Tool::Claude, "x86_64", false) => "linux-x64",
        (Tool::Claude, "x86_64", true) => "linux-x64-musl",
        (Tool::Claude, "aarch64", false) => "linux-arm64",
        (Tool::Claude, "aarch64", true) => "linux-arm64-musl",
        // The BASELINE build on x86-64: it needs no AVX2, and the AVX2 one is a different binary
        // that a node without it may not run. On arm64 there is only one build.
        (Tool::Opencode, "x86_64", false) => "opencode-linux-x64-baseline.tar.gz",
        (Tool::Opencode, "x86_64", true) => "opencode-linux-x64-baseline-musl.tar.gz",
        (Tool::Opencode, "aarch64", false) => "opencode-linux-arm64.tar.gz",
        (Tool::Opencode, "aarch64", true) => "opencode-linux-arm64-musl.tar.gz",
        _ => return None,
    })
}

/// This machine's platform name for `tool`, or `None` when the vendor publishes no build for it.
pub fn this_platform(tool: Tool) -> Option<&'static str> {
    platform(
        tool,
        std::env::consts::OS,
        std::env::consts::ARCH,
        cfg!(target_env = "musl"),
    )
}

// ---- layout -------------------------------------------------------------------------------------

/// `$XDG_DATA_HOME/teams-lite`, falling back to `~/.local/share/teams-lite` — the directory the
/// store lives in, which is the data volume in the image.
pub fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .map(|home| home.join(".local/share"))
        })?;
    Some(base.join("teams-lite"))
}

/// `<data dir>/tools` — beside the store, on the data volume in the image.
pub fn tools_dir() -> Option<PathBuf> {
    Some(data_dir()?.join("tools"))
}

/// The directory every version of one tool lives in.
fn tool_dir(root: &Path, tool: Tool) -> PathBuf {
    root.join(tool.name())
}

/// The stable path the backend runs: `<root>/bin/<program>`, a symlink into `current`.
fn bin_path(root: &Path, tool: Tool) -> PathBuf {
    root.join("bin").join(tool.program())
}

/// This app's copy of a program, when one is installed and its link resolves to a file.
pub fn managed_program(program: &str) -> Option<PathBuf> {
    let tool = Tool::named(program)?;
    let path = bin_path(&tools_dir()?, tool);
    path.is_file().then_some(path)
}

/// Whether `path` — a program the backend resolved — is this app's own copy.
pub fn is_managed(path: &Path) -> bool {
    let Some(root) = tools_dir() else {
        return false;
    };
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(path).starts_with(canonical(&root))
}

/// The version this app installed, read off the `current` link.
pub fn installed_version(tool: Tool) -> Option<String> {
    installed_version_in(&tools_dir()?, tool)
}

fn installed_version_in(root: &Path, tool: Tool) -> Option<String> {
    let target = std::fs::read_link(tool_dir(root, tool).join("current")).ok()?;
    let name = target.file_name()?.to_str()?;
    // The link is ours, but what is on disk is never believed on the strength of its name alone:
    // a version that does not parse, or whose binary is gone, is no install.
    let version = Version::parse(name)?;
    tool_dir(root, tool)
        .join(name)
        .join(tool.program())
        .is_file()
        .then(|| version.to_string())
}

/// How much this app's copy of a tool weighs on disk.
pub fn installed_bytes(tool: Tool) -> Option<u64> {
    let root = tools_dir()?;
    let version = installed_version_in(&root, tool)?;
    std::fs::metadata(tool_dir(&root, tool).join(version).join(tool.program()))
        .ok()
        .map(|meta| meta.len())
}

// ---- the agent's home ---------------------------------------------------------------------------

/// The declared agent home, when one is set and absolute.
pub fn agent_home() -> Option<PathBuf> {
    std::env::var_os(AGENT_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// The variables a CLI's own files are found by, removed from its environment when an agent home
/// is in force, so every one of them derives from `HOME` and lands on the store volume.
pub const RELOCATED_VARIABLES: [&str; 4] =
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];

/// Shape the environment of one agent CLI child.
///
/// Two independent halves:
///
///   - **an agent home** ([`AGENT_HOME_ENV`]) becomes the child's `HOME`, created `0700` when
///     missing, with the XDG variables removed so nothing a CLI writes escapes it;
///   - **this app's own copy** is told not to update itself (`DISABLE_UPDATES=1` for Claude Code,
///     `OPENCODE_DISABLE_AUTOUPDATE=1` for opencode), because its versions are this module's to
///     manage: Claude Code's own updater would write 340 MB versions into its home and move a
///     launcher this app does not use. The user's own install is left exactly as they set it up.
pub fn prepare_child(command: &mut std::process::Command, program: &str, managed: bool) {
    prepare_child_with(command, program, managed, agent_home().as_deref());
}

/// [`prepare_child`] with the agent home handed in, so both halves are tested without touching
/// this process's own environment.
pub(crate) fn prepare_child_with(
    command: &mut std::process::Command,
    program: &str,
    managed: bool,
    home: Option<&Path>,
) {
    if let Some(home) = home {
        if let Err(e) = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home) {
            eprintln!("[agent] could not create the agent home {}: {e}", home.display());
        }
        command.env("HOME", home);
        for variable in RELOCATED_VARIABLES {
            command.env_remove(variable);
        }
    }
    if managed {
        match Tool::named(program) {
            Some(Tool::Claude) => {
                command.env("DISABLE_UPDATES", "1");
            }
            Some(Tool::Opencode) => {
                command.env("OPENCODE_DISABLE_AUTOUPDATE", "1");
            }
            None => {}
        }
    }
}

// ---- releases -----------------------------------------------------------------------------------

/// The newest version upstream offers, by the cheapest request that says so — one small document,
/// and never GitHub's API (whose unauthenticated budget the app's own update check spends).
pub async fn latest_version(http: &reqwest::Client, tool: Tool) -> Result<String> {
    match tool {
        Tool::Claude => {
            let url = format!("{CLAUDE_RELEASES}/{CLAUDE_CHANNEL}");
            let body = get_document(http, &url, 64).await?;
            claude_channel_version(&body)
        }
        Tool::Opencode => {
            let body = get_document(http, OPENCODE_NPM_LATEST, MAX_DOCUMENT_BYTES).await?;
            opencode_npm_version(&body)
        }
    }
}

/// The version a Claude Code channel file names.
fn claude_channel_version(body: &[u8]) -> Result<String> {
    let text = std::str::from_utf8(body).context("the release channel is not text")?.trim();
    let version = Version::parse(text)
        .with_context(|| format!("the release channel names `{}`, which is not a version", text.escape_debug()))?;
    Ok(version.to_string())
}

/// The version npm's `opencode-ai@latest` names — refused unless it is the major this app runs.
fn opencode_npm_version(body: &[u8]) -> Result<String> {
    #[derive(Deserialize)]
    struct Latest {
        version: String,
    }
    let latest: Latest = serde_json::from_slice(body).context("npm's answer for opencode-ai is not its record")?;
    let version = Version::parse(&latest.version)
        .with_context(|| format!("npm names opencode `{}`, which is not a version", latest.version))?;
    ensure!(
        version.0 == OPENCODE_MAJOR,
        "npm's newest opencode is {version}, and this build runs OpenCode {OPENCODE_MAJOR} only — \
         its successor changed how a run is started"
    );
    Ok(version.to_string())
}

/// One release, resolved: what to download and what it must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tool: Tool,
    pub version: String,
    artifact: Artifact,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Artifact {
    /// The binary's size and SHA-256 from Anthropic's SIGNED manifest.
    Claude { platform: &'static str, sha256: String, size: u64 },
    /// The tarball's size and SHA-256 from GitHub's release API.
    Opencode { asset: &'static str, sha256: String, size: u64 },
}

/// Resolve `version` of `tool` for this machine.
pub async fn resolve(http: &reqwest::Client, tool: Tool, version: &str, now_unix: u64) -> Result<Release> {
    let platform = this_platform(tool)
        .with_context(|| format!("{} publishes no {} build for this machine", tool.publisher(), tool.name()))?;
    ensure!(Version::parse(version).is_some(), "`{version}` is not a version");
    match tool {
        Tool::Claude => {
            let base = format!("{CLAUDE_RELEASES}/{version}");
            let manifest = get_document(http, &format!("{base}/manifest.json"), MAX_DOCUMENT_BYTES).await?;
            let signature =
                get_document(http, &format!("{base}/manifest.json.sig"), openpgp::MAX_SIGNATURE_BYTES).await?;
            claude_release(&manifest, &signature, version, platform, now_unix)
        }
        Tool::Opencode => {
            let url = format!("{OPENCODE_RELEASE_API}/v{version}");
            let body = get_document(http, &url, MAX_DOCUMENT_BYTES).await?;
            opencode_release(&body, version, platform)
        }
    }
}

/// A Claude Code release from its manifest — only once Anthropic's signature over those exact bytes
/// verifies, and only when the manifest names the version that was asked for.
fn claude_release(
    manifest: &[u8],
    signature: &[u8],
    version: &str,
    platform: &'static str,
    now_unix: u64,
) -> Result<Release> {
    let key = openpgp::parse_public_key(CLAUDE_KEY, CLAUDE_KEY_FINGERPRINT)
        .context("read the pinned Claude Code release key")?;
    openpgp::verify_detached(&key, manifest, signature, now_unix)
        .context("Claude Code's release manifest is not signed by Anthropic's release key — refused")?;

    #[derive(Deserialize)]
    struct Manifest {
        version: String,
        platforms: std::collections::BTreeMap<String, Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        binary: String,
        checksum: String,
        size: u64,
    }
    let manifest: Manifest = serde_json::from_slice(manifest).context("the signed manifest is not a manifest")?;
    // The channel file is unsigned, so it could name one version and serve another's manifest; the
    // version INSIDE the signature is the one that counts.
    ensure!(
        manifest.version == version,
        "the signed manifest is for {} and {version} was asked for — refused",
        manifest.version
    );
    let entry = manifest
        .platforms
        .get(platform)
        .with_context(|| format!("Claude Code {version} publishes no {platform} build"))?;
    ensure!(entry.binary == "claude", "the manifest names an unexpected binary `{}`", entry.binary);
    ensure!(is_sha256_hex(&entry.checksum), "the manifest's checksum is not a SHA-256");
    ensure!(
        entry.size > 0 && entry.size <= MAX_BINARY_BYTES,
        "the manifest states a size of {} bytes, which no binary has",
        entry.size
    );
    Ok(Release {
        tool: Tool::Claude,
        version: version.to_string(),
        artifact: Artifact::Claude {
            platform,
            sha256: entry.checksum.to_ascii_lowercase(),
            size: entry.size,
        },
    })
}

/// An opencode release from GitHub's answer for its tag.
fn opencode_release(body: &[u8], version: &str, asset: &'static str) -> Result<Release> {
    #[derive(Deserialize)]
    struct ReleaseJson {
        tag_name: String,
        assets: Vec<Asset>,
    }
    #[derive(Deserialize)]
    struct Asset {
        name: String,
        size: u64,
        digest: Option<String>,
    }
    let release: ReleaseJson = serde_json::from_slice(body).context("GitHub's answer is not a release")?;
    ensure!(
        release.tag_name == format!("v{version}"),
        "GitHub answered release {} for v{version} — refused",
        release.tag_name
    );
    let found = release
        .assets
        .iter()
        .find(|a| a.name == asset)
        .with_context(|| format!("opencode {version} publishes no {asset}"))?;
    let sha256 = found
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|hex| is_sha256_hex(hex))
        .with_context(|| format!("GitHub states no SHA-256 for {asset}, so it cannot be verified — refused"))?;
    ensure!(
        found.size > 0 && found.size <= MAX_BINARY_BYTES,
        "GitHub states a size of {} bytes for {asset}",
        found.size
    );
    Ok(Release {
        tool: Tool::Opencode,
        version: version.to_string(),
        artifact: Artifact::Opencode {
            asset,
            sha256: sha256.to_ascii_lowercase(),
            size: found.size,
        },
    })
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---- installing ---------------------------------------------------------------------------------

/// Where an install is, for the bar a page draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Reading which version is newest, and what it must be.
    Resolving,
    /// Bytes arriving: `received` of `total` (0 when unknown).
    Downloading { received: u64, total: u64 },
    /// Decompressing and checking what arrived.
    Unpacking,
}

/// How an install ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A new version is now the one that runs.
    Installed { version: String },
    /// Nothing newer was found; this version was already installed.
    Current { version: String },
}

/// Install the newest version of `tool` this machine can run, or do nothing when it is already
/// here. The whole of it holds the tool's machine-wide lock.
pub async fn install<F>(http: &reqwest::Client, tool: Tool, now_unix: u64, on_phase: F) -> Result<Outcome>
where
    F: FnMut(Phase),
{
    let root = tools_dir().context("no XDG_DATA_HOME and no HOME — nowhere to install a CLI")?;
    install_in(&root, http, tool, now_unix, on_phase).await
}

async fn install_in<F>(root: &Path, http: &reqwest::Client, tool: Tool, now_unix: u64, mut on_phase: F) -> Result<Outcome>
where
    F: FnMut(Phase),
{
    let root = root.to_path_buf();
    ensure!(
        this_platform(tool).is_some(),
        "{} publishes no {} build for this machine",
        tool.publisher(),
        tool.name()
    );
    let dir = tool_dir(&root, tool);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let _lock = lock_tool(&dir).await?;
    // Holding the lock, nobody else is staging this tool — so whatever a staging directory or a
    // half-made link is doing here, it is left over from a process that died mid-install, and it
    // can weigh as much as a whole binary.
    clear_leftovers(&dir);

    on_phase(Phase::Resolving);
    let version = latest_version(http, tool).await?;
    if let Some(installed) = installed_version_in(&root, tool) {
        if !is_update(Some(&installed), Some(&version)) {
            link_bin(&root, tool)?;
            return Ok(Outcome::Current { version: installed });
        }
    }
    let release = resolve(http, tool, &version, now_unix).await?;

    let staging = dir.join(format!(".staging.{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).with_context(|| format!("create {}", staging.display()))?;
    let fetched = fetch(http, &release, &staging, &mut on_phase).await;
    let activated = fetched.and_then(|()| activate(&root, tool, &release.version, &staging));
    if let Err(e) = activated {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(Outcome::Installed { version: release.version })
}

/// Download and unpack one release into `staging/<program>`, verified.
async fn fetch<F>(http: &reqwest::Client, release: &Release, staging: &Path, on_phase: &mut F) -> Result<()>
where
    F: FnMut(Phase),
{
    let binary = staging.join(release.tool.program());
    match &release.artifact {
        Artifact::Claude { platform, sha256, size } => {
            let base = format!("{CLAUDE_RELEASES}/{}/{platform}", release.version);
            let compressed = staging.join("claude.zst");
            match download(http, &format!("{base}/claude.zst"), &compressed, None, on_phase).await {
                Ok(_) => {
                    on_phase(Phase::Unpacking);
                    let (src, dest, size, sha) = (compressed.clone(), binary.clone(), *size, sha256.clone());
                    tokio::task::spawn_blocking(move || unpack_zstd(&src, &dest, size, &sha))
                        .await
                        .context("the unpacking task stopped")??;
                    let _ = std::fs::remove_file(&compressed);
                }
                // The zstd stream is an optimisation the installer script itself treats as one:
                // a release that publishes only the plain binary is downloaded plain.
                Err(e) if e.downcast_ref::<NotFound>().is_some() => {
                    let (received, digest) = download(http, &format!("{base}/claude"), &binary, Some(*size), on_phase).await?;
                    on_phase(Phase::Unpacking);
                    verify_bytes("Claude Code", received, &digest, *size, sha256)?;
                }
                Err(e) => return Err(e),
            }
        }
        Artifact::Opencode { asset, sha256, size } => {
            let url = format!("{OPENCODE_DOWNLOADS}/v{}/{asset}", release.version);
            let tarball = staging.join(asset);
            let (received, digest) = download(http, &url, &tarball, Some(*size), on_phase).await?;
            verify_bytes(asset, received, &digest, *size, sha256)?;
            on_phase(Phase::Unpacking);
            let (src, dest) = (tarball.clone(), binary.clone());
            tokio::task::spawn_blocking(move || unpack_opencode(&src, &dest))
                .await
                .context("the unpacking task stopped")??;
            let _ = std::fs::remove_file(&tarball);
        }
    }
    ensure_elf(&binary)?;
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("make {} executable", binary.display()))?;
    Ok(())
}

/// Remove what an install that died left in a tool's directory: staging directories and links
/// that were never renamed into place. Called only with the tool's lock held.
fn clear_leftovers(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(".staging.") || name.starts_with(".current.")) {
            continue;
        }
        let path = entry.path();
        let removed = if path.is_dir() && !path.is_symlink() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = removed {
            eprintln!("[agent-cli] could not remove the leftover {}: {e}", path.display());
        }
    }
}

/// A download answered 404 — the one failure that means "not published", never "try again".
#[derive(Debug)]
struct NotFound(String);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not published (404)", self.0)
    }
}

impl std::error::Error for NotFound {}

/// Stream `url` to `dest`, hashing as it goes. `expected` is the length the release states, checked
/// against the response's own before a byte is written, and the read is refused at the first byte
/// past it. Answers the bytes received and their SHA-256.
async fn download<F>(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected: Option<u64>,
    on_phase: &mut F,
) -> Result<(u64, String)>
where
    F: FnMut(Phase),
{
    // Bounded until the answer starts as well as between its chunks: a server that never answers
    // must not hold the install, and the CLI's lock, for ever. A bound on the WHOLE transfer would
    // be the wrong one — a slow link takes as long as it takes.
    let resp = tokio::time::timeout(IDLE_TIMEOUT, http.get(url).send())
        .await
        .map_err(|_| anyhow!("{url} did not answer for {} seconds", IDLE_TIMEOUT.as_secs()))?
        .with_context(|| format!("download {url}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(NotFound(url.to_string()).into());
    }
    ensure!(resp.status().is_success(), "download {url} -> {}", resp.status());
    let stated = resp.content_length();
    if let (Some(stated), Some(expected)) = (stated, expected) {
        ensure!(
            stated == expected,
            "{url} is {stated} bytes and the release states {expected} — the file may have been replaced"
        );
    }
    let limit = expected.unwrap_or(MAX_BINARY_BYTES);
    if let Some(stated) = stated {
        ensure!(stated <= limit, "{url} is {stated} bytes, more than any release of it");
    }
    let total = expected.or(stated).unwrap_or(0);

    let mut out = File::create(dest).with_context(|| format!("create {}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut resp = resp;
    on_phase(Phase::Downloading { received: 0, total });
    loop {
        let chunk = tokio::time::timeout(IDLE_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| anyhow!("the download of {url} stopped — nothing arrived for {} seconds", IDLE_TIMEOUT.as_secs()))?
            .with_context(|| format!("read {url}"))?;
        let Some(chunk) = chunk else { break };
        received += chunk.len() as u64;
        ensure!(received <= limit, "{url} is longer than {limit} bytes — refused");
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| disk_error(e, dest))?;
        on_phase(Phase::Downloading { received, total });
    }
    out.sync_all().map_err(|e| disk_error(e, dest))?;
    Ok((received, crate::pinned_download::hex(&hasher.finalize())))
}

/// A write that failed, said in words that name the commonest cause.
fn disk_error(error: std::io::Error, path: &Path) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::StorageFull {
        let dir = path.parent().unwrap_or(path);
        return anyhow!("the volume holding {} is full — free some room on it, then try again", dir.display());
    }
    anyhow::Error::new(error).context(format!("write {}", path.display()))
}

fn verify_bytes(what: &str, received: u64, digest: &str, size: u64, sha256: &str) -> Result<()> {
    ensure!(
        received == size,
        "{what} arrived as {received} bytes and the release states {size} — the transfer stopped"
    );
    ensure!(
        digest.eq_ignore_ascii_case(sha256),
        "{what} is not the file its release states (its SHA-256 differs) — refused, because it would run \
         on this machine"
    );
    Ok(())
}

/// Decompress Claude Code's zstd stream into `dest`, refusing past `size` bytes, and check the
/// result against the SIGNED manifest's own size and digest.
fn unpack_zstd(src: &Path, dest: &Path, size: u64, sha256: &str) -> Result<()> {
    let input = File::open(src).with_context(|| format!("open {}", src.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(input).context("read the zstd stream")?;
    let mut out = File::create(dest).with_context(|| format!("create {}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = decoder.read(&mut buf).context("decompress Claude Code")?;
        if n == 0 {
            break;
        }
        written += n as u64;
        ensure!(written <= size, "Claude Code decompresses past the {size} bytes its manifest states — refused");
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| disk_error(e, dest))?;
    }
    out.sync_all().map_err(|e| disk_error(e, dest))?;
    verify_bytes("Claude Code", written, &crate::pinned_download::hex(&hasher.finalize()), size, sha256)
}

/// Take the one `opencode` executable out of its release tarball. Every other entry is ignored,
/// and an entry that is not a plain file is never followed.
fn unpack_opencode(src: &Path, dest: &Path) -> Result<()> {
    let input = File::open(src).with_context(|| format!("open {}", src.display()))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
    for entry in archive.entries().context("read the opencode tarball")? {
        let mut entry = entry.context("read the opencode tarball")?;
        let path = entry.path().context("read a tarball entry's name")?.into_owned();
        let name = path.strip_prefix("./").unwrap_or(path.as_path());
        if name != Path::new("opencode") {
            continue;
        }
        ensure!(
            entry.header().entry_type().is_file(),
            "the tarball's `opencode` is not a plain file — refused"
        );
        let size = entry.header().size().context("read the entry's size")?;
        ensure!(size > 0 && size <= MAX_BINARY_BYTES, "the tarball's `opencode` is {size} bytes");
        let mut out = File::create(dest).with_context(|| format!("create {}", dest.display()))?;
        let copied = std::io::copy(&mut (&mut entry).take(size), &mut out).map_err(|e| disk_error(e, dest))?;
        ensure!(copied == size, "the tarball's `opencode` ended after {copied} of {size} bytes");
        out.sync_all().map_err(|e| disk_error(e, dest))?;
        return Ok(());
    }
    bail!("the opencode tarball holds no `opencode` executable")
}

/// The first four bytes of an executable for this OS. A sanity check behind the digest, never in
/// place of it.
fn ensure_elf(path: &Path) -> Result<()> {
    let mut magic = [0u8; 4];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .with_context(|| format!("read {}", path.display()))?;
    ensure!(magic == *b"\x7fELF", "{} is not an executable for this machine", path.display());
    Ok(())
}

/// Make a verified binary in `staging` the version that runs: rename it into its version's
/// directory, swing `current` to it by renaming a new link over the old, make sure `bin/` points
/// through `current`, and give every other version's disk back.
fn activate(root: &Path, tool: Tool, version: &str, staging: &Path) -> Result<()> {
    let dir = tool_dir(root, tool);
    let target = dir.join(version);
    if target.exists() {
        std::fs::remove_dir_all(&target).with_context(|| format!("remove {}", target.display()))?;
    }
    std::fs::rename(staging, &target)
        .with_context(|| format!("rename {} -> {}", staging.display(), target.display()))?;

    let fresh = dir.join(format!(".current.{}", std::process::id()));
    let _ = std::fs::remove_file(&fresh);
    std::os::unix::fs::symlink(version, &fresh).with_context(|| format!("link {}", fresh.display()))?;
    std::fs::rename(&fresh, dir.join("current")).context("switch to the new version")?;
    link_bin(root, tool)?;

    // Only now, with the new version the one that runs. A run still using an older binary keeps its
    // inode until it exits: unlinking a running executable is safe, overwriting one is not.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == version || name == "current" || name == ".lock" {
                continue;
            }
            let path = entry.path();
            let removed = if path.is_dir() && !path.is_symlink() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(e) = removed {
                eprintln!("[agent-cli] could not remove {}: {e}", path.display());
            }
        }
    }
    Ok(())
}

/// `<root>/bin/<program>` → `../<tool>/current/<program>`, made or mended.
fn link_bin(root: &Path, tool: Tool) -> Result<()> {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).with_context(|| format!("create {}", bin.display()))?;
    let link = bin_path(root, tool);
    let target = Path::new("..").join(tool.name()).join("current").join(tool.program());
    if std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) {
        return Ok(());
    }
    let fresh = bin.join(format!(".{}.{}", tool.program(), std::process::id()));
    let _ = std::fs::remove_file(&fresh);
    std::os::unix::fs::symlink(&target, &fresh).with_context(|| format!("link {}", fresh.display()))?;
    std::fs::rename(&fresh, &link).with_context(|| format!("place {}", link.display()))?;
    Ok(())
}

/// Give back everything this app installed for `tool`. Refused while it is being installed — by
/// this process or another — rather than pulled out from under the install.
pub fn remove(tool: Tool) -> Result<u64> {
    let root = tools_dir().context("no XDG_DATA_HOME and no HOME — nothing is installed")?;
    remove_in(&root, tool)
}

fn remove_in(root: &Path, tool: Tool) -> Result<u64> {
    let dir = tool_dir(root, tool);
    if !dir.exists() {
        return Ok(0);
    }
    let lock = open_lock(&dir)?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            bail!("{} is being installed on this machine right now — try again once that is done", tool.name())
        }
        Err(TryLockError::Error(e)) => return Err(anyhow::Error::new(e).context("lock the install")),
    }
    let freed = disk_usage(&dir);
    let link = bin_path(root, tool);
    if link.is_symlink() {
        std::fs::remove_file(&link).with_context(|| format!("remove {}", link.display()))?;
    }
    std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    Ok(freed)
}

fn disk_usage(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_dir() {
        std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|e| disk_usage(&e.path())).sum())
            .unwrap_or(0)
    } else if meta.is_file() {
        meta.len()
    } else {
        0
    }
}

fn open_lock(dir: &Path) -> Result<File> {
    let path = dir.join(".lock");
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))
}

/// Take a tool's install lock, waiting for another process's install to end.
///
/// A NON-blocking try in a loop rather than a blocking `flock`: this runs on the async runtime, and
/// a lock taken twice in one process through two descriptions would otherwise wait on itself.
async fn lock_tool(dir: &Path) -> Result<File> {
    let file = open_lock(dir)?;
    let deadline = tokio::time::Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(TryLockError::WouldBlock) => {
                bail!("another install on this machine has held this CLI for {} minutes", LOCK_WAIT.as_secs() / 60)
            }
            Err(TryLockError::Error(e)) => return Err(anyhow::Error::new(e).context("lock the install")),
        }
    }
}

/// Fetch a small document, bounded.
async fn get_document(http: &reqwest::Client, url: &str, max: usize) -> Result<Vec<u8>> {
    let mut resp = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .with_context(|| format!("fetch {url}"))?;
    ensure!(resp.status().is_success(), "fetch {url} -> {}", resp.status());
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.with_context(|| format!("read {url}"))? {
        body.extend_from_slice(&chunk);
        ensure!(body.len() <= max, "{url} answered more than {max} bytes — refused");
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &[u8] = include_bytes!("testdata/claude-manifest-2.1.311.json");
    const SIGNATURE: &[u8] = include_bytes!("testdata/claude-manifest-2.1.311.json.sig");
    const NOW: u64 = 1_793_050_000;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("teams-lite-agent-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_version_is_three_numbers_and_nothing_that_could_be_a_path() {
        assert_eq!(Version::parse("2.1.311"), Some(Version(2, 1, 311)));
        for bad in ["", "2.1", "2.1.311.1", "v2.1.311", "2.1.x", "../2.1.3", "2.1.3/..", " 2.1.3", "1234567.0.0"] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
        assert!(Version(2, 1, 318) > Version(2, 1, 311));
        assert!(Version(2, 10, 0) > Version(2, 9, 99), "compared as numbers, never as text");
    }

    #[test]
    fn an_update_only_ever_moves_forward() {
        assert!(is_update(Some("2.1.311"), Some("2.1.318")));
        assert!(!is_update(Some("2.1.318"), Some("2.1.311")), "a channel pointed back is no update");
        assert!(!is_update(Some("2.1.318"), Some("2.1.318")));
        assert!(!is_update(None, Some("2.1.318")), "nothing installed is an install, not an update");
        assert!(!is_update(Some("2.1.318"), None));
    }

    #[test]
    fn the_platform_is_the_one_this_build_was_compiled_for() {
        assert_eq!(platform(Tool::Claude, "linux", "x86_64", false), Some("linux-x64"));
        assert_eq!(platform(Tool::Claude, "linux", "aarch64", true), Some("linux-arm64-musl"));
        // opencode's x86-64 build is the BASELINE one: the AVX2 build is a different binary.
        assert_eq!(
            platform(Tool::Opencode, "linux", "x86_64", false),
            Some("opencode-linux-x64-baseline.tar.gz")
        );
        assert_eq!(platform(Tool::Opencode, "linux", "aarch64", false), Some("opencode-linux-arm64.tar.gz"));
        assert_eq!(platform(Tool::Claude, "macos", "aarch64", false), None);
        assert_eq!(platform(Tool::Opencode, "linux", "riscv64", false), None);
    }

    #[test]
    fn the_channel_names_a_version_and_nothing_else() {
        assert_eq!(claude_channel_version(b"2.1.311\n").unwrap(), "2.1.311");
        assert!(claude_channel_version(b"<html>login</html>").is_err(), "a captive portal is no version");
    }

    #[test]
    fn opencode_follows_its_first_major_only() {
        assert_eq!(opencode_npm_version(br#"{"name":"opencode-ai","version":"1.19.5"}"#).unwrap(), "1.19.5");
        let refused = opencode_npm_version(br#"{"version":"2.2.5"}"#).unwrap_err().to_string();
        assert!(refused.contains("OpenCode 1 only"), "{refused}");
        assert!(opencode_npm_version(br#"{"version":"latest"}"#).is_err());
    }

    #[test]
    fn a_claude_release_is_read_only_from_a_manifest_anthropic_signed() {
        let release = claude_release(MANIFEST, SIGNATURE, "2.1.311", "linux-x64", NOW).unwrap();
        assert_eq!(release.version, "2.1.311");
        let Artifact::Claude { sha256, size, platform } = &release.artifact else {
            panic!("a Claude release")
        };
        assert_eq!(*platform, "linux-x64");
        assert_eq!(*size, 293_776_752, "the size the signed manifest states");
        assert!(is_sha256_hex(sha256));

        // The manifest's own version is what counts, not the one asked for.
        let refused = claude_release(MANIFEST, SIGNATURE, "2.1.318", "linux-x64", NOW).unwrap_err().to_string();
        assert!(refused.contains("asked for"), "{refused}");
        // And one changed byte voids it.
        let mut tampered = MANIFEST.to_vec();
        let at = tampered.len() - 10;
        tampered[at] ^= 0x01;
        let refused = claude_release(&tampered, SIGNATURE, "2.1.311", "linux-x64", NOW).unwrap_err();
        assert!(format!("{refused:#}").contains("not signed"), "{refused:#}");
    }

    #[test]
    fn an_opencode_release_needs_the_digest_github_states() {
        let digest = "17c200fd4b2289954cc01552559f9b6d03ec157b2ddfb5eb54144f491656333d";
        let answer = format!(
            r#"{{"tag_name":"v1.19.5","immutable":true,"assets":[
                {{"name":"opencode-linux-x64.tar.gz","size":79651896,"digest":"sha256:{}"}},
                {{"name":"opencode-linux-x64-baseline.tar.gz","size":79651821,"digest":"sha256:{digest}"}}]}}"#,
            "5".repeat(64)
        );
        let release = opencode_release(answer.as_bytes(), "1.19.5", "opencode-linux-x64-baseline.tar.gz").unwrap();
        assert_eq!(
            release.artifact,
            Artifact::Opencode {
                asset: "opencode-linux-x64-baseline.tar.gz",
                sha256: digest.to_string(),
                size: 79_651_821
            }
        );

        let no_digest = r#"{"tag_name":"v1.19.5","assets":[{"name":"opencode-linux-x64-baseline.tar.gz","size":5}]}"#;
        let refused = opencode_release(no_digest.as_bytes(), "1.19.5", "opencode-linux-x64-baseline.tar.gz")
            .unwrap_err()
            .to_string();
        assert!(refused.contains("cannot be verified"), "{refused}");

        let other_tag = answer.replace("v1.19.5", "v1.19.4");
        assert!(opencode_release(other_tag.as_bytes(), "1.19.5", "opencode-linux-x64-baseline.tar.gz").is_err());
    }

    #[test]
    fn a_zstd_stream_is_checked_against_the_signed_digest_after_it_is_decompressed() {
        let dir = scratch("zstd");
        let binary = b"\x7fELF and the rest of a binary".repeat(100);
        let compressed = zstd::encode_all(&binary[..], 3).unwrap();
        std::fs::write(dir.join("claude.zst"), &compressed).unwrap();
        let sha = crate::pinned_download::hex(&Sha256::digest(&binary));

        unpack_zstd(&dir.join("claude.zst"), &dir.join("claude"), binary.len() as u64, &sha).unwrap();
        assert_eq!(std::fs::read(dir.join("claude")).unwrap(), binary);

        let wrong = unpack_zstd(&dir.join("claude.zst"), &dir.join("claude"), binary.len() as u64, &"0".repeat(64))
            .unwrap_err()
            .to_string();
        assert!(wrong.contains("SHA-256 differs"), "{wrong}");
        // A stream that decompresses past the signed size is stopped at the first byte over it.
        let bomb = unpack_zstd(&dir.join("claude.zst"), &dir.join("claude"), 10, &sha).unwrap_err().to_string();
        assert!(bomb.contains("past the 10 bytes"), "{bomb}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tarball(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (name, body, kind) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*kind);
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            if *kind == tar::EntryType::Symlink {
                header.set_link_name("/etc/passwd").unwrap();
            }
            header.set_cksum();
            builder.append_data(&mut header, name, *body).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn only_the_opencode_executable_is_taken_out_of_its_tarball() {
        let dir = scratch("tar");
        let archive = tarball(&[
            ("README", b"hello", tar::EntryType::Regular),
            ("opencode", b"\x7fELF-opencode", tar::EntryType::Regular),
        ]);
        std::fs::write(dir.join("o.tar.gz"), archive).unwrap();
        unpack_opencode(&dir.join("o.tar.gz"), &dir.join("out")).unwrap();
        assert_eq!(std::fs::read(dir.join("out")).unwrap(), b"\x7fELF-opencode");
        assert!(!dir.join("README").exists(), "nothing else is ever extracted");

        let link = tarball(&[("opencode", b"", tar::EntryType::Symlink)]);
        std::fs::write(dir.join("l.tar.gz"), link).unwrap();
        let refused = unpack_opencode(&dir.join("l.tar.gz"), &dir.join("out2")).unwrap_err().to_string();
        assert!(refused.contains("not a plain file"), "{refused}");

        let empty = tarball(&[("bin/other", b"x", tar::EntryType::Regular)]);
        std::fs::write(dir.join("e.tar.gz"), empty).unwrap();
        assert!(unpack_opencode(&dir.join("e.tar.gz"), &dir.join("out3")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn stage(root: &Path, tool: Tool, body: &[u8]) -> PathBuf {
        let staging = tool_dir(root, tool).join(format!(".staging.{}", std::process::id()));
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join(tool.program()), body).unwrap();
        staging
    }

    #[test]
    fn an_update_swings_a_link_and_gives_the_old_version_back() {
        let root = scratch("layout");
        let tool = Tool::Claude;
        assert_eq!(installed_version_in(&root, tool), None);

        activate(&root, tool, "2.1.311", &stage(&root, tool, b"old")).unwrap();
        assert_eq!(installed_version_in(&root, tool).as_deref(), Some("2.1.311"));
        // The backend runs bin/claude, which resolves through `current`.
        assert_eq!(std::fs::read(bin_path(&root, tool)).unwrap(), b"old");

        // A run in flight holds the old binary open; the update must not disturb what it reads.
        let mut running = File::open(bin_path(&root, tool)).unwrap();
        activate(&root, tool, "2.1.318", &stage(&root, tool, b"new")).unwrap();
        assert_eq!(installed_version_in(&root, tool).as_deref(), Some("2.1.318"));
        assert_eq!(std::fs::read(bin_path(&root, tool)).unwrap(), b"new");
        let mut held = String::new();
        running.read_to_string(&mut held).unwrap();
        assert_eq!(held, "old", "the running inode is unlinked, never overwritten");
        assert!(!tool_dir(&root, tool).join("2.1.311").exists(), "the old version's disk is given back");

        // And removing it takes everything, the link in bin/ included.
        let freed = remove_in(&root, tool).unwrap();
        assert_eq!(freed, 3);
        assert!(!bin_path(&root, tool).exists());
        assert_eq!(installed_version_in(&root, tool), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_install_that_died_leaves_nothing_the_next_one_keeps() {
        let root = scratch("leftovers");
        let dir = tool_dir(&root, Tool::Claude);
        activate(&root, Tool::Claude, "2.1.311", &stage(&root, Tool::Claude, b"x")).unwrap();
        std::fs::create_dir_all(dir.join(".staging.999999")).unwrap();
        std::fs::write(dir.join(".staging.999999/claude"), b"half a binary").unwrap();
        std::os::unix::fs::symlink("2.1.311", dir.join(".current.999999")).unwrap();
        clear_leftovers(&dir);
        assert!(!dir.join(".staging.999999").exists());
        assert!(!dir.join(".current.999999").exists());
        // What runs is untouched.
        assert_eq!(installed_version_in(&root, Tool::Claude).as_deref(), Some("2.1.311"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_version_whose_binary_is_gone_is_no_install() {
        let root = scratch("gone");
        activate(&root, Tool::Opencode, "1.19.5", &stage(&root, Tool::Opencode, b"x")).unwrap();
        std::fs::remove_file(tool_dir(&root, Tool::Opencode).join("1.19.5/opencode")).unwrap();
        assert_eq!(installed_version_in(&root, Tool::Opencode), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_removal_waits_for_no_install_and_refuses_one_in_flight() {
        let root = scratch("busy");
        activate(&root, Tool::Claude, "2.1.311", &stage(&root, Tool::Claude, b"x")).unwrap();
        let held = open_lock(&tool_dir(&root, Tool::Claude)).unwrap();
        held.try_lock().unwrap();
        let refused = remove_in(&root, Tool::Claude).unwrap_err().to_string();
        assert!(refused.contains("being installed"), "{refused}");
        drop(held);
        assert!(remove_in(&root, Tool::Claude).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_child_runs_in_the_agent_home_and_this_apps_copy_never_updates_itself() {
        let mut command = std::process::Command::new("true");
        prepare_child(&mut command, "claude", true);
        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into(), v.map(|v| v.to_string_lossy().into())))
            .collect();
        assert!(envs.contains(&("DISABLE_UPDATES".into(), Some("1".into()))));

        let mut theirs = std::process::Command::new("true");
        prepare_child(&mut theirs, "opencode", false);
        assert!(
            !theirs.get_envs().any(|(k, _)| k == "OPENCODE_DISABLE_AUTOUPDATE"),
            "the user's own install is left as they set it up"
        );
        let mut ours = std::process::Command::new("true");
        prepare_child(&mut ours, "opencode", true);
        assert!(ours.get_envs().any(|(k, v)| k == "OPENCODE_DISABLE_AUTOUPDATE" && v.is_some()));

        // Under an agent home, HOME is it and every XDG variable is REMOVED rather than inherited,
        // so nothing a CLI writes lands outside the volume.
        let home = scratch("home").join("agent-home");
        let mut homed = std::process::Command::new("true");
        homed.env("XDG_DATA_HOME", "/elsewhere");
        prepare_child_with(&mut homed, "opencode", true, Some(&home));
        let env = |name: &str| homed.get_envs().find(|(k, _)| *k == name).map(|(_, v)| v.map(|v| v.to_owned()));
        assert_eq!(env("HOME"), Some(Some(home.clone().into_os_string())));
        for variable in RELOCATED_VARIABLES {
            assert_eq!(env(variable), Some(None), "{variable} is removed from the child");
        }
        let mode = std::fs::metadata(&home).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the home holds credentials, so it is the user's alone");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    /// The image and this module are two halves of one rule — where a CLI keeps its files, and
    /// that this app's copy never updates itself — on two sides of a process boundary. A sign-in
    /// the helper saved anywhere a run does not look is a login nobody ever uses, so the two are
    /// pinned together here.
    #[test]
    fn the_image_runs_a_cli_exactly_where_the_backend_does() {
        let dockerfile = include_str!("../packaging/docker/Dockerfile");
        let helper = include_str!("../packaging/docker/teams-lite-agent");

        // The agent home is DECLARED, and on the data volume (the store's own directory).
        assert!(
            dockerfile.contains(&format!("{AGENT_HOME_ENV}=/home/teams/.local/share/teams-lite/")),
            "the image declares an agent home on the data volume"
        );
        // …and nothing image-wide is moved for it: XDG_DATA_HOME would move the store itself.
        for variable in RELOCATED_VARIABLES {
            assert!(
                !dockerfile.lines().any(|l| l.trim_start().starts_with(&format!("{variable}="))),
                "the image must not set {variable}"
            );
        }
        // ripgrep, which opencode would otherwise download unverified on its first search.
        assert!(dockerfile.contains("libcap2-bin ripgrep"), "the image installs ripgrep");
        assert!(dockerfile.contains("/usr/local/bin/teams-lite-agent"), "the helper is in the image");

        // The helper sets what `prepare_child` sets.
        assert!(helper.contains(AGENT_HOME_ENV));
        let unset = helper.lines().find(|l| l.trim_start().starts_with("unset ")).expect("an unset line");
        for variable in RELOCATED_VARIABLES {
            assert!(unset.contains(variable), "the helper removes {variable}, as a run does");
        }
        assert!(helper.contains("DISABLE_UPDATES=1") && helper.contains("OPENCODE_DISABLE_AUTOUPDATE=1"));
        // It finds the CLIs where this module installs them: `<data>/teams-lite/tools/bin`.
        assert!(helper.contains("teams-lite/tools/bin"));
        let root = Path::new("/d/teams-lite/tools");
        assert_eq!(bin_path(root, Tool::Claude), Path::new("/d/teams-lite/tools/bin/claude"));
    }

    /// The whole chain against the real vendors: the channel, the signed manifest, the zstd stream
    /// and the decompressed binary for Claude Code; npm, GitHub's digest and the tarball for opencode.
    /// About 200 MB of download, so it is run by hand:
    ///
    ///     cargo test --lib agent_cli::tests::the_real_clis_install_and_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "downloads both CLIs from their vendors"]
    async fn the_real_clis_install_and_verify() {
        let base = std::env::var_os("HOME").map(PathBuf::from).unwrap().join(".cache/teams-lite-agent-cli-live");
        let _ = std::fs::remove_dir_all(&base);
        let http = reqwest::Client::builder().user_agent(crate::USER_AGENT).build().unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        for tool in Tool::ALL {
            let mut last = None;
            let outcome = install_in(&base, &http, tool, now, |phase| last = Some(phase)).await.unwrap();
            let version = installed_version_in(&base, tool).expect("installed");
            assert_eq!(outcome, Outcome::Installed { version: version.clone() });
            assert!(matches!(last, Some(Phase::Unpacking)), "{last:?}");
            let status = std::process::Command::new(bin_path(&base, tool)).arg("--version").output().unwrap();
            println!("{} {version}: {}", tool.name(), String::from_utf8_lossy(&status.stdout).trim());
            assert!(status.status.success());
            // A second install finds it current and downloads nothing.
            let again = install_in(&base, &http, tool, now, |_| {}).await.unwrap();
            assert_eq!(again, Outcome::Current { version });
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
