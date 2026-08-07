// Manual live recon for the QUALITY of an inline chat image.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (GET only), and it
// answers one question: when this app draws a picture somebody pasted into a chat, is it
// drawing the FULL-RESOLUTION object, or a cheap reduced view of it?
//
// Two phases:
//   1. a SURVEY over many pictures, comparing the view every message points at
//      (`views/imgo`) with the full one (`views/imgpsh_fullsize_anim`): how many are a
//      reduction, by how much, and what the extra bytes cost.
//   2. the whole VIEW TABLE for a few of them — every view name AMS is known to publish,
//      with its status, its bytes and its real pixels — beside the `width`/`height` the
//      Teams client wrote on the `<img>`.
//
// It prints SHAPES and never content: an object id is truncated, and no message text, no
// sender and no conversation is read out.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example inline_image_recon [-- <how many pictures> [<how many tables>]]
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};

use teams_lite::sender_icon::image_dimensions;

/// How many distinct objects the survey measures by default, and how many of them get the
/// whole view table. Every fetch is a whole picture, so both are small on purpose.
const SAMPLE: usize = 24;
const TABLES: usize = 3;

/// The full view — what the app should draw — and the reduced one every message points at.
const FULL_VIEW: &str = "imgpsh_fullsize_anim";
const MESSAGE_VIEW: &str = "imgo";

/// The view names an AMS/asyncgw object is known to publish. `imgo` is what every message
/// in this store points at; the rest are what a client could ask for instead.
const VIEWS: &[&str] = &[
    "imgo",
    "imgpsh_fullsize",
    "imgpsh_fullsize_anim",
    "imgpsh_mobile_save_anim",
    "imgpsh_mthumb",
    "imgt1",
    "imgt1_anim",
    "original",
    "thumbnail",
];

/// One inline picture as the MESSAGE describes it.
struct Claim {
    /// The `src` the body carries, verbatim — the URL this app really fetches.
    src: String,
    /// The `width`/`height` attributes the Teams client wrote, when it wrote them.
    width: Option<f64>,
    height: Option<f64>,
}

fn main() -> Result<()> {
    let sample: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(SAMPLE);
    let tables: usize = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(TABLES);

    let claims = read_claims(&db_path()?)?;
    println!("== {} inline AMSImage picture(s) in the store", claims.len());
    let with_size = claims
        .iter()
        .filter(|c| c.width.is_some() && c.height.is_some())
        .count();
    println!(
        "== {with_size} of them state a width and a height on the <img> ({} do not)",
        claims.len() - with_size
    );

    let mut views = std::collections::BTreeSet::new();
    for c in &claims {
        views.insert(view_of(&c.src).unwrap_or("(none)").to_string());
    }
    println!(
        "== the view every message points at: {}\n",
        views.into_iter().collect::<Vec<_>>().join(", ")
    );

    // The newest first, and one entry per object: a picture re-sent lands in the store twice.
    let mut seen = std::collections::HashSet::new();
    let picked: Vec<&Claim> = claims
        .iter()
        .rev()
        .filter(|c| seen.insert(object_of(&c.src).unwrap_or_default()))
        .take(sample)
        .collect();

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(measure(&picked, tables))
}

async fn measure(picked: &[&Claim], tables: usize) -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    println!("== region={} · measuring {} picture(s)\n", session.region, picked.len());

    survey(&http, &session, picked).await;

    println!("== the whole view table for the newest {tables}\n");
    for claim in picked.iter().take(tables) {
        let object = object_of(&claim.src).unwrap_or_default();
        println!("-- object {}…", object.chars().take(12).collect::<String>());
        match (claim.width, claim.height) {
            (Some(w), Some(h)) => println!("   the message claims {w} x {h}"),
            _ => println!("   the message states no size"),
        }

        let mut original: Option<(u32, u32)> = None;
        for view in VIEWS {
            let url = with_view(&claim.src, view);
            match teams_lite::teams_media::fetch_media(&http, &session, &url).await {
                Ok(media) => {
                    let dims = image_dimensions(&media.bytes);
                    let shape = match dims {
                        Some((w, h)) => format!("{w} x {h}"),
                        None => "unreadable header".to_string(),
                    };
                    println!(
                        "   {view:<24} {:>9} bytes · {} · {shape}",
                        media.bytes.len(),
                        media.content_type
                    );
                    if *view == "imgo" {
                        original = dims;
                    }
                    // A view answering the same pixels as `imgo` is the same picture under
                    // another name; a bigger one would be what this app is missing.
                    if let (Some((ow, _)), Some((w, _))) = (original, dims) {
                        if *view != "imgo" && w > ow {
                            println!("      ^^ BIGGER than imgo by {:.2}x", f64::from(w) / f64::from(ow));
                        }
                    }
                }
                Err(e) => println!("   {view:<24} no ({})", first_line(&format!("{e:#}"))),
            }
        }

        if let (Some((w, _)), Some(claimed)) = (original, claim.width) {
            // Below 1 the picture on screen holds fewer pixels than arrived (a plain
            // downscale); above 1 the message asks for MORE than the object holds, which is
            // an upscale and the one shape that really cannot look sharp.
            println!(
                "   the message draws it at {:.2}x the pixels it holds",
                claimed / f64::from(w.max(1))
            );
        }
        println!();
    }

    Ok(())
}

/// The reduced view every message points at, against the full one, over the whole sample.
/// This is the number the fix rests on: how often `imgo` is a reduction, by how much, and
/// what the pixels it drops cost in bytes.
async fn survey(http: &reqwest::Client, session: &teams_lite::teams::Session, picked: &[&Claim]) {
    let mut reduced = 0usize;
    let mut same = 0usize;
    let mut missing = 0usize;
    let mut cheap_bytes = 0usize;
    let mut full_bytes = 0usize;
    let mut worst = 1.0f64;

    for claim in picked {
        let cheap = fetch(http, session, &with_view(&claim.src, MESSAGE_VIEW)).await;
        let full = fetch(http, session, &with_view(&claim.src, FULL_VIEW)).await;
        let object = object_of(&claim.src).unwrap_or_default();
        let head = object.chars().take(12).collect::<String>();
        match (cheap, full) {
            (Some((cb, Some((cw, ch)))), Some((fb, Some((fw, fh))))) => {
                cheap_bytes += cb;
                full_bytes += fb;
                let ratio = f64::from(fw) / f64::from(cw.max(1));
                if fw > cw || fh > ch {
                    reduced += 1;
                    worst = worst.max(ratio);
                    println!(
                        "   {head}… {MESSAGE_VIEW} {cw}x{ch} ({cb} B) → {FULL_VIEW} {fw}x{fh} ({fb} B) · {ratio:.2}x"
                    );
                } else {
                    same += 1;
                    println!("   {head}… {cw}x{ch}, the same in both ({cb} → {fb} B)");
                }
            }
            (_, None) => {
                missing += 1;
                println!("   {head}… no {FULL_VIEW} at all");
            }
            _ => {
                missing += 1;
                println!("   {head}… unreadable");
            }
        }
    }

    println!(
        "\n== {reduced} of {} are a REDUCTION, {same} are already whole, {missing} could not be read",
        picked.len()
    );
    println!("== the worst reduction in the sample: {worst:.2}x");
    if cheap_bytes > 0 {
        println!(
            "== the whole picture costs {:.2}x the bytes ({cheap_bytes} → {full_bytes} over {} picture(s))\n",
            full_bytes as f64 / cheap_bytes as f64,
            reduced + same
        );
    }
}

/// One view's bytes and pixels, or `None` when it is not served.
async fn fetch(
    http: &reqwest::Client,
    session: &teams_lite::teams::Session,
    url: &str,
) -> Option<(usize, Option<(u32, u32)>)> {
    let media = teams_lite::teams_media::fetch_media(http, session, url).await.ok()?;
    Some((media.bytes.len(), image_dimensions(&media.bytes)))
}

/// Every inline `AMSImage` in the store, oldest first.
fn read_claims(db: &str) -> Result<Vec<Claim>> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT content FROM messages WHERE content LIKE '%schema.skype.com/AMSImage%' ORDER BY rowid",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let html: String = row.get(0)?;
        out.extend(claims_in(&html));
    }
    Ok(out)
}

/// The `AMSImage` tags of one body. Deliberately a scan rather than a parse: this reads
/// three attributes off a tag and never renders anything.
fn claims_in(html: &str) -> Vec<Claim> {
    let mut out = Vec::new();
    for tag in html.split("<img").skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        if !tag.contains("AMSImage") {
            continue;
        }
        let Some(src) = attr(tag, "src") else { continue };
        if !src.contains("/views/") {
            continue;
        }
        out.push(Claim {
            src,
            width: attr(tag, "width").and_then(|v| v.parse().ok()),
            height: attr(tag, "height").and_then(|v| v.parse().ok()),
        });
    }
    out
}

/// A double-quoted attribute of one tag.
fn attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    Some(rest[..rest.find('"')?].to_string())
}

/// The view name a hosted-content URL ends with (`…/views/imgo` → `imgo`).
fn view_of(url: &str) -> Option<&str> {
    url.rsplit_once("/views/")
        .map(|(_, view)| view.split(['?', '#']).next().unwrap_or(view))
}

/// The object id of a hosted-content URL (`…/v1/objects/<id>/views/…`).
fn object_of(url: &str) -> Option<String> {
    let (head, _) = url.rsplit_once("/views/")?;
    Some(head.rsplit_once("/objects/")?.1.to_string())
}

/// The same object under another view name.
fn with_view(url: &str, view: &str) -> String {
    match url.rsplit_once("/views/") {
        Some((head, _)) => format!("{head}/views/{view}"),
        None => url.to_string(),
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(120).collect()
}

fn db_path() -> Result<String> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    let path = format!("{base}/teams-lite/teams-lite.sqlite");
    anyhow::ensure!(
        std::path::Path::new(&path).exists(),
        "no store at {path} — run the app once so it has one"
    );
    Ok(path)
}
