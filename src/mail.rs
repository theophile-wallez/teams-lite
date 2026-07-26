// Outlook mail, read-only, over Microsoft Graph.
//
// The same broker/PRT identity that backs Teams also carries the mailbox: the
// Office FOCI client id already holds `Mail.ReadWrite` and `Mail.Send` consent, so
// no new app registration or user consent is involved (see `auth`). That makes the
// authorization trivially available — and makes the discipline below mandatory.
//
// READ-ONLY BY CONSTRUCTION. This module issues GET requests and nothing else.
// There is no send, reply, forward, delete, move, or mark-as-read path anywhere in
// it: not "not exposed yet", but absent, so no caller can reach one. The mailbox
// belongs to the user personally and a mail leaving it is as irreversible as a
// Teams message posted to a colleague — the incident that produced the automation
// rules in AGENTS.md. Two tests at the bottom of this file enforce the property
// mechanically: one asserts this module contains no non-GET verb, the other that
// the crate contains no `sendMail` endpoint at all. If mail sending is ever
// wanted, it is a deliberate feature with its own consent gate and its own entry
// in `OUTWARD_METHODS` — never a quiet addition here.
//
// Shape of the sync, and why it is not delta-based:
//   - Folder identity comes from the well-known path ALIASES (`/me/mailFolders/
//     inbox`, `/sentitems`, …). `wellKnownName` does not exist on this tenant's
//     `mailFolder` type (Graph answers 400), and `displayName` is localized — the
//     user's inbox is literally "Boîte de réception" — so neither can order the
//     sidebar. The aliases are stable and locale-independent.
//   - History is a KEYSET query: `$filter=receivedDateTime lt <iso>` +
//     `$orderby=receivedDateTime desc`. No opaque cursor to persist, and paging
//     older is the same query with the oldest row's timestamp.
//   - Live updates POLL the newest window rather than using `/messages/delta`.
//     Establishing a delta watermark would mean draining the whole folder first:
//     `$deltatoken=latest` is not honoured here (it starts a full sync), and the
//     inbox holds 6578 messages. The newest-window poll costs one request per
//     watched folder and catches what a mail client must catch — new mail, and
//     read/deleted state for the window the user is actually looking at. Anything
//     older reconciles when it is re-fetched. See [`POLL_WINDOW`] and
//     `Store::prune_mail_window`.
//
// Timestamps: `receivedDateTime` is kept as its ISO 8601 UTC string, truncated to
// whole seconds ([`normalize_timestamp`]). Fixed-width UTC text sorts
// lexicographically exactly as it sorts chronologically, so the store orders and
// pages on the string itself and no date arithmetic exists on the Rust side; the
// UI parses it once for display.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::mail_html::{self, SanitizedBody};

/// Graph host every request targets. The bearer token is only ever sent here.
const GRAPH_HOST: &str = "graph.microsoft.com";

/// Broker scope for the mailbox. Deliberately the SAME scope string the
/// SharePoint/OneDrive media path already uses, so both share one entry in the
/// process-wide token cache and one refresh (see `auth::TokenCache`).
pub const MAIL_SCOPE: &str = crate::teams_media::GRAPH_SCOPE;

/// How many message headers a list/backfill page holds. Chosen like the Teams page
/// size: enough to fill a tall viewport in one round-trip, small enough that the
/// first paint is fast.
pub const DEFAULT_PAGE_SIZE: u32 = 40;

/// How many messages the live poll re-reads at the head of a watched folder.
///
/// The poll re-fetches this window rather than asking only for "what is newer than
/// X": one request then catches all three things that can change — mail arriving,
/// mail being read elsewhere, and mail being deleted or moved elsewhere — because
/// the window can be compared against what we hold (see `Store::prune_mail_window`).
/// Asking only for newer mail would be marginally cheaper and would never notice a
/// deletion.
pub const POLL_WINDOW: u32 = 50;

/// Message fields the list needs. `body` is deliberately ABSENT: a body is up to
/// ~135 KB of HTML, and fetching 40 of them to render a list of subjects would be
/// the single most wasteful thing this module could do. Bodies load per message
/// ([`fetch_body`]) and are then cached in the store.
const HEADER_SELECT: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,\
                             receivedDateTime,isRead,hasAttachments,importance,bodyPreview";

/// The well-known folders, in the order the sidebar shows them. Identity is the
/// path ALIAS Graph resolves (locale-independent, unlike `displayName`), and the
/// index in this list is the sort position. A folder the mailbox does not have is
/// simply skipped; anything not listed here is a user folder, sorted after these
/// by name.
///
/// `outbox` and `drafts` are included as read-only views: this app cannot compose,
/// so they exist to show what real Outlook has queued or saved, nothing more.
const WELL_KNOWN_FOLDERS: &[(&str, &str)] = &[
    ("inbox", "Inbox"),
    ("archive", "Archive"),
    ("sentitems", "Sent"),
    ("drafts", "Drafts"),
    ("outbox", "Outbox"),
    ("junkemail", "Junk"),
    ("deleteditems", "Deleted"),
];

/// A mail folder as the sidebar shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailFolder {
    pub id: String,
    /// The folder's own (localized) name, as Outlook shows it.
    pub display_name: String,
    /// The stable, locale-independent label for a well-known folder ("Inbox",
    /// "Sent", …), or empty for a user-created folder. The UI shows this when
    /// present so the sidebar reads the same in any tenant language.
    pub well_known: String,
    pub total_count: i64,
    pub unread_count: i64,
    /// Sort position: the index in [`WELL_KNOWN_FOLDERS`] for a well-known folder,
    /// or a value past all of them for a user folder (which then sorts by name).
    pub position: i64,
}

/// One address on a message (`from`, `toRecipients`, `ccRecipients`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAddress {
    pub name: String,
    pub address: String,
}

/// A message as the list needs it — everything except the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailHeader {
    pub id: String,
    pub folder_id: String,
    /// Graph's thread key. Kept so a future conversation view can group by it; the
    /// list is flat today.
    pub conversation_id: String,
    pub subject: String,
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    /// ISO 8601 UTC, whole seconds (see [`normalize_timestamp`]). The ordering and
    /// paging key, on both the wire and in SQLite.
    pub received: String,
    pub is_read: bool,
    pub has_attachments: bool,
    /// Graph `importance`: "low" | "normal" | "high".
    pub importance: String,
    /// Graph's own plain-text first lines. Used for the list preview, so a preview
    /// never depends on having fetched (or sanitized) the body.
    pub preview: String,
}

/// One attachment listed on a message. Bytes are NOT here — a file attachment can
/// be tens of megabytes, so the list stays cheap and the bytes are fetched per
/// attachment on demand ([`fetch_attachment`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAttachment {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: i64,
    /// True for an attachment referenced from the body (`cid:`) rather than shown
    /// as a file. Inline ones are embedded into the sanitized HTML and are not
    /// listed as files by the UI.
    pub is_inline: bool,
}

/// A fetched, rendered message body plus the attachments it came with.
#[derive(Debug, Clone)]
pub struct FetchedBody {
    /// The message's own header, read in the SAME request as the body.
    ///
    /// This is what makes a deep link work. Opening `/m/<id>` in a fresh tab has no
    /// list to take the subject and sender from, and asking for them separately
    /// would be a second round-trip on the one path where latency is most visible.
    /// `None` only if Graph answered a shape with no id or timestamp.
    pub header: Option<MailHeader>,
    pub body: SanitizedBody,
    pub attachments: Vec<MailAttachment>,
}

/// Raw bytes of one attachment, for the download/inline path.
pub struct AttachmentBytes {
    pub content_type: String,
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Upper bound on a single attachment we will proxy, mirroring the Teams media
/// proxy's cap: past this the bytes are refused rather than buffered whole into a
/// base64 WebSocket frame.
pub const MAX_ATTACHMENT_BYTES: usize = 24 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP — GET only.
// ---------------------------------------------------------------------------

/// Issue one Graph GET and parse the JSON body.
///
/// The ONLY request builder in this module, and it is a GET. Everything else goes
/// through it, which is what makes "this module cannot write to the mailbox" a
/// structural property rather than a promise (see the module doc and the tests).
///
/// `url` must already be a full `https://graph.microsoft.com/...` URL built by one
/// of the `endpoint*` helpers, so the bearer token is only ever sent to Graph.
async fn graph_get(
    http: &reqwest::Client,
    token: &str,
    url: &str,
    prefer: Option<&str>,
) -> Result<Value> {
    anyhow::ensure!(
        url.starts_with(&format!("https://{GRAPH_HOST}/")),
        "refusing to send the Graph token to a non-Graph URL"
    );
    let mut req = http.get(url).bearer_auth(token);
    if let Some(prefer) = prefer {
        req = req.header("Prefer", prefer);
    }
    let resp = req.send().await.context("graph mail request")?;
    let status = resp.status();
    let body = resp.text().await.context("read graph mail response")?;
    if !status.is_success() {
        // Surface Graph's own message (it names the offending property/filter),
        // but never the token or the whole payload.
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default();
        anyhow::bail!("graph mail -> {status} {detail}");
    }
    serde_json::from_str(&body).context("parse graph mail response")
}

/// A `/v1.0/me/...` endpoint URL. Callers pass the already-encoded query.
fn endpoint(path: &str) -> String {
    format!("https://{GRAPH_HOST}/v1.0/me{path}")
}

/// Percent-encode one OData query-parameter value.
fn q(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/// Resolve the mailbox's folders: every well-known folder that exists, in
/// [`WELL_KNOWN_FOLDERS`] order, followed by the user's own top-level folders
/// sorted by name.
///
/// The well-known ones are resolved by alias, one request each, concurrently — the
/// only way to identify them without `wellKnownName` (absent here) or the localized
/// display name. A missing alias is not an error: a mailbox simply may not have
/// that folder, so it is skipped.
pub async fn fetch_folders(http: &reqwest::Client, token: &str) -> Result<Vec<MailFolder>> {
    let select = "id,displayName,totalItemCount,unreadItemCount";

    // Well-known folders, by alias, concurrently. Each is independent, so one
    // missing folder never fails the batch.
    let known = futures_util::future::join_all(WELL_KNOWN_FOLDERS.iter().enumerate().map(
        |(position, (alias, label))| async move {
            let url = endpoint(&format!("/mailFolders/{alias}?$select={select}"));
            let value = graph_get(http, token, &url, None).await.ok()?;
            let mut folder = parse_folder(&value)?;
            folder.well_known = (*label).to_string();
            folder.position = position as i64;
            Some(folder)
        },
    ))
    .await;

    let mut folders: Vec<MailFolder> = known.into_iter().flatten().collect();
    let well_known_ids: std::collections::HashSet<String> =
        folders.iter().map(|f| f.id.clone()).collect();

    // The user's own top-level folders. Best-effort: the well-known list above is
    // what the sidebar needs to be useful, so a failure here degrades rather than
    // fails the whole call.
    let url = endpoint(&format!("/mailFolders?$top=100&$select={select}"));
    if let Ok(value) = graph_get(http, token, &url, None).await {
        let mut extra: Vec<MailFolder> = value["value"]
            .as_array()
            .map(|items| items.iter().filter_map(parse_folder).collect())
            .unwrap_or_default();
        extra.retain(|f| !well_known_ids.contains(&f.id));
        extra.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        // Past every well-known position, so user folders always come after.
        for (i, folder) in extra.iter_mut().enumerate() {
            folder.position = (WELL_KNOWN_FOLDERS.len() + i) as i64;
        }
        folders.extend(extra);
    }

    anyhow::ensure!(!folders.is_empty(), "no mail folders returned");
    Ok(folders)
}

/// Parse one `mailFolder` resource. Returns `None` when it carries no id (an error
/// envelope, or a shape we don't recognize) rather than inventing a folder.
fn parse_folder(value: &Value) -> Option<MailFolder> {
    let id = value["id"].as_str()?.to_string();
    Some(MailFolder {
        id,
        display_name: value["displayName"].as_str().unwrap_or_default().to_string(),
        well_known: String::new(),
        total_count: value["totalItemCount"].as_i64().unwrap_or(0),
        unread_count: value["unreadItemCount"].as_i64().unwrap_or(0),
        position: i64::MAX,
    })
}

// ---------------------------------------------------------------------------
// Message lists
// ---------------------------------------------------------------------------

/// The newest page of a folder, newest first.
pub async fn fetch_newest(
    http: &reqwest::Client,
    token: &str,
    folder_id: &str,
    limit: u32,
) -> Result<Vec<MailHeader>> {
    let url = endpoint(&format!(
        "/mailFolders/{}/messages?$select={HEADER_SELECT}&$orderby={}&$top={limit}",
        q(folder_id),
        q("receivedDateTime desc"),
    ));
    fetch_headers(http, token, &url, folder_id).await
}

/// The page of messages strictly OLDER than `before` (an ISO 8601 UTC timestamp
/// from the oldest row already held), newest first. This is the scroll-up path.
///
/// Keyset paging on the same property the results are ordered by — the only
/// combination Exchange accepts. (Pairing `$orderby=receivedDateTime` with a filter
/// on a different property, e.g. `hasAttachments`, is refused as "too complex".)
pub async fn fetch_older(
    http: &reqwest::Client,
    token: &str,
    folder_id: &str,
    before: &str,
    limit: u32,
) -> Result<Vec<MailHeader>> {
    let url = endpoint(&format!(
        "/mailFolders/{}/messages?$select={HEADER_SELECT}&$filter={}&$orderby={}&$top={limit}",
        q(folder_id),
        q(&format!("receivedDateTime lt {before}")),
        q("receivedDateTime desc"),
    ));
    fetch_headers(http, token, &url, folder_id).await
}

async fn fetch_headers(
    http: &reqwest::Client,
    token: &str,
    url: &str,
    folder_id: &str,
) -> Result<Vec<MailHeader>> {
    let value = graph_get(http, token, url, None).await?;
    Ok(parse_headers(&value, folder_id))
}

/// Decode a `value` array of `message` resources into headers, skipping anything
/// without an id or a timestamp (which could not be ordered or addressed).
pub fn parse_headers(value: &Value, folder_id: &str) -> Vec<MailHeader> {
    value["value"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| parse_header(item, folder_id))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_header(value: &Value, folder_id: &str) -> Option<MailHeader> {
    let id = value["id"].as_str()?.to_string();
    let received = normalize_timestamp(value["receivedDateTime"].as_str()?);
    if received.is_empty() {
        return None;
    }
    Some(MailHeader {
        id,
        folder_id: folder_id.to_string(),
        conversation_id: value["conversationId"].as_str().unwrap_or_default().to_string(),
        subject: value["subject"].as_str().unwrap_or_default().trim().to_string(),
        from: parse_address(&value["from"]).unwrap_or_else(|| MailAddress {
            name: String::new(),
            address: String::new(),
        }),
        to: parse_address_list(&value["toRecipients"]),
        cc: parse_address_list(&value["ccRecipients"]),
        received,
        is_read: value["isRead"].as_bool().unwrap_or(true),
        has_attachments: value["hasAttachments"].as_bool().unwrap_or(false),
        importance: value["importance"].as_str().unwrap_or("normal").to_string(),
        preview: collapse_whitespace(value["bodyPreview"].as_str().unwrap_or_default()),
    })
}

/// Graph wraps an address as `{ "emailAddress": { "name", "address" } }`. Returns
/// `None` when neither field is present, so an absent `from` (a draft) stays absent
/// instead of becoming an empty person.
fn parse_address(value: &Value) -> Option<MailAddress> {
    let inner = value.get("emailAddress").unwrap_or(value);
    let name = inner["name"].as_str().unwrap_or_default().trim().to_string();
    let address = inner["address"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() && address.is_empty() {
        return None;
    }
    Some(MailAddress { name, address })
}

fn parse_address_list(value: &Value) -> Vec<MailAddress> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_address).collect())
        .unwrap_or_default()
}

/// Truncate an ISO 8601 UTC timestamp to whole seconds, so every stored value is
/// the same fixed width and lexicographic order equals chronological order (which
/// is what lets SQLite sort and page on the text directly — see the module doc).
/// Anything that is not a plausible `YYYY-MM-DDTHH:MM:SS` prefix yields `""`, and
/// its message is skipped rather than mis-sorted.
pub fn normalize_timestamp(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() < 19 {
        return String::new();
    }
    let head = &raw[..19];
    let bytes = head.as_bytes();
    let shape_ok = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && head
            .char_indices()
            .filter(|(i, _)| ![4, 7, 10, 13, 16].contains(i))
            .all(|(_, c)| c.is_ascii_digit());
    if !shape_ok {
        return String::new();
    }
    format!("{head}Z")
}

/// Collapse runs of whitespace (including the newlines Graph's `bodyPreview`
/// carries) into single spaces, so a list preview is one clean line.
fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Bodies + attachments
// ---------------------------------------------------------------------------

/// Fetch one message's body, render it safe, and list its attachments.
///
/// The returned HTML is self-contained and inert: scripts and remote references
/// are gone, and inline (`cid:`) images have been replaced by embedded `data:`
/// URIs, so displaying a mail makes NO network request of its own. That is both a
/// privacy property — a remote image in a mail is a read receipt for its sender,
/// and one sampled message carried 63 of them — and what lets the whole body be
/// cached in SQLite and re-displayed offline. See `mail_html`.
///
/// Inline images are fetched per attachment (bytes and `contentId` come together)
/// and only for attachments marked inline and under
/// [`mail_html::MAX_INLINE_IMAGE_BYTES`]; a file attachment is never downloaded
/// here, only listed.
pub async fn fetch_body(
    http: &reqwest::Client,
    token: &str,
    message_id: &str,
) -> Result<FetchedBody> {
    // The header fields come along for free in this request (see
    // `FetchedBody::header`), including `parentFolderId` — the only place the
    // message resource says which folder it lives in.
    let url = endpoint(&format!(
        "/messages/{}?$select={HEADER_SELECT},body,parentFolderId",
        q(message_id)
    ));
    // Ask for HTML explicitly: without this Graph may answer text for a message
    // whose native body is HTML, which would lose all of its structure.
    let value = graph_get(http, token, &url, Some("outlook.body-content-type=\"html\"")).await?;

    let folder_id = value["parentFolderId"].as_str().unwrap_or_default();
    let header = parse_header(&value, folder_id);
    let raw_html = value["body"]["content"].as_str().unwrap_or_default();
    let is_html = value["body"]["contentType"]
        .as_str()
        .map(|t| t.eq_ignore_ascii_case("html"))
        .unwrap_or(true);
    let has_attachments = value["hasAttachments"].as_bool().unwrap_or(false);

    let attachments = if has_attachments {
        list_attachments(http, token, message_id).await.unwrap_or_default()
    } else {
        Vec::new()
    };

    // Only inline attachments are embedded, and only when the body actually points
    // at one — a mail with an inline-marked attachment nothing references costs no
    // download.
    let inline: Vec<&MailAttachment> = if raw_html.contains("cid:") {
        attachments.iter().filter(|a| a.is_inline).collect()
    } else {
        Vec::new()
    };
    let mut embedded: Vec<mail_html::InlineImage> = Vec::new();
    let mut inline_bytes = 0usize;
    for attachment in inline {
        if attachment.size as usize > mail_html::MAX_INLINE_IMAGE_BYTES {
            continue;
        }
        if inline_bytes + attachment.size.max(0) as usize > mail_html::MAX_INLINE_TOTAL_BYTES {
            break;
        }
        // Best-effort per image: one that fails to load simply isn't embedded, and
        // the sanitizer drops its placeholder.
        if let Ok(Some(image)) = fetch_inline_image(http, token, message_id, &attachment.id).await {
            inline_bytes += image.data_base64.len();
            embedded.push(image);
        }
    }

    let body = if is_html {
        mail_html::sanitize(raw_html, &embedded)
    } else {
        mail_html::from_plain_text(raw_html)
    };
    Ok(FetchedBody {
        header,
        body,
        attachments,
    })
}

/// List a message's attachments (no bytes). `$select` is restricted to properties
/// the BASE `attachment` type declares: `contentId` lives on `fileAttachment` and
/// selecting it is a 400, which is why the inline path reads it from the full
/// per-attachment resource instead.
async fn list_attachments(
    http: &reqwest::Client,
    token: &str,
    message_id: &str,
) -> Result<Vec<MailAttachment>> {
    let url = endpoint(&format!(
        "/messages/{}/attachments?$select=id,name,contentType,size,isInline",
        q(message_id)
    ));
    let value = graph_get(http, token, &url, None).await?;
    Ok(parse_attachments(&value))
}

pub fn parse_attachments(value: &Value) -> Vec<MailAttachment> {
    value["value"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(MailAttachment {
                        id: item["id"].as_str()?.to_string(),
                        name: item["name"].as_str().unwrap_or_default().to_string(),
                        content_type: item["contentType"]
                            .as_str()
                            .unwrap_or("application/octet-stream")
                            .to_string(),
                        size: item["size"].as_i64().unwrap_or(0),
                        is_inline: item["isInline"].as_bool().unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch one inline image as the `contentId` → base64 pair the sanitizer needs to
/// embed it. The FULL attachment resource is read (no `$select`) because that is
/// the only response carrying both `contentId` and `contentBytes`; the caller has
/// already bounded which attachments reach this path by size and inline flag.
/// `None` means the resource was not a usable inline image.
async fn fetch_inline_image(
    http: &reqwest::Client,
    token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<Option<mail_html::InlineImage>> {
    let url = endpoint(&format!(
        "/messages/{}/attachments/{}",
        q(message_id),
        q(attachment_id)
    ));
    let value = graph_get(http, token, &url, None).await?;
    let content_id = value["contentId"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let data_base64 = value["contentBytes"].as_str().unwrap_or_default().to_string();
    let content_type = value["contentType"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_string();
    if content_id.is_empty() || data_base64.is_empty() {
        return Ok(None);
    }
    Ok(Some(mail_html::InlineImage {
        content_id,
        content_type,
        data_base64,
    }))
}

/// Fetch one attachment's raw bytes, for the UI's download/preview path.
///
/// Uses `/$value`, which streams the bytes rather than the base64 blob the JSON
/// resource embeds. Size-capped like the Teams media proxy.
pub async fn fetch_attachment(
    http: &reqwest::Client,
    token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<AttachmentBytes> {
    // The name/type come from the resource; the bytes from its $value.
    let meta_url = endpoint(&format!(
        "/messages/{}/attachments/{}?$select=id,name,contentType,size",
        q(message_id),
        q(attachment_id)
    ));
    let meta = graph_get(http, token, &meta_url, None).await?;
    let size = meta["size"].as_i64().unwrap_or(0);
    anyhow::ensure!(
        size as usize <= MAX_ATTACHMENT_BYTES,
        "attachment too large: {size} bytes"
    );

    let url = endpoint(&format!(
        "/messages/{}/attachments/{}/$value",
        q(message_id),
        q(attachment_id)
    ));
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("graph attachment bytes request")?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !status.is_success() {
        anyhow::bail!("graph attachment bytes -> {status}");
    }
    let bytes = resp.bytes().await.context("read attachment bytes")?;
    anyhow::ensure!(
        bytes.len() <= MAX_ATTACHMENT_BYTES,
        "attachment too large: {} bytes",
        bytes.len()
    );
    Ok(AttachmentBytes {
        // Prefer the resource's own type: `$value` sometimes answers a generic one.
        content_type: meta["contentType"]
            .as_str()
            .map(str::to_string)
            .or(content_type)
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        name: meta["name"].as_str().unwrap_or_default().to_string(),
        bytes: bytes.to_vec(),
    })
}

// ---------------------------------------------------------------------------
// Persistence
//
// Mail is local-first exactly like chat: a fetch writes through to SQLite and the
// UI is served from there, so re-opening a folder or a mail costs no network. These
// helpers own the mapping between the Graph shapes above and the store's rows,
// keeping that translation out of the request handlers (mirrors
// `teams_read::persist_page`).
// ---------------------------------------------------------------------------

/// Serialize an address list the way the store holds it (and the UI reads it).
fn addresses_json(addresses: &[MailAddress]) -> String {
    Value::Array(
        addresses
            .iter()
            .map(|a| serde_json::json!({ "name": a.name, "address": a.address }))
            .collect(),
    )
    .to_string()
}

/// Serialize an attachment list the way the store holds it.
pub fn attachments_json(attachments: &[MailAttachment]) -> String {
    Value::Array(
        attachments
            .iter()
            .map(|a| {
                serde_json::json!({
                    "id": a.id,
                    "name": a.name,
                    "content_type": a.content_type,
                    "size": a.size,
                    "is_inline": a.is_inline,
                })
            })
            .collect(),
    )
    .to_string()
}

/// Persist a folder list, returning true when any folder's metadata moved (so the
/// caller emits `mail_folders_changed` only on a real change).
pub fn persist_folders(store: &crate::store::Store, folders: &[MailFolder]) -> Result<bool> {
    store.transaction(|| {
        let mut changed = false;
        for folder in folders {
            changed |= store.upsert_mail_folder(&crate::store::MailFolderUpdate {
                id: &folder.id,
                display_name: &folder.display_name,
                well_known: &folder.well_known,
                total_count: folder.total_count,
                unread_count: folder.unread_count,
                position: folder.position,
            })?;
        }
        Ok(changed)
    })
}

/// Persist a page of message headers, returning how many rows actually changed.
///
/// One transaction for the whole page: the store's batching is what keeps a 40-mail
/// page a single commit instead of forty (see `Store::transaction`).
pub fn persist_headers(store: &crate::store::Store, headers: &[MailHeader]) -> Result<usize> {
    store.transaction(|| {
        let mut changed = 0;
        for header in headers {
            let to = addresses_json(&header.to);
            let cc = addresses_json(&header.cc);
            if store.upsert_mail_message(&crate::store::MailMessageUpdate {
                id: &header.id,
                folder_id: &header.folder_id,
                conversation_id: &header.conversation_id,
                subject: &header.subject,
                from_name: &header.from.name,
                from_address: &header.from.address,
                to_addresses: &to,
                cc_addresses: &cc,
                received: &header.received,
                is_read: header.is_read,
                has_attachments: header.has_attachments,
                importance: &header.importance,
                preview: &header.preview,
            })? {
                changed += 1;
            }
        }
        Ok(changed)
    })
}

/// Cache a rendered body (and its attachment list) against its message.
pub fn persist_body(
    store: &crate::store::Store,
    message_id: &str,
    fetched: &FetchedBody,
) -> Result<()> {
    store.set_mail_body(
        message_id,
        &crate::store::MailBodyUpdate {
            html: &fetched.body.html,
            blocked_remote_images: fetched.body.blocked_remote_images as i64,
            truncated: fetched.body.truncated,
            attachments: &attachments_json(&fetched.attachments),
        },
    )
}

/// Extend a folder's history frontier from a freshly fetched page.
///
/// `has_more` is inferred the way the Teams backfill does it: a page that came back
/// full probably has more behind it, a short page is the end of the folder.
pub fn persist_frontier(
    store: &crate::store::Store,
    folder_id: &str,
    page: &[MailHeader],
    requested: u32,
) -> Result<()> {
    let Some(oldest) = page.last().map(|h| h.received.clone()) else {
        // An empty page means we reached the end (nothing older to ask for).
        return store.set_mail_frontier(folder_id, "", false);
    };
    store.set_mail_frontier(folder_id, &oldest, page.len() as u32 >= requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not
    /// the prose that explains it (this file's own module doc necessarily names the
    /// endpoints it forbids). A `//` preceded by `:` is left alone so the `https://`
    /// inside a string literal survives — otherwise everything after a URL on the
    /// same line would look like a comment, and a forbidden token hiding after one
    /// would slip through.
    ///
    /// Known limitation, stated rather than hidden: a string literal containing a
    /// bare `//` (not after a colon) truncates the rest of its line. No such
    /// literal exists in this crate, and the failure mode is a scan that reads
    /// less, so the tests below also assert they actually found something to scan.
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| {
                let bytes = line.as_bytes();
                let mut cut = line.len();
                for i in 0..bytes.len().saturating_sub(1) {
                    if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                        cut = i;
                        break;
                    }
                }
                &line[..cut]
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// THE no-write guarantee, enforced on this module's own source: every request
    /// goes through `graph_get`, and no other HTTP verb appears anywhere in the
    /// file. A future edit that adds a `.post(...)` — a send, a move, a
    /// mark-as-read — fails this test instead of quietly gaining the ability to
    /// change the user's mailbox.
    #[test]
    fn module_issues_only_get_requests() {
        let source = include_str!("mail.rs");
        // Skip this test module, whose own body necessarily names the forbidden
        // verbs, then strip comments so the doc block above does not match either.
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("async fn graph_get"), "scanned the wrong text");
        for verb in [".post(", ".put(", ".patch(", ".delete(", ".request("] {
            assert!(
                !code.contains(verb),
                "src/mail.rs must issue GET requests only, found `{verb}`. Mail is read-only \
                 by construction: adding a write path here is a deliberate feature that needs \
                 its own consent gate, not an edit to this module."
            );
        }
    }

    /// The mailbox's send endpoint must not exist anywhere in the crate. Graph
    /// exposes sending as `/sendMail` (and `/send` on a draft), and the token this
    /// app already holds carries `Mail.Send` — so the only thing standing between
    /// this codebase and a mail leaving the user's account is that no code names
    /// that endpoint. This test keeps it that way.
    #[test]
    fn crate_contains_no_mail_send_endpoint() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new("src"), &mut files);
        assert!(files.len() > 5, "no Rust sources found to scan");
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            let code =
                strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(&source));
            assert!(
                !code.contains("sendMail"),
                "{} names the Graph mail-send endpoint. Sending mail is forbidden: the account \
                 is the user's personal mailbox and a sent mail cannot be recalled.",
                file.display()
            );
        }
    }

    #[test]
    fn normalizes_timestamps_to_whole_seconds() {
        // Already second-precision: unchanged.
        assert_eq!(
            normalize_timestamp("2026-06-30T14:20:16Z"),
            "2026-06-30T14:20:16Z"
        );
        // Fractional seconds are truncated, so every stored value is fixed width.
        assert_eq!(
            normalize_timestamp("2026-06-30T14:20:16.1234567Z"),
            "2026-06-30T14:20:16Z"
        );
        // Whitespace is tolerated.
        assert_eq!(
            normalize_timestamp("  2026-01-02T03:04:05Z  "),
            "2026-01-02T03:04:05Z"
        );
        // Anything not shaped like a timestamp is refused (the caller skips it).
        assert_eq!(normalize_timestamp(""), "");
        assert_eq!(normalize_timestamp("2026-06-30"), "");
        assert_eq!(normalize_timestamp("not a timestamp at all"), "");
        assert_eq!(normalize_timestamp("2026/06/30T14:20:16Z"), "");
        assert_eq!(normalize_timestamp("2026-06-30 14:20:16Z"), "");
    }

    #[test]
    fn normalized_timestamps_sort_chronologically_as_text() {
        // The property the store's ORDER BY depends on: fixed-width UTC text sorts
        // exactly as time does, so no date arithmetic is needed anywhere.
        let mut stamps = vec![
            normalize_timestamp("2026-06-30T14:20:16Z"),
            normalize_timestamp("2025-12-31T23:59:59Z"),
            normalize_timestamp("2026-07-01T00:00:00Z"),
            normalize_timestamp("2026-06-30T14:20:15.999Z"),
        ];
        stamps.sort();
        assert_eq!(
            stamps,
            vec![
                "2025-12-31T23:59:59Z",
                "2026-06-30T14:20:15Z",
                "2026-06-30T14:20:16Z",
                "2026-07-01T00:00:00Z",
            ]
        );
    }

    #[test]
    fn parses_a_message_header() {
        let value = json!({
            "value": [{
                "id": "AAMk-1",
                "conversationId": "conv-1",
                "subject": "  Quarterly review  ",
                "from": { "emailAddress": { "name": "Lucas Silva", "address": "lucas@example.com" } },
                "toRecipients": [
                    { "emailAddress": { "name": "Me", "address": "me@example.com" } },
                    { "emailAddress": { "address": "other@example.com" } }
                ],
                "ccRecipients": [{ "emailAddress": { "name": "Ada", "address": "ada@example.com" } }],
                "receivedDateTime": "2026-06-30T14:20:16Z",
                "isRead": false,
                "hasAttachments": true,
                "importance": "high",
                "bodyPreview": "Hi,\r\n\r\nplease   review the deck\nbefore Friday."
            }]
        });
        let headers = parse_headers(&value, "folder-1");
        assert_eq!(headers.len(), 1);
        let h = &headers[0];
        assert_eq!(h.id, "AAMk-1");
        assert_eq!(h.folder_id, "folder-1");
        assert_eq!(h.conversation_id, "conv-1");
        assert_eq!(h.subject, "Quarterly review");
        assert_eq!(h.from.name, "Lucas Silva");
        assert_eq!(h.from.address, "lucas@example.com");
        assert_eq!(h.to.len(), 2);
        assert_eq!(h.to[1].name, "");
        assert_eq!(h.to[1].address, "other@example.com");
        assert_eq!(h.cc.len(), 1);
        assert_eq!(h.received, "2026-06-30T14:20:16Z");
        assert!(!h.is_read);
        assert!(h.has_attachments);
        assert_eq!(h.importance, "high");
        // The preview is collapsed to a single clean line.
        assert_eq!(h.preview, "Hi, please review the deck before Friday.");
    }

    #[test]
    fn skips_messages_without_an_id_or_timestamp() {
        // Neither could be ordered or addressed, so they are dropped rather than
        // stored with an invented key.
        let value = json!({
            "value": [
                { "subject": "no id", "receivedDateTime": "2026-06-30T14:20:16Z" },
                { "id": "AAMk-2", "subject": "no timestamp" },
                { "id": "AAMk-3", "receivedDateTime": "yesterday" },
                { "id": "AAMk-4", "receivedDateTime": "2026-06-30T14:20:16Z" }
            ]
        });
        let headers = parse_headers(&value, "f");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].id, "AAMk-4");
    }

    #[test]
    fn defaults_a_missing_read_flag_to_read() {
        // A message whose `isRead` we could not read must not raise a false unread
        // badge; "read" is the non-alarming default.
        let value = json!({ "value": [{ "id": "x", "receivedDateTime": "2026-06-30T14:20:16Z" }] });
        assert!(parse_headers(&value, "f")[0].is_read);
    }

    #[test]
    fn parses_an_absent_sender_as_empty_rather_than_inventing_one() {
        let value = json!({ "value": [{ "id": "x", "receivedDateTime": "2026-06-30T14:20:16Z" }] });
        let h = &parse_headers(&value, "f")[0];
        assert_eq!(h.from.name, "");
        assert_eq!(h.from.address, "");
    }

    #[test]
    fn parses_folders_and_skips_error_envelopes() {
        let ok = json!({
            "id": "folder-1",
            "displayName": "Boîte de réception",
            "totalItemCount": 6578,
            "unreadItemCount": 4261
        });
        let folder = parse_folder(&ok).expect("a folder with an id parses");
        assert_eq!(folder.id, "folder-1");
        // The localized display name is preserved verbatim — it is what Outlook
        // shows — while ordering and the stable label come from the alias.
        assert_eq!(folder.display_name, "Boîte de réception");
        assert_eq!(folder.total_count, 6578);
        assert_eq!(folder.unread_count, 4261);

        // An error envelope (a mailbox without that folder) is not a folder.
        let err = json!({ "error": { "code": "ErrorItemNotFound", "message": "not found" } });
        assert!(parse_folder(&err).is_none());
    }

    #[test]
    fn parses_attachments_with_safe_defaults() {
        let value = json!({
            "value": [
                {
                    "id": "att-1",
                    "name": "invite.ics",
                    "contentType": "application/ics",
                    "size": 1942,
                    "isInline": false
                },
                { "id": "att-2", "name": "logo.png", "isInline": true },
                { "name": "no id" }
            ]
        });
        let atts = parse_attachments(&value);
        assert_eq!(atts.len(), 2);
        assert_eq!(atts[0].content_type, "application/ics");
        assert_eq!(atts[0].size, 1942);
        assert!(!atts[0].is_inline);
        // A missing content type falls back to a generic binary type.
        assert_eq!(atts[1].content_type, "application/octet-stream");
        assert!(atts[1].is_inline);
    }

    #[test]
    fn well_known_folders_are_unique_and_inbox_first() {
        let aliases: std::collections::HashSet<&str> =
            WELL_KNOWN_FOLDERS.iter().map(|(a, _)| *a).collect();
        assert_eq!(aliases.len(), WELL_KNOWN_FOLDERS.len());
        assert_eq!(WELL_KNOWN_FOLDERS[0].0, "inbox");
    }

    #[test]
    fn endpoints_stay_on_graph_and_encode_their_arguments() {
        // A folder id contains base64 characters (`+`, `/`, `=`) that must not leak
        // into the URL structure.
        let url = endpoint(&format!("/mailFolders/{}/messages", q("AAMk/id+with=pad")));
        assert!(url.starts_with("https://graph.microsoft.com/v1.0/me/"));
        assert!(!url.contains("id+with"));
        assert!(url.contains("AAMk%2Fid%2Bwith%3Dpad"));
    }

    #[tokio::test]
    async fn refuses_to_send_the_token_to_a_non_graph_url() {
        // Defence in depth around the one request builder: even if a caller
        // constructed a URL by hand, the bearer token never leaves Graph.
        let http = reqwest::Client::new();
        let err = graph_get(&http, "secret-token", "https://evil.example.com/steal", None)
            .await
            .expect_err("a non-Graph URL must be refused");
        assert!(err.to_string().contains("non-Graph URL"));
    }
}
