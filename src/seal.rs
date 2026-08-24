//! A SEALED chat: the words of a message are encrypted before they reach Teams.
//!
//! A chat is not sealed by default. The user marks one, sets or generates a passphrase, and
//! from then on every message this app POSTS to that conversation carries a ciphertext where
//! its words used to be. Each participant who also runs teams-lite adds the same passphrase
//! and reads the conversation in the clear; the tenant, Microsoft, and anybody reading the
//! thread in a stock client sees one opaque token.
//!
//! # What this protects, and what it cannot
//!
//! THE THREAT IS THE TENANT, NEVER THE MACHINE. Everything else this app holds is already in
//! the clear on this disk — the store keeps every message the user ever synced — so encrypting
//! at rest here would be theatre. What is bought is that the words never exist on Microsoft's
//! side at all. So the backend is the encryption boundary and the key lives in the local
//! store: the passphrase is entered once and covers the phone and the laptop alike, which
//! reach one backend, and the agent (which runs HERE) can still seal what it posts.
//!
//! What a sealed chat therefore does NOT hide, and each is a deliberate stated limit:
//!
//!   - WHO said something, WHEN, in WHICH conversation, and how long it was. Teams routes the
//!     message; the metadata is the routing.
//!   - WHOM a message @MENTIONS. That travels in `properties.mentions`, which is what makes
//!     the notification happen, and its span has to sit in the clear (see
//!     [`crate::teams_send`]). A mention is offered anyway, and the composer says so.
//!   - A PICTURE. Its bytes are uploaded to Microsoft's own object store, so they cannot be
//!     sealed by anything in this module. The composer says so and the message is marked.
//!   - The ORDER of messages, and whether one was DELETED. The tenant controls the transport, so
//!     it can drop a message, hold one back, or reorder two, and no reader can tell. What it
//!     CANNOT do is change what a sealed message says, move it to another chat, or put somebody
//!     else's name on it: the AAD binds the conversation and the sender (see [`aad`]). It can
//!     still REPLAY the same bytes into the same chat at a later moment — binding the
//!     clientmessageid would close that, and `teams_read` does not parse one off an inbound
//!     message yet, so it is a stated gap rather than an unknown one.
//!   - WHO ELSE holds the passphrase. Everybody who has it can read every message ever sealed
//!     under it, and can seal a message themselves. A padlock is a claim about who can READ,
//!     never about who wrote — the dialog that takes a passphrase says so.
//!   - Anything the local AGENT is asked. The prompt carries the thread in the clear to the
//!     model provider, which is what the user asked for; only the agent's own REPLY is sealed.
//!
//! # The envelope
//!
//! One opaque base64url token, and NOTHING ELSE, is the whole body:
//!
//! ```text
//! <p>pR1cAAoLDA0ODxAREhMUFRYXGBkaGxwdHh8g…</p>
//! ```
//!
//! There is deliberately no notice, no words and no name of this app in it. A sentence saying
//! "sealed with teams-lite" would be the one readable part of a sealed message — it would tell
//! the tenant which client the user runs and tell everybody that this conversation has
//! something to hide. What marks the message is inside the token, where nobody can read it:
//! [`MAGIC`] and a version in its first decoded bytes. The cost is stated where the rule is —
//! a colleague on a stock client is shown a token with nothing to explain it, and this app's
//! own reader draws a locked row.
//!
//! The decoded bytes are:
//!
//! ```text
//!   0..3   MAGIC          three bytes, so a token can be RECOGNISED without the key
//!   3      version        VERSION
//!   4      flags          bit 0: the plaintext was deflated
//!   5..9   key id         which passphrase opens it (see `SealKey::id`)
//!   9..21  nonce          12 random bytes, fresh for every single seal
//!   21..   ciphertext     AES-256-GCM, its 16-byte tag included
//! ```
//!
//! The header is not secret and is not meant to be: recognising a sealed message WITHOUT the
//! key is what lets the app draw a locked row and say which passphrase is missing, instead of
//! showing a wall of base64 or — worse — reading a colleague's ciphertext as their words.
//!
//! Every fact about the CARRIER is measured against the real tenant by
//! `examples/sealed_message_probe.rs`: a base64url token comes back byte for byte through
//! Teams' own server-side sanitizer, an edit keeps it, and the ceiling is the service's own
//! 102 400 bytes for a whole message — which is what [`MAX_SEALED_PLAINTEXT`] is derived from.
//!
//! # The key
//!
//! ```text
//!   salt = SHA-256("teams-lite/seal/v1/salt" || conversation id)   [16 bytes]
//!   prk  = Argon2id(canonical(passphrase), salt, m = 64 MiB, t = 3, p = 4)   [32 bytes]
//!   enc  = HKDF-SHA256-Expand(prk, "…/aes256")                     [32 bytes]
//!   id   = HKDF-SHA256-Expand(prk, "…/keyid")                      [4 bytes]
//! ```
//!
//! Argon2id because the adversary keeps the ciphertext FOR EVER and can attack a weak
//! passphrase offline at whatever speed it likes; a fast hash here would undo the feature for
//! everybody who types a word they can remember. It is run ONCE — when a passphrase is added —
//! and the derived key is what the store keeps, so no read ever pays for it.
//!
//! `canonical` is what makes the feature survive contact with a phone: the passphrase is
//! lowercased and stripped of every separator before it is derived (see
//! [`canonical_passphrase`]). Reading a passphrase off a laptop and typing it into a phone is
//! THE commonest path through this whole feature, and a phone keyboard capitalizes the first
//! character of a field — so without this, `Abcd-efgh-…` is a different key, every message in
//! the thread reads as one sealed under a passphrase the reader does not hold, and the sentence
//! the app shows blames them for a passphrase they typed correctly.
//!
//! The salt is derived from the conversation id rather than random-and-published for one
//! reason: it needs no coordination. Two participants who type the same passphrase must land
//! on the same key with nothing to exchange but that passphrase, and a random salt would have
//! to travel in the first sealed message and be found again by whoever joins later. What that
//! gives up is a precomputation defence the conversation id already supplies in practice: a
//! thread id is 32 hex characters of tenant-minted entropy, so no table is shared between two
//! conversations, or between two tenants.

use anyhow::{Context, Result, bail, ensure};
use std::io::{Read, Write};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

/// The three bytes every envelope opens with, so a sealed message can be told from an
/// ordinary one WITHOUT the key.
///
/// Deliberately not ASCII and deliberately not a name: base64url of these bytes reads as
/// nothing, which is the point (§ The envelope). Never change them — a message already in a
/// thread carries these three bytes for ever, and a build that stopped recognising them would
/// draw every sealed message a colleague ever sent as an ordinary one full of base64.
pub const MAGIC: [u8; 3] = [0xA7, 0x1D, 0x5C];

/// The envelope version. A reader that meets a HIGHER one says so rather than guessing: an
/// AEAD has no partial credit, so a layout this build does not know is one it must not open.
pub const VERSION: u8 = 1;

/// The payload is padded up to a multiple of this before it is sealed.
///
/// Without it the ciphertext's length IS the plaintext's, to the byte, for ever, in the hands
/// of the party this feature protects the words from — and over a chat whose answers are "ok",
/// "yes", "no" and "agreed", the length alone tells them apart with no key at all. 64 bytes
/// puts every short message in one bucket, which is most of them, and costs at most 63 bytes.
///
/// It does not hide everything and is not meant to: a long message is still visibly longer than
/// a short one, and [`FLAG_DEFLATE`] still says whether the body compressed. What it removes is
/// the exact length, which is the part that identifies a one-word answer.
const PAD_BLOCK: usize = 64;

/// Bit 0 of the flags byte: the plaintext was deflated before it was sealed.
///
/// It is a flag rather than a rule because compression is only applied when it actually
/// shrinks the body — a short message deflates to something LONGER, and a token nobody can
/// read is still a token somebody's client has to draw.
const FLAG_DEFLATE: u8 = 1;

/// Where each field of a decoded envelope starts.
const OFF_VERSION: usize = 3;
const OFF_FLAGS: usize = 4;
const OFF_KEY_ID: usize = 5;
const OFF_NONCE: usize = 9;
const OFF_CIPHERTEXT: usize = 21;

/// AES-GCM's nonce, and its authentication tag.
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Which passphrase opened, or sealed, a message. Four bytes of HKDF output — enough to pick
/// the right key out of the handful a conversation may know, and enough to tell "this was
/// sealed with a DIFFERENT passphrase" from "this is corrupt", which are two different
/// sentences for the reader.
///
/// Publishing it costs nothing: it is HKDF-Expand under its own label, so it says nothing
/// about the encryption key derived under another. Four bytes do mean two different
/// passphrases collide about once in four billion, and the only cost of that is one wasted
/// decryption attempt whose authentication tag then fails.
pub type KeyId = [u8; 4];

/// The largest plaintext body this app will seal, in bytes.
///
/// The service refuses a whole message over **102 400 bytes** (measured — see
/// `examples/sealed_message_probe.rs`, which reads the number out of the refusal itself). An
/// envelope is [`OFF_CIPHERTEXT`] + [`TAG_LEN`] bytes of header and tag, and base64 is four
/// bytes out for every three in, so the ceilings have to CLOSE the way the composer's three
/// picture ceilings do: the largest body this side accepts must not be able to build a message
/// the service refuses.
///
/// 64 KiB against a 102 400-byte ceiling leaves better than 12 KiB of room for everything else
/// in the POST — the mentions property, the reply's own metadata, the client message id — even
/// in the worst case, which is a body that does not compress at all.
/// `the_ceilings_close` pins the arithmetic; move this and it fails.
pub const MAX_SEALED_PLAINTEXT: usize = 64 * 1024;

/// The service's own limit on a whole message, measured. Here so the test that closes the
/// ceilings reads the same number the probe printed.
pub const SERVICE_MESSAGE_LIMIT: usize = 102_400;

/// How much room the rest of a POST is allowed, on top of the sealed body.
const POST_OVERHEAD_BUDGET: usize = 12 * 1024;

/// A decompressed body is never allowed past this. The ciphertext is AUTHENTICATED, so only
/// somebody holding the key can produce one at all — this is the belt on top of that, because
/// a deflate stream's output size is not bounded by its input's.
///
/// It is exactly [`MAX_SEALED_PLAINTEXT`] and not a multiple of it: [`seal`] refuses a longer
/// plaintext, so anything above this could not have come from this app, and `msg_reader` runs
/// the inflate on every sealed row of every page — so the bound is an allocation budget
/// multiplied by the page size, not a one-off.
const MAX_INFLATED: usize = MAX_SEALED_PLAINTEXT;

/// Argon2id's cost, and the reason for each number.
///
/// 64 MiB and three passes is roughly a fifth of a second on a laptop, and it is paid ONCE per
/// passphrase rather than once per message: [`derive`] runs when the user adds one, and the
/// key it returns is what the store keeps. That is what makes it affordable to be this far
/// above the usual interactive-login parameters — the usual reason to keep them low is a login
/// that happens on every request, and nothing here does.
/// **THESE THREE NUMBERS ARE PART OF THE FORMAT, and moving one is a [`VERSION`] change.**
/// Nothing in the envelope records them, and it deliberately does not need to: the key id is
/// derived from the Argon2id output, so a colleague on a build with different parameters
/// derives a DIFFERENT key from the SAME passphrase — and every message then reads as
/// `UnknownKey`, whose sentence is "you have not added this passphrase", in both directions,
/// for a passphrase both people typed correctly and with nothing able to say why.
/// [`the_kdf_cost_is_pinned_to_the_version`] is what makes that impossible to do by accident.
///
/// `p` is 4 rather than 1: the cost an attacker pays is m×t whichever it is, so lanes buy the
/// DEFENDER wall clock back for nothing — `p = 1` spends the latency budget and gains no
/// security at all. `m` is RFC 9106's second recommended profile.
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_PASSES: u32 = 3;
const ARGON2_LANES: u32 = 4;

/// The alphabet a generated passphrase is written in: no `0`, `O`, `1`, `l`, `I`.
///
/// A passphrase is read off one screen and typed into another, often a phone's keyboard, and
/// the two characters people get wrong are those. 31 symbols is 4.95 bits each.
const PASSPHRASE_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// A generated passphrase is five groups of four, so it can be read aloud and retyped:
/// 20 symbols, a little under 100 bits.
///
/// That is far past what any KDF needs to make brute force hopeless, which is the point: the
/// ciphertext is held for ever by the party this feature protects it from, so the generated
/// default must not depend on Argon2id for its safety — only a passphrase the USER chose does.
const PASSPHRASE_GROUPS: usize = 5;
const PASSPHRASE_GROUP_LEN: usize = 4;

/// A key that opens and seals one conversation's messages.
///
/// It carries no passphrase and no conversation id: it is the derived material and its id,
/// which is everything a seal or an open needs. The store holds these, so a read never runs
/// Argon2id.
#[derive(Clone)]
pub struct SealKey {
    /// Which passphrase this is, as published in every envelope it seals.
    pub id: KeyId,
    /// The AES-256 key.
    enc: [u8; 32],
}

impl SealKey {
    /// Rebuild a key from the bytes the store holds.
    pub fn from_stored(id: KeyId, enc: [u8; 32]) -> Self {
        Self { id, enc }
    }

    /// The key material, for the store to keep. Deliberately named so that a call site that
    /// hands these to a CLIENT reads as wrong: a page is never told a key (see the
    /// `seal_status` RPC, which answers which conversations are sealed and never with what).
    pub fn secret_for_store(&self) -> [u8; 32] {
        self.enc
    }

    /// The key id as the hex a store row and a log line can carry.
    pub fn id_hex(&self) -> String {
        hex_of(&self.id)
    }
}

impl std::fmt::Debug for SealKey {
    /// Never the key material. A `{:?}` in a journal line is how a secret escapes.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SealKey({})", self.id_hex())
    }
}

/// What a body turned out to be.
///
/// The three failures are three different sentences for the reader, and collapsing them into
/// one is what makes an encrypted chat feel broken: "you have not added this passphrase" is
/// something they can act on, "this build is too old" is something an update fixes, and
/// "these bytes are damaged" is neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// Not a sealed message at all. Every message in an unsealed chat, and every message a
    /// colleague sent before the chat was sealed.
    NotSealed,
    /// The words, as the HTML body they were before they were sealed.
    Words(String),
    /// Sealed under a passphrase this machine does not hold.
    UnknownKey(KeyId),
    /// Sealed by a newer build of this app than the one reading it.
    NewerVersion(u8),
    /// Recognisably sealed, and the bytes do not survive their own authentication tag.
    Damaged,
}

/// Derive the key a passphrase gives for one conversation. SLOW on purpose — see
/// [`ARGON2_MEMORY_KIB`]. Run it when the user adds a passphrase, keep what it returns.
///
/// The conversation id is part of the derivation, so the same passphrase in two chats is two
/// unrelated keys: a passphrase a colleague was given for one conversation opens nothing else,
/// even though they hold the words the user typed.
pub fn derive(passphrase: &str, conversation_id: &str) -> Result<SealKey> {
    let passphrase = canonical_passphrase(passphrase);
    ensure!(!passphrase.is_empty(), "a passphrase cannot be empty");
    ensure!(!conversation_id.is_empty(), "a conversation id is needed to derive a key");

    let mut salt = [0u8; 16];
    let digest = Sha256::new()
        .chain_update(b"teams-lite/seal/v1/salt")
        .chain_update(conversation_id.as_bytes())
        .finalize();
    salt.copy_from_slice(&digest[..16]);

    let params = argon2::Params::new(ARGON2_MEMORY_KIB, ARGON2_PASSES, ARGON2_LANES, Some(32))
        .map_err(|e| anyhow::anyhow!("argon2 parameters: {e}"))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut prk = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut prk)
        .map_err(|e| anyhow::anyhow!("derive a key from the passphrase: {e}"))?;

    Ok(SealKey { id: expand(&prk, b"teams-lite/seal/v1/keyid")?, enc: expand(&prk, b"teams-lite/seal/v1/aes256")? })
}

/// One HKDF-Expand under its own label. Two labels means the published key id says nothing
/// about the key that encrypts.
fn expand<const N: usize>(prk: &[u8; 32], label: &[u8]) -> Result<[u8; N]> {
    let hk = Hkdf::<Sha256>::from_prk(prk).map_err(|e| anyhow::anyhow!("hkdf from prk: {e}"))?;
    let mut out = [0u8; N];
    hk.expand(label, &mut out).map_err(|e| anyhow::anyhow!("hkdf expand: {e}"))?;
    Ok(out)
}

/// Seal one HTML body into the whole body of a message to post.
///
/// `html` is the body this app would have posted in the clear — the words, the reply's own
/// quote, the mention spans, everything. All of it goes inside, because a sealed message whose
/// quote was left in the clear would publish the very words of the message it answers.
pub fn seal(key: &SealKey, conversation_id: &str, sender_mri: &str, html: &str) -> Result<String> {
    ensure!(
        html.len() <= MAX_SEALED_PLAINTEXT,
        "this message is too long to seal: {} bytes against a limit of {}",
        html.len(),
        MAX_SEALED_PLAINTEXT
    );

    // Deflate only when it wins. A short message compresses to something longer, and the
    // token a colleague's client has to draw is the thing being kept small.
    let raw = html.as_bytes();
    let (flags, packed) = match deflate(raw) {
        Ok(packed) if packed.len() < raw.len() => (FLAG_DEFLATE, packed),
        _ => (0u8, raw.to_vec()),
    };
    let payload = padded(&packed);

    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let mut envelope = Vec::with_capacity(OFF_CIPHERTEXT + payload.len() + TAG_LEN);
    envelope.extend_from_slice(&MAGIC);
    envelope.push(VERSION);
    envelope.push(flags);
    envelope.extend_from_slice(&key.id);
    envelope.extend_from_slice(&nonce);

    let cipher = Aes256Gcm::new_from_slice(&key.enc).map_err(|e| anyhow::anyhow!("aes key: {e}"))?;
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: &payload, aad: &aad(&envelope[..OFF_NONCE], conversation_id, sender_mri) },
        )
        .map_err(|_| anyhow::anyhow!("seal the message"))?;
    envelope.extend_from_slice(&sealed);

    Ok(format!("<p>{}</p>", URL_SAFE_NO_PAD.encode(&envelope)))
}

/// Open a body with whichever of the keys this machine holds fits it.
///
/// A body that is not a sealed envelope comes back [`Opened::NotSealed`] and untouched, which
/// is what every message in an unsealed chat — and every message sent before a chat was sealed
/// — takes. That is why this can be applied to EVERY row on the way out of the store without
/// deciding first whether a conversation is sealed: the envelope answers for itself.
pub fn open(keys: &[SealKey], conversation_id: &str, sender_mri: &str, body: &str) -> Opened {
    let Some(envelope) = envelope_bytes(body) else { return Opened::NotSealed };
    if envelope[OFF_VERSION] != VERSION {
        return Opened::NewerVersion(envelope[OFF_VERSION]);
    }
    let mut id: KeyId = [0; 4];
    id.copy_from_slice(&envelope[OFF_KEY_ID..OFF_NONCE]);

    let mut damaged = false;
    for key in keys.iter().filter(|k| k.id == id) {
        match open_with(key, conversation_id, sender_mri, &envelope) {
            Ok(words) => return Opened::Words(words),
            // Keep looking: two passphrases can collide on four bytes of key id, so the
            // first key that matches the id is not necessarily the one that sealed this.
            Err(_) => damaged = true,
        }
    }
    if damaged { Opened::Damaged } else { Opened::UnknownKey(id) }
}

/// One attempt with one key.
fn open_with(key: &SealKey, conversation_id: &str, sender_mri: &str, envelope: &[u8]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(&key.enc).map_err(|e| anyhow::anyhow!("aes key: {e}"))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&envelope[OFF_NONCE..OFF_CIPHERTEXT]),
            Payload {
                msg: &envelope[OFF_CIPHERTEXT..],
                aad: &aad(&envelope[..OFF_NONCE], conversation_id, sender_mri),
            },
        )
        .map_err(|_| anyhow::anyhow!("the authentication tag does not fit"))?;
    let packed = unpadded(&plain)?;
    let bytes = if envelope[OFF_FLAGS] & FLAG_DEFLATE != 0 { inflate(&packed)? } else { packed };
    String::from_utf8(bytes).context("a sealed body that is not UTF-8")
}

/// Which key sealed a body, without holding any key at all.
///
/// This is what lets the app draw a locked row, and say WHICH passphrase is missing, for a
/// message it cannot read — and it is what the page is told rather than the ciphertext.
pub fn key_id_of(body: &str) -> Option<KeyId> {
    let envelope = envelope_bytes(body)?;
    let mut id: KeyId = [0; 4];
    id.copy_from_slice(&envelope[OFF_KEY_ID..OFF_NONCE]);
    Some(id)
}

/// Whether a body is a sealed envelope at all.
pub fn is_sealed(body: &str) -> bool {
    envelope_bytes(body).is_some()
}

/// The decoded envelope inside a body, or `None` for an ordinary message.
///
/// Three things have to hold, and they are what keeps an ordinary message — a colleague pasting
/// a JWT, a hash, a long identifier — from ever being read as a ciphertext: the body is ONE
/// base64url token and nothing else, it decodes, and its first three bytes are [`MAGIC`]. A
/// false positive costs one failed authentication tag and a row drawn as damaged, so the magic
/// is what makes that vanishingly unlikely rather than merely unlikely.
fn envelope_bytes(body: &str) -> Option<Vec<u8>> {
    let token = token_of(body)?;
    let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    (bytes.len() > OFF_CIPHERTEXT + TAG_LEN && bytes[..3] == MAGIC).then_some(bytes)
}

/// The single base64url token a sealed body is, allowing the one `<p>` wrapper Teams stores it
/// in and the whitespace it may add around it.
fn token_of(body: &str) -> Option<&str> {
    // The `<p>` wrapper is REQUIRED rather than optional, and it is the shape
    // `examples/sealed_message_probe.rs` measured through the tenant. It is also the last
    // narrowing between an ordinary message and a false positive: a body this app decides is an
    // envelope and cannot open is drawn as a locked row, so a colleague's message that happened
    // to be one bare base64 run would have its words withheld. With the wrapper, the magic and
    // the length all required, that needs a body somebody deliberately built.
    let inner = body.trim().strip_prefix("<p>")?.strip_suffix("</p>")?.trim();
    // Long enough to be an envelope at all, so a short word is rejected before it is decoded.
    let smallest = (OFF_CIPHERTEXT + TAG_LEN) * 4 / 3;
    (inner.len() >= smallest
        && inner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(inner)
}

/// What the ciphertext is bound to: its own header, the conversation, and the SENDER.
///
/// The header is in the AAD so the version, the flags and the key id cannot be flipped by
/// whoever holds the message. The conversation id is there so a ciphertext the tenant copies
/// into ANOTHER chat fails to open rather than appearing there as words somebody said.
///
/// **The sender is there because Microsoft routes the message and owns the `from` field.**
/// Without it, the tenant can take the envelope one colleague posted and re-deliver the same
/// bytes as another colleague's message in the same chat: the tag verifies, the words open, and
/// the history draws the wrong person saying them — with a padlock beside it, which lends them
/// MORE credibility than an ordinary message has. Authorship is the one thing this app never
/// misstates (§ Renaming a person), so it is bound rather than trusted.
///
/// It is safe to bind because the two spellings are MEASURED to agree byte for byte: the mri the
/// sealer holds (`Session::self_mri`) is the mri the reader's own parser produces for that
/// message (`examples/sealed_message_probe.rs`, 2026-08-24). What is inferred rather than
/// measured is the same equality for a COLLEAGUE's message, which needs a second install of this
/// app to try — and the failure there is visible rather than silent: their message reads as
/// damaged, its token stays on disk, and the version byte is what a fix would move.
fn aad(header: &[u8], conversation_id: &str, sender_mri: &str) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(header.len() + conversation_id.len() + sender_mri.len() + 2);
    out.extend_from_slice(header);
    out.push(0);
    out.extend_from_slice(conversation_id.as_bytes());
    out.push(0);
    out.extend_from_slice(sender_mri.as_bytes());
    out
}

/// The payload as it is sealed: its own length, the bytes, then zeros up to a whole
/// [`PAD_BLOCK`]. The length prefix is what makes the padding removable — a trailing run of
/// zeros is not distinguishable from a body that ends in them.
fn padded(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len() + PAD_BLOCK);
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    while out.len() % PAD_BLOCK != 0 {
        out.push(0);
    }
    out
}

/// The bytes back out of a padded payload. Every bound is checked: the plaintext is
/// authenticated, so a failure here can only be a key that opened bytes it should not have —
/// and reading a length out of somebody else's plaintext must not panic.
fn unpadded(payload: &[u8]) -> Result<Vec<u8>> {
    ensure!(payload.len() >= 4, "a sealed payload with no length");
    let len = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    ensure!(4 + len <= payload.len(), "a sealed payload shorter than its own length");
    Ok(payload[4..4 + len].to_vec())
}

fn deflate(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(bytes).context("deflate a sealed body")?;
    encoder.finish().context("finish deflating a sealed body")
}

fn inflate(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(bytes)
        .take(MAX_INFLATED as u64)
        .read_to_end(&mut out)
        .context("inflate a sealed body")?;
    ensure!(out.len() < MAX_INFLATED, "a sealed body inflates past the limit");
    Ok(out)
}

/// A passphrase the app generated: five groups of four, from an alphabet with no character
/// anybody mistypes. `abcd-efgh-jkmn-pqrs-tuvw`.
///
/// It is the DEFAULT the dialog offers, because a passphrase somebody invents is the one part
/// of this feature that Argon2id has to carry, and a generated one carries itself.
pub fn generate_passphrase() -> String {
    let mut groups = Vec::with_capacity(PASSPHRASE_GROUPS);
    for _ in 0..PASSPHRASE_GROUPS {
        let mut group = String::with_capacity(PASSPHRASE_GROUP_LEN);
        while group.len() < PASSPHRASE_GROUP_LEN {
            let mut byte = [0u8; 1];
            OsRng.fill_bytes(&mut byte);
            // Rejection sampling: 256 is not a multiple of 31, so taking a modulo would make
            // the first few symbols likelier than the rest and quietly cost entropy.
            let limit = (256 / PASSPHRASE_ALPHABET.len()) * PASSPHRASE_ALPHABET.len();
            if (byte[0] as usize) < limit {
                group.push(PASSPHRASE_ALPHABET[byte[0] as usize % PASSPHRASE_ALPHABET.len()] as char);
            }
        }
        groups.push(group);
    }
    groups.join("-")
}

/// Bytes as lowercase hex — a key id in a store row, a journal line, or on the wire.
pub fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A key id back from the hex a store row holds.
pub fn key_id_from_hex(hex: &str) -> Result<KeyId> {
    ensure!(hex.len() == 8, "a key id is 8 hex characters");
    let mut out: KeyId = [0; 4];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).context("a key id that is not hex")?;
    }
    Ok(out)
}

/// The 32 bytes of a stored key, from the hex a store row holds.
pub fn key_bytes_from_hex(hex: &str) -> Result<[u8; 32]> {
    ensure!(hex.len() == 64, "a key is 64 hex characters");
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).context("a key that is not hex")?;
    }
    Ok(out)
}

/// Refuse a passphrase that could only be a mistake, at the trust boundary.
///
/// Deliberately not a strength meter: a passphrase the user chose is theirs, and the generated
/// default is what makes the strong choice the easy one. What this catches is an empty field, a
/// whole message pasted into it, and the invisible characters a copy out of a chat message
/// brings with it — a passphrase with a stray newline is one that will not open the chat on
/// the other machine, and nothing would say why.
pub fn check_passphrase(passphrase: &str) -> Result<String> {
    let trimmed = passphrase.trim();
    ensure!(!trimmed.is_empty(), "a passphrase cannot be empty");
    ensure!(
        trimmed.chars().count() <= MAX_PASSPHRASE_CHARS,
        "a passphrase is at most {MAX_PASSPHRASE_CHARS} characters"
    );
    if let Some(bad) = trimmed.chars().find(|c| c.is_control()) {
        bail!("a passphrase cannot hold {:?}", bad);
    }
    Ok(trimmed.to_string())
}

/// The form a passphrase is DERIVED from: lowercased, and with every separator and space gone.
///
/// A passphrase is read off one screen and typed into another, and the two things that happen on
/// the way are a capital letter a phone's keyboard added and a hyphen somebody typed as a space.
/// Both would derive a different key, and the failure is invisible: every message in the thread
/// comes back as one sealed under a passphrase this machine does not hold, which is the sentence
/// the app shows somebody who typed theirs correctly.
///
/// So the passphrase is case-insensitive and separator-insensitive, deliberately. What that
/// costs is the entropy of the case and the separators of a passphrase the USER invented — which
/// is why a generated one is what the dialog offers first: it is drawn from a lowercase alphabet
/// with no separators of its own to lose, and its 99 bits do not depend on either.
///
/// Unicode is NOT normalized here: this crate carries no normalization table, and the alphabet a
/// generated passphrase uses is ASCII. A passphrase somebody typed in two different Unicode
/// spellings of one character is a stated gap rather than a silent one.
pub fn canonical_passphrase(passphrase: &str) -> String {
    passphrase
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '_' | '.' | '\u{2013}' | '\u{2014}'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// A sanity bound, well clear of any real passphrase — it catches a whole message pasted into
/// the field, the way `teams_send::MAX_SUBJECT_CHARS` does for a title.
pub const MAX_PASSPHRASE_CHARS: usize = 256;

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

    /// A key with no Argon2id in the way. Every test but one is about the ENVELOPE, and
    /// 64 MiB three times over per test is a suite nobody runs.
    fn key(seed: u8) -> SealKey {
        SealKey::from_stored([seed, seed, seed, seed], [seed; 32])
    }

    /// Whoever sealed the message under test.
    const ME: &str = "8:orgid:2367c029-149d-4ebd-a96c-1fe12bfc24cf";

    #[test]
    fn a_sealed_body_comes_back_word_for_word() {
        let k = key(1);
        let html = "<p>hello <b>there</b></p>";
        let body = seal(&k, CHAT, ME, html).unwrap();
        assert_eq!(open(&[k], CHAT, ME, &body), Opened::Words(html.to_string()));
    }

    #[test]
    fn the_body_is_one_opaque_token_and_says_nothing() {
        let body = seal(&key(1), CHAT, ME, "<p>the merger closes on Friday</p>").unwrap();
        let inner = body.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap();
        assert!(
            inner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "the body must be one base64url token: {inner}"
        );
        // Not one readable word about this app, this feature, or the message.
        for word in ["teams", "lite", "seal", "encrypt", "Friday", "merger"] {
            assert!(
                !body.to_lowercase().contains(word),
                "a sealed body must not carry the word {word:?}: {body}"
            );
        }
    }

    #[test]
    fn an_ordinary_body_is_never_read_as_a_ciphertext() {
        let k = key(1);
        for body in [
            "<p>hello</p>",
            "",
            "<p>eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U</p>",
            "<p>a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2</p>",
            "<p>Deployed 0f8a91c3b2d4e5f60718293a4b5c6d7e8f90a1b2 to production just now</p>",
        ] {
            assert_eq!(open(&[k.clone()], CHAT, ME, body), Opened::NotSealed, "body: {body}");
        }
    }

    #[test]
    fn a_message_sealed_with_another_passphrase_names_the_key_rather_than_failing() {
        let body = seal(&key(1), CHAT, ME, "<p>not for you</p>").unwrap();
        assert_eq!(open(&[key(2)], CHAT, ME, &body), Opened::UnknownKey([1, 1, 1, 1]));
        // And with no key at all, which is what a chat nobody has a passphrase for looks like.
        assert_eq!(open(&[], CHAT, ME, &body), Opened::UnknownKey([1, 1, 1, 1]));
    }

    #[test]
    fn a_key_id_collision_costs_one_attempt_and_not_the_message() {
        // Two keys, one id: the first cannot open it, the second can. Reading the first
        // failure as "damaged" would lose a message that is perfectly readable.
        let right = SealKey::from_stored([9, 9, 9, 9], [7; 32]);
        let wrong = SealKey::from_stored([9, 9, 9, 9], [8; 32]);
        let body = seal(&right, CHAT, ME, "<p>readable</p>").unwrap();
        assert_eq!(
            open(&[wrong, right], CHAT, ME, &body),
            Opened::Words("<p>readable</p>".to_string())
        );
    }

    #[test]
    fn a_damaged_envelope_is_told_apart_from_an_unknown_key() {
        let k = key(1);
        let body = seal(&k, CHAT, ME, "<p>hello</p>").unwrap();
        let token = body.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(token).unwrap();
        // One bit of the ciphertext, which is what a tag exists to catch.
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let damaged = format!("<p>{}</p>", URL_SAFE_NO_PAD.encode(&bytes));
        assert_eq!(open(&[k], CHAT, ME, &damaged), Opened::Damaged);
    }

    #[test]
    fn the_conversation_is_bound_so_a_ciphertext_cannot_be_moved() {
        let k = key(1);
        let body = seal(&k, CHAT, ME, "<p>said in one chat</p>").unwrap();
        // The tenant holds the message and can post it anywhere. In another conversation it
        // must not open as words somebody said there.
        assert_eq!(open(&[k], "19:another@thread.v2", ME, &body), Opened::Damaged);
    }

    #[test]
    fn the_sender_is_bound_so_sealed_words_cannot_be_reattributed() {
        // Microsoft routes the message and owns the `from` field. Re-delivered as somebody
        // else's, a sealed message must FAIL rather than draw the wrong person's name over the
        // right words with a padlock beside it.
        let k = key(1);
        let body = seal(&k, CHAT, ME, "<p>I approve the payment</p>").unwrap();
        let colleague = "8:orgid:00000000-0000-0000-0000-000000000000";
        assert_eq!(open(&[k.clone()], CHAT, colleague, &body), Opened::Damaged);
        assert_eq!(open(&[k.clone()], CHAT, "", &body), Opened::Damaged);
        assert_eq!(
            open(&[k], CHAT, ME, &body),
            Opened::Words("<p>I approve the payment</p>".to_string())
        );
    }

    #[test]
    fn the_header_is_bound_so_the_flags_cannot_be_flipped() {
        let k = key(1);
        // Long and repetitive, so it really deflates and the flag really matters.
        let html = format!("<p>{}</p>", "the same sentence over and over. ".repeat(50));
        let body = seal(&k, CHAT, ME, &html).unwrap();
        let token = body.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(token).unwrap();
        assert_eq!(bytes[OFF_FLAGS] & FLAG_DEFLATE, FLAG_DEFLATE, "that body should deflate");
        bytes[OFF_FLAGS] &= !FLAG_DEFLATE;
        let tampered = format!("<p>{}</p>", URL_SAFE_NO_PAD.encode(&bytes));
        assert_eq!(open(&[k], CHAT, ME, &tampered), Opened::Damaged);
    }

    #[test]
    fn a_newer_version_says_so_rather_than_guessing_at_the_layout() {
        let k = key(1);
        let body = seal(&k, CHAT, ME, "<p>hello</p>").unwrap();
        let token = body.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(token).unwrap();
        bytes[OFF_VERSION] = VERSION + 1;
        let newer = format!("<p>{}</p>", URL_SAFE_NO_PAD.encode(&bytes));
        assert_eq!(open(&[k], CHAT, ME, &newer), Opened::NewerVersion(VERSION + 1));
    }

    #[test]
    fn every_seal_of_one_message_is_a_different_ciphertext() {
        // A fresh nonce each time. Two identical bodies sealing to identical tokens would
        // tell the tenant that the user repeated themselves, which is what a nonce is for.
        let k = key(1);
        let a = seal(&k, CHAT, ME, "<p>ok</p>").unwrap();
        let b = seal(&k, CHAT, ME, "<p>ok</p>").unwrap();
        assert_ne!(a, b);
        assert_eq!(open(&[k.clone()], CHAT, ME, &a), open(&[k], CHAT, ME, &b));
    }

    #[test]
    fn a_long_body_deflates_and_a_short_one_does_not() {
        let k = key(1);
        let short = seal(&k, CHAT, ME, "<p>hi</p>").unwrap();
        let short_bytes = URL_SAFE_NO_PAD
            .decode(short.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap())
            .unwrap();
        assert_eq!(short_bytes[OFF_FLAGS] & FLAG_DEFLATE, 0, "deflating a short body makes it longer");

        let long = format!("<p>{}</p>", "a repeated clause, ".repeat(400));
        let sealed = seal(&k, CHAT, ME, &long).unwrap();
        let bytes = URL_SAFE_NO_PAD
            .decode(sealed.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap())
            .unwrap();
        assert_eq!(bytes[OFF_FLAGS] & FLAG_DEFLATE, FLAG_DEFLATE);
        assert!(sealed.len() < long.len(), "a compressible body should seal smaller than it is");
        assert_eq!(open(&[k], CHAT, ME, &sealed), Opened::Words(long));
    }

    #[test]
    fn the_ceilings_close() {
        // The rule the composer's three picture ceilings hold: the largest body this side
        // accepts must not be able to build a message the SERVICE refuses. The worst case is
        // a body that does not compress, so the envelope is the full 4/3 of it.
        let worst = OFF_CIPHERTEXT + MAX_SEALED_PLAINTEXT + TAG_LEN;
        let encoded = (worst + 2) / 3 * 4;
        let body = encoded + "<p></p>".len();
        assert!(
            body + POST_OVERHEAD_BUDGET <= SERVICE_MESSAGE_LIMIT,
            "the largest sealed body is {body} bytes, which leaves {} for the rest of the POST \
             against a measured service limit of {SERVICE_MESSAGE_LIMIT}",
            SERVICE_MESSAGE_LIMIT.saturating_sub(body)
        );
        // And one byte past the limit is refused HERE rather than by the service.
        let k = key(1);
        assert!(seal(&k, CHAT, ME, &"x".repeat(MAX_SEALED_PLAINTEXT + 1)).is_err());
        assert!(seal(&k, CHAT, ME, &"x".repeat(MAX_SEALED_PLAINTEXT)).is_ok());
    }

    #[test]
    fn a_generated_passphrase_is_readable_and_has_the_entropy_it_claims() {
        let one = generate_passphrase();
        assert_eq!(one.len(), PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LEN + PASSPHRASE_GROUPS - 1);
        assert_eq!(one.split('-').count(), PASSPHRASE_GROUPS);
        for c in one.chars().filter(|c| *c != '-') {
            assert!(PASSPHRASE_ALPHABET.contains(&(c as u8)), "{c} is not in the alphabet");
            assert!(!"01lIO".contains(c), "{c} is a character people mistype");
        }
        // 20 symbols out of 31 is a little under 100 bits; the point of the assertion is that
        // nobody quietly shortens it.
        let bits = (PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LEN) as f64 * 31f64.log2();
        assert!(bits > 95.0, "a generated passphrase carries only {bits} bits");
        assert_ne!(one, generate_passphrase());
    }

    #[test]
    fn a_passphrase_is_checked_at_the_trust_boundary() {
        assert_eq!(check_passphrase("  hunter two  ").unwrap(), "hunter two");
        assert!(check_passphrase("").is_err());
        assert!(check_passphrase("   ").is_err());
        // A newline copied out of a chat message is the failure nothing would explain.
        assert!(check_passphrase("hunter\ntwo").is_err());
        assert!(check_passphrase(&"x".repeat(MAX_PASSPHRASE_CHARS + 1)).is_err());
        assert!(check_passphrase(&"x".repeat(MAX_PASSPHRASE_CHARS)).is_ok());
    }

    #[test]
    fn the_same_passphrase_is_a_different_key_in_another_chat() {
        let here = derive("hunter two", CHAT).unwrap();
        let there = derive("hunter two", "19:other@thread.v2").unwrap();
        assert_ne!(here.id, there.id);
        let body = seal(&here, CHAT, ME, "<p>hello</p>").unwrap();
        assert_eq!(open(&[there], CHAT, ME, &body), Opened::UnknownKey(here.id));
    }

    #[test]
    fn a_passphrase_derives_the_same_key_on_every_machine() {
        // The whole feature: two people type the same words and land on one key, with nothing
        // exchanged but the passphrase.
        let a = derive("correct horse battery", CHAT).unwrap();
        let b = derive("correct horse battery", CHAT).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.secret_for_store(), b.secret_for_store());
        // And it is the passphrase TRIMMED, so a space a phone's keyboard added is not a
        // different chat.
        assert_eq!(derive(" correct horse battery ", CHAT).unwrap().id, a.id);
    }

    #[test]
    fn the_key_id_is_not_a_piece_of_the_key() {
        let k = derive("hunter two", CHAT).unwrap();
        let enc = k.secret_for_store();
        assert!(
            !enc.windows(4).any(|w| w == k.id),
            "the published key id must not appear inside the key it belongs to"
        );
    }

    #[test]
    fn a_key_never_prints_itself() {
        let k = derive("hunter two", CHAT).unwrap();
        let shown = format!("{k:?}");
        assert_eq!(shown, format!("SealKey({})", k.id_hex()));
        for byte in k.secret_for_store() {
            // A key of all one byte would make this vacuous; a derived one will not.
            assert!(shown.len() < 40, "the debug form is too long to be only an id: {shown}");
            let _ = byte;
        }
    }

    #[test]
    fn a_key_survives_the_hex_the_store_keeps_it_as() {
        let k = derive("hunter two", CHAT).unwrap();
        let back = SealKey::from_stored(
            key_id_from_hex(&k.id_hex()).unwrap(),
            key_bytes_from_hex(&hex_of(&k.secret_for_store())).unwrap(),
        );
        assert_eq!(back.id, k.id);
        let body = seal(&k, CHAT, ME, "<p>hello</p>").unwrap();
        assert_eq!(open(&[back], CHAT, ME, &body), Opened::Words("<p>hello</p>".to_string()));
        assert!(key_id_from_hex("abc").is_err());
        assert!(key_bytes_from_hex("abcd").is_err());
    }

    #[test]
    fn which_key_a_message_needs_is_readable_without_holding_any() {
        // What the page is told about a message it cannot open: which passphrase, never the
        // ciphertext.
        let k = key(3);
        let body = seal(&k, CHAT, ME, "<p>hello</p>").unwrap();
        assert_eq!(key_id_of(&body), Some([3, 3, 3, 3]));
        assert!(is_sealed(&body));
        assert_eq!(key_id_of("<p>hello</p>"), None);
        assert!(!is_sealed("<p>hello</p>"));
    }

    #[test]
    fn a_passphrase_survives_being_retyped_on_a_phone() {
        // THE commonest path through this feature: read it off the laptop, type it into the
        // phone — which capitalizes the first character of the field, and where a hyphen is
        // easily typed as a space. Every one of these must be the SAME chat.
        let generated = "abcd-efgh-jkmn-pqrs-tuvw";
        let want = derive(generated, CHAT).unwrap();
        for typed in [
            "Abcd-efgh-jkmn-pqrs-tuvw", // a phone keyboard's autocapitalize
            "ABCD-EFGH-JKMN-PQRS-TUVW", // caps lock
            "abcd efgh jkmn pqrs tuvw", // the hyphens typed as spaces
            "abcdefghjkmnpqrstuvw",     // the separators left out
            "  abcd-efgh-jkmn-pqrs-tuvw  ",
            "abcd\u{2014}efgh-jkmn-pqrs-tuvw", // an em dash a phone substituted
        ] {
            assert_eq!(
                derive(typed, CHAT).unwrap().id,
                want.id,
                "{typed:?} must open the same chat as {generated:?}"
            );
        }
        // And a genuinely different passphrase still is one.
        assert_ne!(derive("abcd-efgh-jkmn-pqrs-tuvx", CHAT).unwrap().id, want.id);
    }

    #[test]
    fn the_exact_length_of_a_message_is_not_published() {
        // The ciphertext's length would otherwise BE the plaintext's, for ever, in the hands of
        // the party this feature keeps the words from — and "ok" against "no" is then one byte
        // apart with no key needed.
        let k = key(1);
        let sizes: Vec<usize> = ["<p>ok</p>", "<p>no</p>", "<p>yes</p>", "<p>agreed</p>"]
            .iter()
            .map(|html| seal(&k, CHAT, ME, html).unwrap().len())
            .collect();
        assert_eq!(
            sizes.iter().collect::<std::collections::HashSet<_>>().len(),
            1,
            "every short answer must seal to one length, got {sizes:?}"
        );
        // A long message is still visibly longer: the padding hides the exact length, never the
        // order of magnitude, and saying otherwise would be a claim this does not earn. The body
        // has to be INCOMPRESSIBLE to show it — 4096 repeated characters deflate to nothing and
        // seal SMALLER than a two-letter answer, which is a pleasant accident and not a rule.
        let mut noise = String::from("<p>");
        let mut state: u32 = 1;
        for _ in 0..4096 {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            noise.push(char::from(b'a' + (state >> 16) as u8 % 26));
        }
        noise.push_str("</p>");
        let long = seal(&k, CHAT, ME, &noise).unwrap();
        assert!(long.len() > sizes[0], "{} vs {}", long.len(), sizes[0]);
    }

    #[test]
    fn a_padded_body_of_any_length_comes_back_exactly() {
        // The padding is removed by a length prefix, so the boundary cases are the ones either
        // side of a whole block.
        let k = key(1);
        for len in [0, 1, 59, 60, 61, 63, 64, 65, 127, 128, 129] {
            let html = format!("<p>{}</p>", "x".repeat(len));
            let body = seal(&k, CHAT, ME, &html).unwrap();
            assert_eq!(open(&[k.clone()], CHAT, ME, &body), Opened::Words(html), "length {len}");
        }
    }

    #[test]
    fn the_kdf_cost_is_pinned_to_the_version() {
        // These three numbers are part of the FORMAT: the key id comes out of the Argon2id
        // output, so a build with different parameters derives a different key from the same
        // passphrase — and both machines then tell their reader they have not added a passphrase
        // they typed correctly. Moving one of these means moving VERSION with it.
        assert_eq!(
            (VERSION, ARGON2_MEMORY_KIB, ARGON2_PASSES, ARGON2_LANES),
            (1, 65_536, 3, 4),
            "the KDF cost changed: bump VERSION in the same commit, or a colleague on the other \
             build cannot read a word this one seals"
        );
    }

    #[test]
    fn only_the_shape_the_tenant_really_returns_is_read_as_an_envelope() {
        // The `<p>` wrapper is what `examples/sealed_message_probe.rs` measured, and requiring it
        // is the last narrowing before a false positive costs a colleague their words.
        let k = key(1);
        let body = seal(&k, CHAT, ME, "<p>hello</p>").unwrap();
        let token = body.strip_prefix("<p>").unwrap().strip_suffix("</p>").unwrap();
        assert!(!is_sealed(token), "a bare token with no wrapper is not an envelope");
        assert!(!is_sealed(&format!("<p>{token}</p><p>and more</p>")));
        assert!(!is_sealed(&format!("<div>{token}</div>")));
        assert!(is_sealed(&body));
        // The whitespace Teams stores around a body is still allowed.
        assert!(is_sealed(&format!("  {body}\n")));
    }

    #[test]
    fn a_quote_and_a_mention_span_are_sealed_with_the_words_they_belong_to() {
        // A reply's quote holds the words of the message it answers. Left in the clear it
        // would publish exactly what the sealed message was answering.
        let k = key(1);
        let html = "<blockquote itemid=\"1755\"><p>the merger closes Friday</p></blockquote>\
                    <p>noted <span itemscope itemtype=\"http://schema.skype.com/Mention\" itemid=\"0\">Ada</span></p>";
        let body = seal(&k, CHAT, ME, html).unwrap();
        assert!(!body.contains("merger"), "the quoted words must not survive in the clear");
        assert!(!body.contains("Ada"), "the mention span travels sealed with the body");
        assert_eq!(open(&[k], CHAT, ME, &body), Opened::Words(html.to_string()));
    }
}
