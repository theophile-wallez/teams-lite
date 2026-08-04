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
// (local-first is enforced server-side). The server runs the check once at startup,
// best-effort, and pushes an `update_available` event to the UI.
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub url: String,
    pub size: u64,
}

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
/// swallow. The `http` client is reused from the backend (it already carries a
/// User-Agent, which the GitHub API requires).
pub async fn check(http: &reqwest::Client, current_rev: &str) -> Result<Option<UpdateInfo>> {
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

    let Some(latest) = parse_release_rev(target, notes) else {
        // We reached GitHub but couldn't identify the release's commit. Don't
        // guess — say "no update" rather than risk a false alarm.
        return Ok(None);
    };

    if is_update(current_rev, &latest) {
        Ok(Some(UpdateInfo {
            current: short_rev(current_rev),
            latest: short_rev(&latest),
            url: html_url,
            asset: parse_asset(body.get("assets")),
        }))
    } else {
        Ok(None)
    }
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
    Ok(dir.join(format!("teams-{}", short_rev(latest_rev))))
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

/// Throw away every downloaded build.
///
/// Called when the check finds this build CURRENT, which is the moment a download becomes
/// worthless: either it was installed and we are now running it, or the release moved on
/// past it. Without this, 130 MB of a build nobody will ever run again would sit in the
/// cache for good — and a successful update is precisely the case that leaves one there.
///
/// Best-effort and quiet: the cache is the one place a machine may clean up behind us, so
/// a failure here is not worth a word to anybody.
pub fn discard_downloads() {
    if let Ok(base) = cache_base() {
        discard_downloads_in(&base);
    }
}

/// [`discard_downloads`] with the cache root injected, so what it removes — and what it
/// leaves alone — is unit-tested.
fn discard_downloads_in(base: &Path) {
    let _ = std::fs::remove_dir_all(updates_dir(base));
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
    anyhow::ensure!(
        received == expected,
        "the download is {received} bytes but the release says {expected} — it was cut short"
    );
    anyhow::ensure!(
        head.starts_with(&[0x7f, b'E', b'L', b'F']),
        "the download is not a Linux binary (no ELF header) — the release may be broken, \
         or something answered for it"
    );
    Ok(())
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

    #[test]
    fn verify_accepts_a_complete_elf() {
        assert!(verify(&[0x7f, b'E', b'L', b'F'], 100, 100).is_ok());
    }

    #[test]
    fn verify_refuses_a_truncated_download() {
        let e = verify(&[0x7f, b'E', b'L', b'F'], 99, 100).unwrap_err().to_string();
        assert!(e.contains("cut short"), "{e}");
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

    /// Clearing downloads drops the 130 MB nobody will run again — and NOTHING else in
    /// that cache. Its siblings are the backend and the web bundle the `teams` command
    /// unpacked and is running from; reaching those would break the app it just updated.
    #[test]
    fn discarding_downloads_spares_the_app_it_runs_from() {
        let base = std::env::temp_dir().join(format!("teams-lite-cache-{}", std::process::id()));
        let updates = updates_dir(&base);
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("teams-def5678"), b"a whole build").unwrap();
        let extracted = base.join("teams-lite").join("server");
        std::fs::write(&extracted, b"the backend this process is running").unwrap();

        discard_downloads_in(&base);

        assert!(!updates.exists(), "the downloads must be gone");
        assert!(extracted.is_file(), "the unpacked backend must survive");
        // Idempotent: a machine with nothing cached is the common case.
        discard_downloads_in(&base);
        std::fs::remove_dir_all(&base).ok();
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
    #[test]
    fn the_installer_waits_for_the_agent_before_it_restarts() {
        let installer = include_str!("../bin/teams-lite-service.sh");

        let restart = installer
            .find("try-restart")
            .expect("bin/teams-lite-service.sh restarts the units");
        let wait = installer.find("|| wait_for_quiet_agent").expect(
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
}
