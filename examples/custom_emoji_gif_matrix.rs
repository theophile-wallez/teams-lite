// Find out how to make an animated GIF stay animated through Teams' AMS, so that EVERY
// Teams client shows the animation — not just teams-lite.
//
// What is already measured (`examples/custom_emoji_gif_probe.rs`): for an object uploaded
// the way the app uploads a custom emoji, `views/imgo` answers image/jpeg — ONE still
// frame — while `content/imgpsh` still holds the original GIF89a. A message body references
// `views/imgo`, so every client draws the still. Pointing teams-lite's own proxy at
// `content/imgpsh` would fix teams-lite alone; making the animation reach a STOCK client
// means getting `views/imgo` itself to serve it.
//
// The suspicion this measures: the app passes the emoji's NAME as `filename`, with no
// extension, and states nothing else about the format — so AMS is never told the bytes are
// a GIF and transcodes them to a still. Each variant below declares the format somewhere
// different, uploads the SAME animated GIF, and reports what each path then serves. A
// variant AMS refuses is a finding too: the refusal names the vocabulary.
//
// It POSTS NO MESSAGE, edits nothing and reacts to nothing. The only write it performs is
// creating AMS objects — a write to the media service, not to a chat. It still has to name
// a conversation, because an AMS object is created with a conversation's read permission,
// and the one it names is the sandbox thread (CLAUDE.md § Sending messages) and no other.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example custom_emoji_gif_matrix
//
use std::collections::BTreeSet;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use teams_lite::{custom_emoji, sender_icon, teams, teams_media};

/// The sandbox channel (CLAUDE.md § Sending messages). Nothing is posted to it — it is
/// named because an AMS object carries a conversation's read permission — and it is the
/// only conversation this file may ever name.
const SANDBOX: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// IC3 token scope for AMS uploads — the same string the backend's own `IC3_SCOPE` holds
/// (src/bin/server.rs). It is spelled again because that const is private to the binary.
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";

/// The client version AMS is told, mirroring `teams_send::AMS_CLIENT_VERSION` — private to
/// that module, and a create AMS answers differently under another client version would be
/// measuring a different client than the one that ships.
const AMS_CLIENT_VERSION: &str = "1415/26061118216";

/// A real animated GIF (~61 KB), already proven fetchable through these rails by
/// `examples/custom_emoji_slackmoji.rs`, so this example needs no fixture on disk.
const EMOJI_URL: &str = "https://slackmojis.com/emojis/2453-alert/download";

/// The two paths every variant is measured on: the one a message REFERENCES, and the one
/// the bytes were PUT to.
const MEASURED_PATHS: &[&str] = &["/views/imgo", "/content/imgpsh"];

/// One way of telling AMS what it is being handed.
struct Variant {
    label: &'static str,
    create: Value,
    /// The `content-type` header on the content PUT. The app sends
    /// `application/octet-stream` (`teams_send::upload_ams_object`); one variant declares
    /// the real type there instead, because the upload is the other place the format could
    /// be stated and it costs one header to rule out.
    upload_type: &'static str,
}

/// The whole matrix, cheapest cause first. Permissions and `sharingMode` are held constant
/// so the only thing that varies is how the format is declared.
fn variants() -> Vec<Variant> {
    let octet = "application/octet-stream";
    let create = |extra: Value| -> Value {
        let mut body = json!({
            "type": "pish/image",
            "permissions": { SANDBOX: ["read"] },
            "sharingMode": "Inline",
            "filename": "meow",
        });
        let (Value::Object(body_map), Value::Object(extra)) = (&mut body, extra) else {
            unreachable!("both literals above are objects");
        };
        body_map.extend(extra);
        body
    };
    vec![
        Variant {
            label: "control — exactly what the app sends today",
            create: create(json!({})),
            upload_type: octet,
        },
        Variant {
            label: "filename carries the extension",
            create: create(json!({ "filename": "meow.gif" })),
            upload_type: octet,
        },
        Variant {
            label: "extension + contentType on the create",
            create: create(json!({ "filename": "meow.gif", "contentType": "image/gif" })),
            upload_type: octet,
        },
        Variant {
            label: "extension + originalContentType on the create",
            create: create(json!({ "filename": "meow.gif", "originalContentType": "image/gif" })),
            upload_type: octet,
        },
        Variant {
            label: "type pish/gif",
            create: create(json!({ "type": "pish/gif", "filename": "meow.gif" })),
            upload_type: octet,
        },
        Variant {
            label: "type pish/animatedImage",
            create: create(json!({ "type": "pish/animatedImage", "filename": "meow.gif" })),
            upload_type: octet,
        },
        Variant {
            label: "type pish/video",
            create: create(json!({ "type": "pish/video", "filename": "meow.gif" })),
            upload_type: octet,
        },
        Variant {
            label: "extension + image/gif on the content PUT",
            create: create(json!({ "filename": "meow.gif" })),
            upload_type: "image/gif",
        },
    ]
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    let ic3 = teams_lite::auth::get_token(IC3_SCOPE)
        .await
        .context("acquire IC3 token")?;
    let ams = ams_endpoint(&session)?;
    println!("AMS endpoint: {ams}");

    // The source bytes, and the assertion that there is anything to measure. This also
    // exercises the GIF walk below on a known-animated file every single run: if the
    // parser breaks, the example refuses to upload anything rather than reporting eight
    // confident "still" verdicts.
    println!("\nfetching the source GIF from {EMOJI_URL}");
    let source = sender_icon::fetch_raster(EMOJI_URL, custom_emoji::MAX_CUSTOM_EMOJI_BYTES)
        .await
        .context("fetch the source GIF")?
        .context("the source URL answered with no image at all")?;
    let source_verdict = verdict(&source.content_type, &source.bytes);
    println!(
        "source: {} | {} bytes | {} | {}",
        source.content_type,
        source.bytes.len(),
        first_bytes(&source.bytes),
        source_verdict
    );
    anyhow::ensure!(
        source_verdict.starts_with("animated GIF"),
        "the source is {source_verdict}, so there is nothing to measure — this matrix asks \
         whether an ANIMATED GIF survives AMS, and a still one would answer 'still' \
         everywhere for reasons that have nothing to do with AMS"
    );

    // Every variant, on the same bytes. A refusal is recorded rather than fatal: the
    // vocabulary AMS accepts is exactly what the refusals map out.
    let mut animated_by: Option<(&'static str, Value)> = None;
    let mut first_object: Option<String> = None;

    for variant in variants() {
        println!("\n=== {} ===", variant.label);
        println!("create: {}", variant.create);
        println!("content PUT type: {}", variant.upload_type);

        let id = match create_object(&http, ams, &ic3, &variant.create).await {
            Ok(id) => id,
            Err(e) => {
                println!("create refused: {e}");
                continue;
            }
        };
        println!("object: {id}");
        if let Err(e) = put_content(&http, ams, &ic3, &id, variant.upload_type, &source.bytes).await
        {
            println!("content PUT refused: {e}");
            continue;
        }
        first_object.get_or_insert_with(|| id.clone());

        for path in MEASURED_PATHS {
            let animated = report(&http, &session, &format!("{ams}/v1/objects/{id}{path}"), path).await;
            if animated && *path == "/views/imgo" && animated_by.is_none() {
                animated_by = Some((variant.label, variant.create.clone()));
            }
        }
    }

    // The object's own metadata, in full. The earlier probe saw 719 bytes of JSON at the
    // bare object URL and printed six of them; that JSON is the one place AMS itself says
    // which views it offers, which ends the guessing about view names.
    let mut original_served_by: Option<String> = None;
    if let Some(id) = &first_object {
        let url = format!("{ams}/v1/objects/{id}");
        println!("\n=== Object metadata ({url}) ===");
        match teams_media::fetch_media(&http, &session, &url).await {
            Ok(media) => {
                let text = String::from_utf8_lossy(&media.bytes);
                match serde_json::from_str::<Value>(&text) {
                    Ok(parsed) => {
                        println!("{}", serde_json::to_string_pretty(&parsed)?);
                        let mut names = BTreeSet::new();
                        view_names(&parsed, &mut names);
                        if names.is_empty() {
                            println!("\nthe metadata names no view of its own");
                        }
                        for name in &names {
                            let path = format!("/views/{name}");
                            let view = format!("{ams}/v1/objects/{id}{path}");
                            if report(&http, &session, &view, &path).await
                                && original_served_by.is_none()
                            {
                                original_served_by = Some(path);
                            }
                        }
                    }
                    // Not JSON is itself worth stating rather than swallowing: it would
                    // mean the bare URL serves the object rather than describing it.
                    Err(_) => println!(
                        "not JSON: {} | {} bytes | {}",
                        media.content_type,
                        media.bytes.len(),
                        first_bytes(&media.bytes)
                    ),
                }
            }
            Err(e) => println!("refused: {e}"),
        }
    }

    println!("\n=== Verdict ===");
    match &animated_by {
        Some((label, create)) => {
            println!("views/imgo serves the animation under: {label}.");
            println!("the create body that achieved it:\n{}", serde_json::to_string_pretty(create)?);
        }
        None => println!(
            "No variant makes views/imgo animated — every way of declaring the format was \
             either refused or transcoded to a still, so a stock Teams client cannot be \
             shown this animation through an AMS view."
        ),
    }
    match &original_served_by {
        Some(path) => println!("Of the views the metadata lists, {path} serves the original."),
        None => println!(
            "No view the metadata lists serves the original; only content/imgpsh did, and \
             that is the upload path rather than a view a message can reference."
        ),
    }
    Ok(())
}

/// The AMS endpoint the session names, resolved the way `teams_send::ams_endpoint` does —
/// private to that module, and a second spelling of the fallback order would measure an
/// endpoint the app might not use.
fn ams_endpoint(session: &teams::Session) -> Result<&str> {
    session
        .endpoint("amsV2")
        .or_else(|| session.endpoint("ams"))
        .map(|endpoint| endpoint.trim_end_matches('/'))
        .filter(|endpoint| !endpoint.is_empty())
        .context("no amsV2 or ams endpoint in regionGtms")
}

/// Create one AMS object and answer with its id. A refusal carries the status and the
/// service's own body verbatim: an unknown field rejected with a 4xx is the finding.
async fn create_object(
    http: &reqwest::Client,
    ams: &str,
    ic3: &str,
    body: &Value,
) -> Result<String> {
    let resp = http
        .post(format!("{ams}/v1/objects/"))
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
        .json(body)
        .send()
        .await
        .context("create AMS object")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "{status}: {text}");
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|parsed| parsed.get("id")?.as_str().map(String::from))
        .filter(|id| !id.is_empty())
        .with_context(|| format!("{status} but no id: {text}"))
}

/// PUT the bytes to the object, at the one content path the app uses.
async fn put_content(
    http: &reqwest::Client,
    ams: &str,
    ic3: &str,
    id: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<()> {
    let resp = http
        .put(format!("{ams}/v1/objects/{id}/content/imgpsh"))
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
        .header("content-type", content_type)
        .body(bytes.to_vec())
        .send()
        .await
        .context("upload AMS content")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "{status}: {text}");
    Ok(())
}

/// Fetch one path of one object and print the row this whole example exists to produce.
/// Answers whether that path served an animation.
async fn report(
    http: &reqwest::Client,
    session: &teams::Session,
    url: &str,
    label: &str,
) -> bool {
    match teams_media::fetch_media(http, session, url).await {
        Ok(media) => {
            let verdict = verdict(&media.content_type, &media.bytes);
            println!(
                "{label:18} → {} | {} bytes | {} | {verdict}",
                media.content_type,
                media.bytes.len(),
                first_bytes(&media.bytes)
            );
            verdict.starts_with("animated GIF")
        }
        Err(e) => {
            println!("{label:18} → refused {e}");
            false
        }
    }
}

/// Every view name the object's own JSON names, in either shape it might take: a `views`
/// map or list, or any URL carrying `/views/<name>`.
fn view_names(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "views" {
                    match child {
                        Value::Object(views) => out.extend(views.keys().cloned()),
                        Value::Array(views) => {
                            out.extend(views.iter().filter_map(|v| v.as_str()).map(String::from))
                        }
                        _ => {}
                    }
                }
                view_names(child, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| view_names(item, out)),
        Value::String(text) => {
            if let Some((_, tail)) = text.rsplit_once("/views/") {
                let name = tail.split(['/', '?', '#']).next().unwrap_or(tail);
                if !name.is_empty() {
                    out.insert(name.to_string());
                }
            }
        }
        _ => {}
    }
}

/// The first 6 bytes as ASCII where printable, plus hex — enough to read a magic number
/// off the output without dumping anybody's media.
fn first_bytes(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(6)];
    let ascii: String = head
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '.' })
        .collect();
    let hex: Vec<String> = head.iter().map(|b| format!("{b:02x}")).collect();
    format!("{ascii:6} [{}]", hex.join(" "))
}

/// What a path really served: `animated GIF`, `still <something>`, and the frame count
/// behind the judgement.
fn verdict(content_type: &str, bytes: &[u8]) -> String {
    if !matches!(bytes.get(..6), Some(b"GIF87a") | Some(b"GIF89a")) {
        let kind = if content_type.is_empty() { "unnamed type" } else { content_type };
        return format!("still {kind}");
    }
    let frames = gif_frames(bytes);
    let counted = frames.map_or_else(
        || "structure unreadable".to_string(),
        |n| format!("{n} frame{}", if n == 1 { "" } else { "s" }),
    );
    let looping = bytes.windows(11).any(|w| w == b"NETSCAPE2.0");
    let animated = frames.is_some_and(|n| n > 1) || looping;
    let marker = if looping { ", NETSCAPE2.0" } else { "" };
    format!(
        "{} GIF ({counted}{marker})",
        if animated { "animated" } else { "still" }
    )
}

/// How many image-descriptor blocks a GIF holds, by WALKING its block structure. Counting
/// `0x2C` bytes instead is the obvious shortcut and it is wrong: `0x2C` is a comma, so it
/// occurs freely inside LZW data and a byte count reads almost every single-frame GIF as
/// animated — which on this example is a false "the fix works". `None` when the structure
/// runs out before the trailer.
fn gif_frames(bytes: &[u8]) -> Option<usize> {
    // The 6-byte header, the 7-byte logical screen descriptor, then the global colour
    // table its own packed field (byte 10) declares.
    let mut at = 13 + color_table_len(*bytes.get(10)?);
    let mut frames = 0;
    loop {
        match *bytes.get(at)? {
            0x3B => return Some(frames),
            // An extension: the introducer, its label, then length-prefixed sub-blocks.
            0x21 => at = skip_sub_blocks(bytes, at + 2)?,
            // An image: the introducer, a 9-byte descriptor whose last byte may declare a
            // local colour table, the LZW minimum code size, then the pixel sub-blocks.
            0x2C => {
                frames += 1;
                at += 10;
                at += color_table_len(*bytes.get(at - 1)?) + 1;
                at = skip_sub_blocks(bytes, at)?;
            }
            _ => return None,
        }
    }
}

/// The bytes a colour table occupies for a packed field that may declare one.
fn color_table_len(packed: u8) -> usize {
    if packed & 0x80 == 0 {
        0
    } else {
        3 << ((packed & 0x07) + 1)
    }
}

/// The offset past a chain of length-prefixed sub-blocks, which a zero length terminates.
fn skip_sub_blocks(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *bytes.get(at)? as usize;
        at += 1 + len;
        if len == 0 {
            return Some(at);
        }
    }
}
