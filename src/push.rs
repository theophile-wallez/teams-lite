//! Web Push — the standard that lets an installed web app receive a notification
//! while it is closed.
//!
//! This is what makes teams-lite usable as a phone app: iOS delivers a push to a
//! Home Screen web app through APNs, so the always-on backend can reach the phone
//! even though no page is open and no socket is connected. Three RFCs are in play
//! and all three are implemented here, because the alternative was a C dependency
//! (`openssl` through the `web-push` crate) that the portable single binary must
//! not grow:
//!
//! - **RFC 8030** — the HTTP POST to the push service endpoint the browser handed us.
//! - **RFC 8291** — the payload encryption. The push service (Apple, Mozilla, Google)
//!   forwards ciphertext it cannot read: the content encryption key is derived from
//!   an ECDH exchange with a key pair that never leaves the device, so the message
//!   preview in a notification is readable by the phone and by nobody in between.
//!   That is a privacy guarantee worth stating, since the payload carries a
//!   colleague's words.
//! - **RFC 8292** — VAPID. A signed JWT identifies this server to the push service,
//!   and the public half is baked into the device's subscription, so nobody else can
//!   push to it. Apple *requires* it.
//!
//! ## The endpoint is an outbound POST, so it is allow-listed
//!
//! A subscription is a URL supplied by a client. Storing one and posting message
//! text to it is, in the wrong hands, an exfiltration channel: register an endpoint
//! you control and the backend mails you every incoming chat. Two things stop that.
//! `push_subscribe` is a write-token-gated RPC (`MACHINE_METHODS` in
//! `src/bin/server.rs`), and [`is_supported_endpoint`] refuses any host that is not
//! a browser vendor's push service — so even a client that got the token cannot
//! aim the stream somewhere new.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::sec1::ToEncodedPoint,
};
use serde::Serialize;
use sha2::Sha256;

/// The push services a subscription may point at: the browser vendors' own, and
/// nothing else. See the module note on why this list exists at all.
///
/// Matched as a host suffix on a `.`-boundary, so `web.push.apple.com` passes and
/// `web.push.apple.com.evil.test` does not.
const SUPPORTED_PUSH_HOSTS: [&str; 4] = [
    // Safari, on iOS and macOS — the one this feature exists for.
    "push.apple.com",
    // Firefox.
    "push.services.mozilla.com",
    // Chrome and every other Chromium (FCM).
    "googleapis.com",
    // Edge (Windows Notification Service).
    "notify.windows.com",
];

/// The `sub` claim of the VAPID token: a contact for whoever operates this push
/// sender, which the push service may use to complain to a human. There is no
/// operator here but the user themselves, and the value is never verified, so it
/// names the project. Overridable for a user who would rather be reachable.
const DEFAULT_VAPID_SUBJECT: &str = "https://github.com/teams-lite";

/// How long a VAPID token stays valid. Well inside the 24 hours push services
/// accept, and short enough that a leaked token is worthless within the hour.
const VAPID_TOKEN_LIFETIME_SECS: u64 = 3 * 3600;

/// The single record size we declare (`rs`). One record holds the whole payload —
/// notifications are small — so this is a formality, but it is part of the
/// aes128gcm header and must be present.
const RECORD_SIZE: u32 = 4096;

/// The ceiling a push service puts on one encrypted message. Apple's is 4096
/// bytes; the overhead (86-byte header, 16-byte tag, 1-byte delimiter) leaves this
/// much plaintext. A payload over it is a bug in the caller, not something to
/// discover from a 413.
pub const MAX_PAYLOAD_BYTES: usize = 3993;

/// How long the push service keeps trying to deliver, in seconds. An hour: a chat
/// notification that arrives after lunch is noise, but a phone that was briefly in
/// a tunnel should still get it.
pub const MESSAGE_TTL_SECS: u32 = 3600;

fn b64u() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// Decode base64url, tolerating what browsers actually send: padding or none, and
/// the standard alphabet (`+/`) in place of the URL one (`-_`).
///
/// `PushSubscription.toJSON()` produces unpadded base64url, but the keys travel
/// through hand-written client code often enough that being strict here would fail
/// a real subscription for a cosmetic reason.
fn decode_b64u(input: &str) -> Result<Vec<u8>> {
    let normalized: String = input
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    b64u().decode(normalized.as_bytes()).context("not valid base64url")
}

/// This server's VAPID identity: one P-256 key pair, generated once and kept in the
/// store.
///
/// It must be STABLE. A device's subscription embeds the public half, and a push
/// signed by a different key is rejected — so regenerating this key silently
/// breaks every phone that already opted in, and the only repair is to subscribe
/// again. Hence generate-once-then-load, never generate-per-process.
pub struct VapidKey {
    signing_key: SigningKey,
}

impl VapidKey {
    /// A fresh key pair from the OS CSPRNG.
    pub fn generate() -> Self {
        Self { signing_key: SigningKey::random(&mut rand_core::OsRng) }
    }

    /// Load a key pair from the stored private scalar (base64url, 32 bytes).
    pub fn from_private_base64url(encoded: &str) -> Result<Self> {
        let bytes = decode_b64u(encoded).context("VAPID private key")?;
        let signing_key =
            SigningKey::from_slice(&bytes).context("VAPID private key is not a P-256 scalar")?;
        Ok(Self { signing_key })
    }

    /// The private scalar, base64url — the form the store keeps. A secret: it is
    /// the authority to push to every device that subscribed.
    pub fn private_base64url(&self) -> String {
        b64u().encode(self.signing_key.to_bytes())
    }

    /// The public key as the uncompressed SEC1 point (65 bytes), base64url — the
    /// `applicationServerKey` a browser needs to create a subscription, and the `k`
    /// parameter of the `Authorization` header.
    pub fn public_base64url(&self) -> String {
        b64u().encode(self.signing_key.verifying_key().to_encoded_point(false).as_bytes())
    }

    /// The `Authorization` header value for one POST: `vapid t=<jwt>,k=<public key>`.
    ///
    /// `audience` is the scheme+host of the endpoint (each push service checks that
    /// the token was minted for it, so one token is not replayable at another).
    fn authorization(&self, audience: &str, now_secs: u64, subject: &str) -> Result<String> {
        let header = b64u().encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({
            "aud": audience,
            "exp": now_secs + VAPID_TOKEN_LIFETIME_SECS,
            "sub": subject,
        });
        let payload = b64u().encode(serde_json::to_vec(&claims)?);
        let signing_input = format!("{header}.{payload}");
        // ES256 over the JWT signing input. RFC 7515 wants the raw r||s pair, which
        // is exactly what `Signature::to_bytes` gives — not the DER form.
        let signature: Signature = self.signing_key.sign(signing_input.as_bytes());
        let jwt = format!("{signing_input}.{}", b64u().encode(signature.to_bytes()));
        Ok(format!("vapid t={jwt},k={}", self.public_base64url()))
    }
}

/// One device's subscription, as the browser's `PushSubscription` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    /// The push service URL to POST to. Opaque, and specific to this device.
    pub endpoint: String,
    /// The device's public key (uncompressed P-256 point), base64url.
    pub p256dh: String,
    /// The device's 16-byte authentication secret, base64url.
    pub auth: String,
}

impl Subscription {
    /// Reject anything that is not a usable subscription *before* it is stored, so
    /// a bad one fails at the RPC that created it rather than at 3 a.m. in a
    /// delivery task.
    pub fn validate(&self) -> Result<()> {
        if !is_supported_endpoint(&self.endpoint) {
            bail!("endpoint is not a known browser push service");
        }
        let key = decode_b64u(&self.p256dh).context("subscription key p256dh")?;
        PublicKey::from_sec1_bytes(&key).context("p256dh is not a P-256 public key")?;
        let auth = decode_b64u(&self.auth).context("subscription key auth")?;
        if auth.len() != 16 {
            bail!("auth secret must be 16 bytes, got {}", auth.len());
        }
        Ok(())
    }
}

/// Whether a subscription endpoint points at a browser vendor's push service over
/// HTTPS. Everything else is refused: see the module note.
pub fn is_supported_endpoint(endpoint: &str) -> bool {
    let Some(rest) = endpoint.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // A userinfo or port section would let a lookalike host slip past the suffix
    // match ("evil.test@web.push.apple.com"), so neither is accepted.
    if host.is_empty() || host.contains('@') || host.contains(':') {
        return false;
    }
    let host = host.to_ascii_lowercase();
    SUPPORTED_PUSH_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// What became of one delivery attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The push service accepted it.
    Delivered,
    /// The subscription is dead — the app was uninstalled, or the browser rotated
    /// it. The caller must forget it: retrying costs a request per message forever.
    Gone,
    /// Anything else. Kept as text for the log and the store's `last_error`.
    Failed(String),
}

/// The JSON the service worker receives (`web/public/sw.js` reads exactly these
/// fields). Small on purpose: what the notification says, and where a tap goes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Notification {
    /// Notification title — the sender, or the sender and where they wrote.
    pub title: String,
    /// One line of body text: the message preview.
    pub body: String,
    /// In-app path a tap opens, e.g. `/c/19%3A…%40thread.v2`.
    pub url: String,
    /// Collapse key. A second notification with the same tag replaces the first, so
    /// a burst in one conversation stays one row on the lock screen.
    pub tag: String,
}

/// Encrypt and POST one notification to one device.
///
/// Never retries: the push service already does that for {@link MESSAGE_TTL_SECS},
/// and a chat notification is not worth a queue of our own.
pub async fn deliver(
    client: &reqwest::Client,
    key: &VapidKey,
    subscription: &Subscription,
    payload: &[u8],
    ttl_secs: u32,
) -> Result<Outcome> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        bail!("payload is {} bytes, over the {MAX_PAYLOAD_BYTES}-byte limit", payload.len());
    }
    if !is_supported_endpoint(&subscription.endpoint) {
        bail!("endpoint is not a known browser push service");
    }
    let ua_public = PublicKey::from_sec1_bytes(&decode_b64u(&subscription.p256dh)?)
        .context("subscription key p256dh")?;
    let auth_secret = decode_b64u(&subscription.auth)?;
    let body = encrypt(payload, &ua_public, &auth_secret, Sender::random(), random_salt())?;

    let audience = endpoint_audience(&subscription.endpoint)?;
    let authorization = key.authorization(&audience, now_secs(), vapid_subject())?;

    let response = client
        .post(&subscription.endpoint)
        .header("authorization", authorization)
        .header("content-encoding", "aes128gcm")
        .header("content-type", "application/octet-stream")
        .header("ttl", ttl_secs.to_string())
        // "high" asks the service to wake a sleeping device now. A chat message is
        // the reason the user installed this.
        .header("urgency", "high")
        .body(body)
        .send()
        .await?;

    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(Outcome::Delivered);
    }
    let detail = response.text().await.unwrap_or_default();
    Ok(classify(status, &detail))
}

/// What one HTTP status from a push service means for the subscription.
///
/// Separate and pure so the mapping is unit tested: the 404/410 branch is the one
/// that DELETES a stored subscription, and getting it wrong either loses a working
/// device or retries a dead one on every message forever.
fn classify(status: u16, detail: &str) -> Outcome {
    // 404: the push service never heard of this subscription. 410: it is expired.
    // Both are permanent, and both are the normal end of a subscription's life.
    if status == 404 || status == 410 {
        return Outcome::Gone;
    }
    let detail = detail.trim();
    Outcome::Failed(if detail.is_empty() {
        format!("push service answered {status}")
    } else {
        format!("push service answered {status}: {}", truncate(detail, 200))
    })
}

/// The `aud` claim: scheme and host of the endpoint, no path.
fn endpoint_audience(endpoint: &str) -> Result<String> {
    let rest = endpoint.strip_prefix("https://").ok_or_else(|| anyhow!("endpoint is not https"))?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        bail!("endpoint has no host");
    }
    Ok(format!("https://{host}"))
}

/// The `sub` claim, from the environment or {@link DEFAULT_VAPID_SUBJECT}.
fn vapid_subject() -> &'static str {
    static SUBJECT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SUBJECT.get_or_init(|| {
        std::env::var("TEAMS_LITE_VAPID_SUBJECT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.starts_with("https://") || s.starts_with("mailto:"))
            .unwrap_or_else(|| DEFAULT_VAPID_SUBJECT.to_string())
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "…"
}

/// The sender's half of the ECDH exchange: an EPHEMERAL key pair, one per message.
///
/// Fresh per message by design — reusing it would let anyone holding one ciphertext
/// and the endpoint correlate every later message to the same device.
struct Sender {
    secret: SecretKey,
}

impl Sender {
    fn random() -> Self {
        Self { secret: SecretKey::random(&mut rand_core::OsRng) }
    }

    /// Rebuild the sender key from its private scalar. Only the RFC 8291 test
    /// vector needs this: the vector fixes both the key and the salt, which is the
    /// only way to check this code against the standard rather than against itself.
    #[cfg(test)]
    fn from_private_base64url(encoded: &str) -> Result<Self> {
        let bytes = decode_b64u(encoded)?;
        Ok(Self { secret: SecretKey::from_slice(&bytes)? })
    }

    /// The uncompressed public point (65 bytes) that travels in the message header.
    fn public_bytes(&self) -> Vec<u8> {
        self.secret.public_key().to_encoded_point(false).as_bytes().to_vec()
    }
}

fn random_salt() -> [u8; 16] {
    // uuid v4 is the crate's existing OS-CSPRNG path (it is how the write token is
    // minted), so the salt comes from the same place rather than adding a second.
    let mut salt = [0u8; 16];
    salt.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    salt
}

/// Encrypt one payload into an aes128gcm message body (RFC 8188 framing, RFC 8291
/// key derivation).
///
/// The body is `salt(16) || rs(4) || idlen(1) || sender public key(65) || ciphertext`,
/// which is what the browser's push machinery decrypts before it hands the JSON to
/// the service worker.
fn encrypt(
    payload: &[u8],
    ua_public: &PublicKey,
    auth_secret: &[u8],
    sender: Sender,
    salt: [u8; 16],
) -> Result<Vec<u8>> {
    use aes_gcm::{
        Aes128Gcm, Nonce,
        aead::{Aead, KeyInit},
    };

    let ua_public_bytes = ua_public.to_encoded_point(false).as_bytes().to_vec();
    let sender_public_bytes = sender.public_bytes();

    let shared = diffie_hellman(sender.secret.to_nonzero_scalar(), ua_public.as_affine());

    // RFC 8291 §3.3: the ECDH secret is stretched with the device's auth secret as
    // the salt, and the info string binds the result to BOTH public keys — so a
    // ciphertext cannot be replayed against another subscription.
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&ua_public_bytes);
    key_info.extend_from_slice(&sender_public_bytes);
    let mut ikm = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| anyhow!("HKDF expand failed for the input keying material"))?;

    let prk = hkdf::Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| anyhow!("HKDF expand failed for the content encryption key"))?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| anyhow!("HKDF expand failed for the nonce"))?;

    // One record, so the padding delimiter is 0x02 ("last record"). 0x01 would tell
    // the receiver to expect another and it would fail on the truncated stream.
    let mut record = Vec::with_capacity(payload.len() + 1);
    record.extend_from_slice(payload);
    record.push(0x02);

    let ciphertext = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| anyhow!("invalid content encryption key length"))?
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| anyhow!("aes128gcm encryption failed"))?;

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(sender_public_bytes.len() as u8);
    body.extend_from_slice(&sender_public_bytes);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8291 §5 + Appendix A. The point of this test: it checks the derivation and
    // framing against the STANDARD, not against another run of this code. Every
    // input is pinned (both key pairs, the auth secret, the salt), so the body is
    // reproducible byte for byte.
    const RFC_PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const RFC_AUTH_SECRET: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const RFC_UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const RFC_SENDER_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const RFC_SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const RFC_BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
                            mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
                            pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    #[test]
    fn encryption_matches_the_rfc_8291_test_vector() {
        let ua_public = PublicKey::from_sec1_bytes(&decode_b64u(RFC_UA_PUBLIC).unwrap()).unwrap();
        let auth_secret = decode_b64u(RFC_AUTH_SECRET).unwrap();
        let sender = Sender::from_private_base64url(RFC_SENDER_PRIVATE).unwrap();
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&decode_b64u(RFC_SALT).unwrap());

        let body =
            encrypt(RFC_PLAINTEXT.as_bytes(), &ua_public, &auth_secret, sender, salt).unwrap();

        assert_eq!(b64u().encode(&body), RFC_BODY.replace(['\n', ' '], ""));
    }

    #[test]
    fn the_body_is_framed_as_rfc_8188_expects() {
        let ua_public = PublicKey::from_sec1_bytes(&decode_b64u(RFC_UA_PUBLIC).unwrap()).unwrap();
        let auth_secret = decode_b64u(RFC_AUTH_SECRET).unwrap();
        let payload = b"hello";

        let body =
            encrypt(payload, &ua_public, &auth_secret, Sender::random(), random_salt()).unwrap();

        assert_eq!(&body[16..20], &RECORD_SIZE.to_be_bytes(), "record size");
        assert_eq!(body[20], 65, "key id length is the uncompressed point length");
        // header + payload + padding delimiter + GCM tag
        assert_eq!(body.len(), 86 + payload.len() + 1 + 16);
    }

    #[test]
    fn a_fresh_salt_and_sender_key_change_every_message() {
        let ua_public = PublicKey::from_sec1_bytes(&decode_b64u(RFC_UA_PUBLIC).unwrap()).unwrap();
        let auth = decode_b64u(RFC_AUTH_SECRET).unwrap();

        let first = encrypt(b"same", &ua_public, &auth, Sender::random(), random_salt()).unwrap();
        let second = encrypt(b"same", &ua_public, &auth, Sender::random(), random_salt()).unwrap();

        assert_ne!(first, second, "identical payloads must not encrypt identically");
    }

    #[test]
    fn a_vapid_key_survives_a_round_trip_through_the_store() {
        let key = VapidKey::generate();
        let restored = VapidKey::from_private_base64url(&key.private_base64url()).unwrap();
        assert_eq!(key.public_base64url(), restored.public_base64url());
        // 65-byte uncompressed point => 87 base64url characters, and the browser
        // requires exactly that form for `applicationServerKey`.
        assert_eq!(decode_b64u(&key.public_base64url()).unwrap().len(), 65);
    }

    #[test]
    fn the_authorization_header_carries_an_es256_jwt_for_the_endpoint() {
        let key = VapidKey::generate();
        let header = key.authorization("https://web.push.apple.com", 1_700_000_000, "https://a.test").unwrap();

        let (scheme, params) = header.split_once(' ').unwrap();
        assert_eq!(scheme, "vapid");
        let (token, public) = params.split_once(',').unwrap();
        let jwt = token.strip_prefix("t=").unwrap();
        assert_eq!(public.strip_prefix("k=").unwrap(), key.public_base64url());

        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "header.payload.signature");
        let claims: serde_json::Value =
            serde_json::from_slice(&decode_b64u(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["sub"], "https://a.test");
        assert_eq!(claims["exp"], 1_700_000_000 + VAPID_TOKEN_LIFETIME_SECS);
        // Raw r||s, not DER: a DER signature is 70-72 bytes and push services
        // reject it.
        assert_eq!(decode_b64u(parts[2]).unwrap().len(), 64);
    }

    #[test]
    fn only_a_browser_vendors_push_service_is_accepted() {
        for endpoint in [
            "https://web.push.apple.com/QF0zAgAA…",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://sfo.notify.windows.com/w/?token=abc",
        ] {
            assert!(is_supported_endpoint(endpoint), "{endpoint} should be accepted");
        }
        for endpoint in [
            // The whole point of the list: an attacker-supplied sink.
            "https://exfil.test/collect",
            // Lookalikes.
            "https://web.push.apple.com.exfil.test/collect",
            "https://pushapple.com/x",
            // Plaintext, and the tricks that hide a real host.
            "http://web.push.apple.com/x",
            "https://exfil.test@web.push.apple.com/x",
            "https://web.push.apple.com:8443/x",
            "",
        ] {
            assert!(!is_supported_endpoint(endpoint), "{endpoint} should be refused");
        }
    }

    #[test]
    fn a_subscription_is_validated_before_it_is_stored() {
        let good = Subscription {
            endpoint: "https://web.push.apple.com/abc".to_string(),
            p256dh: RFC_UA_PUBLIC.to_string(),
            auth: RFC_AUTH_SECRET.to_string(),
        };
        assert!(good.validate().is_ok());

        let wrong_host = Subscription { endpoint: "https://exfil.test/abc".to_string(), ..good.clone() };
        assert!(wrong_host.validate().is_err());

        let short_auth = Subscription { auth: "c2hvcnQ".to_string(), ..good.clone() };
        assert!(short_auth.validate().is_err());

        let not_a_point = Subscription { p256dh: "bm90LWEta2V5".to_string(), ..good.clone() };
        assert!(not_a_point.validate().is_err());
    }

    #[test]
    fn browser_supplied_keys_decode_with_or_without_padding() {
        let padded = "BTBZMqHH6r4Tts7J_aSIgg==";
        let standard_alphabet = "BTBZMqHH6r4Tts7J+aSIgg";
        assert_eq!(decode_b64u(padded).unwrap(), decode_b64u(RFC_AUTH_SECRET).unwrap());
        assert_eq!(decode_b64u(standard_alphabet).unwrap().len(), 16);
    }

    #[test]
    fn the_audience_is_the_endpoint_origin() {
        assert_eq!(
            endpoint_audience("https://web.push.apple.com/QF0zAgAA/x?y=1").unwrap(),
            "https://web.push.apple.com"
        );
        assert!(endpoint_audience("http://web.push.apple.com/x").is_err());
    }

    #[test]
    fn only_a_permanent_answer_retires_a_subscription() {
        // These two are the end of a subscription's life, and the only statuses that
        // may delete a device: 404 (never heard of it) and 410 (expired).
        assert_eq!(classify(404, ""), Outcome::Gone);
        assert_eq!(classify(410, "gone"), Outcome::Gone);
        // Everything else is transient or ours to fix, so the device stays.
        for status in [400, 401, 403, 413, 429, 500, 503] {
            assert!(matches!(classify(status, ""), Outcome::Failed(_)), "{status}");
        }
        // The service's own explanation is the useful part of a failure.
        assert_eq!(
            classify(401, "  VAPID credentials are invalid  "),
            Outcome::Failed(
                "push service answered 401: VAPID credentials are invalid".to_string()
            )
        );
        // …but it is not allowed to be a log flood.
        let Outcome::Failed(long) = classify(500, &"x".repeat(500)) else {
            panic!("a 500 is a failure, not a retirement");
        };
        assert!(long.chars().count() < 260, "{}", long.chars().count());
    }

    #[test]
    fn an_oversized_payload_is_refused_before_the_network() {
        let key = VapidKey::generate();
        let subscription = Subscription {
            endpoint: "https://web.push.apple.com/abc".to_string(),
            p256dh: RFC_UA_PUBLIC.to_string(),
            auth: RFC_AUTH_SECRET.to_string(),
        };
        let oversized = vec![b'x'; MAX_PAYLOAD_BYTES + 1];
        let client = reqwest::Client::new();
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(deliver(&client, &key, &subscription, &oversized, MESSAGE_TTL_SECS))
            .unwrap_err();
        assert!(error.to_string().contains("over the"), "{error}");
    }
}
