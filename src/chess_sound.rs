//! THE BOARD'S OWN SOUNDS — chess.com's, fetched once and served from this machine.
//!
//! A board that answers a move with a knock is most of what makes playing one feel like playing one,
//! and the sounds every chess player already knows are chess.com's: the wooden click of a piece
//! landing, the double knock of a capture, the alert of a check. They are RECORDINGS, so unlike the
//! rest of this app's cues (`web/src/lib/sounds.ts`, and the oscillators these replaced) they cannot
//! be built out of nothing — they have to be downloaded. This module is why the reader's browser
//! never does the downloading.
//!
//! **THEY ARE NOT IN THIS APP, and that is deliberate twice over.**
//!
//!   - **They are chess.com's recordings, not ours.** This app does not redistribute somebody
//!     else's assets: committing them to a public repository and shipping them inside the 134 MB
//!     release asset would be publishing their audio under our name. Fetching them per machine, from
//!     the address they publish them at, is what any browser does when it opens chess.com. It is the
//!     licensing argument rather than a size one — 64 KB in a 134 MB asset would cost nothing, which
//!     is exactly why the engine's own reason (7.3 MB nobody who never opens a board should pay for)
//!     does not apply here and must not be borrowed as a justification.
//!   - **The BROWSER never touches their server.** A page that fetched these itself would tell
//!     chess.com's CDN the reader's address every time it drew a board — which is the read receipt
//!     § Mail strips out of every message body, in another costume. The backend fetches ONCE per
//!     machine, verifies each file against a digest this build pins, caches them under
//!     `~/.cache/teams-lite/chess-sounds/<version>/`, and this app serves the bytes from its own
//!     origin (see web/chess-sound-file.ts). So the number of requests chess.com ever sees is the
//!     number of machines that opened a board, not the number of boards or the number of moves.
//!
//! **A BOARD IS NEVER SILENT WHILE THEY ARE MISSING.** The synthesized palette stays in
//! `web/src/lib/chess-sound.ts` as the FALLBACK, so the first game on a fresh machine, a machine
//! that is offline, and one where chess.com cannot be reached all sound like the app did before this
//! — a knock rather than a recording of oak. That is the rule § A picture somebody SENT already
//! holds for a reduced view: the better thing is the addition, so the feature can never cost a
//! reader the thing itself.
//!
//! **EVERY NUMBER BELOW IS MEASURED**, on 2026-08-25, by fetching all twelve files and hashing them.
//! The digests are the whole of the safety here: a length alone is met by any 5 353 bytes, and three
//! of these files are exactly that long.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::pinned_download::{self, PinnedFile};

/// Where they come from. ONE host, ONE directory, and the file name is the only part that varies —
/// so no client supplies any piece of a URL this machine fetches.
///
/// The table below cannot be written in terms of it: a `const` array of `&'static str` needs
/// literals, and `concat!` takes literals rather than constants. So this is the CHECKER rather than
/// the source — `every_sound_is_pinned_by_name_size_and_digest` holds every entry to `base + name`,
/// which is what makes the twelve spellings one address.
#[cfg(test)]
const SOUND_BASE: &str = "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/";

/// What these sounds are, where a reader can see it.
pub const SOUND_LABEL: &str = "chess.com's default board sounds";

/// The theme and a digest over the whole pinned table — the cache directory AND the middle segment
/// of the route that serves it (see web/chess-sound-file.ts).
///
/// **IT CARRIES THE TABLE'S OWN DIGEST**, for the reason [`crate::chess_engine::ENGINE_VERSION`]
/// carries the wasm's: the file NAMES are upstream's and would not change if chess.com replaced the
/// recordings behind them, so `chesscom-default` alone would let a later build — pinning different
/// digests under the same names — read the bytes this one verified out of the cache, and serve them
/// from a URL this app tells the browser to keep for a year. With the digest in the path, a
/// different pinned set is a different directory and a different address, with nothing to invalidate.
///
/// `chess_sound::tests::the_version_is_the_table_s_own_digest` recomputes it, so it cannot drift
/// from the table it names.
pub const SOUND_VERSION: &str = "chesscom-default-94997488";

/// The twelve, MEASURED on 2026-08-25 (fetched from the URL each one names, then `sha256sum`).
///
/// The set is the one the user named, event by event, and it is deliberately not everything that
/// directory holds: chess.com also publishes `game-win-long`, `game-lose-long` and `game-draw`,
/// which are not pinned here — so a game ending is `game-end` whichever way it went (see
/// `web/src/lib/chess-sound.ts`, where that trade is stated where a reader of the palette meets it).
///
/// **THE ORDER IS PART OF [`SOUND_VERSION`]**, which is computed over this table as written.
pub const SOUND_FILES: [PinnedFile; 12] = [
    PinnedFile {
        name: "game-start.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "game-start.mp3"
        ),
        size: 5_353,
        sha256: "cdb01ddc68a1406abd065597ec604053dd9ea8e20636f27d41a6fe1d6b1a835d",
    },
    PinnedFile {
        name: "game-end.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "game-end.mp3"
        ),
        size: 5_353,
        sha256: "9b53d24c925bcc96b05ca4808ff1198293f0bb3422176927cef5d3a10c4c9023",
    },
    PinnedFile {
        name: "capture.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "capture.mp3"
        ),
        size: 6_889,
        sha256: "7158a77f3eb9a763fe723e9c9291819de8748444a1192d10383159fd8175709b",
    },
    PinnedFile {
        name: "castle.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "castle.mp3"
        ),
        size: 5_353,
        sha256: "da05719e6b3f0d04a2ac1a551e643ab14f4e840ae3b9410c0ea15ba4bcac5010",
    },
    PinnedFile {
        name: "premove.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "premove.mp3"
        ),
        size: 4_201,
        sha256: "7d1057ba9537f92d20214028e6dd7e82f4c9c9fb607c6eb55e6f8cdc641f89af",
    },
    PinnedFile {
        name: "move-self.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "move-self.mp3"
        ),
        size: 3_433,
        sha256: "3a2eb75af1334c06dafd735c23388a560285e0df9436a44d27adc95a010a8547",
    },
    PinnedFile {
        name: "move-opponent.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "move-opponent.mp3"
        ),
        size: 3_433,
        sha256: "0931855637e50e4edbc7916ec7a66cca2f0eee763e1c791ff774a9945517ea61",
    },
    PinnedFile {
        name: "move-check.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "move-check.mp3"
        ),
        size: 6_121,
        sha256: "ef4764a74d19d0db1659e413e8afadc25f1e8cfba83a4a76e6e64f28f3077d52",
    },
    PinnedFile {
        name: "promote.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "promote.mp3"
        ),
        size: 4_969,
        sha256: "69219212aa2dce6031d6a641f8813779809bdff33562a8418d8e003eea465815",
    },
    PinnedFile {
        name: "notify.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "notify.mp3"
        ),
        size: 3_817,
        sha256: "5cfab87e94b55e1e51f0ac13856e6ba223e2fda6d2f4dd43f7b7e995ab393007",
    },
    PinnedFile {
        name: "illegal.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "illegal.mp3"
        ),
        size: 4_585,
        sha256: "3224eb7a6d93e52229ddcb49c62e584764d1474c123d25c91ecb2c74aa6291f9",
    },
    PinnedFile {
        name: "tenseconds.mp3",
        url: concat!(
            "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
            "tenseconds.mp3"
        ),
        size: 10_729,
        sha256: "797b878fc67d1c368c661c5e78511edc0796b5aba2e959204213a9547ba1d277",
    },
];

/// What the whole set weighs.
pub fn total_bytes() -> u64 {
    SOUND_FILES.iter().map(|f| f.size).sum()
}

/// What these bytes go on to do, stated in every refusal (see [`pinned_download::verify`]).
const RISK: &str = "it would be decoded and played in the reader's browser";

/// How long one file may take. Five kilobytes on a slow phone tether is still seconds, not minutes.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Where the sounds live. `TEAMS_LITE_CHESS_SOUND_DIR` overrides it, which is what lets a test point
/// the whole feature at a temporary directory — read here and in web/chess-sound-file.ts, and
/// nowhere else, so there is one answer to "where are the sounds" on this machine.
pub fn sounds_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("TEAMS_LITE_CHESS_SOUND_DIR")
        .filter(|d| !d.is_empty() && Path::new(d).is_absolute())
    {
        return Ok(PathBuf::from(dir));
    }
    Ok(pinned_download::cache_base()?
        .join("teams-lite")
        .join("chess-sounds")
        .join(SOUND_VERSION))
}

/// The path of ONE pinned sound. A name outside the table answers `None`.
pub fn sound_path(name: &str) -> Option<PathBuf> {
    let dir = sounds_dir().ok()?;
    pinned_download::path_of(&dir, &SOUND_FILES, name)
}

/// Whether every sound is on this machine, at the right length and holding the right bytes.
///
/// Unlike the engine's own check this is NOT cached per process: the whole set is 64 KB, so hashing
/// it is microseconds, and a cache would be one more thing that can be stale.
pub fn is_present() -> bool {
    let Ok(dir) = sounds_dir() else {
        return false;
    };
    SOUND_FILES
        .iter()
        .all(|file| pinned_download::is_intact(&dir, file))
}

/// What a page needs: whether it can play recordings, where to fetch them from on THIS app's own
/// origin, and what they weigh. It carries no filesystem path — where the bytes are is this
/// machine's business.
///
/// The ROUTE is spelled by this machine rather than assembled by a client, for the reason
/// `chess_engine::status_json` spells the worker's: the address carries a version, and a page that
/// built it itself would be one build's page guessing another build's URL.
pub fn status_json() -> serde_json::Value {
    serde_json::json!({
        "label": SOUND_LABEL,
        "version": SOUND_VERSION,
        "present": is_present(),
        "bytes": total_bytes(),
        "route": format!("/__chess-sound/{SOUND_VERSION}/"),
    })
}

/// Fetch whatever is missing and verify it. A file already intact is left alone, so a second call
/// costs no request at all.
pub async fn download(http: &reqwest::Client) -> Result<()> {
    let dir = sounds_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    for file in SOUND_FILES.iter() {
        if pinned_download::is_intact(&dir, file) {
            continue;
        }
        pinned_download::fetch_one(http, file, &dir, DOWNLOAD_TIMEOUT, RISK, &mut |_| {}).await?;
    }
    Ok(())
}

/// Give the disk back. Answers how many bytes went.
pub fn forget() -> Result<u64> {
    let dir = sounds_dir()?;
    pinned_download::forget_in(&dir, &SOUND_FILES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    /// The pinned table is the MEASURED one, and the numbers are the whole of its safety.
    #[test]
    fn every_sound_is_pinned_by_name_size_and_digest() {
        assert_eq!(SOUND_FILES.len(), 12, "the twelve events a board has");
        for file in SOUND_FILES.iter() {
            assert!(
                file.url.starts_with(SOUND_BASE),
                "one host, one directory: {}",
                file.url
            );
            assert_eq!(
                file.url,
                format!("{SOUND_BASE}{}", file.name),
                "the URL is the base plus the name and nothing else"
            );
            assert!(file.name.ends_with(".mp3"), "{} is an mp3", file.name);
            assert_eq!(file.sha256.len(), 64, "a sha256 is 64 hex characters");
            assert!(
                file.sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "lowercase hex only: {}",
                file.name
            );
            assert!(file.size > 0 && file.size < 64 * 1024, "{} is small", file.name);
        }
        // The measured total, so a typo in one size fails here rather than in a reader's browser.
        assert_eq!(total_bytes(), 64_236);

        // THREE of them are the SAME LENGTH and hold different recordings, which is why a length is
        // never what this module trusts.
        let same: Vec<_> = SOUND_FILES.iter().filter(|f| f.size == 5_353).collect();
        assert_eq!(same.len(), 3, "game-start, game-end and castle");
        let digests: std::collections::HashSet<_> = same.iter().map(|f| f.sha256).collect();
        assert_eq!(digests.len(), 3, "and all three digests differ");

        // No name is pinned twice: a duplicate would be one entry silently shadowing another.
        let names: std::collections::HashSet<_> = SOUND_FILES.iter().map(|f| f.name).collect();
        assert_eq!(names.len(), SOUND_FILES.len());
    }

    /// The version carries a digest OVER THE TABLE, so a build pinning different recordings cannot
    /// read this one's bytes out of the cache or be handed a browser's year-long copy of them.
    #[test]
    fn the_version_is_the_table_s_own_digest() {
        let mut hasher = Sha256::new();
        for file in SOUND_FILES.iter() {
            hasher.update(format!("{}:{}\n", trimmed(file.name), file.sha256));
        }
        let digest = pinned_download::hex(&hasher.finalize());
        assert_eq!(
            SOUND_VERSION,
            format!("chesscom-default-{}", &digest[..8]),
            "SOUND_VERSION must be recomputed when the table changes"
        );
    }

    /// The name without its suffix — what the digest above is taken over, and what the page's own
    /// table names.
    fn trimmed(name: &str) -> &str {
        name.strip_suffix(".mp3").unwrap_or(name)
    }

    /// THE ROUTE THAT SERVES THEM AGREES WITH THIS TABLE.
    ///
    /// The bytes reach the browser through `web/chess-sound-file.ts`, which is on the other side of a
    /// process boundary: it is TypeScript, run by the app's own web server and by the dev server, so
    /// nothing else in this crate can see it. A name or a version that drifted there is a sound this
    /// backend fetched and the page cannot load. It is the discipline `chess_engine`, the unit files
    /// and the ports table already hold.
    #[test]
    fn the_sounds_and_their_route_agree() {
        let route = include_str!("../web/chess-sound-file.ts");
        assert!(
            route.contains(&format!("CHESS_SOUND_VERSION = \"{SOUND_VERSION}\"")),
            "web/chess-sound-file.ts must name this build's sound version"
        );
        for file in SOUND_FILES.iter() {
            assert!(
                route.contains(&format!("\"{}\"", file.name)),
                "web/chess-sound-file.ts must serve {}",
                file.name
            );
        }
        // And NOTHING else: the list is what a request is matched against, so a thirteenth entry
        // would be a file this build never verified.
        assert_eq!(
            route.matches(".mp3\"").count(),
            SOUND_FILES.len(),
            "the route serves exactly the pinned sounds"
        );
        assert!(
            route.contains("CHESS_SOUNDS_SERVED.includes(asked)"),
            "the path must be built from the MATCH rather than from the request, or the route \
             serves any file on this machine"
        );
    }

    /// The page's own table names exactly these files — the third side of the same boundary.
    ///
    /// `web/src/lib/chess-sound.ts` maps an EVENT (a capture, a check) onto one of these names. A
    /// name that exists there and not here is an event whose sound would 404 for ever, and the page
    /// would fall back to a synthesized one with nothing to say why.
    #[test]
    fn the_page_asks_for_the_files_this_build_pins() {
        let page = include_str!("../web/src/lib/chess-sound.ts");
        for file in SOUND_FILES.iter() {
            let stem = trimmed(file.name);
            assert!(
                page.contains(&format!("\"{stem}\"")),
                "web/src/lib/chess-sound.ts must name {stem}"
            );
        }
    }

    #[test]
    fn present_is_the_bytes_of_every_pinned_file() {
        temp_env_dir("chess-sound-present", |dir| {
            assert!(!is_present(), "nothing there");
            assert!(!status_json()["present"].as_bool().unwrap());
            // Every file at the right LENGTH but the wrong bytes: still not the set, because the
            // digest is what says these are the recordings this build measured.
            for file in SOUND_FILES.iter() {
                std::fs::write(dir.join(file.name), vec![0u8; file.size as usize]).unwrap();
            }
            assert!(!is_present(), "the right length is not the right file");
            // And giving them back frees whatever was there, including a half download.
            std::fs::write(dir.join("capture.mp3.part.999"), b"half").unwrap();
            assert_eq!(forget().unwrap(), total_bytes() + 4);
        });
    }

    #[test]
    fn the_cache_path_carries_the_version() {
        temp_env_dir("chess-sound-path", |dir| {
            assert_eq!(sounds_dir().unwrap(), dir);
        });
        let shown = sounds_dir().unwrap().display().to_string();
        assert!(shown.contains("teams-lite"), "{shown}");
        assert!(shown.contains("chess-sounds"), "{shown}");
        assert!(shown.ends_with(SOUND_VERSION), "{shown}");
    }

    #[test]
    fn only_a_pinned_name_is_a_path() {
        temp_env_dir("chess-sound-traversal", |_| {
            assert!(sound_path("capture.mp3").is_some());
            for name in [
                "../../../etc/passwd",
                "capture.mp3/../../secret",
                "",
                "capture",
                "CAPTURE.MP3",
                "game-win-long.mp3",
            ] {
                assert!(sound_path(name).is_none(), "{name} is not pinned");
            }
        });
    }

    /// THE WHOLE SET, against the real CDN — the one check that cannot be faked.
    ///
    /// Everything above is arithmetic over a pinned table; this fetches the twelve real files,
    /// hashes them and installs them. It is `#[ignore]`d because it reaches the network:
    ///
    /// ```text
    /// cargo test --lib chess_sound::tests::the_real_sounds_download_and_verify -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "fetches 64 KB from chess.com's CDN"]
    fn the_real_sounds_download_and_verify() {
        let dir = std::env::temp_dir().join(format!("teams-lite-sounds-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // SAFETY: nothing else runs in this test's process while it holds the variable.
        unsafe { std::env::set_var("TEAMS_LITE_CHESS_SOUND_DIR", &dir) };
        let http = reqwest::Client::builder().build().expect("http client");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(async { download(&http).await })
            .expect("the pinned sounds download and verify");
        assert!(is_present(), "and they are present afterwards");
        for file in SOUND_FILES.iter() {
            let path = sound_path(file.name).expect("a pinned path");
            let bytes = std::fs::read(&path).expect("read it back");
            assert_eq!(bytes.len() as u64, file.size, "{}", file.name);
            assert_eq!(
                pinned_download::hex(&Sha256::digest(&bytes)),
                file.sha256,
                "{}",
                file.name
            );
            println!("[chess-sound] {} verified: {} bytes", file.name, bytes.len());
        }
        // A SECOND download is a no-op rather than twelve more requests.
        rt.block_on(async { download(&http).await }).expect("idempotent");
        assert_eq!(forget().unwrap(), total_bytes());
        unsafe { std::env::remove_var("TEAMS_LITE_CHESS_SOUND_DIR") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run `body` with the sound directory pointed at a temporary one. Serialized by a mutex,
    /// because the override is an environment variable and tests share a process.
    fn temp_env_dir(tag: &str, body: impl FnOnce(&Path)) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("teams-lite-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: the mutex above is what keeps this from racing another test in this process.
        unsafe { std::env::set_var("TEAMS_LITE_CHESS_SOUND_DIR", &dir) };
        body(&dir);
        unsafe { std::env::remove_var("TEAMS_LITE_CHESS_SOUND_DIR") };
        let _ = std::fs::remove_dir_all(&dir);
    }
}
