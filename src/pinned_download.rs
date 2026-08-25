//! A FILE THIS BUILD PINNED, fetched from the internet and verified before anything uses it.
//!
//! Two features fetch bytes that a reader's browser then runs or plays: the chess ENGINE (7.3 MB of
//! WebAssembly — see [`crate::chess_engine`]) and the board's own SOUNDS (64 KB of MP3 — see
//! [`crate::chess_sound`]). Neither ships in the release asset, and in both the browser never
//! touches the host: the backend fetches, verifies, caches, and this app serves the bytes from its
//! own origin.
//!
//! **THE POLICY IS HERE, ONCE.** What each feature keeps for itself is its own table, its own cache
//! directory and its own words for a reader; what they must never spell twice is the rule that
//! decides whether a downloaded file may be used at all. Two copies of that rule is two chances to
//! get it wrong, and the one that was got wrong would be serving whatever a host answered to a
//! browser as this app's own origin. So:
//!
//!   - **the URL is a CONSTANT** in the caller's table — one host, one path per entry, and no client
//!     supplies any part of it. A client that could name the URL could make this machine fetch
//!     anything and then hand it to the reader's browser;
//!   - **the response's own stated length must match** the pinned one, checked BEFORE the bytes, so
//!     a captive portal's login page costs nothing;
//!   - **the SHA-256 must match**, computed over the bytes as they stream and checked before
//!     anything is installed. It is the only thing standing between the reader and whatever the
//!     host answered today, which is why a length alone is never enough: the right length with the
//!     wrong bytes is exactly what a substituted file looks like;
//!   - **the read is BOUNDED** by the pinned size itself, refused at the first byte over, so
//!     nothing is ever written that could not possibly verify;
//!   - **the install is a RENAME** of a `.part` sibling, so a file is complete or absent — never
//!     half of one that a page would try to use;
//!   - **a file that fails is DELETED**, because a half file that looks right is worse than no
//!     file: the next attempt would load it.
//!
//! The `.part` name carries the PROCESS ID. `with_extension("part")` replaces the suffix, so two
//! files differing only in theirs would stream into one temporary — and this machine runs two
//! send-capable backends against one cache (§ Running the released build beside the staged one), so
//! two transfers into one temporary corrupt both.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One file a build pins: where it comes from, and what it must be.
///
/// The name is its name on disk AND in the URL — and the only thing a path is ever built from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinnedFile {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    /// Lowercase hex, 64 characters.
    pub sha256: &'static str,
}

/// This machine's cache root, XDG first.
///
/// The cache is the one place a machine is allowed to clean up behind us, which is why these files
/// live there rather than in the store. ABSOLUTE only: the routes that serve these bytes take a
/// path starting with `/` (see web/engine-file.ts and web/chess-sound-file.ts), and a relative value
/// accepted here and refused there is one machine with two answers to "where is it".
pub fn cache_base() -> Result<PathBuf> {
    match std::env::var_os("XDG_CACHE_HOME") {
        Some(dir) if !dir.is_empty() && Path::new(&dir).is_absolute() => Ok(PathBuf::from(dir)),
        _ => {
            let home = std::env::var_os("HOME")
                .context("no XDG_CACHE_HOME and no HOME — nowhere to put a downloaded file")?;
            Ok(PathBuf::from(home).join(".cache"))
        }
    }
}

/// Lowercase hex of some bytes.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The SHA-256 of a file on disk, or `None` when it cannot be read.
pub fn digest_of(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(hex(&Sha256::digest(&bytes)))
}

/// The path of ONE PINNED file inside `dir`.
///
/// A name that is not in `files` answers `None`, which is what makes a traversal impossible:
/// nothing here ever joins a caller's string to a directory.
pub fn path_of(dir: &Path, files: &[PinnedFile], name: &str) -> Option<PathBuf> {
    let file = files.iter().find(|f| f.name == name)?;
    Some(dir.join(file.name))
}

/// Is what arrived the file this build pinned? Length AND digest.
///
/// `risk` names what these bytes would go on to do, and it is stated in the refusal because that is
/// what makes the refusal worth reading: the same mismatch on a WebAssembly module and on a sound
/// effect are two different sentences to whoever finds one in a journal.
///
/// Pure, so both halves are tested with no network.
pub fn verify(file: &PinnedFile, received: u64, digest: &str, risk: &str) -> Result<()> {
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
        "{} is not the file this build pinned (its checksum differs) — refused, because {}",
        file.name,
        risk
    );
    Ok(())
}

/// Whether one pinned file is on disk, at the right length AND holding the right bytes.
///
/// **THE DIGEST IS CHECKED ON DISK, not only on the way in**, and that is worth the work: these
/// bytes are served to the browser from this app's own origin, so whatever is in the directory acts
/// as the app. A file placed there by hand — or left by a build that pinned something else — would
/// otherwise be used on the strength of its length alone, and the download's own check cannot cover
/// that: it happened before the file existed.
pub fn is_intact(dir: &Path, file: &PinnedFile) -> bool {
    let path = dir.join(file.name);
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.len() != file.size {
        return false;
    }
    digest_of(&path).is_some_and(|d| d.eq_ignore_ascii_case(file.sha256))
}

/// One file: streamed to a `.part`, hashed as it goes, installed by rename only once both the
/// length and the digest are what this build pinned.
///
/// `on_progress` is called with the bytes received so far, often — the caller throttles.
pub async fn fetch_one<F>(
    http: &reqwest::Client,
    file: &PinnedFile,
    dir: &Path,
    timeout: Duration,
    risk: &str,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64),
{
    let dest = dir.join(file.name);
    let part = dir.join(format!("{}.part.{}", file.name, std::process::id()));
    let resp = http
        .get(file.url)
        .timeout(timeout)
        .send()
        .await
        .with_context(|| format!("download {}", file.name))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "download {} -> {}",
        file.name,
        resp.status()
    );
    // The transfer's own statement of its length, checked before the bytes: it costs nothing and it
    // catches a host answering with something else entirely. It is never taken AS the expected
    // length — the pinned numbers stay the authority.
    if let Some(stated) = resp.content_length() {
        anyhow::ensure!(
            stated == file.size,
            "{} is {} bytes here and {} bytes in this build — the file upstream may have been \
             replaced, so this build cannot verify it",
            file.name,
            stated,
            file.size
        );
    }

    let mut out =
        std::fs::File::create(&part).with_context(|| format!("create {}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut resp = resp;
    on_progress(0);
    let outcome: Result<()> = loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                received += chunk.len() as u64;
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

    let verified = outcome.and_then(|()| verify(file, received, &hex(&hasher.finalize()), risk));
    if let Err(e) = verified {
        // Leave nothing usable behind: half a file, or somebody else's, is worse than none.
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, &dest)
        .with_context(|| format!("rename {} -> {}", part.display(), dest.display()))?;
    Ok(())
}

/// Give the disk back: every pinned file in `dir`, and every temporary a failed transfer left
/// behind — whichever process wrote it, since a pid that is gone is not coming back for its half a
/// download. Answers how many bytes went, so a row can say it.
pub fn forget_in(dir: &Path, files: &[PinnedFile]) -> Result<u64> {
    let mut freed = 0;
    for file in files.iter() {
        let path = dir.join(file.name);
        if let Ok(meta) = std::fs::metadata(&path) {
            if std::fs::remove_file(&path).is_ok() {
                freed += meta.len();
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !files
                .iter()
                .any(|f| name.starts_with(&format!("{}.part.", f.name)))
            {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if std::fs::remove_file(entry.path()).is_ok() {
                    freed += meta.len();
                }
            }
        }
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: PinnedFile = PinnedFile {
        name: "thing.bin",
        url: "https://example.invalid/thing.bin",
        size: 4,
        // sha256 of the four bytes `test`.
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    };

    #[test]
    fn verify_refuses_a_wrong_length_and_wrong_bytes() {
        assert!(verify(&FILE, 4, FILE.sha256, "it runs").is_ok());
        assert!(
            verify(&FILE, 4, &FILE.sha256.to_uppercase(), "it runs").is_ok(),
            "hex is hex"
        );

        let short = verify(&FILE, 3, FILE.sha256, "it runs")
            .unwrap_err()
            .to_string();
        assert!(short.contains("transfer stopped"), "{short}");
        // The digest is the rail that matters: the right LENGTH with the wrong bytes is exactly what
        // a substituted file looks like.
        let wrong = verify(&FILE, 4, &"0".repeat(64), "it would run in the browser")
            .unwrap_err()
            .to_string();
        assert!(wrong.contains("checksum differs"), "{wrong}");
        assert!(
            wrong.contains("it would run in the browser"),
            "the refusal states the risk: {wrong}"
        );
    }

    #[test]
    fn a_path_comes_from_a_pinned_name_and_never_from_a_caller() {
        let dir = Path::new("/tmp/whatever");
        assert!(path_of(dir, &[FILE], "thing.bin").is_some());
        for name in [
            "../../../etc/passwd",
            "thing.bin/../../secret",
            "",
            "thing",
            "THING.BIN",
        ] {
            assert!(path_of(dir, &[FILE], name).is_none(), "{name}");
        }
    }

    #[test]
    fn intact_means_the_right_length_and_the_right_bytes() {
        let dir = std::env::temp_dir().join(format!("teams-lite-pinned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(!is_intact(&dir, &FILE), "nothing there");
        // The right length, the wrong bytes: not the file.
        std::fs::write(dir.join(FILE.name), b"nope").unwrap();
        assert!(!is_intact(&dir, &FILE), "the right length is not the right file");
        std::fs::write(dir.join(FILE.name), b"test").unwrap();
        assert!(is_intact(&dir, &FILE));

        // And forgetting takes the file AND a half download, whichever process wrote it.
        std::fs::write(dir.join(format!("{}.part.999", FILE.name)), b"ha").unwrap();
        assert_eq!(forget_in(&dir, &[FILE]).unwrap(), 6);
        assert!(!is_intact(&dir, &FILE));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
