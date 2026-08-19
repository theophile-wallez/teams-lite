// The update: is a newer `teams` build available, and can this one replace itself?
//
// teams-lite ships as a ROLLING `latest` GitHub release — CI republishes the
// `latest` tag on every push to master. There is no semantic version, so a
// build's identity is the git commit it was compiled from (embedded at build
// time as `TEAMS_BUILD_REV`; see build.rs). This module answers one question:
// "does the `latest` release point at a DIFFERENT commit than the one I'm
// running?" If so, a newer build exists.
//
// It lives in the backend, not the UI, because the UI never touches the network
// (local-first is enforced server-side). The server POLLS it — `spawn_release_poll`, every
// RELEASE_CHECK_INTERVAL for the whole life of the process, best-effort — and pushes an
// `update_available` event to the UI when the answer changes. It used to ask once at
// startup, which meant an app left open for weeks never learned about anything published
// after it booted: the only reliable way to be offered an update was to restart the app the
// button exists to restart. The request is claimed through the store so it stays ONE per
// machine (see `GITHUB_HOURLY_REQUESTS`, which is why that matters).
//
// The check's network call is deliberately unwrapped from the shared retry policy:
// an update check is a nicety, not core function — a single attempt that fails
// silently is exactly the right behaviour (offline, rate-limited, etc.).
//
// THE UPDATE ITSELF IS TWO STEPS, and the user takes both (see `update_download` /
// `update_apply` in src/bin/server.rs, and the button in
// web/src/components/update-button.tsx):
//
//   1. `download` streams the release asset into the cache and verifies it. It costs
//      130 MB on a metered connection, so it never happens on its own.
//   2. `install_binary` renames it over the `teams` binary this app is running from,
//      which is atomic — the running processes keep their open inode, and the next
//      start gets the new build. The RESTART is the launcher's (launcher/src/
//      update.ts): it owns the web server and the backend child, so it is the only
//      process that can put them both back up on the new build.
//
// WHICH INSTALL CAN DO THAT is `self_install`, and the honest answer is "only the
// `teams` command from install.sh". That binary IS the release asset, byte for byte,
// so replacing it is the whole update. A staged always-on service (see
// bin/teams-lite-service.sh) is not: it runs a separate backend binary and web bundle
// built from a checkout, with unit files and wrapper scripts beside them, and the
// release asset holds none of that shape. Swapping something in there would report
// success while the service kept running what it had — so this module refuses, and
// the UI keeps a link to the release instead of offering a button that lies.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

/// The GitHub repository that publishes the rolling `latest` release.
pub const REPO: &str = "theophile-wallez/teams-lite";

/// The release asset that IS the app: one self-contained `teams` binary, which
/// embeds the Bun runtime, the backend and the built web app (see launcher/build.ts).
/// The name matches what install.sh downloads for this architecture — teams-lite is
/// Linux/x86_64 only, and CI publishes exactly this one asset.
pub const ASSET_NAME: &str = "teams-linux-x64";

/// How long to wait on the GitHub API before giving up. An update check must
/// never hold anything up, so this is short.
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// What GitHub's REST API allows an UNAUTHENTICATED caller, per hour and per IP.
///
/// Measured against this repository on 2026-08-06, because the number decides how often
/// the release may be polled: the response says `x-ratelimit-limit: 60`, and a conditional
/// request buys nothing — an `If-None-Match` that answered `304` still moved
/// `x-ratelimit-used` from 2 to 3 to 4 on three successive requests. So the budget is 60
/// requests an hour for everything this app asks GitHub: the poll, the compare API behind
/// the changelog, and the re-read before every download.
///
/// It is a shared budget per MACHINE (an IP), which is why the poll is claimed through the
/// store rather than run per backend — see `Store::claim_release_check` and
/// `RELEASE_CHECK_INTERVAL` in src/bin/server.rs.
pub const GITHUB_HOURLY_REQUESTS: u32 = 60;

/// How long the DOWNLOAD may take. Generous next to the check: it is 130 MB the user
/// asked for and is watching a progress bar of, on whatever connection a phone-facing
/// machine has. Long enough to be irrelevant on any working link, short enough that a
/// stalled transfer ends by itself instead of leaving the button spinning for ever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Environment variable the `teams` command sets on the backend it spawns, naming the
/// binary IT was started from (`launcher/src/backend.ts`).
///
/// The backend cannot work that path out for itself: it runs from a copy of the
/// embedded backend under `~/.cache`, and its parent's `/proc/<ppid>/exe` is a guess
/// that breaks the moment a backend is attached to rather than spawned. The launcher
/// knows its own `process.execPath`, is the process that will exec the new build, and
/// is the only one that can restart the app — so it says so, once, and this variable
/// is also the proof that a launcher is there to do it.
pub const LAUNCHER_BIN_ENV: &str = "TEAMS_LITE_LAUNCHER_BIN";

/// A newer release than the one currently running. `current`/`latest` are short
/// commit SHAs for display; `url` points at the release page (what a user opens when
/// this install cannot replace itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub url: String,
    /// The downloadable binary, when the release publishes one for this machine.
    /// `None` means the release exists but carries no asset we could install — the
    /// notice then stays a link, exactly as it did before there was a button.
    pub asset: Option<Asset>,
}

/// The release asset to download: where it is, and how big it is.
///
/// The size comes from the GitHub API rather than from the transfer's own
/// `Content-Length`, so the progress bar has a total before the first byte arrives
/// and so a truncated download can be told from a complete one afterwards.
///
/// It describes the release AT THE MOMENT IT WAS READ, and nothing longer: `latest` is a
/// rolling tag that CI republishes on every push, so this size stops matching the file
/// behind that URL the next time the project ships. Read it again before a download —
/// never compare a transfer against a number an earlier check remembered.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Asset {
    pub url: String,
    pub size: u64,
}

/// The published `latest` release, as a fact about the REPOSITORY rather than about any
/// one build: the commit it was made from, its page, and the binary on it.
///
/// It is separate from [`UpdateInfo`] because the two have different owners. This is what
/// GitHub says and it is the same answer for every process on a machine — so it is read
/// ONCE per machine and shared through the store (see `SETTING_RELEASE`), which is what
/// keeps a two-minute poll inside GitHub's 60-requests-an-hour budget for an unauthenticated
/// caller. `UpdateInfo` is the comparison against ONE build, which is local, free, and
/// different for the staged pair and the released build running beside it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Release {
    /// The commit the release was built from, full length and lowercase.
    pub rev: String,
    pub url: String,
    pub asset: Option<Asset>,
}

/// Where the machine's last release read is kept, so every backend sharing this store
/// learns what `latest` names without asking GitHub itself.
pub const SETTING_RELEASE: &str = "release_latest";

/// When the machine last ASKED (epoch ms). It is the claim as well as the record: the
/// backend that moves it is the one that fetches, which is what makes the poll one
/// request per machine rather than one per backend (see `Store::claim_release_check`).
pub const SETTING_RELEASE_CHECKED_MS: &str = "release_checked_ms";

/// The commit this binary was built from, or `None` for a dev build.
///
/// build.rs always defines `TEAMS_BUILD_REV`, but leaves it empty for local
/// builds (CI sets it to the release commit). An empty value means "built from
/// source" — we return `None` so the caller skips the check entirely rather than
/// comparing against a blank and nagging every developer.
pub fn build_rev() -> Option<&'static str> {
    match option_env!("TEAMS_BUILD_REV") {
        Some(rev) if !rev.trim().is_empty() => Some(rev.trim()),
        _ => None,
    }
}

/// Check GitHub for a newer `latest` release than `current_rev`.
///
/// Returns `Ok(Some(info))` when the published `latest` release was built from a
/// different commit, `Ok(None)` when up to date (or the remote commit could not
/// be determined), and `Err` only on a network/HTTP failure the caller should
/// swallow.
///
/// One request and one comparison, for the caller that needs both at once: a download,
/// which must read the release again before it trusts a size. The repeating POLL uses the
/// two halves apart — [`fetch_release`] once per machine, [`compare`] in every backend —
/// because the request is the scarce half.
pub async fn check(http: &reqwest::Client, current_rev: &str) -> Result<Option<UpdateInfo>> {
    Ok(fetch_release(http).await?.as_ref().and_then(|r| compare(r, current_rev)))
}

/// Ask GitHub what the rolling `latest` release is now. The network half, and the only
/// half that costs anything.
///
/// `Ok(None)` means GitHub answered but the release's commit could not be identified —
/// never a guess, because a wrong answer here is a false alarm on every client. `Err` is a
/// network or HTTP failure the caller swallows; the API answers `403` once this IP has
/// spent its hour, which is why the poll is shared rather than made per backend.
///
/// The `http` client is reused from the backend (it already carries a User-Agent, which
/// the GitHub API requires).
pub async fn fetch_release(http: &reqwest::Client) -> Result<Option<Release>> {
    let api = format!("https://api.github.com/repos/{REPO}/releases/tags/latest");
    let resp = http
        .get(&api)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("github releases request")?;

    // Non-2xx (rate limit, no release yet, transient 5xx): treat as "no info".
    // Bail with the status so the caller can log it; it is never fatal.
    if !resp.status().is_success() {
        anyhow::bail!("github releases -> {}", resp.status());
    }

    let body: serde_json::Value = resp.json().await.context("github releases body")?;
    let target = body.get("target_commitish").and_then(|v| v.as_str());
    let notes = body.get("body").and_then(|v| v.as_str());
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest"));

    let Some(rev) = parse_release_rev(target, notes) else {
        // We reached GitHub but couldn't identify the release's commit. Don't
        // guess — say "no update" rather than risk a false alarm.
        return Ok(None);
    };

    Ok(Some(Release { rev, url: html_url, asset: parse_asset(body.get("assets")) }))
}

/// Is this release a newer build than `current_rev`? The comparison half: pure, free, and
/// answered per BACKEND, because two installs on one machine run different commits.
///
/// `None` means this build IS the release (or there is nothing to compare against, for a
/// build made from source) — never a nag without a real comparison, which is
/// [`is_update`]'s own rule.
pub fn compare(release: &Release, current_rev: &str) -> Option<UpdateInfo> {
    is_update(current_rev, &release.rev).then(|| UpdateInfo {
        current: short_rev(current_rev),
        latest: short_rev(&release.rev),
        url: release.url.clone(),
        asset: release.asset.clone(),
    })
}

/// Read the commits between two builds — what the update would actually bring.
///
/// GitHub's compare API answers that in one request, which is why the changelog is not
/// assembled from the release history: the running build may be a hundred releases back,
/// and this is true whether or not any of them still exists. The whole messages are handed
/// to `changelog::from_commits`, which is the ONE place they are read (CI renders the same
/// module into every release body — see src/changelog.rs).
///
/// Best-effort like the check it follows. A commit GitHub cannot find (a force-pushed
/// history), a rate limit, a 5xx: the caller shows the button with no list rather than no
/// button, because what an update BRINGS is a nicety and that there IS one is not.
pub async fn changes(
    http: &reqwest::Client,
    base: &str,
    head: &str,
) -> Result<crate::changelog::Changelog> {
    let api = format!("https://api.github.com/repos/{REPO}/compare/{base}...{head}");
    let resp = http
        .get(&api)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("github compare request")?;
    anyhow::ensure!(resp.status().is_success(), "github compare -> {}", resp.status());
    let body: serde_json::Value = resp.json().await.context("github compare body")?;
    Ok(parse_comparison(&body))
}

/// Turn a compare response into a changelog.
///
/// Pure, so the shape is unit-tested without a network. Two fields matter and they are not
/// the same number: `commits` is what this page carries — GitHub stops at 250 — while
/// `total_commits` is how many there really are. Passing both is what lets the app say
/// "and 40 more" instead of quietly ending the list.
pub fn parse_comparison(body: &serde_json::Value) -> crate::changelog::Changelog {
    let messages: Vec<String> = body
        .get("commits")
        .and_then(|c| c.as_array())
        .map(|commits| {
            commits
                .iter()
                .filter_map(|c| c.get("commit")?.get("message")?.as_str())
                // The WHOLE message: `changelog::from_commits` splits the subject from the
                // paragraphs under it, so this parse and the workflow's `git log` hand it
                // the same shape and neither decides what a reader is shown. It used to cut
                // at the first line here, which threw the author's own explanation away
                // before the one module that knows what to do with it ever saw it.
                .map(|message| message.trim().to_string())
                .filter(|message| !message.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Newest first, which is not the order the API answers in: `compare` lists commits
    // oldest first, and a reader scanning a group wants the newest at the top.
    let messages: Vec<String> = messages.into_iter().rev().collect();
    let total = body
        .get("total_commits")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(messages.len());
    crate::changelog::from_commits(&messages, total)
}

/// Find the release's own `teams` binary in the API's `assets` array.
///
/// Both fields are required: a download URL with no size would leave the progress bar
/// without a total and the finished file without anything to check itself against, and
/// a size of zero is not an asset. Anything else in the release (a checksum file, a
/// second architecture) is ignored by name.
pub fn parse_asset(assets: Option<&serde_json::Value>) -> Option<Asset> {
    let entry = assets?
        .as_array()?
        .iter()
        .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(ASSET_NAME))?;
    let url = entry.get("browser_download_url")?.as_str()?.trim().to_string();
    let size = entry.get("size")?.as_u64()?;
    if url.is_empty() || size == 0 {
        return None;
    }
    Some(Asset { url, size })
}

/// The `teams` binary this app can replace with the release asset, or `None` when
/// this install is not one (see the module header for why that is not a shortcoming).
///
/// Three things are checked, because each failure has to be known BEFORE the user is
/// offered a button: a launcher named its binary, that binary is still there, and its
/// directory is writable — the swap is a rename inside it, so a read-only install
/// prefix (or one owned by root) cannot be updated from here.
pub fn self_install() -> Option<PathBuf> {
    self_install_from(std::env::var_os(LAUNCHER_BIN_ENV))
}

/// The three checks of [`self_install`], with the environment injected so they can be
/// tested without writing to this process's own environment.
fn self_install_from(named: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(named?);
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    let dir = path.parent()?;
    if is_writable_dir(dir) {
        Some(path)
    } else {
        None
    }
}

/// Can we create a file in `dir`? Asked by actually trying, because a permission
/// answered from the mode bits ignores every other reason a write fails (a read-only
/// mount, an immutable attribute, a full disk).
fn is_writable_dir(dir: &Path) -> bool {
    let probe = dir.join(".teams-lite-update-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Where a downloaded build waits between the two clicks.
///
/// The cache, deliberately: it is a 130 MB file that is worthless once installed, and a
/// cache is the one place a machine is allowed to clean up behind us. The name carries
/// the commit, so a second release downloads to a second file rather than resuming
/// into a stale one, and an interrupted download leaves a `.part` beside it that the
/// next attempt overwrites.
pub fn download_path(latest_rev: &str) -> Result<PathBuf> {
    let dir = updates_dir(&cache_base()?);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join(download_name(latest_rev)))
}

/// What a build's download is CALLED, in one place — because [`prune_downloads`] decides
/// what to keep by that name, and two spellings of it would mean a cleanup that spares
/// nothing.
fn download_name(rev: &str) -> String {
    format!("teams-{}", short_rev(rev))
}

/// This machine's cache root, XDG first.
fn cache_base() -> Result<PathBuf> {
    match std::env::var_os("XDG_CACHE_HOME") {
        Some(dir) if Path::new(&dir).is_absolute() => Ok(PathBuf::from(dir)),
        _ => {
            let home = std::env::var_os("HOME")
                .context("no XDG_CACHE_HOME and no HOME — nowhere to put the download")?;
            Ok(PathBuf::from(home).join(".cache"))
        }
    }
}

/// Where downloads live under a cache root. A directory of its OWN, and that matters: the
/// `teams` command unpacks the backend and the web bundle into siblings of it
/// (`~/.cache/teams-lite/server` and `.../web`, see launcher/src/backend.ts), and those are
/// what the app runs from — clearing downloads must never reach them.
fn updates_dir(base: &Path) -> PathBuf {
    base.join("teams-lite").join("updates")
}

/// Throw away every downloaded build EXCEPT the one `keep_rev` names.
///
/// Called on every pass of the release watch, because a build the release has moved past
/// is worthless: 130 MB nobody will ever run again would otherwise sit in the cache for
/// good, and a successful update is precisely the case that leaves one there.
///
/// **What is kept is the download for whatever `latest` names, and that is the whole rail.**
/// This cache is per MACHINE while a phase is per PROCESS, and this machine deliberately
/// runs two installs on two different commits (see § Running the released build beside the
/// staged one): the staged service IS the newest release within minutes of every push,
/// while the released build — the only shape that can update itself — is an older commit
/// sitting on a download it is about to install. Clearing the whole directory therefore
/// deleted that download from under it, and the second click failed with a message naming
/// the install path and no reason. It happened on 2026-08-06. Every install agrees on what
/// `latest` is and every download fetches exactly that, so keeping that one rev is what
/// makes one process's cleanup safe for another's transfer. There is deliberately no way to
/// ask for "remove everything".
///
/// Best-effort and quiet: the cache is the one place a machine may clean up behind us, so
/// a failure here is not worth a word to anybody.
pub fn prune_downloads(keep_rev: &str) {
    if let Ok(base) = cache_base() {
        prune_downloads_in(&base, keep_rev);
    }
}

/// Did the caller fail to name a rev at all?
///
/// A build made from source has no `TEAMS_BUILD_REV` to compare with, and "I do not know
/// what `latest` is" must never resolve to "so remove everything": that is the rule
/// [`prune_downloads`] exists to hold, spelled for the one caller that reads its own rev.
/// A prune that knows nothing removes nothing.
fn names_no_build(keep_rev: &str) -> bool {
    keep_rev.trim().is_empty()
}

/// [`prune_downloads`] with the cache root injected, so what it removes — and what it
/// leaves alone — is unit-tested.
fn prune_downloads_in(base: &Path, keep_rev: &str) {
    if names_no_build(keep_rev) {
        return;
    }
    let dir = updates_dir(base);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    // Both spellings of the kept build: the finished file, and the `.part` a transfer that
    // is still running writes into. Removing the second one is removing a download in
    // flight.
    let keep = download_name(keep_rev);
    let keep_part = format!("{keep}.part");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == keep || name == keep_part {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Stream `asset` to `dest`, reporting progress as it goes.
///
/// `on_progress` is called with (received, total) — often, so the caller throttles
/// rather than this. The file lands complete or not at all: bytes go to a `.part`
/// sibling and are renamed over `dest` only after the transfer matched the size the
/// release published AND the first bytes look like a Linux executable. That pair is
/// what install.sh checks too, and it is what stops a captive portal's HTML login page
/// from being installed as the app.
pub async fn download<F>(
    http: &reqwest::Client,
    asset: &Asset,
    dest: &Path,
    mut on_progress: F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let part = dest.with_extension("part");
    let resp = http
        .get(&asset.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .context("download the release asset")?;
    anyhow::ensure!(
        resp.status().is_success(),
        "download {} -> {}",
        ASSET_NAME,
        resp.status()
    );

    // The transfer's own statement of its length, checked BEFORE the bytes: `latest` is a
    // rolling tag, so the asset the metadata described may already have been replaced by a
    // newer build, and finding that out after 130 MB costs the user the whole transfer for
    // nothing. It is never taken as the expected size — a captive portal states a length
    // for its login page too, so what the RELEASE published stays the authority.
    if let Some(stated) = resp.content_length() {
        anyhow::ensure!(stated == asset.size, "{}", size_mismatch(stated, asset.size));
    }

    let mut file = std::fs::File::create(&part)
        .with_context(|| format!("create {}", part.display()))?;
    let mut received: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(4);
    let mut resp = resp;
    on_progress(0, asset.size);
    // `chunk()` rather than a `Stream`: it is reqwest's own chunked read and needs no
    // extra feature, and the loop is the same shape either way.
    while let Some(chunk) = resp.chunk().await.context("read the release asset")? {
        if head.len() < 4 {
            head.extend(chunk.iter().take(4 - head.len()));
        }
        std::io::Write::write_all(&mut file, &chunk)
            .with_context(|| format!("write {}", part.display()))?;
        received += chunk.len() as u64;
        on_progress(received, asset.size);
    }
    drop(file);

    let verified = verify(&head, received, asset.size);
    if let Err(e) = verified {
        // Leave nothing installable behind: a half file that looks like a build is
        // worse than no file, because the next click would install it.
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod {}", part.display()))?;
    }
    std::fs::rename(&part, dest)
        .with_context(|| format!("rename {} -> {}", part.display(), dest.display()))?;
    Ok(())
}

/// Is what we downloaded the build we asked for? Size AND shape, and neither alone:
/// a proxy error page is the wrong size, and a truncated transfer of the real asset is
/// the right shape.
///
/// Pure, so both halves are unit-tested without a network.
pub fn verify(head: &[u8], received: u64, expected: u64) -> Result<()> {
    anyhow::ensure!(received == expected, "{}", size_mismatch(received, expected));
    anyhow::ensure!(
        head.starts_with(&[0x7f, b'E', b'L', b'F']),
        "the download is not a Linux binary (no ELF header) — the release may be broken, \
         or something answered for it"
    );
    Ok(())
}

/// What a size that does not match means, in the words of what actually happened.
///
/// Fewer bytes than the release published is a transfer that stopped. MORE is not a
/// truncation at all — it is a DIFFERENT build: `latest` is a rolling tag whose asset is
/// replaced on every push, so a size measured when the check ran describes a file that no
/// longer exists. Calling that "cut short" sent its reader looking for a network fault
/// that was never there, and it hid the one thing they needed to know — that trying again
/// is the fix, because the next attempt re-reads the release.
/// The MEANING comes first and the bytes come after it, in a parenthesis. What the user was
/// shown began with two nine-digit numbers and ended in a conclusion that was wrong, so the
/// one sentence they had said nothing they could act on.
fn size_mismatch(received: u64, expected: u64) -> String {
    if received < expected {
        format!("the transfer was cut short ({received} of {expected} bytes)")
    } else {
        format!(
            "the release was replaced while it was being fetched \
             ({received} bytes, not {expected})"
        )
    }
}

/// Put a downloaded build in place of the running one, atomically.
///
/// A rename, never a write into `target`: the launcher and this backend are executing
/// from that file, and overwriting the bytes of a running executable is what gives a
/// process a `SIGBUS`. A rename replaces the directory entry instead — every running
/// process keeps the inode it started from, and the next start gets the new build. The
/// temporary sits in the SAME directory, because a rename across filesystems is not one.
///
/// Copies rather than moves the download, so a failed install leaves the cached file
/// ready for a second attempt instead of nothing at all.
pub fn install_binary(downloaded: &Path, target: &Path) -> Result<()> {
    let dir = target
        .parent()
        .with_context(|| format!("{} has no parent directory", target.display()))?;
    let staged = dir.join(".teams-lite-update.new");
    std::fs::copy(downloaded, &staged)
        .with_context(|| format!("copy {} -> {}", downloaded.display(), staged.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Err(e) = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(&staged);
            return Err(e).with_context(|| format!("chmod {}", staged.display()));
        }
    }

    if let Err(e) = std::fs::rename(&staged, target) {
        let _ = std::fs::remove_file(&staged);
        return Err(e).with_context(|| format!("replace {}", target.display()));
    }
    Ok(())
}

/// Determine the commit a release was built from.
///
/// We publish the commit in TWO independent places (see .github/workflows/
/// build.yml): the release's `target_commitish` (set to the full SHA) and the
/// release notes body ("Rolling build from <SHA> — <timestamp>"). We prefer the
/// structured `target_commitish` when it is a full SHA, and fall back to
/// scanning the notes — so the check keeps working even if GitHub ever resolves
/// `target_commitish` to a branch name instead of the SHA.
pub fn parse_release_rev(target_commitish: Option<&str>, notes: Option<&str>) -> Option<String> {
    if let Some(t) = target_commitish {
        let t = t.trim();
        if is_full_sha(t) {
            return Some(t.to_lowercase());
        }
    }
    notes.and_then(extract_sha40)
}

/// Is a newer commit than what we're running? True only when both sides name a
/// commit and they are not the same build. Short/full SHAs compare by prefix, so
/// `abc1234` and its 40-char form are treated as identical. Empty inputs (dev
/// build, unknown remote) yield `false` — never nag without a real comparison.
pub fn is_update(local: &str, remote: &str) -> bool {
    let local = local.trim().to_lowercase();
    let remote = remote.trim().to_lowercase();
    if local.is_empty() || remote.is_empty() {
        return false;
    }
    // Same build if one SHA is a prefix of the other (handles short vs full).
    if local.starts_with(&remote) || remote.starts_with(&local) {
        return false;
    }
    true
}

/// Shorten a SHA for display (first 7 chars, git-style). Non-SHA/short strings
/// pass through unchanged.
fn short_rev(rev: &str) -> String {
    let rev = rev.trim();
    if rev.len() > 7 && rev.chars().all(|c| c.is_ascii_hexdigit()) {
        rev[..7].to_lowercase()
    } else {
        rev.to_string()
    }
}

/// Is `s` exactly a 40-character hex string (a full git SHA-1)?
fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Find the first maximal run of exactly 40 hex characters in `s` (a full SHA
/// embedded in free text, e.g. the release notes). Runs of a different length
/// (like the digit groups of an ISO timestamp) are ignored. Returned lowercased.
fn extract_sha40(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        if chars[i].is_ascii_hexdigit() {
            let start = i;
            while i < n && chars[i].is_ascii_hexdigit() {
                i += 1;
            }
            if i - start == 40 {
                return Some(chars[start..i].iter().collect::<String>().to_lowercase());
            }
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "0123456789abcdef0123456789abcdef01234567";
    const SHA_B: &str = "fedcba9876543210fedcba9876543210fedcba98";

    #[test]
    fn is_update_same_commit_is_not_an_update() {
        assert!(!is_update(SHA_A, SHA_A));
    }

    /// The comparison is the FREE half, and it is per build.
    ///
    /// One machine runs two installs on one commit each, so the release is fetched once and
    /// compared twice. Splitting it out is what lets the poll cost one request whatever the
    /// number of backends — and it makes the answer testable with no network at all.
    #[test]
    fn a_release_is_compared_against_each_build_without_a_request() {
        let release = Release {
            rev: SHA_B.to_string(),
            url: "https://github.com/o/r/releases/tag/latest".to_string(),
            asset: Some(Asset { url: "https://example.invalid/teams".to_string(), size: 7 }),
        };

        // A build the release moved away from: an update, named by both short revs, and
        // carrying the asset a download needs.
        let info = compare(&release, SHA_A).expect("a different commit is an update");
        assert_eq!(info.current, SHA_A[..7]);
        assert_eq!(info.latest, SHA_B[..7]);
        assert_eq!(info.url, release.url);
        assert_eq!(info.asset, release.asset);

        // The build the release IS — including its short form, which is what a stored
        // `latest` from an older payload looks like. Never a nag against oneself.
        assert!(compare(&release, SHA_B).is_none());
        assert!(compare(&release, &SHA_B[..7]).is_none());
        // And never a nag with nothing to compare against (a build made from source).
        assert!(compare(&release, "").is_none());
    }

    /// A `Release` survives the store round trip, because that is how one backend's answer
    /// reaches the others. An older shape must be readable or the poll would re-fetch
    /// every pass; a shape it cannot read is treated as no answer, never guessed at.
    #[test]
    fn a_release_travels_through_the_store_as_json() {
        let release = Release {
            rev: SHA_A.to_string(),
            url: "https://example.invalid/releases".to_string(),
            asset: Some(Asset { url: "https://example.invalid/a".to_string(), size: 130 }),
        };
        let json = serde_json::to_string(&release).expect("a release serializes");
        assert_eq!(serde_json::from_str::<Release>(&json).unwrap(), release);

        // A release with no binary for this machine is a real state, not a parse failure:
        // the notice stays a link.
        let linkless = Release { asset: None, ..release };
        let json = serde_json::to_string(&linkless).unwrap();
        assert_eq!(serde_json::from_str::<Release>(&json).unwrap(), linkless);
    }

    #[test]
    fn is_update_different_commit_is_an_update() {
        assert!(is_update(SHA_A, SHA_B));
    }

    #[test]
    fn is_update_short_and_full_of_same_commit_match() {
        // The 7-char prefix of SHA_A is the same build, not an update.
        assert!(!is_update(&SHA_A[..7], SHA_A));
        assert!(!is_update(SHA_A, &SHA_A[..7]));
    }

    #[test]
    fn is_update_is_case_insensitive() {
        assert!(!is_update(&SHA_A.to_uppercase(), SHA_A));
    }

    #[test]
    fn is_update_empty_side_never_nags() {
        assert!(!is_update("", SHA_A));
        assert!(!is_update(SHA_A, ""));
        assert!(!is_update("  ", SHA_A));
    }

    #[test]
    fn parse_prefers_full_sha_target_commitish() {
        let got = parse_release_rev(Some(SHA_A), Some("Rolling build from deadbeef — 2026."));
        assert_eq!(got.as_deref(), Some(SHA_A));
    }

    #[test]
    fn parse_falls_back_to_notes_when_target_is_a_branch() {
        // GitHub sometimes returns a branch name here; the notes still carry the SHA.
        let notes = format!("Rolling build from {SHA_B} — 2026-07-20T23:00:00Z.");
        let got = parse_release_rev(Some("master"), Some(&notes));
        assert_eq!(got.as_deref(), Some(SHA_B));
    }

    #[test]
    fn parse_ignores_timestamp_digits_in_notes() {
        // No 40-hex SHA present: the ISO timestamp must not be mistaken for one.
        let got = parse_release_rev(Some("master"), Some("Built at 2026-07-20T23:00:00Z."));
        assert_eq!(got, None);
    }

    #[test]
    fn parse_returns_none_without_any_commit() {
        assert_eq!(parse_release_rev(None, None), None);
        assert_eq!(parse_release_rev(Some(""), Some("")), None);
    }

    #[test]
    fn extract_sha40_finds_embedded_sha() {
        let text = format!("prefix {SHA_A} suffix");
        assert_eq!(extract_sha40(&text).as_deref(), Some(SHA_A));
    }

    #[test]
    fn extract_sha40_rejects_39_and_41_char_runs() {
        let short = "a".repeat(39);
        let long = "a".repeat(41);
        assert_eq!(extract_sha40(&short), None);
        assert_eq!(extract_sha40(&long), None);
    }

    #[test]
    fn short_rev_trims_full_sha_to_seven() {
        assert_eq!(short_rev(SHA_A), "0123456");
    }

    #[test]
    fn short_rev_passes_through_non_sha() {
        assert_eq!(short_rev("dev"), "dev");
    }

    // ---- the asset, and the two steps that install it ------------------------

    fn assets_json(name: &str, size: u64) -> serde_json::Value {
        serde_json::json!([
            { "name": "checksums.txt", "browser_download_url": "https://example/c", "size": 12 },
            { "name": name, "browser_download_url": "https://example/teams", "size": size },
        ])
    }

    #[test]
    fn parse_asset_finds_the_binary_by_name() {
        let got = parse_asset(Some(&assets_json(ASSET_NAME, 61_000_000)));
        assert_eq!(
            got,
            Some(Asset { url: "https://example/teams".into(), size: 61_000_000 })
        );
    }

    #[test]
    fn parse_asset_ignores_a_release_without_our_binary() {
        // Another architecture only: there is nothing this machine can install, so the
        // notice has to stay a link rather than offer a download.
        assert_eq!(parse_asset(Some(&assets_json("teams-linux-arm64", 42))), None);
        assert_eq!(parse_asset(None), None);
    }

    #[test]
    fn parse_asset_refuses_a_zero_sized_entry() {
        // A size of zero would make the progress bar meaningless and `verify` vacuous.
        assert_eq!(parse_asset(Some(&assets_json(ASSET_NAME, 0))), None);
    }

    // ---- what the update brings (the compare API) ----------------------------

    fn comparison_json(total: u64, messages: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "total_commits": total,
            "commits": messages
                .iter()
                .map(|m| serde_json::json!({ "commit": { "message": m } }))
                .collect::<Vec<_>>(),
        })
    }

    /// The API answers oldest first and the reader wants newest first, so the order is
    /// REVERSED here — the one thing about this parse that is easy to get silently wrong.
    #[test]
    fn a_comparison_is_read_newest_first() {
        let got = parse_comparison(&comparison_json(2, &["fix: the older one", "fix: the newer one"]));
        let summaries: Vec<&str> =
            got.groups[0].changes.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["the newer one", "the older one"]);
    }

    /// A commit message is a subject and then the author's paragraphs. The subject is the
    /// entry; the body is the DETAIL, which the release page renders and the app's own
    /// payload drops — one split, in `changelog::parse`, so this parse decides neither.
    #[test]
    fn a_commits_body_travels_beside_its_summary() {
        let got = parse_comparison(&comparison_json(
            1,
            &["feat(calendar): join a meeting\n\nWhat was wrong before, and what it cost."],
        ));
        let change = &got.groups[0].changes[0];
        assert_eq!(change.summary, "join a meeting");
        assert_eq!(
            change.body.as_deref(),
            Some("What was wrong before, and what it cost."),
            "the paragraphs under a subject are most of what a release page has to say"
        );
    }

    /// GitHub's compare stops at 250 commits and states the real count beside them, so a
    /// build far behind gets a bounded list that still says how far behind it is.
    #[test]
    fn a_truncated_comparison_still_states_the_real_total() {
        let got = parse_comparison(&comparison_json(300, &["fix: the one page we were given"]));
        assert_eq!(got.total, 300);
        assert_eq!(got.omitted, 299);
    }

    #[test]
    fn an_empty_comparison_is_an_empty_changelog() {
        assert!(parse_comparison(&comparison_json(0, &[])).is_empty());
        assert!(parse_comparison(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn verify_accepts_a_complete_elf() {
        assert!(verify(&[0x7f, b'E', b'L', b'F'], 100, 100).is_ok());
    }

    #[test]
    fn verify_refuses_a_truncated_download() {
        let e = verify(&[0x7f, b'E', b'L', b'F'], 99, 100).unwrap_err().to_string();
        assert!(e.contains("cut short"), "{e}");
    }

    /// The failure the user was actually shown: 134 092 928 bytes against a release that
    /// said 134 088 832 — MORE than expected, reported as a truncation. `latest` is a
    /// rolling tag, so the extra page was a newer build, and the words sent their reader
    /// hunting a network fault while the fix was to read the release again.
    #[test]
    fn verify_calls_a_bigger_download_a_replaced_release_and_never_a_truncation() {
        let e = verify(&[0x7f, b'E', b'L', b'F'], 134_092_928, 134_088_832)
            .unwrap_err()
            .to_string();
        assert!(e.contains("replaced"), "{e}");
        assert!(!e.contains("cut short"), "{e}");
    }

    #[test]
    fn verify_refuses_something_that_is_not_a_binary() {
        // The captive-portal case: the right number of bytes, of the wrong thing.
        let e = verify(b"<htm", 100, 100).unwrap_err().to_string();
        assert!(e.contains("ELF"), "{e}");
    }

    /// The swap must be a RENAME over the target, so a running process keeps the inode
    /// it is executing from. The proof is an open handle to the old file reading the old
    /// bytes after the install: overwriting in place is what would give it new ones (and
    /// a `SIGBUS`, which no test can catch).
    #[test]
    fn install_binary_replaces_the_target_without_touching_the_old_inode() {
        let dir = std::env::temp_dir().join(format!("teams-lite-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("teams-bin");
        let downloaded = dir.join("teams-new");
        std::fs::write(&target, b"OLD").unwrap();
        std::fs::write(&downloaded, b"NEW").unwrap();

        let old_inode = {
            use std::os::unix::fs::MetadataExt as _;
            std::fs::metadata(&target).unwrap().ino()
        };

        install_binary(&downloaded, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
        let new_inode = {
            use std::os::unix::fs::MetadataExt as _;
            std::fs::metadata(&target).unwrap().ino()
        };
        assert_ne!(old_inode, new_inode, "the target must be a NEW inode, not rewritten bytes");

        // The download survives, so a failed restart can be retried without paying for
        // the bytes again.
        assert!(downloaded.is_file());
        // And the executable bit is on, whatever the umask was: this file is exec'd next.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "mode {mode:o}");
        }
        // No temporary left in the install directory.
        assert!(!dir.join(".teams-lite-update.new").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Pruning downloads drops the 130 MB nobody will run again — and NOTHING else in
    /// that cache. Its siblings are the backend and the web bundle the `teams` command
    /// unpacked and is running from; reaching those would break the app it just updated.
    #[test]
    fn pruning_downloads_spares_the_app_it_runs_from() {
        let base = std::env::temp_dir().join(format!("teams-lite-cache-{}", std::process::id()));
        let updates = updates_dir(&base);
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("teams-def5678"), b"a whole build").unwrap();
        let extracted = base.join("teams-lite").join("server");
        std::fs::write(&extracted, b"the backend this process is running").unwrap();

        prune_downloads_in(&base, SHA_A);

        assert!(
            !updates.join("teams-def5678").exists(),
            "a build the release moved past must be gone"
        );
        assert!(extracted.is_file(), "the unpacked backend must survive");
        // Idempotent: a machine with nothing cached is the common case.
        prune_downloads_in(&base, SHA_A);
        std::fs::remove_dir_all(&base).ok();
    }

    /// **A prune must never take the download for the build `latest` names.**
    ///
    /// This is the 2026-08-06 failure. The cache is per MACHINE and a phase is per
    /// PROCESS, and this machine runs two installs on two different commits on purpose:
    /// the staged service becomes the newest release within minutes of every push, so its
    /// two-minute poll found itself CURRENT — and cleared the whole directory, including
    /// the 130 MB the RELEASED build (an older commit, and the only shape that can update
    /// itself) had just downloaded and was waiting to install. The second click then
    /// failed, and the user was shown the install path with no reason behind it.
    ///
    /// Every install fetches exactly what `latest` names, so sparing that one rev is what
    /// makes one process's cleanup safe for another process's transfer.
    #[test]
    fn a_prune_never_takes_the_build_another_install_is_about_to_run() {
        let base = std::env::temp_dir().join(format!("teams-lite-keep-{}", std::process::id()));
        let updates = updates_dir(&base);
        std::fs::create_dir_all(&updates).unwrap();
        let live = updates.join(download_name(SHA_A));
        let in_flight = updates.join(format!("{}.part", download_name(SHA_A)));
        let stale = updates.join(download_name(SHA_B));
        std::fs::write(&live, b"the build the other install is about to run").unwrap();
        std::fs::write(&in_flight, b"a transfer that is still running").unwrap();
        std::fs::write(&stale, b"a build the release moved past").unwrap();

        // The pass that used to be destructive: this backend IS the release, and another
        // one is sitting on that very download.
        prune_downloads_in(&base, SHA_A);

        assert!(live.is_file(), "the download for `latest` must survive a prune");
        assert!(in_flight.is_file(), "a transfer in flight must survive a prune");
        assert!(!stale.exists(), "a build nobody will run again must go");

        // And a prune that knows NOTHING removes nothing: a build made from source names no
        // commit, and "I cannot compare" must never resolve to "so remove everything".
        std::fs::write(&stale, b"a build the release moved past").unwrap();
        prune_downloads_in(&base, "");
        assert!(stale.is_file(), "a prune with no rev to spare must remove nothing");
        assert!(live.is_file(), "a prune with no rev to spare must remove nothing");
        std::fs::remove_dir_all(&base).ok();
    }

    /// There must be no way to spell "clear the whole directory": that is the shape of the
    /// bug above, and it reads as sensible cleanup every time somebody writes it.
    #[test]
    fn nothing_in_this_module_clears_the_download_directory_wholesale() {
        let source = include_str!("update.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields a first part");
        assert!(
            !source.contains("remove_dir_all"),
            "a download directory removed wholesale takes another install's transfer with \
             it — prune by the rev `latest` names instead"
        );
    }

    #[test]
    fn self_install_needs_a_launcher_that_named_an_existing_binary() {
        assert_eq!(self_install_from(None), None);
        assert_eq!(self_install_from(Some("relative/teams".into())), None);
        assert_eq!(self_install_from(Some("/nonexistent/teams".into())), None);

        let dir = std::env::temp_dir().join(format!("teams-lite-self-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("teams-bin");
        std::fs::write(&bin, b"x").unwrap();
        assert_eq!(self_install_from(Some(bin.clone().into())), Some(bin));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A staged always-on service must never be offered a self-update: its layout is a
    /// separate backend binary, a web bundle, wrapper scripts and unit files, and the
    /// release asset holds none of that (see the module header). The env var is what the
    /// `teams` command sets, and a service unit sets nothing — so the absence of it is
    /// the whole check, and this pins that nothing else stands in for it.
    #[test]
    fn nothing_but_the_launchers_own_variable_makes_an_install_updatable() {
        // The module without its tests: this test names both forbidden spellings, so
        // scanning the whole file would only ever find itself.
        let source = include_str!("update.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields a first part");
        assert!(
            !source.contains("current_exe"),
            "the backend runs from a CACHE COPY of itself, so its own path names nothing \
             installable — never derive the install from it"
        );
        assert!(
            !source.contains("teams-lite/service"),
            "the staged service must not be recognised here: it would be offered a swap \
             that leaves it running what it had"
        );
    }

    /// The staged `VERSION` must name the commit the artifacts were BUILT from.
    ///
    /// This is the bug that made a shipped feature look broken. The installer read
    /// `git rev-parse HEAD` once for the build and again for `VERSION`; a hook
    /// fast-forwarded the checkout inside the minute between the two, so `VERSION`
    /// named a commit the staged backend did not hold. Nothing healed it either:
    /// `.claude/hooks/sync-service-to-master.sh` compares `VERSION` with `HEAD`, read
    /// them as equal, and never rebuilt. The user's own app answered `unknown method`
    /// on a new RPC while every test in the repo passed.
    ///
    /// So the installer reads `HEAD` in exactly ONE place, pins it in `BUILD_REV`, and
    /// writes that. The test reads the script, because the failure lives on the other
    /// side of the process boundary and no Rust test would see it.
    #[test]
    fn the_installer_stages_the_commit_it_built() {
        let installer = include_str!("../bin/teams-lite-service.sh");

        let reads_head: Vec<&str> = installer
            .lines()
            .filter(|line| line.contains("rev-parse HEAD") && line.contains("git -C"))
            .collect();
        assert_eq!(
            reads_head.len(),
            1,
            "bin/teams-lite-service.sh must read HEAD in one place only, or the build \
             and the staged VERSION can name two different commits: {reads_head:?}"
        );

        assert!(
            installer.contains(r#"local commit="$BUILD_REV""#),
            "the VERSION file must record the pinned BUILD_REV, not a fresh read of HEAD"
        );
        for baked in ["TEAMS_BUILD_REV=\"$BUILD_REV\""] {
            assert_eq!(
                installer.matches(baked).count(),
                2,
                "both builds (backend and web) must bake the pinned commit: {baked}"
            );
        }
    }

    /// The unit that runs the RELEASED build beside the staged one, and the three things
    /// that keep the two apart (see packaging/systemd/teams-lite-app.service).
    ///
    /// It exists because this is the only install shape that can update itself, so the
    /// user can dogfood the published artifact without giving up the staged pair their
    /// phone uses. Sharing a machine is fine — two send-capable backends on one store is
    /// a shape this app already has — but sharing a PORT is not, and neither is sharing a
    /// lifecycle.
    #[test]
    fn the_released_build_runs_beside_the_staged_one_and_never_over_it() {
        let unit = include_str!("../packaging/systemd/teams-lite-app.service");

        // Ports of its own, named rather than defaulted: the default IS the staged
        // backend's port, and a second backend that bound it would either fail to start
        // or be attached to by the wrong launcher.
        assert!(
            unit.contains("Environment=TEAMS_LITE_PORT=@APP_BACKEND_PORT@"),
            "the released build's backend needs a port of its own"
        );
        assert!(
            unit.contains("--port @APP_WEB_PORT@"),
            "the released build's web server needs a port of its own"
        );

        // NO idle-exit override, which is the OPPOSITE of the staged backend unit — where
        // it is mandatory. Here the launcher holds its own keepalive, and the idle exit is
        // what clears a backend whose launcher died: one left holding the port would be
        // ATTACHED to by the next start, and an attached backend published its own write
        // token, so every send from this instance's page would be refused.
        // The directive, not the word: the unit's own comment explains the absence, and a
        // comment is what stops the next reader from "fixing" it.
        let sets_idle_exit = unit.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("Environment=") && line.contains("TEAMS_NO_IDLE_EXIT")
        });
        assert!(
            !sets_idle_exit,
            "the app unit must NOT disable the idle exit — that is what cleans up an \
             orphaned backend holding its port"
        );

        // And it says NOTHING about calling, which is how this install calls at all. It
        // used to silence its own registration to spare the second ring, and every call
        // and Join control in this window was disabled for it — a whole feature missing,
        // named nowhere the user could read. Two registrations are safe because each
        // backend holds a calling endpoint id of its own, keyed by its port.
        // The directive, not the word: the unit's own comment explains the absence.
        let silences_calling = unit.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("Environment=") && line.contains(concat!("TEAMS_LITE", "_CALLING"))
        });
        assert!(
            !silences_calling,
            "the released build must be a device the user can call FROM — every window \
             they open is one they may want to call from"
        );

        // Not part of the staged pair's target: restarting or enabling that target must
        // not reach a second app the user did not ask for.
        let joins_staged_target = unit
            .lines()
            .any(|line| line.trim_start().starts_with("PartOf=teams-lite.target"));
        assert!(
            !joins_staged_target,
            "the released build is its own install, not a member of the staged target"
        );

        // A container restart moves the broker's bus, and each backend reads that address
        // from its own frozen environment — so BOTH have to be restarted, or the released
        // one stays up, unauthenticated and silent.
        let bus_restart = include_str!("../packaging/systemd/teams-lite-backend-restart.service");
        for named in ["teams-lite-backend.service", "teams-lite-app.service"] {
            assert!(
                bus_restart.contains(&format!("try-restart {named}")),
                "the broker-bus restart must cover {named}"
            );
        }

        // And the installer must not write a unit whose program is absent: systemd
        // rejects it, and a start would fail with 203/EXEC.
        let installer = include_str!("../bin/teams-lite-service.sh");
        assert!(
            installer.contains(r#"[ "$unit" = teams-lite-app.service ] && [ ! -x "$APP_BIN" ]"#),
            "teams-lite-app.service must be skipped when the released binary is not installed"
        );
    }

    /// A backend that froze the WRONG broker bus is found, and restarted.
    ///
    /// The broker's bus is `/proc/<container-leader>/root/run/user/0/bus` and a process
    /// environment is frozen at exec, so a backend that STARTED BEFORE the container was
    /// ready holds the host session bus — which carries no broker — for as long as it
    /// lives. It never exits over it either: a broken sign-in is deliberately not fatal,
    /// so the process stays `active (running)`, answers every read out of the store, and
    /// signs in to nothing. It happened to teams-lite-app.service on the author's machine,
    /// and the app on that front could not reach Teams at all while the staged pair beside
    /// it worked perfectly.
    ///
    /// Neither existing self-heal covered it: `teams-lite-broker-bus.path` fires on a WRITE
    /// to rootless.json, and on a boot that write lands before anything is watching for it;
    /// `PartOf=intune-container.service` never fires because that unit is a Type=oneshot
    /// which stays "active (exited)" and restarts itself without changing state; and the
    /// keyring check answers about the CONTAINER, which in this failure is perfectly
    /// healthy. So the fix is two-sided, and each side is pinned below — the wrappers WAIT
    /// so the first start is the right one, and the health timer compares each running
    /// backend's frozen address with the broker's own so the rest are caught.
    ///
    /// Every one of these files is on the other side of a process boundary — nothing in the
    /// crate runs them — so a change there is invisible to every other test, and the
    /// failure it reintroduces is silent by construction.
    #[test]
    fn a_backend_that_froze_the_wrong_broker_bus_is_found_and_restarted() {
        let health = include_str!("../packaging/systemd/teams-lite-broker-health.service");
        let bus_check = include_str!("../bin/teams-lite-broker-bus-check.sh");
        let installer = include_str!("../bin/teams-lite-service.sh");
        let wrapper = include_str!("../bin/teams-lite-backend.sh");
        let env = include_str!("../bin/broker-env.sh");
        let released = include_str!("../install.sh");

        // THE TIMER IS THE ONLY TRIGGER THAT WORKS WITH NO CLIENT CONNECTED, which is
        // exactly when this outage goes unnoticed — so the check has to run from it, and
        // with --repair, or it is a diagnosis nobody reads.
        assert!(
            health.contains("teams-lite-broker-bus-check.sh --repair"),
            "the health timer must check each backend's broker bus, and repair it"
        );
        // Both scripts exit 1 to mean "found my fault and asked for the repair", which is
        // information rather than a failure of the unit.
        assert!(
            health.contains("SuccessExitStatus=1"),
            "a check that found its fault must not mark the health unit failed"
        );
        // A unit whose program is absent is one systemd starts with 203/EXEC.
        assert!(
            installer.contains("teams-lite-broker-bus-check.sh\" \"$SERVICE_DIR/teams-lite-broker-bus-check.sh"),
            "the installer must stage the bus check beside the unit that runs it"
        );

        // THE REPAIR IS THE BACKEND'S, NEVER THE CONTAINER'S. The container is healthy in
        // this failure, and restarting it would take the user's sign-in down for a minute
        // to fix something that is not wrong with it.
        assert!(
            bus_check.contains("teams-lite-backend-restart.service"),
            "the bus check must repair through the unit that already restarts both backends"
        );
        // The VERBS, not the word: the script names `intune-container status` in the
        // sentence it prints when it cannot tell, which is a read and the normal way to
        // answer "is the container even up".
        for verb in ["stop", "start", "restart"] {
            assert!(
                !bus_check.contains(&format!("intune-container {verb}")),
                "a stale bus is the backend's fault, not the container's — never {verb} it here"
            );
        }
        // A repair must never fire on ignorance: with no container bus resolvable, a
        // restart would only make the backend fail its own start and take the history
        // offline while it walked up the backoff.
        assert!(
            bus_check.contains("cannot tell") && bus_check.contains("exit 2"),
            "an unknown state must be stated and skipped, never repaired"
        );

        // THE WAIT IS WHAT MAKES THE FIRST START THE RIGHT ONE, on both install shapes.
        assert!(
            wrapper.contains("teams_lite_wait_for_broker_bus"),
            "the staged wrapper must wait for the container rather than exit and retry: \
             Restart= walks to 300 s, so losing the first race costs minutes of silence"
        );
        assert!(
            env.contains("teams_lite_wait_for_broker_bus")
                && env.contains("TEAMS_LITE_BROKER_WAIT_SECONDS"),
            "the wait belongs in the one place the detection already lives"
        );
        // Matched on the unescaped tokens: that wrapper is written through an unquoted
        // heredoc, so every `$` in it is spelled `\$` in this file.
        assert!(
            released.contains("BROKER_WAIT_SECONDS")
                && released.contains("waited=0")
                && released.contains("sleep 1"),
            "the wrapper install.sh writes is what teams-lite-app.service execs, so it \
             must wait too — it is a self-contained copy and cannot source broker-env.sh"
        );

        // AND THE UNIT WAITS TOO, because that wrapper is the one install.sh already WROTE
        // and the in-app update replaces the binary beside it, never the wrapper. So a
        // machine installed before the wait keeps a wrapper that launches anyway until
        // somebody re-runs install.sh — measured here: the container restarted, PartOf=
        // propagated to the app unit, and its backend froze /run/user/1000/bus again with
        // the fix already on master. The unit IS rewritten by every `update`, so it is the
        // half this repo can still correct with no 130 MB download.
        let app = include_str!("../packaging/systemd/teams-lite-app.service");
        assert!(
            app.contains("ExecStartPre=@SERVICE_DIR@/teams-lite-broker-wait.sh"),
            "the app unit must not let its launcher resolve the bus before there is one"
        );
        let wait_script = include_str!("../bin/teams-lite-broker-wait.sh");
        // 69 is EX_UNAVAILABLE, and it is what turns a permanent wrong address into a
        // bounded retry through the unit's own Restart=always.
        assert!(
            wait_script.contains("exit 69"),
            "a container whose bus never appeared must abort the start, not freeze a dead \
             address for the life of the process"
        );
        // …and only where a container is KNOWN. Failing on a host that has none would keep
        // the app unit down for ever over something that is not a fault.
        assert!(
            wait_script.contains("TEAMS_LITE_CONTAINER_STATE"),
            "no Intune container on this host is not a reason to refuse to start"
        );
        for staged in ["teams-lite-broker-bus-check.sh", "teams-lite-broker-wait.sh"] {
            assert!(
                installer.contains(&format!("{staged}\" \"$SERVICE_DIR/{staged}")),
                "the installer must stage {staged} beside the unit that names it"
            );
        }
        // A unit whose ExecStartPre is absent is one systemd starts with 203/EXEC, and
        // `units` can run before anything was ever staged.
        assert!(
            installer.contains(r#"[ ! -x "$SERVICE_DIR/teams-lite-broker-wait.sh" ]"#),
            "the app unit must be skipped when its ExecStartPre is not staged yet"
        );
        // BOUNDED, and only while a container is KNOWN. A host with classic Intune or with
        // none at all must launch at once rather than hanging for the whole window.
        for (name, text) in [("broker-env.sh", env), ("install.sh", released)] {
            assert!(
                text.contains("CONTAINER_STATE") || text.contains("TEAMS_LITE_CONTAINER_STATE"),
                "{name} must gate the wait on a container it can see"
            );
        }
    }

    /// What CI publishes, and the four things about it this module depends on.
    ///
    /// The workflow is on the other side of a process boundary — nothing in the crate runs
    /// it — so a change there is invisible to every other test, and each of these failures
    /// is silent: the app would keep working and quietly stop being able to update, or
    /// start showing a changelog that is empty or wrong.
    #[test]
    fn the_release_workflow_keeps_the_tag_this_module_reads_and_the_notes_it_parses() {
        let workflow = include_str!("../.github/workflows/build.yml");

        // The ROLLING TAG is the app's own address. `check` asks
        // /releases/tags/latest and install.sh downloads /releases/download/latest/…, so
        // every copy already installed depends on this name existing, with the asset on it.
        assert!(
            workflow.contains("gh release create latest out/teams-linux-x64"),
            "the rolling `latest` release must keep carrying the asset: it is the URL every \
             installed build asks about, and moving it would leave them unable to update"
        );

        // The notes' machine-readable line, which `parse_release_rev` falls back to when
        // GitHub resolves `target_commitish` to a branch name.
        assert!(
            workflow.contains(r#"echo "Rolling build from ${GITHUB_SHA}"#),
            "the release notes must state the commit as a 40-character sha, first: it is the \
             fallback `parse_release_rev` reads"
        );

        // The changelog comes from the crate's own renderer, so the release body and the
        // list the button shows are one list (see src/changelog.rs).
        assert!(
            workflow.contains("cargo run --quiet --example changelog"),
            "the release body must be rendered by examples/changelog.rs, never by a second \
             grouper written in the workflow"
        );
        // And it needs the history to render from: a shallow clone answers `git log` with
        // this commit alone, which reads as a project that changed one thing.
        assert!(
            workflow.contains("fetch-depth: 0"),
            "the changelog is `git log` between two builds, so the clone must hold history"
        );

        // THE WHOLE MESSAGE, NUL-SEPARATED. A commit here carries a subject and then the
        // paragraphs saying what was wrong before — measured at 1 501 bytes of subject
        // against 22 171 bytes of body over 20 commits. `--pretty=format:%s` is what this
        // used to be, and it published 6% of what the authors wrote; going back to it would
        // fail nothing else, because both surfaces would simply render short entries.
        assert!(
            workflow.contains("git log -z --no-merges --pretty=format:%s%n%b"),
            "the release notes must carry each commit's BODY, and `-z` is what separates the \
             records: a newline cannot, because it is inside every message"
        );

        // The base must be BEHIND this build. Two releases answer "where is the reader
        // coming from" and the rolling tag races with itself, so ancestry is what picks —
        // without it a second push inside one build re-lists the first push's own change.
        assert!(
            workflow.contains("merge-base --is-ancestor"),
            "the changelog base must be proved an ancestor of this build, or the range names \
             commits this build does not hold"
        );
        assert!(
            workflow.contains("refs/tags/build-*"),
            "the newest immutable build release is the second candidate for the base: it is \
             published before `latest` is recreated, which is what saves the range from the \
             rolling tag's own race"
        );

        // The asset window prunes BUILD releases only. `latest` losing its binary is the
        // same failure as `latest` losing its name.
        let prunes = workflow
            .split("Keep the binary on the newest builds only")
            .nth(1)
            .expect("the workflow prunes old assets");
        assert!(
            prunes.contains(r#"startswith("build-")"#),
            "pruning must select the immutable per-build releases by name, never `latest`"
        );
    }

    /// The restart must not cut a local-agent reply in half.
    ///
    /// This is the second half of a real failure. A run was answering in the sandbox
    /// channel when `.claude/hooks/sync-service-to-master.sh` re-staged master and
    /// restarted the units; the child died with the backend, the final edit never went
    /// out, and the thread was left saying "claude is thinking…" — for ten minutes,
    /// until the user asked what was happening. The other half is the repair
    /// (`repair_abandoned_agent_runs` in src/bin/server.rs), which closes a reply
    /// nobody can finish. This one is the part that keeps the answer instead.
    ///
    /// The test reads the script, like the one above: the wait lives on the other side
    /// of the process boundary, and no Rust test would see it go missing.
    /// The body of one subcommand of the installer script.
    ///
    /// Scoped rather than searched whole, because every name these tests look for also
    /// appears in the script's own prose and in its other subcommands: `stage_artifacts` is
    /// a definition and an `install` step, and `try-restart` is named in the header comment
    /// that explains why the wait exists. A whole-file `find` matched that comment and
    /// failed a test about the order of the code underneath it.
    fn installer_subcommand(name: &str) -> &'static str {
        let installer = include_str!("../bin/teams-lite-service.sh");
        installer
            .split_once(&format!("\n{name}() {{"))
            .unwrap_or_else(|| panic!("bin/teams-lite-service.sh defines {name}"))
            .1
            .split("\ncmd_")
            .next()
            .expect("a subcommand body ends at the next one")
    }

    #[test]
    fn the_installer_waits_for_the_agent_before_it_restarts() {
        let installer = include_str!("../bin/teams-lite-service.sh");
        let update = installer_subcommand("cmd_update");

        let restart = update
            .find("try-restart")
            .expect("`update` restarts the units");
        let wait = update.find("|| wait_for_quiet_agent").expect(
            "`update` must wait for a quiet agent, or a restart freezes a reply mid-answer",
        );
        assert!(wait < restart, "the wait must come BEFORE the restart, not after it");

        // Bounded, and it proceeds when the bound is reached: a run that never ends must
        // not keep the user's phone on an old commit for good.
        assert!(
            installer.contains("AGENT_WAIT_SECONDS"),
            "the wait must be bounded, and the bound must be overridable"
        );
        assert!(
            installer.contains(r#"[ "$wait_for_agent" = no ]"#),
            "`update --now` must be able to skip the wait"
        );
    }

    /// And it must wait before it STAGES, not merely before it restarts.
    ///
    /// The other half of the same failure, found on 2026-08-06. Staging looks like the
    /// harmless step and is not: the web bundle is a directory of hashed chunks, and the
    /// SSR handler imports them off disk as the routes are asked for. Replaced under the
    /// running web server, its next lazy import names a file that is gone — the process
    /// stays up and the app is dead. `update` staged, then held its restart for 19 minutes
    /// for a live `@claude` run, and the user's phone was served Bun's own "fetch(req) did
    /// not return a Response object" page for the whole wait.
    ///
    /// So the order is build (which touches nothing live), wait, stage, restart: a bundle
    /// and the process serving it are out of step for the seconds a `try-restart` takes.
    /// `renderWithSsr` in web/server.ts answers honestly inside those seconds, and neither
    /// half replaces the other — `install` stages without restarting anything at all.
    #[test]
    fn the_installer_waits_before_it_replaces_a_live_artifact() {
        let update = installer_subcommand("cmd_update");

        let wait = update.find("|| wait_for_quiet_agent").expect(
            "`update` must wait for a quiet agent, or a restart freezes a reply mid-answer",
        );
        let stage = update
            .find("stage_artifacts")
            .expect("`update` stages what it built");
        assert!(
            wait < stage,
            "the wait must come BEFORE staging: replacing the web bundle under the \
             running server breaks the app for the whole wait, not just for the restart"
        );

        // The build is the one step that belongs on the far side of the wait: it writes
        // into the checkout, so it touches nothing the running service reads — and a
        // minute of compiling inside the wait would be a minute added to every update.
        let build = update
            .find("build_artifacts")
            .expect("`update` builds before it stages");
        assert!(
            build < wait,
            "building must stay BEFORE the wait: it touches no staged artifact, and \
             moving it after would add its whole duration to every update"
        );
    }
}
