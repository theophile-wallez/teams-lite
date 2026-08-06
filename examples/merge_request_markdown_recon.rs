// Manual live measurement of the MARKDOWN a merge-request description is written in,
// READ-ONLY.
//
// The page renders a description with the app's own markdown subset rather than GitLab's
// rendered HTML (see AGENTS.md § The GitLab page), so the subset has to cover what the
// authors on THIS instance actually write. Guessing the answer is how a description ends up
// as a wall of pipe characters: a construct the parser does not know is printed verbatim,
// and nothing reports it.
//
// So this counts constructs across the open merge requests' descriptions and prints the
// COUNTS alone — never a line of anybody's text, because a description is somebody's work
// and this output ends up in a terminal, a journal or a transcript.
//
//   cargo run --example merge_request_markdown_recon
//
// It READS and nothing else: the list, then one detail per row. The GitLab host and token
// come from the app's own store, so it measures exactly what the page would be handed.
use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState};

/// How many descriptions to read. One detail is one request, and the open list is ~100 rows
/// on this instance: the cap keeps a measurement from being a hundred round trips, and it is
/// STATED in the output, because a sample that does not say it is a sample reads as a census.
const SAMPLE: usize = 40;

/// One construct, and the line that opens it.
struct Construct {
    name: &'static str,
    /// Whether a line opens this construct. It is deliberately as coarse as the parser's own
    /// block rules: what is being measured is how often a reader meets the construct, not
    /// whether a CommonMark edge case is spelled correctly.
    matches: fn(&str) -> bool,
}

const CONSTRUCTS: &[Construct] = &[
    Construct { name: "ATX heading (#…)", matches: |l| l.trim_start().starts_with('#') && l.trim_start().trim_start_matches('#').starts_with(' ') },
    Construct { name: "fenced code (``` or ~~~)", matches: |l| { let t = l.trim_start(); t.starts_with("```") || t.starts_with("~~~") } },
    Construct { name: "table row (a | b)", matches: |l| l.trim_start().starts_with('|') },
    Construct { name: "table delimiter (|---|)", matches: is_table_delimiter },
    Construct { name: "blockquote (>)", matches: |l| l.trim_start().starts_with('>') },
    Construct { name: "bullet item", matches: |l| is_bullet(l.trim_start()) },
    Construct { name: "NESTED bullet item (indented)", matches: |l| l.starts_with("  ") && is_bullet(l.trim_start()) },
    Construct { name: "numbered item", matches: |l| { let t = l.trim_start(); let digits = t.trim_start_matches(|c: char| c.is_ascii_digit()); digits.len() < t.len() && (digits.starts_with(". ") || digits.starts_with(") ")) } },
    Construct { name: "task list ([ ] / [x])", matches: |l| { let t = l.trim_start(); is_bullet(t) && { let rest = t[1..].trim_start(); rest.starts_with("[ ]") || rest.starts_with("[x]") || rest.starts_with("[X]") } } },
    Construct { name: "thematic break (--- / ***)", matches: is_thematic_break },
    Construct { name: "HTML comment (<!--)", matches: |l| l.contains("<!--") },
    Construct { name: "raw HTML tag (<details>, <br>, …)", matches: has_raw_tag },
    Construct { name: "image (![alt](url))", matches: |l| l.contains("![") },
    Construct { name: "inline link ([label](url))", matches: |l| l.contains("](") },
    Construct { name: "autolink (<https://…>)", matches: |l| l.contains("<http") },
    Construct { name: "inline code (`x`)", matches: |l| l.matches('`').count() >= 2 && !l.trim_start().starts_with("```") },
    Construct { name: "emphasis (** or __ or ~~)", matches: |l| l.contains("**") || l.contains("__") || l.contains("~~") },
    Construct { name: "indented code (4 spaces)", matches: |l| l.starts_with("    ") && !is_bullet(l.trim_start()) && !l.trim().is_empty() },
    Construct { name: "hard break (two trailing spaces)", matches: |l| l.ends_with("  ") && !l.trim().is_empty() },
];

/// The one construct whose count depends on more than its own line.
const INDENTED_CODE: &str = "indented code (4 spaces)";

/// The lines a block parser would really read as markup: the ones outside a fenced code
/// block, each paired with whether a list is open where it sits. A fence's own marker line
/// is kept — it is the construct — and everything between markers is dropped.
fn plain_lines<'a>(lines: &[&'a str]) -> Vec<(&'a str, bool)> {
    let mut kept = Vec::new();
    let mut fence: Option<char> = None;
    let mut list_open = false;
    for line in lines {
        let trimmed = line.trim_start();
        let opener = trimmed.starts_with("```").then_some('`').or(trimmed.starts_with("~~~").then_some('~'));
        match (fence, opener) {
            (None, Some(mark)) => {
                fence = Some(mark);
                kept.push((*line, list_open));
            }
            (Some(open), Some(mark)) if open == mark => {
                fence = None;
                kept.push((*line, list_open));
            }
            (Some(_), _) => {}
            (None, None) => {
                if line.trim().is_empty() {
                    list_open = false;
                } else if is_bullet(trimmed) {
                    list_open = true;
                }
                kept.push((*line, list_open));
            }
        }
    }
    kept
}

fn is_bullet(trimmed: &str) -> bool {
    matches!(trimmed.chars().next(), Some('-') | Some('*') | Some('+'))
        && trimmed.chars().nth(1) == Some(' ')
}

fn is_table_delimiter(line: &str) -> bool {
    let t = line.trim();
    t.contains('-') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn is_thematic_break(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3
        && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_'))
}

fn has_raw_tag(line: &str) -> bool {
    const TAGS: &[&str] = &["<details", "</details", "<summary", "</summary", "<br", "<img", "<p>", "<table", "<code", "<pre", "<b>", "<i>", "<a "];
    TAGS.iter().any(|tag| line.contains(tag))
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

    // One counter per construct: how many DESCRIPTIONS use it, and how many lines do.
    let mut descriptions = 0usize;
    let mut empty = 0usize;
    let mut multi_line_paragraphs = 0usize;
    let mut counts: Vec<(usize, usize)> = vec![(0, 0); CONSTRUCTS.len()];

    for row in rows {
        let detail =
            gitlab_mr::fetch_detail(&http, &host, token.as_deref(), &row.project_path, row.iid)
                .await?;
        let body = detail.description.unwrap_or_default();
        if body.trim().is_empty() {
            empty += 1;
            continue;
        }
        descriptions += 1;
        let body = body.replace("\r\n", "\n");
        let lines: Vec<&str> = body.lines().collect();
        // Every count is taken OUTSIDE a fenced block, and an indented line is only code
        // where no list is open. Both matter: a `#` inside a fence is not a heading, and a
        // four-space line under a bullet is that bullet's own continuation. Counting them
        // as constructs is how a measurement talks somebody into a parser rule nobody
        // needs.
        let plain = plain_lines(&lines);
        for (index, construct) in CONSTRUCTS.iter().enumerate() {
            let hits = plain.iter().filter(|(line, _)| (construct.matches)(line)).count();
            let hits = if construct.name == INDENTED_CODE {
                plain.iter().filter(|(line, list_open)| !list_open && (construct.matches)(line)).count()
            } else {
                hits
            };
            if hits > 0 {
                counts[index].0 += 1;
                counts[index].1 += hits;
            }
        }
        // A paragraph HARD-WRAPPED over several lines is the quietest fault of all: a
        // parser that makes one block per line turns one sentence into a column of stubs,
        // and nothing about the output looks broken.
        let prose: Vec<&str> = plain.iter().map(|(line, _)| *line).collect();
        if has_wrapped_paragraph(&prose) {
            multi_line_paragraphs += 1;
        }
    }

    println!("== {descriptions} descriptions with words in them, {empty} empty");
    println!("   {multi_line_paragraphs} hold a paragraph wrapped over several lines");
    println!("   construct                             descriptions   lines");
    let mut ranked: Vec<(usize, &Construct)> = CONSTRUCTS.iter().enumerate().collect();
    ranked.sort_by_key(|(index, _)| std::cmp::Reverse(counts[*index].0));
    for (index, construct) in ranked {
        let (docs, lines) = counts[index];
        println!("   {:<38} {docs:>6}   {lines:>6}", construct.name);
    }
    println!("== done · reads only, no write");
    Ok(())
}

/// True when two consecutive non-blank lines are both ordinary prose — the shape that only
/// reads correctly if the parser JOINS them into one paragraph.
fn has_wrapped_paragraph(lines: &[&str]) -> bool {
    let ordinary = |line: &str| {
        let t = line.trim();
        !t.is_empty()
            && !CONSTRUCTS.iter().any(|c| (c.matches)(line) && c.name != "inline link ([label](url))" && c.name != "inline code (`x`)" && c.name != "emphasis (** or __ or ~~)")
    };
    lines.windows(2).any(|pair| ordinary(pair[0]) && ordinary(pair[1]))
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
