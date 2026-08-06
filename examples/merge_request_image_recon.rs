// Manual live measurement of the IMAGES a merge-request description and comment carry,
// READ-ONLY.
//
// An author pastes a screenshot into a description and GitLab writes
// `![image.png](/uploads/<secret>/image.png){width=777 height=312}` — a RELATIVE path, an
// optional attribute block, and bytes that only a session or a token can open. The page draws
// that with its own markdown subset (see AGENTS.md § The GitLab page), so three things have to
// be measured rather than guessed: which shapes the authors here really produce, what the
// relative path resolves against, and what GitLab answers when the app's own token asks for it.
//
//   cargo run --example merge_request_image_recon
//
// It READS and nothing else: the list, then one detail and one discussion page per row, then a
// GET per distinct upload. It prints COUNTS, STATUSES and SHAPES — never a URL, an upload path
// or a line of anybody's text: an upload path holds a secret (it is the whole authorization to
// read that file), and this output ends up in a terminal, a journal or a transcript.
use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState};

/// How many merge requests to read. One detail plus one discussion page is two requests, and
/// the open list is ~100 rows on this instance: the cap keeps a measurement from being two
/// hundred round trips, and it is STATED in the output, because a sample that does not say it
/// is a sample reads as a census.
const SAMPLE: usize = 40;

/// How many distinct uploads to actually FETCH. The question a fetch answers is "does the
/// token open one of these, and what does GitLab answer with" — a handful settles it, and each
/// one is a picture somebody pasted.
const FETCH_SAMPLE: usize = 6;

/// One image reference found in a body, reduced to its shape.
#[derive(Debug, Default)]
struct Shapes {
    /// `![alt](/uploads/<secret>/<name>)` — a project upload, written relative.
    relative_upload: usize,
    /// `![alt](/-/project/<id>/uploads/…)` — the same file, addressed by project id.
    relative_project_upload: usize,
    /// A relative path that is not an upload at all (a repository file, a wiki page).
    relative_other: usize,
    /// An absolute URL on the configured host.
    absolute_same_host: usize,
    /// An absolute URL somewhere else (a badge, shields.io, an external screenshot host).
    absolute_other_host: usize,
    /// How many of the above carried GitLab's `{width=… height=…}` attribute block.
    with_attributes: usize,
    /// How many carried an attribute block naming something other than width/height.
    with_other_attributes: usize,
    /// How many had no alt text at all.
    without_alt: usize,
}

impl Shapes {
    fn total(&self) -> usize {
        self.relative_upload
            + self.relative_project_upload
            + self.relative_other
            + self.absolute_same_host
            + self.absolute_other_host
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;

    let store = teams_lite::store::Store::open(&db_path()?)?;
    let host = store
        .get_setting("gitlab_host")?
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| teams_lite::gitlab::DEFAULT_HOST.to_string());
    let token = store.get_setting("gitlab_token")?.filter(|t| !t.is_empty());
    println!("== host {host} · token {}", if token.is_some() { "set" } else { "ABSENT" });
    anyhow::ensure!(token.is_some(), "no GitLab token stored — the page can read nothing");

    let list = gitlab_mr::fetch_list(
        &http,
        &host,
        token.as_deref(),
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    let rows: Vec<_> = list.items.iter().take(SAMPLE).collect();
    println!("== {} open merge requests · reading the newest {}", list.items.len(), rows.len());

    let mut descriptions = Shapes::default();
    let mut comments = Shapes::default();
    let mut bodies_with_an_image = 0usize;
    // What an upload path resolves against: the project's own web base, taken from the merge
    // request's `web_url` (everything before the `/-/` marker). Collected per project so a
    // fetch can be tried, and never printed.
    let mut fetchable: Vec<(String, String)> = Vec::new();

    for row in &rows {
        let detail =
            gitlab_mr::fetch_detail(&http, &host, token.as_deref(), &row.project_path, row.iid)
                .await?;
        let base = project_web_base(&detail.web_url);
        if let Some(body) = detail.description.as_deref() {
            let found = scan(body, &host, &mut descriptions);
            if found > 0 {
                bodies_with_an_image += 1;
                collect(body, &base, &mut fetchable);
            }
        }

        let discussions =
            gitlab_mr::fetch_discussions(&http, &host, token.as_deref(), &row.project_path, row.iid)
                .await?;
        for discussion in &discussions.discussions {
            for note in &discussion.notes {
                let found = scan(&note.body, &host, &mut comments);
                if found > 0 {
                    bodies_with_an_image += 1;
                    collect(&note.body, &base, &mut fetchable);
                }
            }
        }
    }

    println!("\n== bodies carrying at least one image: {bodies_with_an_image}");
    report("descriptions", &descriptions);
    report("comments", &comments);

    // What the token really opens. This is the fact nothing else can establish: an upload is
    // served by the WEB app rather than by the API, so whether `PRIVATE-TOKEN` is accepted
    // there is a property of the instance and not of the docs.
    fetchable.sort();
    fetchable.dedup();
    let version = http
        .get(format!("https://{host}/api/v4/version"))
        .header("PRIVATE-TOKEN", token.as_deref().unwrap_or_default())
        .send()
        .await?
        .text()
        .await?;
    println!("\n== instance version: {}", version.trim());
    println!(
        "== trying {} of {} distinct uploads, five ways each",
        fetchable.len().min(FETCH_SAMPLE),
        fetchable.len()
    );
    for (base, path) in fetchable.iter().take(FETCH_SAMPLE) {
        // 1. the WEB path, with the header token — what a page's own <img> would ask for,
        //    plus the token the app holds.
        try_fetch(&http, "web + PRIVATE-TOKEN", format!("{base}{path}"), token.as_deref()).await;
        // 2. the same web path with no credential at all — what the BROWSER would get, which is
        //    the reason the bytes have to travel through the backend.
        try_fetch(&http, "web, no token       ", format!("{base}{path}"), None).await;
        // 3. GitLab's own upload API (`GET /projects/:id/uploads/:secret/:filename`), which is
        //    an API route and therefore the one place a header token is meant to work.
        if let (Some(project), Some((secret, name))) = (project_of(base, &host), upload_of(path)) {
            let api = format!(
                "https://{host}/api/v4/projects/{}/uploads/{secret}/{name}",
                urlencoding::encode(&project)
            );
            try_fetch(&http, "api uploads         ", api, token.as_deref()).await;
        }
        // 4. the web path with the token as a query parameter, which is how GitLab used to
        //    authenticate a non-API route.
        try_fetch(
            &http,
            "web ?private_token  ",
            format!("{base}{path}?private_token={}", token.as_deref().unwrap_or_default()),
            None,
        )
        .await;
        // 5. and THE CODE THIS APP SHIPS, which is the only one of the five that says the page
        //    will really draw a picture: `gitlab_mr::fetch_upload`, over the reference its own
        //    parser accepts, with the rails it applies (the cap, and the sniff on the bytes).
        if let (Some(project), Some((secret, name))) = (project_of(base, &host), upload_of(path)) {
            match gitlab_mr::UploadRef::parse(&project, &secret, &name) {
                Err(err) => println!("   this app's own read   REFUSED the reference: {err}"),
                Ok(reference) => {
                    match gitlab_mr::fetch_upload(&http, &host, token.as_deref(), &reference).await {
                        Err(err) => println!("   this app's own read   failed: {err:#}"),
                        Ok(picture) => println!(
                            "   this app's own read   {} · {} bytes · {}",
                            picture.content_type,
                            picture.bytes.len(),
                            teams_lite::sender_icon::image_dimensions(&picture.bytes)
                                .map(|(w, h)| format!("{w}x{h}"))
                                .unwrap_or_else(|| "(unknown)".to_string()),
                        ),
                    }
                }
            }
        }
    }

    Ok(())
}

/// GET one candidate and print what came back — status, type, size, and what the BYTES say
/// they are. The URL itself is never printed: an upload path is the whole authorization to
/// read that file.
async fn try_fetch(http: &reqwest::Client, what: &str, url: String, token: Option<&str>) {
    let mut request = http.get(&url).header("Accept", "image/*");
    if let Some(token) = token {
        request = request.header("PRIVATE-TOKEN", token);
    }
    match request.send().await {
        Err(err) => println!("   {what} .. request failed: {err}"),
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(none)")
                .to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            let sniffed = teams_lite::sender_icon::image_kind(&bytes).unwrap_or("NOT AN IMAGE");
            let dimensions = teams_lite::sender_icon::image_dimensions(&bytes)
                .map(|(w, h)| format!("{w}x{h}"))
                .unwrap_or_else(|| "(unknown)".to_string());
            println!(
                "   {what} {status} · {content_type} · {} bytes · sniffed {sniffed} · {dimensions}",
                bytes.len()
            );
        }
    }
}

/// The project path out of a project web base (`https://host/group/project` → `group/project`).
fn project_of(base: &str, host: &str) -> Option<String> {
    let rest = base.strip_prefix("https://")?.strip_prefix(host)?;
    let path = rest.trim_matches('/');
    (!path.is_empty()).then(|| path.to_string())
}

/// The secret and the filename out of an upload path (`/uploads/<secret>/<name>`).
fn upload_of(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/uploads/")?;
    let mut parts = rest.splitn(2, '/');
    let secret = parts.next()?.to_string();
    let name = parts.next()?.to_string();
    (!secret.is_empty() && !name.is_empty()).then_some((secret, name))
}

fn report(what: &str, shapes: &Shapes) {
    println!("\n== {what}: {} image references", shapes.total());
    println!("   relative /uploads/…            {}", shapes.relative_upload);
    println!("   relative /-/project/<id>/uploads/…  {}", shapes.relative_project_upload);
    println!("   relative, not an upload        {}", shapes.relative_other);
    println!("   absolute, configured host      {}", shapes.absolute_same_host);
    println!("   absolute, ANOTHER host         {}", shapes.absolute_other_host);
    println!("   with {{width=… height=…}}        {}", shapes.with_attributes);
    println!("   with another attribute         {}", shapes.with_other_attributes);
    println!("   with no alt text               {}", shapes.without_alt);
}

/// Count every `![alt](url)` in one body into `shapes`, and return how many there were.
fn scan(body: &str, host: &str, shapes: &mut Shapes) -> usize {
    let mut found = 0;
    for (alt, url, attributes) in images(body) {
        found += 1;
        if alt.trim().is_empty() {
            shapes.without_alt += 1;
        }
        if let Some(attributes) = attributes {
            if attributes.contains("width") || attributes.contains("height") {
                shapes.with_attributes += 1;
            } else {
                shapes.with_other_attributes += 1;
            }
        }
        if url.starts_with("https://") || url.starts_with("http://") {
            let same = url
                .strip_prefix("https://")
                .map(|rest| rest.split(['/', '?', '#']).next().unwrap_or("").eq_ignore_ascii_case(host))
                .unwrap_or(false);
            if same {
                shapes.absolute_same_host += 1;
            } else {
                shapes.absolute_other_host += 1;
            }
        } else if url.starts_with("/uploads/") {
            shapes.relative_upload += 1;
        } else if url.starts_with("/-/project/") && url.contains("/uploads/") {
            shapes.relative_project_upload += 1;
        } else {
            shapes.relative_other += 1;
        }
    }
    found
}

/// Gather the relative uploads of one body, paired with the project web base they resolve
/// against, so the fetch below can try them.
fn collect(body: &str, base: &str, out: &mut Vec<(String, String)>) {
    for (_, url, _) in images(body) {
        if url.starts_with("/uploads/") {
            out.push((base.to_string(), url));
        }
    }
}

/// Every `![alt](url)` in a body, with the `{…}` attribute block that follows one, if any.
/// Deliberately as coarse as a scanner reading a real body: what is measured is how often a
/// reader meets a shape, not whether a CommonMark edge case is spelled right.
fn images(body: &str) -> Vec<(String, String, Option<String>)> {
    let bytes: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != '!' || bytes[i + 1] != '[' {
            i += 1;
            continue;
        }
        let Some(label_end) = find(&bytes, i + 2, ']') else { break };
        if bytes.get(label_end + 1) != Some(&'(') {
            i = label_end + 1;
            continue;
        }
        let Some(url_end) = find(&bytes, label_end + 2, ')') else { break };
        let alt: String = bytes[i + 2..label_end].iter().collect();
        let url: String = bytes[label_end + 2..url_end].iter().collect();
        let mut attributes = None;
        let mut next = url_end + 1;
        if bytes.get(next) == Some(&'{') {
            if let Some(brace) = find(&bytes, next + 1, '}') {
                attributes = Some(bytes[next + 1..brace].iter().collect());
                next = brace + 1;
            }
        }
        out.push((alt, url.split_whitespace().next().unwrap_or("").to_string(), attributes));
        i = next;
    }
    out
}

fn find(chars: &[char], from: usize, needle: char) -> Option<usize> {
    (from..chars.len()).find(|i| chars[*i] == needle)
}

/// A project's own web base — everything before GitLab's `/-/` marker — which is what a
/// relative `/uploads/…` in that project's markdown resolves against.
fn project_web_base(web_url: &str) -> String {
    match web_url.find("/-/") {
        Some(at) => web_url[..at].to_string(),
        None => web_url.to_string(),
    }
}

/// The store the backend keeps, resolved the way it resolves it.
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
