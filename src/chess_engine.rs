//! THE CHESS ENGINE, fetched only if the user asks for one.
//!
//! A game of chess in this app is played against a colleague who also runs teams-lite (see
//! AGENTS.md § Chess in a conversation). This module is the other opponent: Stockfish, running as
//! WebAssembly in the reader's own browser — and it is here, in the backend, because the ENGINE HAS
//! TO BE DOWNLOADED and this app does not let a browser fetch from a stranger's server.
//!
//! **IT IS NOT IN THE APP, and that is the whole point.** The engine is 7.3 MB of WebAssembly. The
//! release asset the launcher embeds is already 134 MB and rides on every in-app update (§ Updating
//! the app from inside it), so an engine nobody asked for would cost every reader that download for
//! a feature most of them will never open. It is fetched on the user's own press, once per machine,
//! and it can be given back (see [`forget`]).
//!
//! **THE BROWSER NEVER TOUCHES THE HOST.** The rails are the ones `update.rs` and `sender_icon.rs`
//! already hold, and each is here for its own reason:
//!
//!   - **the URL is a CONSTANT** — one host, one release tag, one filename per entry, and no client
//!     supplies any part of it. A client that could name the URL could make this machine fetch
//!     anything and then run it in the reader's browser;
//!   - **the response's own stated length must match** the pinned one, checked before the bytes, so
//!     a captive portal's login page costs nothing;
//!   - **the SHA-256 must match**, computed over the bytes as they stream and checked BEFORE
//!     anything is installed. This is stronger than the ELF sniff the app's own update does, and it
//!     has to be: what is being fetched is CODE that will run in the reader's browser, so its
//!     identity is the only thing standing between the reader and whatever the host answered;
//!   - **the read is BOUNDED** at [`MAX_ENGINE_BYTES`] whatever the server claims, because a length
//!     header is a claim and a disk is not;
//!   - **the install is a RENAME** of a `.part` sibling, so a file is complete or absent — never
//!     half an engine that the page would try to run;
//!   - **a file that fails verification is DELETED**, for the reason the update's own is: a half
//!     file that looks like an engine is worse than no file, because the next press would load it.
//!
//! **THE VERSION IS PART OF THE PATH.** `~/.cache/teams-lite/engine/<version>/` — so a later build
//! that pins a different engine fetches into a directory of its own and can never load the bytes
//! this one verified. The cache is where a machine is allowed to clean up behind us, which is why
//! it lives there rather than in the store.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One file the engine is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineFile {
    /// Its name on disk and in the URL — and the ONLY thing a path is ever built from.
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    /// Lowercase hex, 64 characters.
    pub sha256: &'static str,
}

/// What this engine is called where a reader can see it.
pub const ENGINE_LABEL: &str = "Stockfish 18 Lite";

/// The version, which is also the cache directory AND the middle segment of the route that serves it
/// (see web/engine-file.ts).
///
/// **IT CARRIES THE DIGEST'S OWN FIRST BYTES**, and that is not decoration: the file NAMES are
/// upstream's and would not change if upstream re-tagged the same release with different bytes, so a
/// version string of `18.0.0-lite-single` alone would let a later build — pinning a different digest
/// under the same name — read the bytes this one verified out of the cache, and serve them to the
/// browser from a URL this app tells it to cache for a year. With the digest in the path, a
/// different pinned engine is a different directory and a different URL, with nothing to migrate and
/// nothing to invalidate.
pub const ENGINE_VERSION: &str = "18.0.0-lite-single-a8fbc05e";

/// The engine's own Elo range, MEASURED off the binary itself (`option name UCI_Elo type spin
/// default 1320 min 1320 max 3190`). The picker offers nothing outside it, and the page states the
/// floor rather than pretending a weaker setting exists.
pub const ENGINE_MIN_ELO: u32 = 1320;
pub const ENGINE_MAX_ELO: u32 = 3190;

/// The two files, MEASURED on 2026-08-24 by fetching them and hashing them:
///
/// ```text
/// stockfish-18-lite-single.js    20670 bytes   sha256 2278005057…
/// stockfish-18-lite-single.wasm  7295411 bytes sha256 a8fbc05ec6…
/// ```
///
/// It is the LITE SINGLE build for one measured reason: `option name Threads type spin default 1
/// min 1 max 1` — it is single-threaded by construction, so it needs no `SharedArrayBuffer` and
/// therefore no COOP/COEP headers on this app's own web server. The lichess-style multi-threaded
/// `stockfish.wasm` needs both, and those headers would break every cross-origin picture this app
/// draws. The full NNUE build is 113 MB, which is not "light" by any reading.
pub const ENGINE_FILES: [EngineFile; 2] = [
    EngineFile {
        name: "stockfish-18-lite-single.js",
        url: "https://github.com/nmrugg/stockfish.js/releases/download/v18.0.0/stockfish-18-lite-single.js",
        size: 20_670,
        sha256: "2278005057f381491f1c9bb3e44c9f5920b3a00bef9759e33cc6582769a1f1fe",
    },
    EngineFile {
        name: "stockfish-18-lite-single.wasm",
        url: "https://github.com/nmrugg/stockfish.js/releases/download/v18.0.0/stockfish-18-lite-single.wasm",
        size: 7_295_411,
        sha256: "a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1",
    },
];

/// The GLUE — the file a Worker is created from. Its own name is what the page asks for, and the
/// `.wasm` beside it is found by the glue itself: it reads `self.location` and replaces the `.js`
/// suffix, which is why the two files must be served from ONE directory under ONE path.
pub const ENGINE_WORKER: &str = "stockfish-18-lite-single.js";

/// What every file together weighs — what the row says before the press.
pub fn total_bytes() -> u64 {
    ENGINE_FILES.iter().map(|f| f.size).sum()
}

/// The ceiling on a single read, whatever a server claims. Twice the largest pinned file, so a
/// response that lies about its length costs a bounded amount of disk and nothing else.
pub const MAX_ENGINE_BYTES: u64 = 16 * 1024 * 1024;

/// How long one file may take. A 7.3 MB read on a slow phone tether is minutes, not seconds.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// This machine's cache root, XDG first — the same rule `update::cache_base` follows, for the same
/// reason: the cache is the one place a machine may clean up behind us.
fn cache_base() -> Result<PathBuf> {
    match std::env::var_os("XDG_CACHE_HOME") {
        // ABSOLUTE only, which is `update::cache_base`'s own rule and what the route that serves
        // these files already assumes (`web/engine-file.ts` takes a path starting with `/`). A
        // relative value accepted here and refused there is one machine with two answers to "where
        // is the engine".
        Some(dir) if !dir.is_empty() && Path::new(&dir).is_absolute() => Ok(PathBuf::from(dir)),
        _ => {
            let home = std::env::var_os("HOME")
                .context("no XDG_CACHE_HOME and no HOME — nowhere to put the engine")?;
            Ok(PathBuf::from(home).join(".cache"))
        }
    }
}

/// Where the engine's files live. `TEAMS_LITE_ENGINE_DIR` overrides it, which is what lets a test
/// point the whole feature at a temporary directory — it is read here and nowhere else, so there is
/// one answer to "where is the engine" on this machine.
pub fn engine_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("TEAMS_LITE_ENGINE_DIR")
        .filter(|d| !d.is_empty() && Path::new(d).is_absolute())
    {
        return Ok(PathBuf::from(dir));
    }
    Ok(cache_base()?.join("teams-lite").join("engine").join(ENGINE_VERSION))
}

/// The path of ONE PINNED file. A name that is not in the table answers `None`, which is what makes
/// a path traversal impossible: nothing here ever joins a caller's string to a directory.
pub fn engine_path(name: &str) -> Option<PathBuf> {
    let file = ENGINE_FILES.iter().find(|f| f.name == name)?;
    engine_dir().ok().map(|dir| dir.join(file.name))
}

/// Whether one file is there, the right length AND the right bytes.
///
/// **THE DIGEST IS CHECKED ON DISK, not only on the way in**, and that is worth the work: these
/// bytes are served to the browser from this app's own origin, so whatever is in this directory runs
/// as the app. A file placed there by hand — or left by a build that pinned something else — would
/// otherwise be handed to a Worker on the strength of its length alone. The download's own check
/// cannot cover that: it happened before the file existed on disk.
///
/// It is CACHED per process, keyed by what a change would move (the length and the modification
/// time), so the 7.3 MB is hashed once per backend rather than once per read. A `status` read is
/// answered on every connect and after every press, and hashing on each would be work nobody sees.
fn file_is_present(file: &EngineFile) -> bool {
    let Some(path) = engine_path(file.name) else { return false };
    let Ok(meta) = std::fs::metadata(&path) else { return false };
    if !meta.is_file() || meta.len() != file.size {
        return false;
    }
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = (file.name, meta.len(), stamp);
    if let Ok(seen) = VERIFIED.lock() {
        if seen.get(&key) == Some(&true) {
            return true;
        }
    }
    let Ok(bytes) = std::fs::read(&path) else { return false };
    let ok = hex(&Sha256::digest(&bytes)).eq_ignore_ascii_case(file.sha256);
    if let Ok(mut seen) = VERIFIED.lock() {
        // Only a PASS is remembered: a file that failed may be replaced by the right one a moment
        // later (a download finishing), and a cached "no" would keep the engine absent until the
        // backend restarted.
        if ok {
            seen.insert(key, true);
        }
    }
    if !ok {
        eprintln!(
            "[engine] {} is on disk but is not the file this build pinned — ignoring it",
            file.name
        );
    }
    ok
}

/// What this process has already hashed: `(name, length, mtime) -> verified`.
static VERIFIED: std::sync::Mutex<Option<std::collections::HashMap<(&'static str, u64, u128), bool>>> =
    std::sync::Mutex::new(None);

/// The map, created on first use. A `Mutex<HashMap>` cannot be a `static` initializer without one
/// more dependency, and this is the whole of what that costs.
trait VerifiedMap {
    fn get(&self, key: &(&'static str, u64, u128)) -> Option<&bool>;
    fn insert(&mut self, key: (&'static str, u64, u128), value: bool);
}

impl VerifiedMap for std::sync::MutexGuard<'_, Option<std::collections::HashMap<(&'static str, u64, u128), bool>>> {
    fn get(&self, key: &(&'static str, u64, u128)) -> Option<&bool> {
        self.as_ref().and_then(|map| map.get(key))
    }
    fn insert(&mut self, key: (&'static str, u64, u128), value: bool) {
        self.get_or_insert_with(std::collections::HashMap::new).insert(key, value);
    }
}

/// Whether the whole engine is on this machine.
pub fn is_present() -> bool {
    ENGINE_FILES.iter().all(file_is_present)
}

/// What a page needs to know: whether it can start a game, what fetching one costs, and what the
/// engine's own strength range is. It carries no path — where the bytes are is this machine's
/// business, and the page loads them from the app's own address.
pub fn status_json() -> serde_json::Value {
    serde_json::json!({
        "label": ENGINE_LABEL,
        "version": ENGINE_VERSION,
        "present": is_present(),
        "bytes": total_bytes(),
        // The ADDRESS the page loads the worker from, spelled by this machine rather than assembled
        // by a client: the route carries the engine's version, and a page that built the path itself
        // would be one build's page guessing another build's URL.
        "worker_path": format!("/__engine/{ENGINE_VERSION}/{ENGINE_WORKER}"),
        "min_elo": ENGINE_MIN_ELO,
        "max_elo": ENGINE_MAX_ELO,
    })
}

/// Fetch whatever is missing, verify it, and install it.
///
/// `on_progress` is called with (received, total) over the WHOLE download rather than per file, so
/// a page draws one bar. It is called often; the caller throttles.
pub async fn download<F>(http: &reqwest::Client, mut on_progress: F) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let dir = engine_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let total = total_bytes();
    let mut done: u64 = 0;
    for file in ENGINE_FILES.iter() {
        if file_is_present(file) {
            done += file.size;
            on_progress(done, total);
            continue;
        }
        fetch_one(http, file, &dir, &mut |received| on_progress(done + received, total)).await?;
        done += file.size;
        on_progress(done, total);
    }
    Ok(())
}

/// One file: streamed to a `.part`, hashed as it goes, installed by rename only once both the
/// length and the digest are what this build pinned.
async fn fetch_one<F>(
    http: &reqwest::Client,
    file: &EngineFile,
    dir: &Path,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64),
{
    let dest = dir.join(file.name);
    // `with_extension("part")` REPLACES the suffix, so the glue and its wasm would both stream into
    // `stockfish-18-lite-single.part` — one temporary file for two downloads. The pid is the other
    // half: two backends share this machine (§ Running the released build beside the staged one),
    // and two transfers into one temporary file corrupt both.
    let part = dir.join(format!("{}.part.{}", file.name, std::process::id()));
    let resp = http
        .get(file.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("download {}", file.name))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "download {} -> {}",
        file.name,
        resp.status()
    );
    // The transfer's own statement of its length, checked BEFORE the bytes: it costs nothing and it
    // catches a host answering with something else entirely. It is never taken AS the expected
    // length — the pinned numbers stay the authority.
    if let Some(stated) = resp.content_length() {
        anyhow::ensure!(
            stated == file.size,
            "{} is {} bytes here and {} bytes in this build — the engine release may have been \
             replaced, so this build cannot verify it",
            file.name,
            stated,
            file.size
        );
    }

    let mut out = std::fs::File::create(&part)
        .with_context(|| format!("create {}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut resp = resp;
    on_progress(0);
    let outcome: Result<()> = loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                received += chunk.len() as u64;
                // Bounded by what this build PINNED rather than by the table's own ceiling: a
                // response longer than the file it claims to be is refused at the first byte over,
                // so nothing is written that could not possibly verify.
                if received > file.size {
                    break Err(anyhow::anyhow!(
                        "{} is longer than the {} bytes this build pinned — refused",
                        file.name,
                        file.size
                    ));
                }
                hasher.update(&chunk);
                if let Err(e) = std::io::Write::write_all(&mut out, &chunk) {
                    break Err(anyhow::Error::new(e).context(format!("write {}", part.display())));
                }
                on_progress(received);
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(anyhow::Error::new(e).context(format!("read {}", file.name))),
        }
    };
    drop(out);

    let verified = outcome.and_then(|()| verify(file, received, &hex(&hasher.finalize())));
    if let Err(e) = verified {
        // Leave nothing loadable behind: half an engine, or somebody else's, is worse than none —
        // the next press would hand it to the reader's browser.
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, &dest)
        .with_context(|| format!("rename {} -> {}", part.display(), dest.display()))?;
    Ok(())
}

/// Is what arrived the file this build pinned? Length AND digest, and the digest is the one that
/// matters: it is what says these bytes are the engine that was measured rather than whatever the
/// host answered today.
///
/// Pure, so both halves are tested with no network.
pub fn verify(file: &EngineFile, received: u64, digest: &str) -> Result<()> {
    anyhow::ensure!(
        received == file.size,
        "{} arrived as {} bytes and this build expects {} — the transfer stopped, or the release \
         moved",
        file.name,
        received,
        file.size
    );
    anyhow::ensure!(
        digest.eq_ignore_ascii_case(file.sha256),
        "{} is not the file this build pinned (its checksum differs) — refused, because what it \
         holds would run in the browser",
        file.name
    );
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Give the disk back. Answers how many bytes went, so the row can say it.
pub fn forget() -> Result<u64> {
    let mut freed = 0;
    for file in ENGINE_FILES.iter() {
        let Some(path) = engine_path(file.name) else { continue };
        if let Ok(meta) = std::fs::metadata(&path) {
            if std::fs::remove_file(&path).is_ok() {
                freed += meta.len();
            }
        }
    }
    // Every temporary a failed transfer left behind, whichever process wrote it: they are named
    // `<file>.part.<pid>`, and a pid that is gone is not coming back for its half a download.
    if let Ok(dir) = engine_dir() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !ENGINE_FILES.iter().any(|f| name.starts_with(&format!("{}.part.", f.name))) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if std::fs::remove_file(entry.path()).is_ok() {
                        freed += meta.len();
                    }
                }
            }
        }
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned table is the MEASURED one, and the numbers are the whole of its safety.
    ///
    /// They were read off the real files on 2026-08-24 (fetched from the release named in the URL,
    /// then `sha256sum`). This test is what makes changing one of them a deliberate act: a build
    /// that pins a different engine has to state its own numbers here, and the download refuses
    /// anything that does not match them.
    #[test]
    fn the_engine_is_pinned_by_name_size_and_digest() {
        assert_eq!(ENGINE_FILES.len(), 2, "the glue and its wasm");
        for file in ENGINE_FILES.iter() {
            assert!(
                file.url.starts_with("https://github.com/nmrugg/stockfish.js/releases/download/"),
                "one host, one release: {}",
                file.url
            );
            assert!(file.url.ends_with(file.name), "the URL names the file: {}", file.url);
            assert_eq!(file.sha256.len(), 64, "a sha256 is 64 hex characters");
            assert!(
                file.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "lowercase hex only"
            );
            assert!(file.size > 0 && file.size < MAX_ENGINE_BYTES, "{} is bounded", file.name);
        }
        // The measured numbers themselves, so a typo in one of them fails here rather than in a
        // reader's browser.
        assert_eq!(ENGINE_FILES[0].size, 20_670);
        assert_eq!(ENGINE_FILES[1].size, 7_295_411);
        assert_eq!(total_bytes(), 7_316_081);
        // The glue is what a Worker is made from, and the wasm is found BESIDE it by the glue
        // itself — so the two must sit in one directory and the worker must be the `.js`.
        assert_eq!(ENGINE_WORKER, ENGINE_FILES[0].name);
        assert!(ENGINE_WORKER.ends_with(".js"));
        assert!(ENGINE_FILES[1].name.ends_with(".wasm"));
        assert_eq!(
            ENGINE_FILES[1].name,
            ENGINE_WORKER.replace(".js", ".wasm"),
            "the glue derives the wasm's name from its own, so the pair must differ only in the \
             suffix"
        );
        // The Elo range is the engine's own, measured off `uci`.
        assert_eq!((ENGINE_MIN_ELO, ENGINE_MAX_ELO), (1320, 3190));
    }

    /// THE ROUTE THAT SERVES IT AGREES WITH THIS TABLE.
    ///
    /// The bytes reach the browser through `web/engine-file.ts`, which is on the other side of a
    /// process boundary: it is TypeScript, run by the app's own web server and by the dev server, so
    /// nothing else in this crate can see it. A name or a version that drifted there is an engine
    /// this backend fetched and the page cannot load — and the page's failure would name the file
    /// rather than the mistake. So the two spellings are scanned against each other, which is the
    /// discipline the unit files, the PATH and the ports table already hold.
    #[test]
    fn the_engine_and_its_route_agree() {
        let route = include_str!("../web/engine-file.ts");
        assert!(
            route.contains(&format!("ENGINE_VERSION = \"{ENGINE_VERSION}\"")),
            "web/engine-file.ts must name this build's engine version"
        );
        for file in ENGINE_FILES.iter() {
            assert!(
                route.contains(&format!("name: \"{}\"", file.name)),
                "web/engine-file.ts must serve {} — it is what the page asks for",
                file.name
            );
        }
        // And it serves NOTHING else: the list is what a request is matched against, so a third
        // entry here would be a file this build never verified.
        assert_eq!(
            route.matches("name: \"stockfish").count(),
            ENGINE_FILES.len(),
            "the route serves exactly the pinned files"
        );
        assert!(
            route.contains(&format!("ENGINE_ROUTE}}{{ENGINE_VERSION}}/")) || route.contains("${ENGINE_ROUTE}${ENGINE_VERSION}/"),
            "the route must carry the engine's VERSION, because the answer is cached as immutable"
        );
        assert!(
            route.contains("ENGINE_SERVED.find((file) => file.name === asked)"),
            "the path must be built from the MATCH rather than from the request, or the route \
             serves any file on this machine"
        );
    }

    #[test]
    fn verify_refuses_a_wrong_size_and_a_wrong_digest() {
        let file = &ENGINE_FILES[0];
        assert!(verify(file, file.size, file.sha256).is_ok());
        assert!(verify(file, file.size, &file.sha256.to_uppercase()).is_ok(), "hex is hex");

        let short = verify(file, file.size - 1, file.sha256).unwrap_err().to_string();
        assert!(short.contains("transfer stopped"), "{short}");
        // The digest is the rail that matters: the right LENGTH with the wrong bytes is exactly
        // what a substituted file looks like.
        let wrong = verify(file, file.size, &"0".repeat(64)).unwrap_err().to_string();
        assert!(wrong.contains("checksum differs"), "{wrong}");
        assert!(
            wrong.contains("run in the browser"),
            "the refusal says why it matters: {wrong}"
        );
    }

    /// A path is built from a PINNED NAME and never from a caller's string.
    #[test]
    fn only_a_pinned_name_is_a_path() {
        assert!(engine_path(ENGINE_WORKER).is_some());
        for name in [
            "../../../etc/passwd",
            "stockfish-18-lite-single.js/../../secret",
            "",
            "stockfish.js",
            "stockfish-18-lite-single.JS",
        ] {
            assert!(engine_path(name).is_none(), "{name} is not a pinned name");
        }
    }

    /// The version is part of the directory, so two builds' engines cannot be confused.
    #[test]
    fn the_cache_path_carries_the_version() {
        // Read through the override, so the test says nothing about this machine's own HOME.
        temp_env_dir("engine-path-test", |dir| {
            assert_eq!(engine_dir().unwrap(), dir);
        });
        let path = engine_dir().unwrap();
        let shown = path.display().to_string();
        assert!(shown.contains("teams-lite"), "{shown}");
        assert!(shown.contains("engine"), "{shown}");
        assert!(shown.ends_with(ENGINE_VERSION), "{shown}");
    }

    #[test]
    fn present_is_the_length_of_every_pinned_file() {
        temp_env_dir("engine-present-test", |dir| {
            assert!(!is_present(), "nothing there");
            // A file of the wrong length is not the engine.
            std::fs::write(dir.join(ENGINE_FILES[0].name), b"not the glue").unwrap();
            assert!(!is_present());
            assert!(!status_json()["present"].as_bool().unwrap());
            // Both files at the right LENGTH but the wrong bytes: still not the engine, because the
            // digest is what says these are the bytes this build measured — and they are served to a
            // browser, where whatever they hold runs as the app.
            for file in ENGINE_FILES.iter() {
                std::fs::write(dir.join(file.name), vec![0u8; file.size as usize]).unwrap();
            }
            assert!(!is_present(), "the right length is not the right file");
            assert!(!status_json()["present"].as_bool().unwrap());
            // And giving it back frees whatever was there, including a half download.
            std::fs::write(dir.join(format!("{}.part.999", ENGINE_FILES[0].name)), b"half").unwrap();
            assert_eq!(forget().unwrap(), total_bytes() + 4);
            assert!(!is_present());
        });
    }

    /// THE WHOLE CHAIN, against the real release — the one check that cannot be faked.
    ///
    /// Everything above is arithmetic over a pinned table; this fetches the real files from the real
    /// URL, hashes them, and installs them. It is `#[ignore]`d because it downloads 7.3 MB: a suite
    /// that did that on every run would be a suite nobody runs. Do it by hand when the pinned table
    /// changes, and read what it prints:
    ///
    /// ```text
    /// cargo test --lib chess_engine::tests::the_real_engine_downloads_and_verifies -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "downloads 7.3 MB from the pinned release"]
    fn the_real_engine_downloads_and_verifies() {
        let dir = std::env::temp_dir().join(format!("teams-lite-engine-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // SAFETY: nothing else runs in this test's process while it holds the variable.
        unsafe { std::env::set_var("TEAMS_LITE_ENGINE_DIR", &dir) };
        let http = reqwest::Client::builder().build().expect("http client");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let outcome = rt.block_on(async {
            download(&http, |received, total| {
                if received == total {
                    println!("[engine] {received} of {total} bytes");
                }
            })
            .await
        });
        outcome.expect("the pinned engine downloads and verifies");
        assert!(is_present(), "and it is present afterwards");
        for file in ENGINE_FILES.iter() {
            let path = engine_path(file.name).expect("a pinned path");
            let bytes = std::fs::read(&path).expect("read it back");
            assert_eq!(bytes.len() as u64, file.size);
            assert_eq!(hex(&Sha256::digest(&bytes)), file.sha256, "{}", file.name);
            println!("[engine] {} verified: {} bytes", file.name, bytes.len());
        }
        // And a SECOND download is a no-op rather than a second 7.3 MB.
        let again = rt.block_on(async { download(&http, |_, _| {}).await });
        again.expect("a second download does nothing");
        assert_eq!(forget().unwrap(), total_bytes());
        unsafe { std::env::remove_var("TEAMS_LITE_ENGINE_DIR") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run `body` with the engine directory pointed at a temporary one. Serialized by a mutex,
    /// because the override is an environment variable and tests share a process.
    fn temp_env_dir(tag: &str, body: impl FnOnce(&Path)) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("teams-lite-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: the mutex above is what keeps this from racing another test in this process.
        unsafe { std::env::set_var("TEAMS_LITE_ENGINE_DIR", &dir) };
        body(&dir);
        unsafe { std::env::remove_var("TEAMS_LITE_ENGINE_DIR") };
        let _ = std::fs::remove_dir_all(&dir);
    }
}
