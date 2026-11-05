//! The one OpenPGP question this crate asks: did THIS pinned RSA key sign THESE bytes?
//!
//! It exists for exactly one caller, the Claude Code installer (see [`crate::agent_cli`]). Anthropic
//! publishes every release's `manifest.json` with a detached signature beside it
//! (`manifest.json.sig`), and that manifest is what names the SHA-256 of the binary — Linux builds
//! are not code-signed one by one, so the signed manifest IS the integrity chain. Without checking
//! it, the installer would trust whatever `downloads.claude.ai` answered today, which is the one
//! thing a release signature exists to stop.
//!
//! **IT IS A VERIFIER, NOT AN IMPLEMENTATION OF OPENPGP**, and that is the whole reason it is here
//! rather than a crate. A general implementation (`pgp`, `sequoia-openpgp`) brings dozens of
//! ciphers, compression and a keyring model this app has no use for; what one detached signature
//! from one pinned key needs is a packet reader, the version 4 hash construction, and RSA — which
//! is the `rsa` crate's, so nothing cryptographic is written here. What is refused rather than
//! supported, each on purpose:
//!
//!   - **anything but a version 4 signature over a BINARY document** (signature type `0x00`). A text
//!     signature would need line endings canonicalized, and Anthropic signs the manifest as binary;
//!   - **anything but RSA** with SHA-256, SHA-384 or SHA-512 — the key is RSA 4096 and every
//!     signature measured uses SHA-512;
//!   - **a signature that names another key** in its hashed issuer-fingerprint subpacket, so a
//!     refusal says WHICH failure it was rather than "bad signature";
//!   - **an unknown CRITICAL subpacket**, which RFC 4880 §5.2.3.1 says must make the signature
//!     invalid — honouring a signature whose meaning includes something we cannot read is the
//!     mistake that rule exists to prevent;
//!   - **a signature past its own expiry**;
//!   - **partial and indeterminate packet lengths**: a detached signature is a few hundred bytes and
//!     never needs either.
//!
//! **THE KEY IS PINNED, NOT DISCOVERED.** There is no keyring, no web of trust and no key server:
//! the armored key is committed beside this module and the caller names its fingerprint, which
//! [`parse_public_key`] checks against what it computes over the key packet itself. So a key file
//! swapped in the tree without the fingerprint changing fails a test rather than shipping. What that
//! costs is stated rather than hidden: a key Anthropic REVOKES keeps verifying here until a build
//! pins the new one, because nothing in this module ever asks anybody whether a key is still good.

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::Engine as _;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

/// A pinned RSA public key, as one version 4 key packet states it.
#[derive(Debug, Clone)]
pub struct PublicKey {
    /// The version 4 fingerprint: SHA-1 over the key packet, 20 bytes.
    pub fingerprint: [u8; 20],
    key: RsaPublicKey,
}

impl PublicKey {
    /// The fingerprint as GnuPG prints it, without its spaces: 40 uppercase hex digits.
    pub fn fingerprint_hex(&self) -> String {
        self.fingerprint.iter().map(|b| format!("{b:02X}")).collect()
    }
}

/// The OpenPGP packet tags this module reads.
const TAG_SIGNATURE: u8 = 2;
const TAG_PUBLIC_KEY: u8 = 6;
const TAG_PUBLIC_SUBKEY: u8 = 14;

/// RSA (encrypt or sign) and RSA (sign only) — the two algorithm ids a signing RSA key carries.
const ALGO_RSA: u8 = 1;
const ALGO_RSA_SIGN_ONLY: u8 = 3;

/// The hashed subpackets this module understands. Anything else marked CRITICAL voids the
/// signature (RFC 4880 §5.2.3.1).
const SUB_CREATION_TIME: u8 = 2;
const SUB_EXPIRATION_TIME: u8 = 3;
const SUB_ISSUER: u8 = 16;
const SUB_ISSUER_FINGERPRINT: u8 = 33;

/// The most a detached signature may weigh. One RSA 4096 signature is under 600 bytes armored; a
/// bound keeps a host that answered a megabyte from costing a parse of it.
pub const MAX_SIGNATURE_BYTES: usize = 16 * 1024;

/// Read the key packet whose fingerprint is `fingerprint_hex` out of an armored public key block.
///
/// The fingerprint is COMPUTED over the packet and compared, so this answers a key only when the
/// bytes really are the key the caller pinned — a primary key or a subkey, whichever signs.
pub fn parse_public_key(armored: &str, fingerprint_hex: &str) -> Result<PublicKey> {
    let wanted = decode_fingerprint(fingerprint_hex)?;
    let bytes = dearmor(armored).context("read the armored public key")?;
    for packet in packets(&bytes)? {
        if packet.tag != TAG_PUBLIC_KEY && packet.tag != TAG_PUBLIC_SUBKEY {
            continue;
        }
        let fingerprint = v4_fingerprint(packet.body)?;
        if fingerprint != wanted {
            continue;
        }
        let key = rsa_key_from_packet(packet.body)?;
        return Ok(PublicKey { fingerprint, key });
    }
    bail!("the key block holds no key with fingerprint {fingerprint_hex}")
}

/// Verify a detached signature (armored or binary) by `key` over `data`.
///
/// `Ok(())` means the signature is a version 4 binary-document signature, made by this key, over
/// exactly these bytes, and not past its own expiry at `now_unix`. Every other outcome is an error
/// naming what was wrong.
pub fn verify_detached(key: &PublicKey, data: &[u8], signature: &[u8], now_unix: u64) -> Result<()> {
    ensure!(
        signature.len() <= MAX_SIGNATURE_BYTES,
        "the signature is {} bytes, more than any detached signature needs — refused",
        signature.len()
    );
    let bytes = if signature.starts_with(b"-----BEGIN PGP") {
        let text = std::str::from_utf8(signature).context("the armored signature is not text")?;
        dearmor(text).context("read the armored signature")?
    } else {
        signature.to_vec()
    };
    let all = packets(&bytes)?;
    let packet = match all.as_slice() {
        [one] if one.tag == TAG_SIGNATURE => one,
        [] => bail!("the signature file holds no packet"),
        _ => bail!("the signature file holds something other than exactly one signature"),
    };
    let sig = Signature::parse(packet.body)?;

    if let Some(issuer) = sig.issuer_fingerprint {
        ensure!(
            issuer == key.fingerprint,
            "the signature was made by key {}, not by the pinned key {}",
            hex_upper(&issuer),
            key.fingerprint_hex()
        );
    }
    if let (Some(created), Some(lifetime)) = (sig.created, sig.expires_after) {
        // An expiration of zero means "never" (RFC 4880 §5.2.3.10).
        if lifetime != 0 {
            ensure!(
                u64::from(created) + u64::from(lifetime) > now_unix,
                "the signature expired {} seconds after it was made — refused",
                lifetime
            );
        }
    }

    let digest = sig.digest(data);
    ensure!(
        digest.get(..2) == Some(&sig.left16[..]),
        "the signature does not match these bytes (its digest prefix differs)"
    );

    let k = key.key.size();
    ensure!(
        sig.value.len() <= k,
        "the signature value is longer than the key's modulus — refused"
    );
    // An MPI drops its leading zero bytes; RSA verification needs the full modulus width.
    let mut padded = vec![0u8; k - sig.value.len()];
    padded.extend_from_slice(&sig.value);
    let scheme = match sig.hash {
        HashAlgo::Sha256 => Pkcs1v15Sign::new::<Sha256>(),
        HashAlgo::Sha384 => Pkcs1v15Sign::new::<Sha384>(),
        HashAlgo::Sha512 => Pkcs1v15Sign::new::<Sha512>(),
    };
    key.key
        .verify(scheme, &digest, &padded)
        .map_err(|_| anyhow!("the signature does not match these bytes"))
}

/// Decode an ASCII-armored block, checking its CRC-24 when it carries one.
///
/// Header lines (`Comment: …`) are skipped, and the checksum line is optional, as RFC 4880 §6.2
/// allows — but one that is present and wrong refuses the whole block.
pub fn dearmor(text: &str) -> Result<Vec<u8>> {
    let mut lines = text.lines().map(str::trim_end);
    lines
        .by_ref()
        .find(|line| line.starts_with("-----BEGIN PGP ") && line.ends_with("-----"))
        .context("no armor header line (-----BEGIN PGP …-----)")?;

    let mut body = String::new();
    let mut checksum: Option<&str> = None;
    let mut in_headers = true;
    let mut ended = false;
    for line in lines {
        if line.starts_with("-----END PGP ") {
            ended = true;
            break;
        }
        if in_headers {
            // Armor headers are `Key: value`; the first line that is not one ends them, and the
            // blank line RFC 4880 puts after them is simply skipped.
            if line.is_empty() {
                in_headers = false;
                continue;
            }
            if line.contains(": ") {
                continue;
            }
            in_headers = false;
        }
        if line.is_empty() {
            continue;
        }
        if let Some(sum) = line.strip_prefix('=') {
            checksum = Some(sum);
            continue;
        }
        ensure!(checksum.is_none(), "armor data continues after its checksum line");
        body.push_str(line);
    }
    ensure!(ended, "the armored block has no end line");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .context("the armored block is not base64")?;
    if let Some(sum) = checksum {
        let stated = base64::engine::general_purpose::STANDARD
            .decode(sum.as_bytes())
            .context("the armor checksum is not base64")?;
        ensure!(stated.len() == 3, "the armor checksum is not 24 bits");
        let stated = (u32::from(stated[0]) << 16) | (u32::from(stated[1]) << 8) | u32::from(stated[2]);
        ensure!(stated == crc24(&bytes), "the armor checksum does not match its data");
    }
    Ok(bytes)
}

/// CRC-24 as RFC 4880 §6.1 defines it for armor.
fn crc24(data: &[u8]) -> u32 {
    let mut crc: u32 = 0x00B7_04CE;
    for &byte in data {
        crc ^= u32::from(byte) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if crc & 0x0100_0000 != 0 {
                crc ^= 0x0186_4CFB;
            }
        }
    }
    crc & 0x00FF_FFFF
}

/// One packet: its tag and its body, borrowed from the input.
#[derive(Debug, Clone, Copy)]
struct Packet<'a> {
    tag: u8,
    body: &'a [u8],
}

/// Split bytes into packets (RFC 4880 §4.2), both header formats, definite lengths only.
fn packets(bytes: &[u8]) -> Result<Vec<Packet<'_>>> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let ctb = rest[0];
        ensure!(ctb & 0x80 != 0, "not an OpenPGP packet (bad header octet {ctb:#04x})");
        let (tag, len, header): (u8, usize, usize) = if ctb & 0x40 != 0 {
            let tag = ctb & 0x3f;
            let o1 = *rest.get(1).context("truncated packet header")?;
            match o1 {
                0..=191 => (tag, usize::from(o1), 2),
                192..=223 => {
                    let o2 = *rest.get(2).context("truncated packet header")?;
                    (tag, ((usize::from(o1) - 192) << 8) + usize::from(o2) + 192, 3)
                }
                255 => {
                    let len = be_u32(rest.get(2..6).context("truncated packet header")?);
                    (tag, len as usize, 6)
                }
                _ => bail!("a partial-length packet — refused, no detached signature needs one"),
            }
        } else {
            let tag = (ctb >> 2) & 0x0f;
            match ctb & 0x03 {
                0 => (tag, usize::from(*rest.get(1).context("truncated packet header")?), 2),
                1 => {
                    let b = rest.get(1..3).context("truncated packet header")?;
                    (tag, (usize::from(b[0]) << 8) | usize::from(b[1]), 3)
                }
                2 => (tag, be_u32(rest.get(1..5).context("truncated packet header")?) as usize, 5),
                _ => bail!("an indeterminate-length packet — refused"),
            }
        };
        let end = header
            .checked_add(len)
            .filter(|end| *end <= rest.len())
            .context("a packet runs past the end of its data")?;
        out.push(Packet { tag, body: &rest[header..end] });
        rest = &rest[end..];
    }
    Ok(out)
}

fn be_u32(b: &[u8]) -> u32 {
    (u32::from(b[0]) << 24) | (u32::from(b[1]) << 16) | (u32::from(b[2]) << 8) | u32::from(b[3])
}

/// The version 4 fingerprint of a key packet body (RFC 4880 §12.2).
fn v4_fingerprint(body: &[u8]) -> Result<[u8; 20]> {
    ensure!(body.first() == Some(&4), "not a version 4 key");
    let len = u16::try_from(body.len()).context("a key packet too long to fingerprint")?;
    let mut hasher = Sha1::new();
    hasher.update([0x99]);
    hasher.update(len.to_be_bytes());
    hasher.update(body);
    Ok(hasher.finalize().into())
}

/// The RSA public key a version 4 key packet carries: version, creation time, algorithm, then the
/// two MPIs `n` and `e`.
fn rsa_key_from_packet(body: &[u8]) -> Result<RsaPublicKey> {
    let mut cursor = Cursor::new(body);
    ensure!(cursor.u8()? == 4, "not a version 4 key");
    cursor.take(4)?;
    let algo = cursor.u8()?;
    ensure!(
        algo == ALGO_RSA || algo == ALGO_RSA_SIGN_ONLY,
        "the pinned key is not an RSA key (algorithm {algo})"
    );
    let n = cursor.mpi()?;
    let e = cursor.mpi()?;
    RsaPublicKey::new(BigUint::from_bytes_be(n), BigUint::from_bytes_be(e))
        .map_err(|e| anyhow!("the pinned key is not a usable RSA key: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HashAlgo {
    Sha256,
    Sha384,
    Sha512,
}

/// A version 4 signature packet, read.
#[derive(Debug)]
struct Signature {
    hash: HashAlgo,
    /// The bytes the hash covers after the document: from the version octet through the end of
    /// the hashed subpackets.
    hashed_prefix: Vec<u8>,
    left16: [u8; 2],
    value: Vec<u8>,
    created: Option<u32>,
    expires_after: Option<u32>,
    issuer_fingerprint: Option<[u8; 20]>,
}

impl Signature {
    fn parse(body: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(body);
        let version = cursor.u8()?;
        ensure!(version == 4, "a version {version} signature — only version 4 is read here");
        let sig_type = cursor.u8()?;
        ensure!(
            sig_type == 0x00,
            "a signature of type {sig_type:#04x} — only a signature over a binary document is read"
        );
        let algo = cursor.u8()?;
        ensure!(
            algo == ALGO_RSA || algo == ALGO_RSA_SIGN_ONLY,
            "a signature made with algorithm {algo} — only RSA is read here"
        );
        let hash = match cursor.u8()? {
            8 => HashAlgo::Sha256,
            9 => HashAlgo::Sha384,
            10 => HashAlgo::Sha512,
            other => bail!("a signature hashed with algorithm {other} — refused"),
        };
        let hashed_len = usize::from(cursor.u16()?);
        let hashed = cursor.take(hashed_len)?;
        let hashed_prefix = body[..cursor.position()].to_vec();
        let unhashed_len = usize::from(cursor.u16()?);
        cursor.take(unhashed_len)?;
        let left = cursor.take(2)?;
        let value = cursor.mpi()?.to_vec();
        ensure!(cursor.is_empty(), "a signature packet with bytes after its value");

        let mut sig = Signature {
            hash,
            hashed_prefix,
            left16: [left[0], left[1]],
            value,
            created: None,
            expires_after: None,
            issuer_fingerprint: None,
        };
        for (kind, critical, data) in subpackets(hashed)? {
            match kind {
                SUB_CREATION_TIME if data.len() == 4 => sig.created = Some(be_u32(data)),
                SUB_EXPIRATION_TIME if data.len() == 4 => sig.expires_after = Some(be_u32(data)),
                SUB_ISSUER => {}
                SUB_ISSUER_FINGERPRINT if data.len() == 21 && data[0] == 4 => {
                    let mut fpr = [0u8; 20];
                    fpr.copy_from_slice(&data[1..]);
                    sig.issuer_fingerprint = Some(fpr);
                }
                _ if critical => {
                    bail!("the signature carries a critical subpacket ({kind}) this build cannot read")
                }
                _ => {}
            }
        }
        Ok(sig)
    }

    /// The digest the signature covers: the document, the hashed prefix, and the version 4
    /// trailer (RFC 4880 §5.2.4).
    fn digest(&self, data: &[u8]) -> Vec<u8> {
        let trailer_len = u32::try_from(self.hashed_prefix.len()).unwrap_or(u32::MAX);
        let mut trailer = vec![0x04, 0xFF];
        trailer.extend_from_slice(&trailer_len.to_be_bytes());
        fn run<D: Digest>(parts: [&[u8]; 3]) -> Vec<u8> {
            let mut hasher = D::new();
            for part in parts {
                hasher.update(part);
            }
            hasher.finalize().to_vec()
        }
        let parts = [data, &self.hashed_prefix[..], &trailer[..]];
        match self.hash {
            HashAlgo::Sha256 => run::<Sha256>(parts),
            HashAlgo::Sha384 => run::<Sha384>(parts),
            HashAlgo::Sha512 => run::<Sha512>(parts),
        }
    }
}

/// Split a subpacket area into `(type, critical, data)` (RFC 4880 §5.2.3.1).
fn subpackets(area: &[u8]) -> Result<Vec<(u8, bool, &[u8])>> {
    let mut out = Vec::new();
    let mut cursor = Cursor::new(area);
    while !cursor.is_empty() {
        let o1 = cursor.u8()?;
        let len = match o1 {
            0..=191 => usize::from(o1),
            192..=254 => ((usize::from(o1) - 192) << 8) + usize::from(cursor.u8()?) + 192,
            255 => be_u32(cursor.take(4)?) as usize,
        };
        ensure!(len >= 1, "an empty signature subpacket");
        let packet = cursor.take(len)?;
        out.push((packet[0] & 0x7f, packet[0] & 0x80 != 0, &packet[1..]));
    }
    Ok(out)
}

/// A bounds-checked reader over a byte slice.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn position(&self) -> usize {
        self.at
    }

    fn is_empty(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .context("a packet field runs past the end of its packet")?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok((u16::from(b[0]) << 8) | u16::from(b[1]))
    }

    /// A multiprecision integer: a two-octet bit count, then that many bits, big-endian.
    fn mpi(&mut self) -> Result<&'a [u8]> {
        let bits = usize::from(self.u16()?);
        self.take(bits.div_ceil(8))
    }
}

fn decode_fingerprint(hex: &str) -> Result<[u8; 20]> {
    let digits: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    ensure!(
        digits.len() == 40 && digits.chars().all(|c| c.is_ascii_hexdigit()),
        "a fingerprint is 40 hex digits"
    );
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anthropic's Claude Code release key, exactly as `downloads.claude.ai/keys/claude-code.asc`
    /// served it on 2026-11-04, and the fingerprint its own documentation prints.
    const KEY: &str = include_str!("keys/claude-code.asc");
    const FINGERPRINT: &str = "31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE";
    /// A real release's manifest and its detached signature (2.1.311, the `stable` channel on
    /// 2026-11-04). `gpg --verify` reported a good signature over exactly these bytes.
    const MANIFEST: &[u8] = include_bytes!("testdata/claude-manifest-2.1.311.json");
    const SIGNATURE: &[u8] = include_bytes!("testdata/claude-manifest-2.1.311.json.sig");
    /// The moment the fixture was fetched, well inside the signature's validity.
    const NOW: u64 = 1_793_050_000;

    fn key() -> PublicKey {
        parse_public_key(KEY, FINGERPRINT).expect("the committed key parses")
    }

    #[test]
    fn the_committed_key_is_the_one_anthropic_documents() {
        assert_eq!(key().fingerprint_hex(), FINGERPRINT.replace(' ', ""));
        // A key block that does not hold the pinned fingerprint names no key at all — so a key
        // swapped into the tree fails here rather than verifying somebody else's releases.
        let wrong = "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000";
        let refused = parse_public_key(KEY, wrong).unwrap_err().to_string();
        assert!(refused.contains("no key with fingerprint"), "{refused}");
    }

    #[test]
    fn a_real_release_manifest_verifies() {
        verify_detached(&key(), MANIFEST, SIGNATURE, NOW).expect("Anthropic's own signature verifies");
        // And in its binary form, which is what a release might publish instead of armor.
        let binary = dearmor(std::str::from_utf8(SIGNATURE).unwrap()).unwrap();
        verify_detached(&key(), MANIFEST, &binary, NOW).expect("the binary form verifies too");
    }

    #[test]
    fn one_changed_byte_of_the_manifest_is_refused() {
        // The attack this exists for: the same signature over a manifest naming another binary.
        let text = std::str::from_utf8(MANIFEST).unwrap();
        let first_checksum = text.find("\"checksum\": \"").unwrap() + 13;
        let mut tampered = MANIFEST.to_vec();
        tampered[first_checksum] = if tampered[first_checksum] == b'0' { b'1' } else { b'0' };
        let refused = verify_detached(&key(), &tampered, SIGNATURE, NOW).unwrap_err().to_string();
        assert!(refused.contains("does not match"), "{refused}");

        let mut appended = MANIFEST.to_vec();
        appended.push(b'\n');
        assert!(verify_detached(&key(), &appended, SIGNATURE, NOW).is_err());
    }

    #[test]
    fn a_damaged_signature_is_refused() {
        let mut binary = dearmor(std::str::from_utf8(SIGNATURE).unwrap()).unwrap();
        let last = binary.len() - 1;
        binary[last] ^= 0x01;
        let refused = verify_detached(&key(), MANIFEST, &binary, NOW).unwrap_err().to_string();
        assert!(refused.contains("does not match"), "{refused}");
    }

    #[test]
    fn a_damaged_armor_checksum_is_refused() {
        let text = std::str::from_utf8(SIGNATURE).unwrap();
        let sum_line = text.lines().find(|l| l.starts_with('=')).expect("the fixture has a checksum");
        let flipped = if sum_line.ends_with('A') { "B" } else { "A" };
        let damaged = text.replace(sum_line, &format!("{}{flipped}", &sum_line[..sum_line.len() - 1]));
        let refused = verify_detached(&key(), MANIFEST, damaged.as_bytes(), NOW)
            .unwrap_err();
        assert!(format!("{refused:#}").contains("checksum"), "{refused:#}");
    }

    #[test]
    fn garbage_is_refused_rather_than_read() {
        for junk in [&b""[..], b"hello", b"\x00\x01\x02", b"-----BEGIN PGP SIGNATURE-----\n\nAAAA"] {
            assert!(verify_detached(&key(), MANIFEST, junk, NOW).is_err(), "{junk:?}");
        }
        let huge = vec![b'x'; MAX_SIGNATURE_BYTES + 1];
        assert!(verify_detached(&key(), MANIFEST, &huge, NOW).is_err());
    }

    #[test]
    fn the_crc24_is_the_rfcs() {
        // RFC 4880's CRC of no bytes is its initial value.
        assert_eq!(crc24(b""), 0x00B7_04CE);
        // And the committed key's own checksum line agrees with what this computes.
        assert!(dearmor(KEY).is_ok());
    }

    #[test]
    fn packet_lengths_in_both_formats_are_read() {
        // Old format, one-octet length, tag 2.
        let old = [0x88, 0x02, 0xAA, 0xBB];
        let read = packets(&old).unwrap();
        assert_eq!((read[0].tag, read[0].body), (2, &[0xAA, 0xBB][..]));
        // New format, two-octet length (192 bytes), tag 2.
        let mut new = vec![0xC2, 192, 0];
        new.extend(std::iter::repeat_n(7u8, 192));
        let read = packets(&new).unwrap();
        assert_eq!((read[0].tag, read[0].body.len()), (2, 192));
        // A length past the end, a partial length and an indeterminate one are all refused.
        assert!(packets(&[0x88, 0x05, 0x00]).is_err());
        assert!(packets(&[0xC2, 0xE0, 0x00]).is_err());
        assert!(packets(&[0x8B, 0x00]).is_err());
    }
}
